// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// The Observer run: an in-process agentLoop per chunk that calls a
// `record_observations` tool to capture observations, then mechanically wraps
// each captured observation in a fresh `new` node at the root and persists the
// batch. The Observer is a non-writer (it only appends observation +
// new-wrapper deltas; it never restructures — that's the Builder).
//
// Persistence granularity: ONE `memkeeper.observation` delta PER CHUNK
// (coversFromId = chunk's first entry, coversUpToId = chunk's last), persisted
// immediately after each chunk's agentLoop succeeds (per-chunk durability).
// An abort loses only the in-flight chunk — completed chunks are durable and the
// frontier has already advanced past them, so a re-run skips them (idempotent by
// coverage range). Reverses the earlier accumulate-then-append (one delta per
// run, abort = lose everything), which lost all work on any run longer than the
// abort window.

import type { AgentMessage, AgentTool } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { MemkeeperConfig } from "../config/schema.js";
import { buildChunks, type ChunkOptions, type RenderedChunk } from "../format/chunk.js";
import { computeDetailsAndCache, type EntryResolver } from "../format/details.js";
import { toStoredTimestamp } from "../format/render.js";
import { applyCreateNode, applyRecordObservation, type GraphDelta } from "../graph/mutations.js";
import { toStoreContext } from "../lifecycle.js";
import { log } from "../log.js";
import { notify } from "../notify.js";
import { OBSERVER_SYSTEM } from "../prompts/observer.js";
import {
  NO_LOOP_OVERRIDE,
  NO_TURN_LIMIT,
  runStage,
  type StageRunInput,
  type StageRunResult,
} from "../runtime/agent-loop.js";
import { makeLedgerHook, persistLedger } from "../runtime/ledger-hook.js";
import { resolveStageModelOrNotify, resolveStageReasoning } from "../runtime/model.js";
import { ImportanceSchema } from "../schema.js";
import { encodeObservation, type ObservationEntry } from "../store/codecs.js";
import { appendGraphDeltaBatch, appendObservation, getGraphStore, type StoreContext } from "../store/graph-store.js";
import { type Importance, makeObservation, type NodeId, nowStoredTimestamp, type ObsId } from "../types.js";
import type { WidgetController } from "../widget/tracker.js";

// --- named constants (no bare literals at call sites) ----------------------

export const RECORD_OBS_TOOL = "record_observations";
const OBSERVE_STAGE = "observe" as const;
const NO_SOURCE_ENTRY: SessionEntry | undefined = undefined;
const EMPTY_GAP = 0;
const EMPTY_RECORDS = 0;

/** A captured observation (validated; before id/timestamp/wrap assignment). */
export interface RecordObservation {
  readonly summary: string;
  readonly importance: Importance;
  readonly sourceEntryIds: string[];
}

/** The `record_observations` tool parameter schema (typed for the execute body). */
const RECORD_OBS_PARAMS = Type.Object({
  observations: Type.Array(
    Type.Object({
      summary: Type.String({
        minLength: 1,
        description: "The observation, written concisely as its essential meaning.",
      }),
      importance: ImportanceSchema,
      sourceEntryIds: Type.Array(Type.String(), {
        minItems: 1,
        description:
          "Source entry ids this observation draws on — the E=id values in this chunk. At least one; an id not present here rejects this observation.",
      }),
    }),
  ),
});

/** A factory + accumulator pair: one tool per chunk (its own allowed-id set). */
interface RecordTool {
  readonly tool: AgentTool;
  /** Validated records accumulated across this tool's calls. */
  readonly records: RecordObservation[];
  /** Total observations the model attempted (accepted + rejected) across calls. */
  readonly attempted: number;
}

/**
 * Build a fresh `record_observations` tool bound to one chunk's allowed-id set.
 * Each record is validated per-observation: every cited `sourceEntryId` must be
 * in `allowedIds` (a foreign id rejects that one record only, not the whole
 * batch). Valid records accumulate on `records`.
 */
function makeRecordObservationsTool(allowedIds: ReadonlySet<string>): RecordTool {
  const records: RecordObservation[] = [];
  let attempted = 0;
  const tool: AgentTool<typeof RECORD_OBS_PARAMS> = {
    name: RECORD_OBS_TOOL,
    description: "Record the observations worth keeping from this chunk.",
    label: "Record observations",
    parameters: RECORD_OBS_PARAMS,
    async execute(_toolCallId, params) {
      let accepted = EMPTY_RECORDS;
      let rejected = EMPTY_RECORDS;
      for (const raw of params.observations) {
        attempted += 1;
        const valid = raw.sourceEntryIds.every((srcId: string) => allowedIds.has(srcId));
        if (!valid) {
          rejected += 1;
          continue;
        }
        records.push({
          summary: raw.summary,
          importance: raw.importance as Importance,
          sourceEntryIds: [...raw.sourceEntryIds],
        });
        accepted += 1;
      }
      const ack = `recorded ${accepted}${rejected > EMPTY_RECORDS ? `, ${rejected} rejected for invalid ids` : ""}; continue or reply Done`;
      return { content: [{ type: "text", text: ack }], details: { accepted, rejected } };
    },
  };
  return {
    tool,
    records,
    get attempted() {
      return attempted;
    },
  };
}

// --- run input -------------------------------------------------------------

/** Input to `runObserver`. The run honors `signal` only — the caller owns the
 *  run-lock (the background trigger releases in its IIFE; compaction holds). */
export interface ObserverRunInput {
  ctx: ExtensionContext;
  pi: ExtensionAPI;
  settings: MemkeeperConfig;
  /** The unobserved renderable entries (the gap to cover this run). */
  unobserved: SessionEntry[];
  /** Abort signal (the caller's per-run controller). */
  signal: AbortSignal;
  /** The widget controller (opens the observe stage + forwards agent events). */
  widget: WidgetController;
  /** Test seam — fake stage runner override, or null/omitted for the real `runStage`. */
  runStageFn?: (input: StageRunInput) => Promise<StageRunResult>;
  /** Optional mid-catch-up Builder trigger: after each chunk's persist, the
   *  Observer awaits this; if it returns true the Builder ran (consolidating the
   *  accumulated `new` roots) and the Observer re-asserts its observe stage
   *  before the next chunk. Provided by the compaction hook (the ballooning
   *  case — long catch-ups); undefined on the turn_end path (small batches). */
  maybeBuild?: () => Promise<boolean>;
}

/** A wrapper node paired with the observation id it wraps (persistence pairs). */
interface WrappedPair {
  readonly nodeId: NodeId;
  readonly obsId: ObsId;
}

// --- the run ---------------------------------------------------------------

/**
 * Run the Observer over the unobserved gap: chunk it, run one agentLoop per
 * chunk with the `record_observations` tool, validate each record against its
 * chunk's allowed-id set, wrap valid records in `new` nodes, and persist one
 * observation delta for the whole run. Honors `signal`; writes nothing on abort
 * or when no valid records are captured (notify instead).
 */
export async function runObserver(input: ObserverRunInput): Promise<void> {
  if (input.signal.aborted) return;
  if (input.unobserved.length === EMPTY_GAP) return;

  // model resolution (observerModel -> defaultModel -> session).
  const resolved = await resolveStageModelOrNotify(
    input.ctx,
    "Observer",
    input.settings.observerModel ?? input.settings.defaultModel,
  );
  if (!resolved.ok) {
    return;
  }

  const store = toStoreContext(input.pi, input.ctx);

  // Re-check abort after the model-resolution await: compaction may have
  // signalled during it (mirrors the Builder/Selector guard).
  if (input.signal.aborted) return;

  const chunkOptions: ChunkOptions = {
    tokenThreshold: input.settings.observerThresholdTokens,
    toolBlockCapTokens: input.settings.observerToolBlockCapTokens,
    includeThinking: input.settings.observerIncludeThinking,
    includeEntryId: true,
  };
  const chunks = buildChunks(input.unobserved, chunkOptions);

  // index entries by id for timestamp lookup (mechanical from source).
  const entryById = new Map<string, SessionEntry>();
  for (const entry of input.unobserved) entryById.set(entry.id, entry);

  // A local resolver over the in-hand unobserved entries computes each
  // record's verbatim-source size hint (detailsLines/detailsTokens) without a
  // session round-trip — the source entries are already in `entryById`.
  const localResolver: EntryResolver = (ids) =>
    ids.map((id) => entryById.get(id)).filter((entry): entry is SessionEntry => entry !== undefined);

  const totalChunks = chunks.length;
  let stageOpened = false;
  let done = 0;
  let totalRecords = 0;
  const ledger = makeLedgerHook(OBSERVE_STAGE);
  try {
    input.widget.startStage(OBSERVE_STAGE, { batch: { done: 0, total: totalChunks } });
    stageOpened = true;
    for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex += 1) {
      const chunk = chunks[chunkIndex];
      if (input.signal.aborted) return;
      const recordTool = makeRecordObservationsTool(chunk.allowedIds);
      const stageInput: StageRunInput = {
        systemPrompt: OBSERVER_SYSTEM,
        messages: [{ role: "user", content: chunk.text } as AgentMessage],
        tools: [recordTool.tool],
        model: resolved.model,
        apiKey: resolved.apiKey,
        signal: input.signal,
        reasoning: resolveStageReasoning(
          input.settings.observerThinkingLevel,
          input.settings.defaultThinkingLevel,
          input.ctx.thinkingLevel,
        ),
        maxTurns: NO_TURN_LIMIT,
        maxTokens: input.settings.observerMaxTokens,
        timeoutMs: input.settings.llmCallTimeoutMs,
        onEvent: (event) => input.widget.onEvent(event),
        onStageEnd: ledger.onStageEnd,
        loopFn: NO_LOOP_OVERRIDE,
      };

      const run = input.runStageFn ?? runStage;
      try {
        await run(stageInput);
      } catch (cause) {
        // a throwing chunk's own records are lost (not yet persisted this chunk);
        // prior chunks are already durable (per-chunk persistence). Stop here so
        // the failed chunk + everything after stay re-observable.
        if (input.signal.aborted) return;
        log.error("observer stage failed", cause);
        notify(
          input.ctx,
          "Observer stopped at a failed chunk (LLM error); later entries re-observed next run",
          "warning",
        );
        break;
      } finally {
        done += 1;
        input.widget.setBatch(done, totalChunks);
      }
      // this chunk succeeded → wrap its records + persist IMMEDIATELY (per-chunk
      // durability: an abort loses only the in-flight chunk; the frontier has
      // already advanced past every prior record-bearing chunk). A 0-record
      // chunk persists nothing — it is covered by the next record-bearing
      // chunk's coversUpToId; trailing 0-record chunks re-observe next run.
      const records = recordTool.records;
      if (records.length > EMPTY_RECORDS) {
        totalRecords += records.length;
        persistChunk(store, chunk, records, entryById, localResolver);
        // The per-chunk persist adds nodes OUTSIDE the chunk's agentLoop, so the
        // widget's cached root counts (last invalidated by the chunk's
        // tool_execution_end, then re-cached pre-persist) are stale — drop them so
        // the next render reflects the new roots this chunk (not the next one).
        input.widget.invalidateRoots();
        // Mid-catch-up Builder: at compaction the Builder runs after the Observer
        // anyway, so folding the accumulated `new` roots WHEN the root view crosses
        // the threshold keeps it bounded through a long catch-up instead of
        // ballooning to hundreds of roots before a single giant Builder pass. The
        // orchestrator owns the trigger + the Builder run (the Observer stays
        // decoupled). If it ran, re-assert the observe stage (the Builder flipped
        // the widget to build then ended it).
        if (input.maybeBuild !== undefined) {
          const built = await input.maybeBuild();
          if (input.signal.aborted) return;
          if (built) input.widget.startStage(OBSERVE_STAGE, { batch: { done, total: totalChunks } });
        }
      }
      // an all-bad chunk (model attempted records but every id was foreign) is
      // skipped — no records from it — and the user is warned.
      if (recordTool.attempted > EMPTY_RECORDS && records.length === EMPTY_RECORDS) {
        notify(input.ctx, "Observer skipped a chunk: all observations cited invalid source ids", "warning");
      }
      // persist the cumulative usage ledger PER CHUNK so an interrupted run
      // (compaction cancelled, provider error, crash) keeps the usage tally for
      // every completed chunk — matching the per-chunk durability of the
      // observations themselves (the two stay consistent).
      if (ledger.hasUsage()) persistLedger(store);
    }

    if (input.signal.aborted) return;

    if (totalRecords === EMPTY_RECORDS) {
      // every chunk yielded nothing worth keeping. Completed chunks already
      // advanced the frontier past their range (via the next record-bearing
      // chunk, or trailing re-observe next run); nothing else to do.
      notify(input.ctx, "Observer returned no observations", "warning");
    }
  } catch (cause) {
    // a persist-phase throw (e.g. a wrapper missing its node) is logged, not
    // re-thrown — matching the Builder/Selector runs' error contract (never
    // throw to the caller, keep partial work). Per-chunk LLM failures are
    // caught + notified inline above; this catches the rest.
    log.error("observer run failed", cause);
  } finally {
    if (stageOpened) input.widget.endStage();
  }
}

// --- persist helpers -------------------------------------------------------

/** Wrap a chunk's records in fresh `new` root nodes + persist immediately: one
 *  `memkeeper.graph_delta` entry (the wrapper create_node ops) and one
 *  `memkeeper.observation` entry spanning this chunk's coversFromId/coversUpToId
 *  range. The frontier advances to the chunk's lastEntryId via appendObservation
 *  — so an abort loses only the in-flight chunk; completed chunks are durable
 *  and skipped on re-run. */
function persistChunk(
  store: StoreContext,
  chunk: RenderedChunk,
  records: readonly RecordObservation[],
  entryById: Map<string, SessionEntry>,
  resolver: EntryResolver,
): void {
  const graph = getGraphStore().graph;
  const deltas: GraphDelta[] = [];
  const pairs: WrappedPair[] = [];
  for (const record of records) {
    const nodeId = `n${graph.nextNodeId}` as NodeId;
    // the wrapper carries the observation's one-line summary at birth so every
    // node always reads with a summary; the Builder refines it later.
    applyCreateNode(graph, {
      id: nodeId,
      summary: record.summary,
      importance: record.importance,
      parentNode: null,
      state: "new",
    });
    deltas.push({
      type: "create_node",
      id: nodeId,
      summary: record.summary,
      importance: record.importance,
      parentNode: null,
      state: "new",
    });
    const obsId = `o${graph.nextObsId}` as ObsId;
    const firstSource = record.sourceEntryIds.map((id) => entryById.get(id)).find((entry) => entry !== NO_SOURCE_ENTRY);
    const timestamp = firstSource !== undefined ? toStoredTimestamp(firstSource.timestamp) : nowStoredTimestamp();
    const counts = computeDetailsAndCache(obsId, record.sourceEntryIds, resolver);
    applyRecordObservation(graph, {
      obs: makeObservation({
        id: obsId,
        summary: record.summary,
        importance: record.importance,
        sourceEntryIds: record.sourceEntryIds,
        timestamp,
        parentNode: nodeId,
        detailsLines: counts?.lines,
        detailsTokens: counts?.tokens,
      }),
    });
    pairs.push({ nodeId, obsId });
  }
  // wrappers: one graph_delta entry holding this chunk's create_node ops.
  appendGraphDeltaBatch(store, deltas);
  // observations: one observation entry covering THIS chunk's range
  // (coversUpToId advances the frontier; a later record-bearing chunk's range
  // subsumes any intervening 0-record chunks).
  let tokenCount = 0;
  const serializedRecords = pairs.map((pair) => {
    const obs = graph.observations.get(pair.obsId);
    if (obs === undefined) {
      throw new Error("observer wrap: observation missing");
    }
    tokenCount += obs.detailsTokens; // verbatim source size processed this batch
    return encodeObservation(obs);
  });
  const entry: ObservationEntry = {
    coversFromId: chunk.firstEntryId,
    coversUpToId: chunk.lastEntryId,
    records: serializedRecords,
    tokenCount,
  };
  appendObservation(store, entry);
}
