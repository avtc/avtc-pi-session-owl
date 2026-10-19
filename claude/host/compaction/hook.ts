// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import type { SessionEntry } from "@earendil-works/pi-coding-agent";
// The compaction takeover — the session.compact gate, pi's hook ported to
// the Claude event shape. Gate order (fixed): live pause predicate (conflict
// self-restraint — hooks pass through) → enabled → the precompute branch →
// cut computation at gate entry → acquireForCompaction → ensure-ready phases
// (Observer catch-up over the frontier→cut gap with mid-catch-up Builder
// folding, the Builder with its fast-path intact, the Selector when
// selected-root; the live enabled switch re-checked between phases — a
// disable leaves with a PASS so the engine's own compaction runs) → render →
// snapshot persist BEFORE the answer → the answer. Failure anywhere ⇒ {skip}
// + notify: the conversation stays exactly as it was and the next trigger
// retries. Never throws; the lock releases in the finally.
//
// Port notes: the engine's compact input carries no abort signal (pi's hook
// links one — here the compaction's own controller from the keyed lock is
// the only signal). The kept tail is computed over the event's own messages
// (the engine's cut exists only for its own compactions); the entry-space
// cut aligns by message-bearing branch position, falling back to the whole
// branch when the views disagree (pi's cut-not-found rule).
import type { SessionCompacted, SessionCompactSkipped, SessionMessage } from "claude-code";
import { renderSummary } from "../../core/src/compaction/summary.js";
import { extractTouchedFiles } from "../../core/src/compaction/touched-files.js";
import { ledgerToStageUsages } from "../../core/src/compaction/usage-map.js";
import type { SessionOwlConfig } from "../../core/src/config/schema.js";
import { isRenderableEntry } from "../../core/src/format/chunk.js";
import { BUILDER } from "../../core/src/format/render.js";
import { assertGraphStructure } from "../../core/src/graph/mutations.js";
import { measureRootViewTokens } from "../../core/src/graph/read-tools.js";
import { sinceLastCompaction, snapshotAtCompaction } from "../../core/src/status/usage-ledger.js";
import { cloneLedger, encodeDetails } from "../../core/src/store/codecs.js";
import type { GraphStore } from "../../core/src/store/graph-store.js";
import { computeUnobserved, makeMaybeBuilder } from "../../core/src/triggers.js";
import { O_INITIAL_PROMPT } from "../../core/src/types.js";
import { ModelUnavailableError } from "../runs/seams.js";
import { normalizeSummaryText, ownSummariesFor } from "../storage/summary-identity.js";
import { contextTokensFor, makeTriggerCtx } from "../triggers/context.js";
import { acquireForCompaction, acquireOrSkip } from "../triggers/run-locks.js";
import { buildSkip, buildTakeover, estimateTokensAfter, summaryMessage } from "./answer.js";
import { computeKeptTail } from "./cut.js";
import { ownCompactionFloorIndex, ownSummaryFloorIndex } from "./floor.js";
import { collectTailThinking, renderThinkingSection } from "./thinking.js";

/** The compact event slice the takeover reads (the engine's input shape). */
export interface CompactEvent {
  trigger: "manual" | "auto" | "plugin" | "precompute";
  agentId?: string;
  instructions?: string;
  messages: readonly SessionMessage[];
}

/** The stage runs, pre-bound by the wiring to the conversation's core,
 *  storage, and widget (the stage-run host modules; the hook passes only the
 *  per-compaction fields). */
export interface CompactionRuns {
  runObserver: (input: {
    unobserved: SessionEntry[];
    signal: AbortSignal;
    maybeBuild: () => Promise<boolean>;
  }) => Promise<void>;
  runBuilder: (input: {
    signal: AbortSignal;
    scope: { firstKeptEntryId: string | null } | null;
    /** True only for the final post-catch-up call (the sole call eligible for
     *  the builderSkipWithinBudget fast-path); the mid-catch-up closure passes
     *  false so folding always runs. */
    ensureReady: boolean;
  }) => Promise<void>;
  runSelector: (input: { signal: AbortSignal; scope: { firstKeptEntryId: string | null } | null }) => Promise<void>;
}

/** The takeover's named inputs — everything the gate touches, injected. */
export interface CompactionHookDeps {
  /** The conversation key (agentId-scoped) — the run-lock's key. */
  key: string;
  /** The gate-entry settings snapshot. */
  settings: SessionOwlConfig;
  /** The live settings (re-read between phases — the mid-gate disable). */
  getSettings: () => SessionOwlConfig;
  /** The layered rewind check's compaction entry, awaited BEFORE the gate
   *  reads the store: a rewind that happened since the last check-point
   *  re-folds here, so the takeover renders from the rewound state instead
   *  of the abandoned line's records. A throw degrades to a logged
   *  skip-and-continue (the check's own last-resort rule). */
  rewindCheck: () => Promise<void>;
  /** The conflict-pause live predicate (true ⇒ hooks pass through). */
  isPaused: () => boolean;
  /** The kept-tail budget (the ported keepRecentTokens setting). */
  keepRecentTokens: number;
  /** Whether the kept tail's thinking folds into the '# Memory' summary
   *  row as the attributed-reasoning section (the engine serves user rows;
   *  a trailing assistant row persists as model="<synthetic>" and never
   *  reaches the model). */
  keptTailAggregatedThinking: boolean;
  /** Whether the injected summary echoes as ONE visible assistant row at
   *  the tail's end (a display mirror for the user; the model never sees
   *  that row). Default off. */
  injectedSummaryRow: boolean;
  /** The conversation's entries view (the branch the gap + touched files read). */
  getBranch: () => SessionEntry[];
  getLeafId: () => string | null;
  /** The conversation's observer frontier. */
  getObserverFrontier: () => string | null;
  /** Pins the conversation's core before each store-reading cluster. */
  pinCore: () => Promise<void>;
  /** The pinned conversation's graph store (read + the compaction-baseline write). */
  getGraphStore: () => GraphStore;
  runs: CompactionRuns;
  /** Persists the encoded snapshot BEFORE the answer (the storage layer's
   *  snapshot writer, bound by the wiring) and records the answered
   *  summary's exact text as owl's own (branch record identity). */
  persistSnapshot: (details: unknown, compactionId: string, summaryText: string) => Promise<void>;
  /** Appends the transcript display row for the summary (the engine writes
   *  none of its own for a hook-answered compaction — the row lands
   *  model-invisible and renders in the transcript view). A failure is
   *  logged and never fails the answer. */
  /** The notify adapter (the commands/notify task wires the engine surface). */
  notify: (message: string, level: "info" | "warning" | "error") => void;
  log?: (message: string) => void;
  /** One compaction id per takeover (the snapshot record's id). */
  newCompactionId: () => string;
  /** The budget-free wait: when present,
   *  the ensure-ready phases (catch-up + builder + selector) run INSIDE
   *  this wrapper — the wiring rides a $.tool.call so the engine's 10s
   *  hook-budget clock stays paused for the whole stage wait (the clock
   *  stops while any $ call of the hook is in flight; our own stage waits
   *  otherwise burn it — a long stage wait trips "ran past its 10s
   *  budget"). Absent ⇒
   *  the phases run inline (today's behavior). */
  viaToolCall?: <T>(work: () => Promise<T>) => Promise<T>;
}

/** What the takeover decided: answer, veto, or pass through to the engine. */
export type TakeoverOutcome =
  | { kind: "answer"; result: SessionCompacted; cut?: string | null }
  | { kind: "skip"; result: SessionCompactSkipped }
  | { kind: "pass" };

const COMPACT_EVENT_ENTRY_TYPES = new Set(["message", "custom_message"]);

/** The run hook: the session.compact takeover. Never throws. */
export async function compactionTakeover(e: CompactEvent, deps: CompactionHookDeps): Promise<TakeoverOutcome> {
  // the default is the informational channel — the wiring supplies the real log seam
  const log = deps.log ?? ((message: string) => console.log(message));
  try {
    // (1) the live pause predicate gates at entry (conflict self-restraint)
    if (deps.isPaused()) return { kind: "pass" };
    // (2) disabled ⇒ transparent (the engine's own compaction runs)
    if (!deps.settings.enabled) return { kind: "pass" };
    // (2b) the layered rewind check: a rewind since the last check-point
    // re-folds BEFORE the gate reads the store — the cut, the scope and the
    // ensure-ready phases then work on the rewound conversation's own
    // records, never the abandoned line's. A failed check degrades to a
    // log line (the compaction still runs; the next check-point retries).
    try {
      await deps.rewindCheck();
    } catch (cause) {
      log(
        `rewind check before compaction failed (continuing): ${cause instanceof Error ? cause.message : String(cause)}`,
      );
    }
    // typed /compact instructions are ignored exactly as pi ignores them —
    // the summary is built from the graph, never the focus text
    if (typeof e.instructions === "string" && e.instructions.length > 0) {
      log(`compaction instructions ignored: ${e.instructions}`);
    }
    // (3) the precompute branch: a held result must be a pure mechanical
    // render — any backlog hands back to the real compaction (the full gate)
    if (e.trigger === "precompute") return precomputeTakeover(deps);

    // (4) the cut at gate entry — the kept tail over the event's own messages
    const cut = computeKeptTail(e.messages, deps.keepRecentTokens);
    // an empty swallowed prefix (the whole conversation fits the keep window)
    // is declined: the summary would add a row while keeping every message,
    // so the session stays as-is and the skip reason says why
    if (cut.firstKeptIndex === 0) {
      log("compaction declined: nothing to compact (session too small)");
      return { kind: "skip", result: { skip: "session-owl: nothing to compact (session too small)" } };
    }
    await deps.pinCore();
    const firstKeptEntryId = entryIdForCut(deps.getBranch(), cut.firstKeptIndex, e.messages.length);
    const scope = { firstKeptEntryId };

    // (5) the compaction-exclusive acquire: abort in-flight runs, await them
    const handle = await acquireForCompaction(deps.key);
    const signal = handle.abortController.signal;
    try {
      // a prior owl summary row never rides the tail — the fresh summary
      // re-renders the same graph, so exactly one summary row exists at a time
      const keptTail = cut.kept.filter((m) => !isPriorSummaryRow(m, ownSummariesFor(deps.getGraphStore())));
      return await runGate(deps, log, { kept: keptTail, scope, handle, signal });
    } finally {
      handle.release();
    }
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    if (cause instanceof ModelUnavailableError) {
      // the session stays uncompacted (a skip answer never falls back to the
      // engine's own compaction); the reason is surfaced as the skip notice
      const notice = `session-owl: model unavailable during compaction capture (${reason}) — compaction skipped; fix the model and run /compact again`;
      (deps.log ?? ((m: string) => console.log(m)))(notice);
      return { kind: "skip", result: { skip: notice } };
    }
    return skipFailed(deps, reason);
  }
}

/** The ensure-ready gate body under the held lock: catch-up → Builder →
 *  Selector → render → snapshot persist → the answer. */
async function runGate(
  deps: CompactionHookDeps,
  log: (m: string) => void,
  held: {
    kept: SessionMessage[];
    scope: { firstKeptEntryId: string | null };
    handle: { release(): void; abortController: AbortController };
    signal: AbortSignal;
  },
): Promise<TakeoverOutcome> {
  // the compaction's stage-cost baseline (cloned deep — the stages mutate in place)
  await deps.pinCore();
  const preStageLedger = cloneLedger(deps.getGraphStore().usageLedger);

  // (a)+(b)+(c) run as ONE unit so the whole ensure-ready phase can ride
  // the budget-free tool call (deps.viaToolCall): the engine's 10s hook
  // budget stops while a $ call is in flight, and waiting for our spawned
  // stages is otherwise our own promise time (the budget
  // overrun). The verdict ("ok" | "pass" | "cancel") crosses the wrapper
  // through the captured local — whichever side runs the phases.
  const readyPhases = async (): Promise<"ok" | "pass" | "cancel"> => {
    // (a) Observer catch-up — GAP-DRIVEN regardless of observerMode: observe
    // the renderable entries between the frontier and the cut (the block this
    // compaction is about to swallow)
    const gap = observerCatchUpGap(deps, held.scope.firstKeptEntryId);
    if (gap.length > 0) {
      const bareMaybeBuild = makeMaybeBuilder({
        ctx: makeTriggerCtx({
          key: deps.key,
          getLeafId: deps.getLeafId,
          getBranch: () => deps.getBranch(),
          thinkingLevel: null,
        }) as unknown as Parameters<typeof makeMaybeBuilder>[0]["ctx"],
        settings: deps.settings,
        signal: held.signal,
        scope: held.scope,
        runBuilder: () => deps.runs.runBuilder({ signal: held.signal, scope: held.scope, ensureReady: false }),
      });
      // the vendored decision reads the store singletons mid-Observer — after
      // the Observer's long awaits another conversation's swap may hold them,
      // so every mid-catch-up check re-pins first (the boundary evaluator's
      // cluster discipline)
      const maybeBuild = async (): Promise<boolean> => {
        await deps.pinCore();
        return bareMaybeBuild();
      };
      await deps.runs.runObserver({ unobserved: gap, signal: held.signal, maybeBuild });
    }
    if (held.signal.aborted) return "cancel";
    // live master switch between phases: a disable leaves with a PASS — the
    // engine's native summary runs (NOT a skip)
    if (!deps.getSettings().enabled) {
      log("compaction: session-owl disabled mid-gate — leaving (native compaction)");
      return "pass";
    }

    // (b) the Builder — always invoked; it owns its fast-path (the final
    // post-catch-up call — ensureReady — may skip within budget; the
    // mid-catch-up folding above never does)
    await deps.runs.runBuilder({ signal: held.signal, scope: held.scope, ensureReady: true });
    if (held.signal.aborted) return "cancel";
    if (!deps.getSettings().enabled) {
      log("compaction: session-owl disabled mid-gate — leaving (native compaction)");
      return "pass";
    }

    // (c) the Selector — selected-root only (it owns its cached-tree fast-path)
    if (deps.settings.renderMode === "selected-root") {
      await deps.runs.runSelector({ signal: held.signal, scope: held.scope });
    }
    if (held.signal.aborted) return "cancel";
    return "ok";
  };
  const verdict = deps.viaToolCall !== undefined ? await deps.viaToolCall(readyPhases) : await readyPhases();
  if (verdict === "cancel") return cancelAborted(deps);
  if (verdict === "pass") return { kind: "pass" };
  if (verdict !== "ok") {
    // The wrapper's contract says this is unreachable (it returns the true
    // verdict or throws) — belt-and-braces: an unsettled gate NEVER renders.
    // pi's degrade: a failed gate cancels (no-memory), never a half-built
    // summary from a graph whose stages are still running.
    return skipFailed(deps, "ensure-ready verdict missing (the gate never settled)");
  }

  // render + snapshot — the pin holds the store steady across the cluster
  await deps.pinCore();
  const store = deps.getGraphStore();
  assertGraphStructure(store.graph, "encode snapshot"); // invalid ⇒ skip + notify, the last-good snapshot stays authoritative
  const touchedFiles = extractTouchedFiles(
    { getLeafId: deps.getLeafId, getBranch: deps.getBranch },
    held.scope.firstKeptEntryId,
  );
  const oInitialPrompt = store.graph.observations.get(O_INITIAL_PROMPT) ?? null;
  const summary = renderSummary({
    graph: store.graph,
    selectedTree: store.selectedTree,
    oInitialPrompt,
    renderMode: deps.settings.renderMode,
    touchedFiles,
    compactionCount: countCompactions(deps.getBranch()),
  });
  // the compaction baseline for the status report's since-last arithmetic
  store.lastCompactionLedger = snapshotAtCompaction(store.usageLedger).lastCompactionLedger;

  // the per-stage usage delta isolates THIS compaction's stage cost
  const compactionDelta = sinceLastCompaction(store.usageLedger, preStageLedger);
  const details = encodeDetails(store.graph, store.selectedTree, store.usageLedger) as { compactionStages?: unknown };
  details.compactionStages = ledgerToStageUsages(compactionDelta);

  // The kept tail's aggregated thinking rides INSIDE the summary row (the
  // engine serves user rows; a trailing assistant row persists as
  // model="<synthetic>" and never reaches the model). Off or empty — the
  // summary stands alone.
  let summaryText = summary;
  if (deps.keptTailAggregatedThinking) {
    const collected = collectTailThinking(deps.getBranch(), held.scope.firstKeptEntryId);
    log(
      `kept-tail thinking: ${collected.length} block(s) from cut ${held.scope.firstKeptEntryId ?? "whole-branch"} ` +
        `(branch ${deps.getBranch().length} entr${deps.getBranch().length === 1 ? "y" : "ies"})`,
    );
    const section = renderThinkingSection(collected);
    if (section !== null) summaryText = `${summary}\n\n${section}`;
  } else {
    log("kept-tail thinking: knob off — the tail rides without the attributed section");
  }
  // The display echo: the injected SUMMARY as one visible assistant row at
  // the tail's end — the tree render alone; the reasoning section is
  // AGENT-ONLY content (it rides the model-visible summary row, never the
  // user-facing echo). The model never sees the echo row (the synthetic-row
  // skip), so nothing duplicates.
  let trailing: SessionMessage | undefined;
  if (deps.injectedSummaryRow) trailing = { role: "assistant", text: summary, toolUses: [] };

  // the snapshot + the own-summary record persist BEFORE the answer — a
  // crash in between keeps the previous snapshot authoritative and the
  // compaction skipped
  await deps.persistSnapshot(details, deps.newCompactionId(), summaryText);

  const summaryMsg = summaryMessage(summaryText);
  return {
    kind: "answer",
    // the kept tail's first row id: the alignment's exemption boundary —
    // the summarized prefix legitimately vanishes from the api view, and
    // the engine writes no row a later observer could re-derive it from
    cut: held.scope.firstKeptEntryId,
    result: buildTakeover({
      summary: summaryText,
      kept: held.kept,
      ...(trailing !== undefined ? { trailing } : {}),
      tokensBefore: contextTokensFor(deps.key) ?? undefined,
      tokensAfter: estimateTokensAfter([summaryMsg, ...held.kept, ...(trailing !== undefined ? [trailing] : [])]),
    }),
  };
}

/** The precompute branch (the ready-render rule): answer only from an
 *  already-ready state — no unobserved backlog, root view within threshold —
 *  a pure mechanical render costing zero LLM calls; anything else hands back
 *  with a skip (the real compaction runs the full gate). Nothing persists:
 *  the engine HOLDS the result and installs it at the next real compaction
 *  only if the conversation still holds what it ran over. */
async function precomputeTakeover(deps: CompactionHookDeps): Promise<TakeoverOutcome> {
  const handle = acquireOrSkip(deps.key, "select");
  if (handle === null) {
    return { kind: "skip", result: buildSkip("session-owl precompute skipped: a background run is in flight") };
  }
  try {
    await deps.pinCore();
    const store = deps.getGraphStore();
    const backlog = observerCatchUpGap(deps, null).length > 0;
    const withinThreshold = measureRootViewTokens(store.graph, BUILDER) < deps.settings.builderRootViewThreshold;
    if (backlog || !withinThreshold) {
      return { kind: "skip", result: buildSkip("session-owl precompute skipped: memory graph not render-ready") };
    }
    const summary = renderSummary({
      graph: store.graph,
      selectedTree: store.selectedTree,
      oInitialPrompt: store.graph.observations.get(O_INITIAL_PROMPT) ?? null,
      renderMode: deps.settings.renderMode,
      touchedFiles: extractTouchedFiles({ getLeafId: deps.getLeafId, getBranch: deps.getBranch }, null),
      compactionCount: countCompactions(deps.getBranch()),
    });
    return { kind: "answer", result: buildTakeover({ summary, kept: [] }) };
  } finally {
    handle.release();
  }
}

/** The cancel path when the compaction was aborted mid-gate. */
function cancelAborted(deps: CompactionHookDeps): TakeoverOutcome {
  const reason = "session-owl compaction canceled: compaction aborted";
  deps.notify(reason, "warning");
  return { kind: "skip", result: buildSkip(reason) };
}

/** The failure veto: notify + skip — the conversation stays as it was and
 *  the next trigger retries. */
function skipFailed(deps: CompactionHookDeps, cause: string): TakeoverOutcome {
  const reason = `session-owl compaction failed: ${cause}; retry`;
  deps.notify(reason, "error");
  return { kind: "skip", result: buildSkip(reason) };
}

/** The renderable entries strictly between the frontier and the cut (the
 *  block this compaction swallows). A null/unknown cut ⇒ the whole branch
 *  (pi's cut-not-found rule). */

/** A summary row owl itself rendered at an earlier compaction: the engine
 *  hands it back as a plain user message, so the row is owl's own exactly
 *  when its text matches one of the recorded answered summaries (an exact
 *  identity — a user message that merely opens like a summary never
 *  matches). The fresh answer carries the current render; keeping the old
 *  row would duplicate the memory view in the conversation. */
function isPriorSummaryRow(m: SessionMessage, ownTexts: ReadonlySet<string>): boolean {
  return m.role === "user" && typeof m.text === "string" && ownTexts.has(normalizeSummaryText(m.text));
}

export function observerCatchUpGap(deps: CompactionHookDeps, firstKeptEntryId: string | null): SessionEntry[] {
  const branch = deps.getBranch();
  const cutIndex = firstKeptEntryId === null ? -1 : branch.findIndex((entry) => entry.id === firstKeptEntryId);
  const compactedBlock = cutIndex === -1 ? branch : branch.slice(0, cutIndex);
  // the observation floor: the newest OWL-OWN summary on the block bounds
  // the re-observation scope (everything before it is condensed into that
  // row; a lost coverage state rebuilds from the boundary, and native or
  // foreign-mod summaries are never boundaries — their rows may still be
  // observed, which is the full-session re-observation they require).
  // Two witnesses of the same fact, the newer position winning: the store's
  // recorded summary texts (exact normalized identity) and the block's own
  // compaction entries — chrome rows carrying owl's rendered summary, which
  // survive a store loss and keep the condensed history below them from
  // ever re-entering the scope.
  const recordedFloor = ownSummaryFloorIndex(compactedBlock, ownSummariesFor(deps.getGraphStore()));
  const fileFloor = ownCompactionFloorIndex(compactedBlock);
  const floor = Math.max(recordedFloor, fileFloor);
  if (floor > recordedFloor) {
    (deps.log ?? ((m: string) => console.log(m)))(
      `catch-up floor: on-file own summary at index ${String(floor)} bounds the scope (no recorded match)`,
    );
  }
  const scoped = floor === -1 ? compactedBlock : compactedBlock.slice(floor + 1);
  return computeUnobserved(scoped, deps.getObserverFrontier()).filter(isRenderableEntry);
}

/** Map the message-space cut onto the branch's entry space by TAIL
 *  CORRESPONDENCE: after a compaction the engine's conversation is
 *  `[summary, ...kept, ...new]` while the branch keeps the append-only
 *  originals (the boundary rides as a `compaction` entry, summaries are
 *  those entries' texts), so whole-list positions structurally drift from
 *  a conversation's second compaction on. What holds instead: the newest
 *  `keptCount` messages (the kept tail — never a summary, which sits at
 *  the head region) correspond one-to-one to the newest `keptCount`
 *  MESSAGE-BEARING branch entries — head-side extras (rows the engine
 *  compacted away) sit before the tail region and cannot shift it.
 *  Distrust (null — the whole branch becomes the catch-up block, never a
 *  cut swallowed unobserved) when the cut precedes the summary region, or
 *  the branch is behind even counting its head extras. */
function entryIdForCut(branch: SessionEntry[], firstKeptIndex: number, messageCount: number): string | null {
  const messageBearing = branch.filter((entry) =>
    COMPACT_EVENT_ENTRY_TYPES.has((entry as { type?: string }).type ?? ""),
  );
  // each live compaction rides the branch as TWO door-compaction rows. The
  // current mapping rule (which row is the summary) is the recorded
  // non-empty-summary heuristic — see isCompactionSummaryEntry
  const summaries = branch.reduce((n, entry) => (isCompactionSummaryEntry(entry) ? n + 1 : n), 0);
  const liveTail = messageCount - summaries; // the kept tail + new rows
  const keptCount = messageCount - firstKeptIndex;
  // the cut precedes the summary region (the tail includes a summary), or
  // the branch is behind what the transcript holds — no position is trustworthy
  if (keptCount > liveTail || messageBearing.length < liveTail) return null;
  const aligned = messageBearing[messageBearing.length - keptCount];
  return aligned === undefined ? null : aligned.id;
}

/** The current mapping rule for which compaction entry is a compaction's
 *  SUMMARY row (vs its boundary marker): a non-empty summary text. NOTE:
 *  the live boundary row itself carries text ('Conversation compacted'),
 *  under which this rule counts both rows — a safe-direction over-count; a
 *  live session.append decides the final row-type distinction. */
function isCompactionSummaryEntry(entry: SessionEntry): boolean {
  return (
    (entry as { type?: string }).type === "compaction" &&
    typeof (entry as { summary?: unknown }).summary === "string" &&
    (entry as { summary: string }).summary.length > 0
  );
}

/** Compactions so far on this branch (the summary footer's maturity signal) —
 *  the summary rows under the current mapping rule. */
export function countCompactions(branch: SessionEntry[]): number {
  let count = 0;
  for (const entry of branch) {
    if (isCompactionSummaryEntry(entry)) count += 1;
  }
  return count;
}
