// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// The Observer run — HOST PORT of src/observer/run.ts (the pi file
// value-imports lifecycle/notify/runtime-model, so it is not vendored). The
// orchestration is pi's verbatim with the port's engine seams:
//
//   - one shim runStage per chunk (the stage engine owns the loop; the
//     relay enforces abort/timeout/caps/no-progress — the run's
//     stopAfterTurn counterpart rides the noProgressTurns knob);
//   - the `record_observations` tool is a REGISTERED engine tool whose
//     per-chunk body (allowedIds closure) binds at spawn via onSpawn —
//     the validation/ack semantics are pi's execute verbatim;
//   - pi's resolveStageModelOrNotify pre-check has no engine counterpart
//     (spawn-time model resolution is engine-owned): an unavailable model
//     surfaces at spawn as the engine-failure throw — the caller's
//     skip-and-notify path;
//   - pi's per-call dump files become the per-run dump buffer sections
//     (the dump-ring persistence layer consumes it).
//
// Persistence granularity is pi's: ONE observation entry + ONE graph-delta
// batch per completed chunk, persisted immediately after the chunk's run
// succeeds (per-chunk durability). A 0-record chunk persists an EMPTY-VERDICT
// entry covering its range; an aborted chunk persists ZERO records (the abort
// carries no verdict — the range stays unobserved). The live `enabled` switch
// is the caller-injected isEnabled (re-read after every block).

import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { SessionOwlConfig } from "../../core/src/config/schema.js";
import {
  buildChunks,
  type ChunkOptions,
  type RenderedChunk,
  renderStageInputMessages,
} from "../../core/src/format/chunk.js";
import { toStoredTimestamp } from "../../core/src/format/render.js";
import {
  applyCreateNode,
  applyRecordObservation,
  assertGraphStructure,
  type GraphDelta,
} from "../../core/src/graph/mutations.js";
import { log } from "../../core/src/log.js";
import { OBSERVER_SYSTEM } from "../../core/src/prompts/observer.js";
import { makeLedgerHook, persistLedger } from "../../core/src/runtime/ledger-hook.js";
import { encodeObservation, type ObservationEntry } from "../../core/src/store/codecs.js";
import type { StoreContext } from "../../core/src/store/graph-store.js";
import {
  IMPORTANCE_VALUES,
  type Importance,
  makeObservation,
  type NodeId,
  nowStoredTimestamp,
  type ObsId,
} from "../../core/src/types.js";
import { type EngineStageRunInput, runStage, type StageRunResultLike } from "../../shims/pi-agent-core/index.js";
import { THINKING_ROW_LEAD } from "../compaction/thinking.js";
import { type CoreHandle, type Resolver as EntryResolver, reassertCore } from "../core-instances.js";
import {
  appendDump,
  appendHeaderDurable,
  appendRunParts,
  EMPTY_ARCHIVE,
  flushRunDump,
  openStageDump,
  partsFromArchive,
  type StageDumpLocation,
  stageDumpHeader,
} from "../dumps/module.js";
import { errDetail, sayError } from "../log/err-detail.js";
import { recordDumpSection } from "../stage/dumps.js";
import {
  enableStageDumpArchive,
  getStageRun,
  noteAccepted,
  takeStageDump,
  takeStageFatalModelError,
} from "../stage/runs.js";
import { bindAgentTools, STAGE_TOOL_SPECS, unbindAgentTools } from "../stage/tools.js";
import { lookupModelRates } from "../usage/inputs.js";
import {
  isTimeoutClass,
  loggerNotify,
  ModelUnavailableError,
  runsLog,
  type StageCore,
  type StageNotify,
  type StageWidget,
} from "./seams.js";
import { StageTimeoutError } from "./stage-errors.js";

// --- named constants (no bare literals at call sites) ----------------------

export const RECORD_OBS_TOOL = "record_observations";
const OBSERVE_STAGE = "observer" as const;
const WIDGET_STAGE = "observe" as const;
/** Consecutive no-progress steps (no accepted records) allowed before the
 *  relay trips the run's abort (pi's OBSERVER_NO_PROGRESS_TURNS = 5). */
const OBSERVER_NO_PROGRESS_TURNS = 5;
const NO_SOURCE_ENTRY: SessionEntry | undefined = undefined;
const EMPTY_GAP = 0;
const EMPTY_RECORDS = 0;

/** A captured observation (validated; before id/timestamp/wrap assignment). */
export interface RecordObservation {
  readonly summary: string;
  readonly importance: Importance;
  readonly sourceEntryIds: string[];
}

/** At least one Unicode letter or digit anywhere in the summary. */
const SUBSTANTIVE_SUMMARY_TEST = /\p{L}|\p{N}/u;

/** A summary must carry at least one letter or digit to be substantive. */
function isSubstantiveSummary(summary: string): boolean {
  return SUBSTANTIVE_SUMMARY_TEST.test(summary);
}

// --- the per-chunk record tool body ----------------------------------------

/** The port of pi's makeRecordObservationsTool execute body: per-record
 *  validation against the chunk's allowed-id set (a foreign id or a
 *  non-substantive summary rejects THAT record only; a chunk short resolves
 *  through the id map and persists the stored id), the pure-state ack, and
 *  the accepted-count feed the relay's no-progress rule reads. */
function makeRecordExecutor(
  allowedIds: ReadonlySet<string>,
  idMap: ReadonlyMap<string, string> | undefined,
  agentId: string,
  records: RecordObservation[],
  state: { attempted: number },
): (e: Record<string, unknown>) => Promise<{ result: unknown } | { deny: string }> {
  return async (e) => {
    const observations = (e.observations as unknown[] | undefined) ?? [];
    const acceptedIndexes: number[] = [];
    const failures: string[] = [];
    observations.forEach((raw0, index) => {
      const raw = raw0 as { summary?: unknown; importance?: unknown; sourceEntryIds?: unknown };
      state.attempted += 1;
      const summary = typeof raw.summary === "string" ? raw.summary : "";
      // schema failures reject (pi's TypeBox gate rejects before execute;
      // the engine's registered JSON schema is the outer guard — this is the
      // inner one, and it must REJECT, never invent defaults)
      if (typeof raw.importance !== "string" || !IMPORTANCE_VALUES.includes(raw.importance as Importance)) {
        failures.push(`#${index + 1}: importance must be one of crit/high/med/low`);
        return;
      }
      if (
        !Array.isArray(raw.sourceEntryIds) ||
        raw.sourceEntryIds.length === 0 ||
        raw.sourceEntryIds.some((id) => typeof id !== "string")
      ) {
        failures.push(`#${index + 1}: sourceEntryIds must be a non-empty array of entry ids`);
        return;
      }
      const citedIds = raw.sourceEntryIds as string[];
      // accept-both: a chunk short resolves through the map to its stored id;
      // an exact stored id passes through unchanged. The failure names the
      // positional item AND every exact wrong cite.
      const badCites: string[] = [];
      const sourceEntryIds = citedIds.map((srcId) => {
        const real = idMap?.get(srcId) ?? srcId;
        if (!allowedIds.has(real) && !badCites.includes(srcId)) badCites.push(srcId);
        return real;
      });
      if (badCites.length > 0) {
        const kind = badCites.length === 1 ? "id" : "ids";
        failures.push(`#${index + 1}: source ${kind} ${badCites.join(", ")} not in this chunk`);
        return;
      }
      if (!isSubstantiveSummary(summary)) {
        failures.push(`#${index + 1}: non-substantive summary`);
        return;
      }
      records.push({
        summary,
        importance: raw.importance as Importance,
        sourceEntryIds: [...sourceEntryIds],
      });
      acceptedIndexes.push(index + 1);
    });
    const accepted = acceptedIndexes.length;
    noteAccepted(agentId, accepted);
    const lines: string[] = [];
    if (failures.length === EMPTY_RECORDS) {
      lines.push("accepted: all");
    } else {
      if (accepted > EMPTY_RECORDS) lines.push(`accepted: #${acceptedIndexes.join(", #")}`);
      lines.push("rejected:");
      lines.push(...failures);
    }
    // a STRING result — the engine's default output shape (string | blocks |
    // undefined) rejects OBJECT answers ("does not match its output shape").
    // An ALL-rejected batch answers as a DENY instead: the engine delivers
    // deny text to the model as an ERROR result, never a success-shaped ack;
    // the partial-reject path keeps the mixed ack
    const ack = lines.join("\n");
    const allRejected = accepted === EMPTY_RECORDS && failures.length > EMPTY_RECORDS;
    return allRejected ? { deny: ack } : { result: ack };
  };
}

// --- run input -------------------------------------------------------------

/** Input to `runObserver`. The run honors `signal` only — the caller owns the
 *  run-lock (the background trigger releases in its IIFE; compaction holds).
 *  `core` is the conversation's handle (getCore resolved BEFORE the lock). */
export interface ObserverRunInput {
  core: StageCore;
  store: StoreContext;
  settings: SessionOwlConfig;
  /** The unobserved renderable entries (the gap to cover this run). */
  unobserved: SessionEntry[];
  /** Abort signal (the caller's per-run controller). */
  signal: AbortSignal;
  /** The widget controller (opens the observe stage + drives the batch). */
  widget: StageWidget;
  /** Notify adapter (default: the logger-only stub). */
  notify?: StageNotify;
  /** The live master switch (default: enabled). Re-read after every block. */
  isEnabled?: () => boolean;
  /** Optional mid-catch-up Builder trigger: after each chunk's persist, the
   *  Observer awaits this; if it returns true the Builder ran and the observe
   *  stage re-asserts before the next chunk. */
  maybeBuild?: () => Promise<boolean>;
  /** Optional per-persist ledger flush (durability seam: the wiring passes
   *  the conversation's ledger flush — each completed chunk's records reach
   *  disk at persist time, the crash-window contract; absent in tests that
   *  assert buffering itself). */
  flushLedger?: () => Promise<void>;
  /** Test seam — fake stage runner override. */
  runStageFn?: (input: EngineStageRunInput) => Promise<StageRunResultLike>;
  /** The dump seam (null/undefined = no dump — debugDumpLimit 0 or
   *  unwired).  */
  dumps?: StageDumpLocation | null;
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
 * Run the Observer over the unobserved gap: chunk it, run one engine stage per
 * chunk with the `record_observations` tool, validate each record against its
 * chunk's allowed-id set, wrap valid records in `new` nodes, and persist per
 * chunk (an aborted chunk persists nothing for itself). Honors
 * `signal`; a timeout-class abort throws StageTimeoutError; an engine failure
 * propagates (the caller skips + notifies).
 */
/** The lead-ins of owl's own synthetic transcript rows (the compaction
 *  summary header and the attributed-reasoning row) — rows whose content is
 *  already-observed material by construction. */
const OWL_SYNTHETIC_LEADS: readonly string[] = ["# Memory", THINKING_ROW_LEAD];

/** True when the entry is a REAL conversation row the observer may cite
 *  (owl's own synthetic rows are skipped — never re-observed). */
export function notOwnSyntheticRow(entry: SessionEntry): boolean {
  if (entry.type !== "message") return true; // other kinds are not the synthetic rows
  const message = (entry as { message?: { content?: unknown } }).message;
  const content = message?.content;
  let text: string | null = null;
  if (typeof content === "string") text = content;
  else if (Array.isArray(content)) {
    for (const block of content) {
      if (block !== null && typeof block === "object" && (block as { type?: unknown }).type === "text") {
        const t = (block as { text?: unknown }).text;
        if (typeof t === "string") {
          text = t;
          break;
        }
      }
    }
  }
  if (text === null) return true;
  for (const lead of OWL_SYNTHETIC_LEADS) {
    if (text.startsWith(lead)) return false;
  }
  return true;
}

export async function runObserver(input: ObserverRunInput): Promise<void> {
  const notify = input.notify ?? loggerNotify(console.error);
  const isEnabled = input.isEnabled ?? (() => true);
  if (input.signal.aborted) return;
  if (input.unobserved.length === EMPTY_GAP) return;

  const store = input.store;
  const core = input.core as CoreHandle;
  const model = input.settings.observerModel ?? input.settings.defaultModel;

  const chunkOptions: ChunkOptions = {
    tokenThreshold: input.settings.observerThresholdTokens,
    toolBlockCapTokens: input.settings.observerToolBlockCapTokens,
    includeThinking: input.settings.observerIncludeThinking,
    includeEntryId: true,
    // the platform's transcript ids are 36-char uuids — the chunk renders
    // sequential shorts and the executor resolves them back to stored ids
    shortEntryIds: true,
  };
  // owl's OWN synthetic rows never enter a chunk: the compaction summary is
  // the graph's own render and the attributed-reasoning row copies pre-cut
  // thinking that was observed before the compaction — both are by
  // construction already-observed material (their fixed lead-ins are the
  // discriminator; owl authored both texts).
  const observable = input.unobserved.filter(notOwnSyntheticRow);
  const chunks = buildChunks(observable, chunkOptions);

  const entryById = new Map<string, SessionEntry>();
  for (const entry of observable) entryById.set(entry.id, entry);

  // A local resolver over the in-hand unobserved entries computes each
  // record's verbatim-source size hint without a store round-trip.
  const localResolver: EntryResolver = (ids) =>
    ids.map((id) => entryById.get(id)).filter((entry): entry is SessionEntry => entry !== undefined);

  const totalChunks = chunks.length;
  let stageOpened = false;
  let done = 0;
  let totalRecords = 0;
  // unit-commit: one durable release every CHUNK_FLUSH_EVERY completed chunk
  // checkpoints (N counts CHUNKS, not extracted records — a kill mid-run
  // loses at most that unit) + a boundary drain when the run ends with a
  // partial unit pending
  const CHUNK_FLUSH_EVERY = 5;
  let chunksSinceFlush = 0;
  const unitFlush = async (): Promise<void> => {
    chunksSinceFlush += 1;
    if (chunksSinceFlush < CHUNK_FLUSH_EVERY) return;
    chunksSinceFlush = 0;
    if (input.flushLedger !== undefined) await input.flushLedger();
  };
  const ledger = makeLedgerHook(WIDGET_STAGE);
  const dumpHandle =
    input.dumps !== undefined && input.dumps !== null && input.settings.debugDumpLimit > 0
      ? openStageDump(OBSERVE_STAGE, input.settings.debugDumpLimit, { ...input.dumps, now: Date.now() })
      : null;
  enableStageDumpArchive(OBSERVE_STAGE, dumpHandle !== null);
  let headerWritten = false;
  try {
    input.widget.startStage(WIDGET_STAGE, { batch: { done: 0, total: totalChunks } });
    stageOpened = true;
    for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex += 1) {
      const chunk = chunks[chunkIndex];
      if (input.signal.aborted) return;
      // live master switch: disabling mid-run stops at the next chunk
      // boundary — completed chunks are durable, the tail re-observes later.
      if (!isEnabled()) {
        runsLog(`observer: stopping: session-owl disabled (after ${done}/${totalChunks} chunks)`);
        return;
      }

      const records: RecordObservation[] = [];
      const toolState = { attempted: 0 };
      let boundAgent: string | null = null;

      const stageInput: EngineStageRunInput = {
        stage: OBSERVE_STAGE,
        systemPrompt: OBSERVER_SYSTEM,
        messages: [{ role: "user", content: chunk.text }],
        model,
        signal: input.signal,
        maxTokens: input.settings.observerMaxTokens,
        timeoutMs: input.settings.llmCallTimeoutMs,
        noProgressTurns: OBSERVER_NO_PROGRESS_TURNS,
        // the widget's model-call feed: the engine's stage events stream
        // through this sink into the tracker bridge (the during-run band
        // line renders from these — without it the line stays null)
        onEvent: (event) => input.widget.onEvent(event as never),
        onStageEnd: ledger.onStageEnd as unknown as EngineStageRunInput["onStageEnd"],
        modelRates: lookupModelRates,
        dumpPath: null,
        // bind the chunk's record body + forensics at spawn: the executor
        // layer serves only this agent for this chunk
        onSpawn: (agentId) => {
          boundAgent = agentId;
          const recordBody = makeRecordExecutor(chunk.allowedIds, chunk.idMap, agentId, records, toolState);
          bindAgentTools(agentId, {
            [RECORD_OBS_TOOL]: async (callEvent: Record<string, unknown>) => {
              const answer = await recordBody(callEvent);
              // persisted evidence: which array the executor filled, next to
              // what the chunk end will see. An ALL-rejected batch answers
              // as a DENY (no result field) — stringify null, never undefined
              try {
                log.info(
                  `observer record execute: agent=${agentId} records-len=${records.length} chunk=${chunkIndex + 1}/${totalChunks} answer=${JSON.stringify((answer as { result?: unknown }).result ?? null).slice(0, 60)}`,
                );
              } catch (err) {
                // diagnostics never throw — but the logger itself failing is
                // still said: sayError retries both transports (console only
                // when both refuse), message + stack
                try {
                  sayError(`session-owl: diagnostics failed: ${errDetail(err)}`);
                } catch {
                  // nothing exists to say it with
                }
              }
              return answer;
            },
          });
          const run = getStageRun(agentId);
          if (run !== undefined) {
            recordDumpSection(
              run,
              `<chunk i="${chunkIndex + 1}/${totalChunks}">\n<allowed>\n${[...(chunk.idMap?.keys() ?? chunk.allowedIds)].join("\n")}\n</allowed>\n`,
            );
          }
        },
      };

      const run = input.runStageFn ?? runStage;
      let timedOut = false;
      let result: StageRunResultLike;
      try {
        if (dumpHandle !== null && input.dumps !== undefined && input.dumps !== null) {
          // the header once, then EVERY chunk's input PRE-CALL (pi's
          // durability: a call that dies still leaves its input record)
          if (!headerWritten) {
            headerWritten = true;
            const spec = STAGE_TOOL_SPECS.find((s) => s.name === RECORD_OBS_TOOL);
            const placed = await appendHeaderDurable(
              input.dumps.fs,
              dumpHandle,
              stageDumpHeader(
                OBSERVE_STAGE,
                dumpHandle.startedIso,
                OBSERVER_SYSTEM,
                [
                  {
                    name: RECORD_OBS_TOOL,
                    description: spec?.description,
                    parameters: spec?.inputSchema ?? { type: "object" },
                  },
                ],
                { session: dumpHandle.session, agent: dumpHandle.agent },
              ),
            );
            if (!placed) runsLog("observer dump header not placed after retry");
          }
          await appendDump(
            input.dumps.fs,
            dumpHandle,
            `<input>\n${renderStageInputMessages(
              stageInput.messages as unknown as Parameters<typeof renderStageInputMessages>[0],
            )}\n</input>\n`,
          );
        }
        result = await run(stageInput);
        timedOut = result.timedOut;
      } catch (cause) {
        // Propagate (timeout / engine failure / server down) so the caller
        // cancels + surfaces. An abort is not an error — return cleanly.
        if (input.signal.aborted) return;
        throw cause;
      } finally {
        unbindAgentTools(boundAgent ?? "");
        done += 1;
        input.widget.setBatch(done, totalChunks);
      }
      // a per-LLM-call timeout or a relay timeout-class abort (stall,
      // max-turns runaway) — pi's StageTimeoutError path.
      if (timedOut || isTimeoutClass(result, input.signal)) {
        throw new StageTimeoutError("Observer", input.settings.llmCallTimeoutMs);
      }
      // the model side failed mid-run (engine api_error row): not a verdict,
      // no coverage — the takeover skips and the session stays uncompacted
      const fatalModel = takeStageFatalModelError(OBSERVE_STAGE);
      if (fatalModel !== null) throw new ModelUnavailableError(fatalModel);
      // the chunk's rows/sections drain NOW (per-chunk durability — a crash
      // in a LATER chunk keeps this one's dump content)
      if (dumpHandle !== null && input.dumps !== undefined && input.dumps !== null) {
        try {
          await appendRunParts(
            input.dumps.fs,
            dumpHandle,
            partsFromArchive(takeStageDump(OBSERVE_STAGE) ?? EMPTY_ARCHIVE),
          );
        } catch (drainErr) {
          runsLog("observer dump drain failed", drainErr);
        }
      }
      // this chunk completed → persist IMMEDIATELY (per-chunk durability).
      try {
        log.info(`observer persist decide: chunk=${chunkIndex + 1}/${totalChunks} records-len=${records.length}`);
      } catch (err) {
        // diagnostics never throw — but the logger itself failing is still
        // said: sayError retries both transports, console only when both refuse
        try {
          sayError(`session-owl: diagnostics failed: ${errDetail(err)}`);
        } catch {
          // nothing exists to say it with
        }
      }
      if (records.length > EMPTY_RECORDS) {
        // The LLM await above is a cross-key window: a parallel
        // conversation's event swaps the process-global core mid-run, and the
        // mint/apply below reads it LIVE — re-pin this run's key or wrappers
        // mint foreign ids and land in the wrong graph.
        await reassertCore(core.key);
        totalRecords += records.length;
        persistChunk(core, store, chunk, records, entryById, localResolver);
        await unitFlush(); // a unit checkpoint (the drain gathers every 5)
        input.widget.invalidateRoots();
        // Mid-catch-up Builder: fold the accumulated `new` roots when the
        // trigger says so; the stage re-asserts after a built fold.
        if (input.maybeBuild !== undefined) {
          const built = await input.maybeBuild();
          if (input.signal.aborted) return;
          if (built) input.widget.startStage(WIDGET_STAGE, { batch: { done, total: totalChunks } });
        }
      } else {
        // 0 records — the model's verdict, or the call was aborted mid-flight
        // (an aborted call is NOT a verdict: the range stays unobserved).
        if (input.signal.aborted) return;
        core.store.appendObservation(store, {
          coversFromId: chunk.firstEntryId,
          coversUpToId: chunk.lastEntryId,
          records: [],
          tokenCount: EMPTY_RECORDS,
        });
        await unitFlush(); // the skip marker rides the same unit checkpoints
      }
      // an all-bad chunk (every record cited a foreign id) — the user is warned.
      if (toolState.attempted > EMPTY_RECORDS && records.length === EMPTY_RECORDS) {
        notify("Observer skipped a chunk: all observations cited invalid source ids", "warning");
      }
      // persist the cumulative usage ledger PER CHUNK so an interrupted run
      // keeps the tally for every completed chunk.
      if (ledger.hasUsage()) persistLedger(store);
    }

    if (input.signal.aborted) return;

    if (totalRecords === EMPTY_RECORDS) {
      notify("Observer returned no observations", "warning");
    }
  } catch (cause) {
    // Applied chunks are already durable; the error propagates to the caller
    // (the launch wrapper skips + notifies; compaction cancels + surfaces).
    runsLog("observer run failed", cause);
    throw cause;
  } finally {
    // boundary: drain a partial unit (records persisted since the last
    // checkpoint — also covers the abort/error exit)
    if (chunksSinceFlush > 0 && input.flushLedger !== undefined) {
      chunksSinceFlush = 0;
      try {
        await input.flushLedger();
      } catch (flushErr) {
        runsLog("observer unit flush failed", flushErr);
      }
    }
    if (stageOpened) input.widget.endStage();
    if (dumpHandle !== null && headerWritten && input.dumps !== undefined && input.dumps !== null) {
      try {
        // the final drain + footer (header, each chunk's input, and earlier
        // chunks' rows landed per-chunk)
        await flushRunDump(input.dumps.fs, dumpHandle, partsFromArchive(takeStageDump(OBSERVE_STAGE) ?? EMPTY_ARCHIVE));
      } catch (dumpErr) {
        runsLog("observer dump flush failed", dumpErr);
      }
    }
  }
}

// --- persist helpers -------------------------------------------------------

/** Wrap a chunk's records in fresh `new` root nodes + persist immediately: one
 *  graph_delta batch (wrapper create_node + record_observation pairs in live
 *  order) and one observation entry spanning the chunk's range. The chunk is
 *  prepared WHOLE before anything applies, so a mid-prepare throw leaves the
 *  graph exactly as it was. */
function persistChunk(
  core: CoreHandle,
  store: StoreContext,
  chunk: RenderedChunk,
  records: readonly RecordObservation[],
  entryById: Map<string, SessionEntry>,
  resolver: EntryResolver,
): void {
  const graph = core.store.getGraphStore().graph;
  // trace seam: which conversation's graph object the wrappers mint into
  runsLog(
    `observer persist: key=${core.key} trace#${String((graph as unknown as { owlTrace?: number }).owlTrace ?? "?")} ` +
      `nodes=${graph.nodes.size} nextNode=${graph.nextNodeId} nextObs=${graph.nextObsId} records=${records.length}`,
  );
  assertGraphStructure(graph, "persist_chunk");
  const pairs: WrappedPair[] = [];
  let nodeSeq = graph.nextNodeId;
  let obsSeq = graph.nextObsId;
  for (const record of records) {
    const nodeId = `n${nodeSeq}` as NodeId;
    nodeSeq += 1;
    const obsId = `o${obsSeq}` as ObsId;
    obsSeq += 1;
    const firstSource = record.sourceEntryIds.map((id) => entryById.get(id)).find((entry) => entry !== NO_SOURCE_ENTRY);
    const timestamp =
      firstSource !== undefined ? toStoredTimestamp(firstSource.timestamp as unknown as string) : nowStoredTimestamp();
    const counts = core.details.computeDetailsAndCache(obsId, record.sourceEntryIds, resolver);
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
  core.store.appendGraphDeltaBatch(
    store,
    pairs.flatMap((pair) => [pair.delta, { type: "record_observation", obs: { ...pair.obs } } as const]),
  );
  let tokenCount = 0;
  const serializedRecords = pairs.map((pair) => {
    tokenCount += pair.obs.detailsTokens ?? 0;
    return encodeObservation(pair.obs);
  });
  const entry: ObservationEntry = {
    coversFromId: chunk.firstEntryId,
    coversUpToId: chunk.lastEntryId,
    records: serializedRecords,
    tokenCount,
  };
  core.store.appendObservation(store, entry);
}
