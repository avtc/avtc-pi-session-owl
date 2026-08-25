// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// The Observer run: an in-process agentLoop per chunk that calls a
// `record_observations` tool to capture observations, then mechanically wraps
// each captured observation in a fresh `new` node at the root and persists the
// batch. The Observer is a non-writer (it only appends observation +
// new-wrapper deltas; it never restructures — that's the Builder).
//
// Persistence granularity: ONE `memkeeper.observation` entry PER CHUNK
// (coversFromId = chunk's first entry, coversUpToId = chunk's last) plus ONE
// `memkeeper.graph_delta` batch per record-bearing chunk holding the chunk's ops
// in live order ([create_node, record_observation] per wrapper), persisted
// immediately after each chunk's agentLoop succeeds (per-chunk durability).
// A 0-record chunk persists an EMPTY-VERDICT observation entry (records: [])
// covering its range: every completed chunk advances the frontier, so a
// zero-observation range is NEVER re-observed automatically —
// /mk:reobserve-0-obs-chunks is the only retry path for it.
// An abort loses only the in-flight chunk — completed chunks are durable and the
// frontier has already advanced past them, so a re-run skips them (idempotent by
// coverage range). Reverses the earlier accumulate-then-append (one delta per
// run, abort = lose everything), which lost all work on any run longer than the
// abort window.

import type { AgentMessage, AgentTool } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { getMemkeeperSettings, type MemkeeperConfig } from "../config/schema.js";
import { appendDump, DEFAULT_DUMP_BASE, DUMP_FOOTER, openStageDump, stageDumpHeader } from "../debug-dump.js";
import { buildChunks, type ChunkOptions, type RenderedChunk } from "../format/chunk.js";
import { computeDetailsAndCache, type EntryResolver } from "../format/details.js";
import { toStoredTimestamp } from "../format/render.js";
import { formatTokens } from "../format/tokens.js";
import { applyCreateNode, applyRecordObservation, assertGraphStructure, type GraphDelta } from "../graph/mutations.js";
import { toStoreContext } from "../lifecycle.js";
import { log } from "../log.js";
import { notify } from "../notify.js";
import { OBSERVER_SYSTEM } from "../prompts/observer.js";
import {
  makeNoProgressTurnStop,
  NO_LOOP_OVERRIDE,
  NO_TURN_LIMIT,
  runStage,
  type StageRunInput,
  type StageRunResult,
  StageTimeoutError,
} from "../runtime/agent-loop.js";
import { makeLedgerHook, persistLedger } from "../runtime/ledger-hook.js";
import { resolveStageModelOrNotify, resolveStageReasoning } from "../runtime/model.js";
import { getStageAffinityId } from "../runtime/session-affinity.js";
import { ImportanceSchema } from "../schema.js";
import { encodeObservation, type ObservationEntry } from "../store/codecs.js";
import { appendGraphDeltaBatch, appendObservation, getGraphStore, type StoreContext } from "../store/graph-store.js";
import {
  estimateContentTokens,
  type Importance,
  makeObservation,
  type NodeId,
  nowStoredTimestamp,
  type ObsId,
} from "../types.js";
import type { WidgetController } from "../widget/tracker.js";

// --- named constants (no bare literals at call sites) ----------------------

export const RECORD_OBS_TOOL = "record_observations";
const OBSERVE_STAGE = "observe" as const;
/** Consecutive no-progress turns (no accepted records; streamed text does NOT
 *  count — a model pairing chatter with failing tool calls must stay bounded)
 *  allowed before a chunk's agentLoop is stopped. Normal chunks take 1–2 turns. */
const OBSERVER_NO_PROGRESS_TURNS = 3;
/** Log label for the Observer's no-progress stop warn line. */
const OBSERVER_STOP_LABEL = "observer";
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

/** A summary must carry at least one letter or digit to be substantive. A
 *  degenerate model response (thinking-only garbage such as `!!!!!!`) that
 *  happens to land in a valid tool call must not be written into the graph as
 *  an observation — punctuation/symbol-only summaries are rejected per-record
 *  (same mechanism as a foreign source id). */
function isSubstantiveSummary(summary: string): boolean {
  return SUBSTANTIVE_SUMMARY_TEST.test(summary);
}

/** At least one Unicode letter or digit anywhere in the summary. */
const SUBSTANTIVE_SUMMARY_TEST = /\p{L}|\p{N}/u;

// --- per-call record forensics (debug logging) ------------------------------

/** Cap for one record summary inside the per-call debug dump. */
const RECORD_LOG_CAP = 200;
/** How many of a call's records the debug dump lists (the rest fold into +N). */
const RECORD_LOG_MAX = 10;
const ELLIPSIS = "…";

/** Whitespace-collapse + cap one summary for the debug dump (the logger
 *  sanitizes the assembled line itself; this keeps each record readable). */
function capForRecordLog(summary: string): string {
  const oneLine = summary.replace(/\s+/g, " ").trim();
  if (oneLine.length <= RECORD_LOG_CAP) return oneLine;
  return `${oneLine.slice(0, RECORD_LOG_CAP - ELLIPSIS.length)}${ELLIPSIS}`;
}

/** The numbered per-call record dump: `1. … 2. … (+K more)` — the record
 *  content the accepted= counts cannot show. A model spinning on one chunk
 *  (re-recording every turn) is only distinguishable from real work by WHAT it
 *  records, so successful calls dump their summaries (up to RECORD_LOG_MAX). */
function dumpRecordsForLog(summaries: readonly string[]): string {
  const shown = summaries.slice(0, RECORD_LOG_MAX).map((s, i) => `${i + 1}. ${capForRecordLog(s)}`);
  const more = summaries.length - shown.length;
  return `${shown.join(" ")}${more > 0 ? ` (+${more} more)` : ""}`;
}

/**
 * Build a fresh `record_observations` tool bound to one chunk's allowed-id set.
 * Each record is validated per-observation: every cited `sourceEntryId` must be
 * in `allowedIds` (a foreign id rejects that one record only, not the whole
 * batch) and the summary must be substantive. Valid records accumulate on
 * `records`.
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
      const acceptedIndexes: number[] = [];
      const failures: string[] = [];
      const callSummaries: string[] = [];
      params.observations.forEach((raw, index) => {
        attempted += 1;
        // per-record validation — a bad record drops alone, the batch continues
        if (raw.sourceEntryIds.some((srcId: string) => !allowedIds.has(srcId))) {
          failures.push(`#${index + 1}: source id not in this chunk`);
          return;
        }
        if (!isSubstantiveSummary(raw.summary)) {
          failures.push(`#${index + 1}: non-substantive summary`);
          return;
        }
        records.push({
          summary: raw.summary,
          importance: raw.importance as Importance,
          sourceEntryIds: [...raw.sourceEntryIds],
        });
        acceptedIndexes.push(index + 1);
        callSummaries.push(raw.summary);
      });
      const accepted = acceptedIndexes.length;
      const rejected = failures.length;
      // a pure state report, API-response style — no next-step directives here
      // (the protocol lives in the system prompt): "all" for the clean common
      // case, otherwise the #positions that landed + one line per rejected item,
      // model-indexed so it can diff against its own submitted batch
      const lines: string[] = [];
      if (failures.length === EMPTY_RECORDS) {
        lines.push("accepted: all");
      } else {
        if (accepted > EMPTY_RECORDS) lines.push(`accepted: #${acceptedIndexes.join(", #")}`);
        lines.push("rejected:");
        lines.push(...failures);
      }
      const ack = lines.join("\n");
      log.debug(`observer: record_observations accepted=${accepted} rejected=${rejected}`);
      if (accepted > EMPTY_RECORDS) {
        log.debug(`observer: recorded ${accepted} — ${dumpRecordsForLog(callSummaries)}`);
      }
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

/** A wrapper node paired with the observation it wraps, plus the prepared
 *  create_node delta (persistence pairs — built whole in the prepare phase,
 *  applied + persisted only when the chunk fully prepares). */
interface WrappedPair {
  readonly nodeId: NodeId;
  readonly obsId: ObsId;
  readonly obs: ReturnType<typeof makeObservation>;
  readonly delta: Extract<GraphDelta, { type: "create_node" }>;
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
  // Stage dump (debugDumpLimit): opened before the loop so the finally can
  // close it; the file itself appears only when the header is written (a
  // zero-chunk run or a startStage throw leaves nothing behind). The header
  // carries the record tool's static schema (identical for every chunk —
  // allowedIds is closure state the model never sees); each <chunk> wrapper
  // records its allowed ids for forensics (why records were accepted/rejected).
  const dumpPath = openStageDump(OBSERVE_STAGE, input.settings.debugDumpLimit, DEFAULT_DUMP_BASE);
  let dumpHeaderWritten = false;
  try {
    input.widget.startStage(OBSERVE_STAGE, { batch: { done: 0, total: totalChunks } });
    stageOpened = true;
    if (dumpPath !== null && chunks.length > 0) {
      appendDump(
        dumpPath,
        stageDumpHeader(OBSERVE_STAGE, new Date().toISOString(), OBSERVER_SYSTEM, [
          makeRecordObservationsTool(chunks[0].allowedIds).tool,
        ]),
      );
      dumpHeaderWritten = true;
    }
    for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex += 1) {
      const chunk = chunks[chunkIndex];
      if (input.signal.aborted) return;
      // live master switch: the run re-reads `enabled` after EVERY block, so
      // disabling mid-run stops it at the next block boundary — completed
      // chunks are durable (their coversUpToId advanced the frontier), the
      // uncovered tail re-observes on a later run.
      if (!getMemkeeperSettings().enabled) {
        log.info(`observer: stopping: memkeeper disabled (after ${done}/${totalChunks} chunks)`);
        return;
      }
      const recordTool = makeRecordObservationsTool(chunk.allowedIds);
      // chunk forensics: brackets the chunk's record_observations calls in the
      // log (coverage range + rendered size — the sanity denominator for how
      // many records a chunk can plausibly yield).
      log.debug(
        `observer: chunk ${chunkIndex + 1}/${totalChunks} covers ${chunk.firstEntryId}..${chunk.lastEntryId} ${formatTokens(estimateContentTokens(chunk.text))} tokens`,
      );
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
        // Degenerate-spiral bound: stop the chunk after 3 consecutive turns
        // that accepted no records (streamed text does NOT reset the streak —
        // a model pairing chatter with a failing tool call every turn would
        // otherwise spin forever under NO_TURN_LIMIT; each call also completes
        // well under the per-call timeout, so nothing else bounds it).
        stopAfterTurn: makeNoProgressTurnStop(
          OBSERVER_NO_PROGRESS_TURNS,
          () => recordTool.records.length,
          OBSERVER_STOP_LABEL,
        ),
        maxTokens: input.settings.observerMaxTokens,
        timeoutMs: input.settings.llmCallTimeoutMs,
        onEvent: (event) => input.widget.onEvent(event),
        onStageEnd: ledger.onStageEnd,
        loopFn: NO_LOOP_OVERRIDE,
        // Per-stage affinity so a session's Observer chunks route consistently
        // and share a cache namespace (null outside an active session).
        sessionId: getStageAffinityId(OBSERVE_STAGE) ?? undefined,
        dumpPath,
      };

      const run = input.runStageFn ?? runStage;
      let timedOut = false;
      // per-chunk wrapper: the allowed source ids the tool enforces for THIS
      // chunk (the model infers them from the chunk text; rejections trace here)
      appendDump(
        dumpPath,
        `<chunk i="${chunkIndex + 1}/${totalChunks}">\n<allowed>\n${[...chunk.allowedIds].join("\n")}\n</allowed>\n`,
      );
      try {
        const result = await run(stageInput);
        timedOut = result.timedOut;
      } catch (cause) {
        // Propagate (timeout / LLM failure / server down) so the compaction hook
        // cancels compaction + surfaces a visible error. An abort (compaction
        // cancelled) is not an error — return cleanly. Prior chunks are already
        // durable (per-chunk persistence).
        if (input.signal.aborted) return;
        throw cause;
      } finally {
        done += 1;
        input.widget.setBatch(done, totalChunks);
        appendDump(dumpPath, "</chunk>\n");
      }
      // a per-LLM-call timeout — a stage-stopping error: THROW so the compaction
      // hook cancels compaction + surfaces a visible error.
      if (timedOut) {
        throw new StageTimeoutError("Observer", input.settings.llmCallTimeoutMs);
      }
      // this chunk succeeded → persist IMMEDIATELY (per-chunk durability: an
      // abort loses only the in-flight chunk; the frontier has already advanced
      // past every prior chunk). A record-bearing chunk wraps + persists its
      // records; a 0-record chunk persists an EMPTY-VERDICT entry covering its
      // range — a completed chunk is never re-observed automatically (neither
      // mid-run jumps nor the trailing treadmill); /mk:reobserve-0-obs-chunks
      // is the only retry path for zero-observation ranges.
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
      } else {
        // 0 records (model verdict, all-rejected, or a no-progress-stopped
        // degenerate turn): persist the empty verdict so the frontier advances
        // and no automatic trigger ever retries this range.
        appendObservation(store, {
          coversFromId: chunk.firstEntryId,
          coversUpToId: chunk.lastEntryId,
          records: [],
          tokenCount: EMPTY_RECORDS,
        });
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
      // every chunk yielded nothing worth keeping — each persisted an empty
      // verdict covering itself (no automatic retry; the repair command is the
      // only re-observe path for them).
      notify(input.ctx, "Observer returned no observations", "warning");
    }
  } catch (cause) {
    // Propagate (a persist-phase throw, e.g. a wrapper missing its node) so the
    // compaction hook cancels + surfaces it. Per-chunk LLM failures propagate
    // from the inline catch above. Applied chunks are already durable.
    log.error("observer run failed", cause);
    throw cause;
  } finally {
    if (dumpHeaderWritten) appendDump(dumpPath, DUMP_FOOTER);
    if (stageOpened) input.widget.endStage();
  }
}

// --- persist helpers -------------------------------------------------------

/** Wrap a chunk's records in fresh `new` root nodes + persist immediately: one
 *  `memkeeper.graph_delta` entry (the wrapper create_node ops) and one
 *  `memkeeper.observation` entry spanning this chunk's coversFromId/coversUpToId
 *  range. The frontier advances to the chunk's lastEntryId via appendObservation
 *  — so an abort loses only the in-flight chunk; completed chunks are durable
 *  and skipped on re-run. The chunk is prepared WHOLE before anything applies
 *  (ids minted, details counted, observations built), so a mid-prepare throw
 *  leaves the graph exactly as it was — memory never runs ahead of the log. */
function persistChunk(
  store: StoreContext,
  chunk: RenderedChunk,
  records: readonly RecordObservation[],
  entryById: Map<string, SessionEntry>,
  resolver: EntryResolver,
): void {
  const graph = getGraphStore().graph;
  // one structural gate per chunk: an invalid graph rejects the whole chunk
  // BEFORE anything applies (no partial chunk, no empty-wrapper cruft)
  assertGraphStructure(graph, "persist_chunk");
  // prepare: build every wrapper delta + observation as pure data. Ids are
  // minted from local counters so nothing in the graph advances until apply.
  const pairs: WrappedPair[] = [];
  let nodeSeq = graph.nextNodeId;
  let obsSeq = graph.nextObsId;
  for (const record of records) {
    const nodeId = `n${nodeSeq}` as NodeId;
    nodeSeq += 1;
    const obsId = `o${obsSeq}` as ObsId;
    obsSeq += 1;
    const firstSource = record.sourceEntryIds.map((id) => entryById.get(id)).find((entry) => entry !== NO_SOURCE_ENTRY);
    const timestamp = firstSource !== undefined ? toStoredTimestamp(firstSource.timestamp) : nowStoredTimestamp();
    const counts = computeDetailsAndCache(obsId, record.sourceEntryIds, resolver);
    // the wrapper carries the observation's one-line summary at birth so every
    // node always reads with a summary; the Builder refines it later.
    const delta = {
      type: "create_node",
      id: nodeId,
      summary: record.summary,
      importance: record.importance,
      parentNode: null,
      state: "new",
    } as const;
    pairs.push({
      nodeId,
      obsId,
      delta,
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
  }
  // apply: the prepared wrappers + observations land in the graph
  for (const pair of pairs) {
    applyCreateNode(graph, {
      id: pair.delta.id,
      summary: pair.delta.summary,
      importance: pair.delta.importance,
      parentNode: null,
      state: "new",
    });
    applyRecordObservation(graph, { obs: pair.obs });
  }
  // wrappers + records: one graph_delta entry holding this chunk's ops in live
  // order — each create_node immediately followed by its record_observation.
  // Replay re-executes the exact live sequence, so later Builder merges/mvs
  // relocate the records as they did live (wrapper membership is part of the
  // log, not inferred from capture-time pointers). The record is embedded as a
  // SNAPSHOT copy — the live object's parentNode mutates on every later
  // mv/merge, and the delta must freeze the value at append time.
  appendGraphDeltaBatch(
    store,
    pairs.flatMap((pair) => [pair.delta, { type: "record_observation", obs: { ...pair.obs } } as const]),
  );
  // observations: one observation entry covering THIS chunk's range
  // (coversUpToId advances the frontier; a later record-bearing chunk's range
  // subsumes any intervening 0-record chunks).
  let tokenCount = 0;
  const serializedRecords = pairs.map((pair) => {
    tokenCount += pair.obs.detailsTokens ?? 0; // verbatim source size processed this batch
    return encodeObservation(pair.obs);
  });
  const entry: ObservationEntry = {
    coversFromId: chunk.firstEntryId,
    coversUpToId: chunk.lastEntryId,
    records: serializedRecords,
    tokenCount,
  };
  appendObservation(store, entry);
}
