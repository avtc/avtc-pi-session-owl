// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// compactionHook: the session_before_compact handler. The compaction `summary`
// IS the injection (the agent's post-compaction memory). This hook owns the
// run-lock for the duration of its synchronous ensure-ready stages
// (Observer catch-up → Builder → Selector), renders the summary, snapshots the
// graph to `details`, and returns the compaction result. Failure / abort →
// {cancel:true} + notify (the agent degrades to no-memory, never a half-built
// summary).
//
// Abort handling: the hook NEVER touches event.signal (it is Pi's own
// compaction controller — aborting it breaks Pi's compaction). It holds its own
// per-run AbortController (from acquireForCompaction's handle) and LINKS
// event.signal into it so the stages die if Pi abandons the compaction.

import type { Usage } from "@earendil-works/pi-ai";
import type {
  ExtensionAPI,
  ExtensionContext,
  SessionBeforeCompactEvent,
  SessionEntry,
} from "@earendil-works/pi-coding-agent";
import type { BuilderRunInput } from "../builder/run.js";
import { runBuilder as realRunBuilder } from "../builder/run.js";
import { getSessionOwlSettings, type SessionOwlConfig } from "../config/schema.js";
import { isRenderableEntry } from "../format/chunk.js";
import { assertGraphStructure } from "../graph/mutations.js";
import { log } from "../log.js";
import { notify } from "../notify.js";
import type { ObserverRunInput } from "../observer/run.js";
import { runObserver as realRunObserver } from "../observer/run.js";
import { acquireForCompaction } from "../runtime/run-lock.js";
import { runSelector as realRunSelector, type SelectorRunInput } from "../selector/run.js";
import { countCompactions } from "../status/command.js";
import { sinceLastCompaction, snapshotAtCompaction } from "../status/usage-ledger.js";
import { cloneLedger, encodeDetails } from "../store/codecs.js";
import { getGraphStore } from "../store/graph-store.js";
import type { TodoBridge, TodoContext } from "../todo/types.js";
import { computeUnobserved, makeMaybeBuilder } from "../triggers.js";
import { O_INITIAL_PROMPT } from "../types.js";
import type { WidgetController } from "../widget/tracker.js";
import { renderSummary } from "./summary.js";
import { extractTouchedFiles } from "./touched-files.js";
import { aggregateLedgerUsage, ledgerToStageUsages } from "./usage-map.js";

// --- seams (testability + later-task wiring) --------------------------------

/** Injectable stage runs so tests pass fakes. The Selector run takes the full
 *  SelectorRunInput (ctx + pi + settings + signal + widget + scope + todo); the
 *  hook builds it from its own inputs (todo/todoBridge are null until the
 *  avtc-pi-todo bridge lands). */
export interface CompactionStageRuns {
  runObserver: (input: ObserverRunInput) => Promise<void>;
  runBuilder: (input: BuilderRunInput) => Promise<void>;
  runSelector: (input: SelectorRunInput) => Promise<void>;
}

/** Module-level stage-run seams. Defaults to the real Observer + Builder +
 *  Selector; tests override via the setter. */
let stageRuns: CompactionStageRuns = {
  runObserver: realRunObserver,
  runBuilder: realRunBuilder,
  runSelector: realRunSelector,
};

/** Override the stage runs (tests + later-task wiring). */
export function setCompactionStageRuns(runs: CompactionStageRuns): void {
  stageRuns = runs;
}

/** Injectable settings getter (tests override to control renderMode/thresholds). */
let settingsGetter: () => SessionOwlConfig = getSessionOwlSettings;

/** Override the settings getter (tests). */
export function setCompactionSettingsGetter(getter: () => SessionOwlConfig): void {
  settingsGetter = getter;
}

/** Restore the default seams (tests reset between cases). */
export function resetCompactionSeams(): void {
  stageRuns = { runObserver: realRunObserver, runBuilder: realRunBuilder, runSelector: realRunSelector };
  settingsGetter = getSessionOwlSettings;
}

// --- named constants (no bare literals) ------------------------------------

const CUT_NOT_FOUND = -1;
const BEFORE_CUT = 0;
const EMPTY_GAP = 0;

/** The cancel-on-failure result (degrade toward no-memory). */
const CANCEL_RESULT = { cancel: true } as const;

/** The compaction hook's return (Pi infers the full SessionBeforeCompactResult). */
export type CompactionResult =
  | { cancel: true }
  | { compaction: { summary: string; firstKeptEntryId: string; tokensBefore: number; usage: Usage; details: unknown } };

/**
 * The session_before_compact handler. Runs the ensure-ready gate under the
 * run-lock, renders the summary, snapshots the graph, and returns the
 * compaction result. Never throws — failures cancel + notify.
 *
 * `widget` drives the live progress widget during the ensure-ready stages
 * (passed in by the activate wiring). Never aborts event.signal.
 */
export async function compactionHook(
  event: SessionBeforeCompactEvent,
  ctx: ExtensionContext,
  pi: ExtensionAPI,
  widget: WidgetController,
  todo: { context: TodoContext | null; bridge: TodoBridge | null },
): Promise<CompactionResult | undefined> {
  const settings = settingsGetter();

  // Honor Pi's compaction signal: if Pi already gave up before we start, bail.
  if (event.signal.aborted) return cancelAborted(ctx);

  const firstKeptEntryId = event.preparation.firstKeptEntryId;

  // Acquire the run-lock for the whole ensure-ready gate (aborts + awaits any
  // in-flight background run via its OWN controller). Held across
  // all three sequential stages; released in the finally.
  log.info(`compaction: acquiring lock (firstKeptEntryId=${firstKeptEntryId})`);
  const handle = await acquireForCompaction();
  log.info("compaction: lock acquired");
  // Link Pi's compaction signal into the compaction's own controller so the
  // stages die if Pi abandons the compaction (never abort event.signal itself).
  linkAbort(event.signal, handle.abortController);
  const signal = handle.abortController.signal;

  try {
    // Snapshot the cumulative ledger BEFORE the ensure-ready stages run, so the
    // post-stages delta isolates THIS compaction's Observer/Builder/Selector cost
    // (the bench's metric, UD32). Cloned (deep) — the stages mutate usageLedger in place.
    const preStageLedger = cloneLedger(getGraphStore().usageLedger);
    // (a) Observer catch-up — GAP-DRIVEN (regardless of observerMode): observe
    // the renderable entries strictly between the frontier and the compaction
    // cut (the compacted-away block). A lagging on-threshold frontier is the
    // safety net the ensure-ready gate provides.
    const gap = observerCatchUpGap(ctx, firstKeptEntryId);
    if (gap.length > EMPTY_GAP) {
      log.info(`compaction: observer catch-up start (${gap.length} entries)`);
      // Mid-catch-up Builder: at compaction the Builder runs after the Observer
      // anyway, so folding the accumulated `new` roots whenever the root view
      // crosses the threshold keeps a long catch-up bounded instead of ballooning
      // to hundreds of roots before one giant pass.
      const maybeBuild = makeMaybeBuilder({
        ctx,
        settings,
        signal,
        scope: { firstKeptEntryId },
        runBuilder: () => stageRuns.runBuilder({ ctx, pi, settings, signal, scope: { firstKeptEntryId }, widget }),
      });
      await stageRuns.runObserver({ ctx, pi, settings, unobserved: gap, signal, widget, maybeBuild });
      log.info("compaction: observer catch-up end");
    }
    if (signal.aborted) return cancelAborted(ctx);
    // live master switch: disabling mid-gate leaves session-owl out of this
    // compaction — Pi runs its native summary (NOT a cancel). The Observer's
    // completed chunks are durable (per-chunk persistence).
    if (!settingsGetter().enabled) {
      log.info("compaction: session-owl disabled mid-gate — leaving (native compaction)");
      return undefined;
    }

    // (b) Builder — always called; it owns the internal fast-path (root view
    // under threshold → skip LLM passes; `new` arrivals stay `new` — nothing was
    // folded). Processing all `new` nodes across the whole graph (no firstKeptEntryId filtering).
    log.info("compaction: builder start");
    await stageRuns.runBuilder({ ctx, pi, settings, signal, scope: { firstKeptEntryId }, widget });
    log.info("compaction: builder end");
    if (signal.aborted) return cancelAborted(ctx);
    // live master switch (between phases): a disable after the Builder leaves
    // the gate — the Selector is skipped and Pi runs its native compaction.
    if (!settingsGetter().enabled) {
      log.info("compaction: session-owl disabled mid-gate — leaving (native compaction)");
      return undefined;
    }

    // (c) Selector — only selected-root; always called (the Selector owns the internal
    // fast-path; the hook does NOT gate on threshold alone).
    if (settings.renderMode === "selected-root") {
      log.info("compaction: selector start");
      await stageRuns.runSelector({
        ctx,
        pi,
        settings,
        signal,
        widget,
        scope: { firstKeptEntryId },
        todo: todo.context,
        todoBridge: todo.bridge,
      });
      log.info("compaction: selector end");
    }
    if (signal.aborted) return cancelAborted(ctx);

    // Render + snapshot. The summary IS the injection.
    log.info("compaction: rendering summary + encoding snapshot");
    const store = getGraphStore();
    // The snapshot freeze is the point of no return: every future load trusts
    // `details` blindly. An invalid graph cancels the compaction visibly
    // instead of poisoning the log (the last-good snapshot stays authoritative).
    assertGraphStructure(store.graph, "encode snapshot");
    const touchedFiles = extractTouchedFiles(ctx.sessionManager, firstKeptEntryId);
    const oInitialPromptObs = store.graph.observations.get(O_INITIAL_PROMPT) ?? null;
    const summary = renderSummary({
      graph: store.graph,
      selectedTree: store.selectedTree,
      oInitialPrompt: oInitialPromptObs,
      renderMode: settings.renderMode,
      touchedFiles,
      compactionCount: countCompactions(ctx.sessionManager),
    });
    // capture the compaction baseline so post-compaction /owl:status "since last
    // compaction" arithmetic is correct (deep copy — later stage activity must
    // not mutate the captured baseline).
    store.lastCompactionLedger = snapshotAtCompaction(store.usageLedger).lastCompactionLedger;

    //  (UD32): isolate THIS compaction's stage cost (post-stages − pre-stages)
    // + map to pi's Usage shape. The bench reads compaction.usage for totals
    // + details.compactionStages for the per-stage breakdown table.
    const compactionDelta = sinceLastCompaction(store.usageLedger, preStageLedger);
    const compactionStages = ledgerToStageUsages(compactionDelta);
    const compactionUsage = aggregateLedgerUsage(compactionDelta);
    const details = encodeDetails(store.graph, store.selectedTree, store.usageLedger);
    // attach the per-stage breakdown (additive details field; the bench reads it for)
    details.compactionStages = compactionStages;

    return {
      compaction: {
        summary,
        firstKeptEntryId,
        tokensBefore: event.preparation.tokensBefore,
        usage: compactionUsage,
        details,
      },
    };
  } catch (cause) {
    log.error("compaction hook failed", cause);
    const reason = cause instanceof Error ? cause.message : String(cause);
    notify(ctx, `session-owl compaction failed: ${reason}; retry`, "error");
    return CANCEL_RESULT;
  } finally {
    handle.release();
    log.info("compaction: lock released (hook done)");
  }
}

/** Abort Pi's compaction signal into the compaction's own controller (never the
 *  reverse). If Pi already aborted, abort immediately. */
function linkAbort(piSignal: AbortSignal, own: AbortController): void {
  if (piSignal.aborted) {
    own.abort();
    return;
  }
  piSignal.addEventListener("abort", () => own.abort(), { once: true });
}

/** The cancel path when the compaction was aborted mid-gate. */
function cancelAborted(ctx: ExtensionContext): { cancel: true } {
  notify(ctx, "session-owl compaction canceled: compaction aborted", "warning");
  return CANCEL_RESULT;
}

/**
 * The renderable entries strictly between the Observer frontier and the
 * compaction cut (the compacted-away block to catch up). Returns empty when the
 * frontier is already past the cut (on-threshold, no lag) — a no-op.
 */
function observerCatchUpGap(ctx: ExtensionContext, firstKeptEntryId: string): SessionEntry[] {
  const branch = ctx.sessionManager.getBranch(ctx.sessionManager.getLeafId() ?? undefined);
  const cutIndex = branch.findIndex((e) => e.id === firstKeptEntryId);
  // entries before the cut (the compacted block); if the cut isn't on this branch,
  // the whole branch is the candidate block.
  const compactedBlock = cutIndex === CUT_NOT_FOUND ? branch : branch.slice(BEFORE_CUT, cutIndex);
  return computeUnobserved(compactedBlock, getGraphStore().observerFrontier).filter(isRenderableEntry);
}
