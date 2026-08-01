// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// The Observer run: an in-process agentLoop per chunk that calls a
// `record_observations` tool to capture observations, then mechanically wraps
// each captured observation in a fresh `new` node at the root and persists the
// batch. The Observer is a non-writer (it only appends observation +
// new-wrapper deltas; it never restructures — that's the Builder).
//
// Persistence granularity: ONE `memkeeper.observation` delta per run
// (coversFromId = first unobserved entry, coversUpToId = last), accumulated
// across all chunks then appended at the end (accumulate-then-append — a failed
// or aborted run writes nothing; idempotent by coverage range on re-run).

import type { AgentMessage, AgentTool } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { MemkeeperConfig } from "../config/schema.js";
import { toStoredTimestamp } from "../format/render.js";
import { applyCreateNode, applyRecordObservation, type GraphDelta } from "../graph/mutations.js";
import { toStoreContext } from "../lifecycle.js";
import { log } from "../log.js";
import { notify } from "../notify.js";
import { OBSERVER_SYSTEM } from "../prompts/observer.js";
import { NO_REASONING, runStage, type StageRunInput, type StageRunResult } from "../runtime/agent-loop.js";
import { makeLedgerHook } from "../runtime/ledger-hook.js";
import { resolveStageModel } from "../runtime/model.js";
import { ImportanceSchema } from "../schema.js";
import { encodeObservation, type ObservationEntry } from "../store/codecs.js";
import { appendGraphDelta, appendObservation, getGraphStore, type StoreContext } from "../store/graph-store.js";
import { type Importance, makeObservation, type NodeId, nowStoredTimestamp, type ObsId } from "../types.js";
import type { WidgetController } from "../widget/tracker.js";
import { buildChunks, type ChunkOptions } from "./chunk.js";

// --- named constants (no bare literals at call sites) ----------------------

export const RECORD_OBS_TOOL = "record_observations";
const NO_MAX_TURNS = null;
const NO_LOOP_OVERRIDE = null;
const NO_SOURCE_ENTRY: SessionEntry | undefined = undefined;
const EMPTY_GAP = 0;
const EMPTY_RECORDS = 0;
const FIRST = 0;

/** A captured observation (validated; before id/timestamp/wrap assignment). */
export interface RecordObservation {
  readonly content: string;
  readonly importance: Importance;
  readonly sourceEntryIds: string[];
}

/** The `record_observations` tool parameter schema (typed for the execute body). */
const RECORD_OBS_PARAMS = Type.Object({
  observations: Type.Array(
    Type.Object({
      content: Type.String({
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
          content: raw.content,
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
  if (input.unobserved.length === EMPTY_GAP) return;

  // model resolution (observerModel -> defaultModel -> session).
  const resolved = await resolveStageModel(input.ctx, input.settings.observerModel ?? input.settings.defaultModel);
  if (!resolved.ok) {
    notify(input.ctx, `Observer skipped a run: ${resolved.error}`, "warning");
    return;
  }

  const store = toStoreContext(input.pi, input.ctx);
  const graph = getGraphStore().graph;

  const chunkOptions: ChunkOptions = {
    tokenThreshold: input.settings.observerThresholdTokens,
    toolBlockCapTokens: input.settings.observerToolBlockCapTokens,
    includeThinking: input.settings.observerIncludeThinking,
  };
  const chunks = buildChunks(input.unobserved, chunkOptions);

  // index entries by id for timestamp lookup (mechanical from source).
  const entryById = new Map<string, SessionEntry>();
  for (const entry of input.unobserved) entryById.set(entry.id, entry);

  const allRecords: RecordObservation[] = [];
  const totalChunks = chunks.length;
  let stageOpened = false;
  let done = 0;
  try {
    input.widget.startStage("observe", { batch: { done: 0, total: totalChunks } });
    stageOpened = true;
    for (const chunk of chunks) {
      if (input.signal.aborted) return;
      const recordTool = makeRecordObservationsTool(chunk.allowedIds);
      const stageInput: StageRunInput = {
        systemPrompt: OBSERVER_SYSTEM,
        messages: [{ role: "user", content: chunk.text } as AgentMessage],
        tools: [recordTool.tool],
        model: resolved.model,
        apiKey: resolved.apiKey,
        signal: input.signal,
        reasoning: NO_REASONING,
        maxTurns: NO_MAX_TURNS,
        onEvent: (event) => input.widget.onEvent(event),
        onStageEnd: makeLedgerHook(store, "observe"),
        loopFn: NO_LOOP_OVERRIDE,
      };

      const run = input.runStageFn ?? runStage;
      try {
        await run(stageInput);
      } catch (cause) {
        // an aborted run stops the whole Observer (nothing committed yet).
        if (input.signal.aborted) return;
        log.error("observer stage failed", cause);
        notify(input.ctx, "Observer skipped a chunk (LLM error); continuing", "warning");
        continue;
      } finally {
        done += 1;
        input.widget.setBatch(done, totalChunks);
      }
      allRecords.push(...recordTool.records);
      // an all-bad chunk (model attempted records but every id was foreign) is
      // skipped — no records from it — and the user is warned.
      if (recordTool.attempted > EMPTY_RECORDS && recordTool.records.length === EMPTY_RECORDS) {
        notify(input.ctx, "Observer skipped a chunk: all observations cited invalid source ids", "warning");
      }
    }

    if (input.signal.aborted) return;

    if (allRecords.length === EMPTY_RECORDS) {
      // nothing worth keeping — no delta, frontier unchanged (re-runs next trigger).
      notify(input.ctx, "Observer returned no observations", "warning");
      return;
    }

    // wrap each record in a fresh `new` node at root, in-memory first (create_node
    // + record_observation), tracking the pairs for persistence.
    const pairs: WrappedPair[] = [];
    for (const record of allRecords) {
      const nodeId = `n${graph.nextNodeId}` as NodeId;
      applyCreateNode(graph, {
        id: nodeId,
        summary: "",
        importance: record.importance,
        parentNode: null,
        state: "new",
      });
      const obsId = `o${graph.nextObsId}` as ObsId;
      const firstSource = record.sourceEntryIds
        .map((id) => entryById.get(id))
        .find((entry) => entry !== NO_SOURCE_ENTRY);
      const timestamp = firstSource !== undefined ? toStoredTimestamp(firstSource.timestamp) : nowStoredTimestamp();
      applyRecordObservation(graph, {
        obs: makeObservation({
          id: obsId,
          content: record.content,
          importance: record.importance,
          sourceEntryIds: record.sourceEntryIds,
          timestamp,
          parentNode: nodeId,
        }),
      });
      pairs.push({ nodeId, obsId });
    }

    // persist: the wrapper create_node deltas (one per record), then the single
    // observation entry for the whole run (coversFromId/coversUpToId). The
    // record_observation delta is NOT persisted — observations enter via
    // the observation entry's content index + reconcileLinks on load).
    persistWrappers(store, pairs);
    persistObservationBatch(store, input.unobserved, pairs);
  } finally {
    if (stageOpened) input.widget.endStage();
  }
}

// --- persist helpers -------------------------------------------------------

/** Append one `create_node` graph_delta per wrapper (the structural mutations). */
function persistWrappers(store: StoreContext, pairs: WrappedPair[]): void {
  for (const pair of pairs) {
    const node = getGraphStore().graph.nodes.get(pair.nodeId);
    if (node === undefined) continue; // tolerant: a dissolved wrapper is skipped
    const delta: GraphDelta = {
      type: "create_node",
      id: node.id,
      summary: node.summary,
      importance: node.importance,
      parentNode: null,
      state: node.state,
    };
    appendGraphDelta(store, delta);
  }
}

/** Append the single `memkeeper.observation` delta covering the whole run. */
function persistObservationBatch(store: StoreContext, unobserved: SessionEntry[], pairs: WrappedPair[]): void {
  const graph = getGraphStore().graph;
  const serializedRecords = pairs.map((pair) => {
    const obs = graph.observations.get(pair.obsId);
    if (obs === undefined) {
      throw new Error("observer wrap: observation missing");
    }
    return encodeObservation(obs);
  });
  const tokenCount = pairs.reduce((sum, pair) => {
    const obs = graph.observations.get(pair.obsId);
    return sum + (obs?.contentTokens ?? 0);
  }, 0);
  const coversFromId = unobserved[FIRST]?.id ?? null;
  const coversUpToId = unobserved[unobserved.length - 1].id;
  const entry: ObservationEntry = { coversFromId, coversUpToId, records: serializedRecords, tokenCount };
  appendObservation(store, entry);
}
