// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// The turn_end background-trigger evaluation for all three maintenance stages
// (Observer + Builder + Selector) + the Observer frontier. Each turn_end the
// hook calls onTurnEnd; it evaluates the three triggers and fire-and-forget-
// launches each that shouldFire, serialized by the single run-lock (a colliding
// trigger SKIPS — the unobserved work batches on the next run).
//
// The run-lock lifecycle is CALLER-owned: onTurnEnd acquires per stage
// and releases in the wrapping IIFE's `finally`; the run functions never touch
// the lock (they only honor their AbortSignal). The runFn is injected per stage
// (Observer/Builder/Selector) so this module is testable before those land.

import type { ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import type { MemkeeperConfig } from "./config/schema.js";
import { type ChunkOptions, isRenderableEntry, renderBlocks } from "./format/chunk.js";
import { measureRootViewTokens } from "./graph/read-tools.js";
import { log } from "./log.js";
import { acquireOrSkip, inFlight, type StageName } from "./runtime/run-lock.js";
import { getGraphStore } from "./store/graph-store.js";
import { estimateContentTokens } from "./types.js";

/** Args handed to `onTurnEnd` and the trigger evaluators from the `turn_end` hook.
 *  `prefetchedContextTokens` lets `onTurnEnd` read pi's uncached `getContextUsage()`
 *  ONCE and thread the value into both threshold evaluators (avoids the
 *  double whole-history re-tokenization of the non-default dual-threshold
 *  config). Absent → the evaluator reads it itself. */
export interface TriggerInput {
  ctx: ExtensionContext;
  settings: MemkeeperConfig;
  prefetchedContextTokens?: number | null;
}

/** The run function injected per stage (assignable to the real Observer/Builder/Selector runs).
 *  Each run honors `signal` and takes only the fields it needs (the unified contract carries all). */
export type RunFn = (args: {
  ctx: ExtensionContext;
  settings: MemkeeperConfig;
  signal: AbortSignal;
  /** The compaction cut; null at turn_end (set only by the compaction hook). */
  scope: { firstKeptEntryId: string | null } | null;
  /** The Observer frontier slice; null for Builder/Selector. */
  unobserved: SessionEntry[] | null;
}) => Promise<void>;

/** Whether a session entry is a user message (used to anchor the null-frontier start). */
function isUserMessageEntry(entry: SessionEntry): boolean {
  if (entry.type !== "message") return false;
  const message = entry.message;
  return typeof message === "object" && message !== null && message.role === "user";
}

// --- the Observer frontier -------------------------------------------------

/**
 * The unobserved slice: renderable entries strictly AFTER the frontier id. When the
 * frontier is null (nothing observed yet) the slice starts AFTER the first user
 * message, so the verbatim initial prompt is never re-observed (it is captured
 * mechanically). If there is no user message at all, nothing is
 * unobserved yet (no task anchor — the Observer waits for the first user message).
 * Operational entries are never unobserved sources.
 */
export function computeUnobserved(entries: readonly SessionEntry[], frontier: string | null): SessionEntry[] {
  if (frontier === null) {
    const firstUserIndex = entries.findIndex(isUserMessageEntry);
    // start strictly after the first user message; with no user message there is no
    // anchor, so nothing is unobserved yet (startIndex past the end → empty slice).
    const startIndex = firstUserIndex === -1 ? entries.length : firstUserIndex + 1;
    return entries.slice(startIndex).filter(isRenderableEntry);
  }
  const frontierIndex = entries.findIndex((entry) => entry.id === frontier);
  // frontier not found (stale id) → nothing strictly-after it on this branch → empty
  const startIndex = frontierIndex === -1 ? entries.length : frontierIndex + 1;
  return entries.slice(startIndex).filter(isRenderableEntry);
}

/** Render the unobserved entries and sum their token estimate (chars/4). */
function estimateUnobservedTokens(unobserved: SessionEntry[], settings: MemkeeperConfig): number {
  if (unobserved.length === 0) return 0;
  const options: ChunkOptions = {
    tokenThreshold: Number.POSITIVE_INFINITY,
    toolBlockCapTokens: settings.observerToolBlockCapTokens,
    includeThinking: settings.observerIncludeThinking,
  };
  const blocks = renderBlocks(unobserved, options);
  return blocks.reduce((sum, block) => sum + estimateContentTokens(block.text), 0);
}

// --- Observer trigger ------------------------------------------------------

export interface ObserverTriggerResult {
  shouldFire: boolean;
  unobserved: SessionEntry[];
  reason: string;
}

const SKIP_INFLIGHT = "a run is already in flight";
const OBSERVER_SKIP_MODE = "observerMode is on-compaction (compaction catch-up owns it)";
const OBSERVER_SKIP_EMPTY = "no unobserved entries";
const OBSERVER_SKIP_THRESHOLD = "unobserved tokens below observerThresholdTokens";

/**
 * The Observer trigger (on-threshold): fire when ≥1 unobserved entry AND the rendered
 * unobserved tokens ≥ `observerThresholdTokens`. Skips when disabled/on-compaction or
 * when a run is in flight. No turn-count gate — a single token gate.
 */
export function evaluateObserverTrigger(input: TriggerInput & { unobserved: SessionEntry[] }): ObserverTriggerResult {
  const { settings, unobserved } = input;
  if (settings.observerMode === "on-compaction") {
    return { shouldFire: false, unobserved, reason: OBSERVER_SKIP_MODE };
  }
  if (unobserved.length === 0) {
    return { shouldFire: false, unobserved, reason: OBSERVER_SKIP_EMPTY };
  }
  if (inFlight()) {
    return { shouldFire: false, unobserved, reason: SKIP_INFLIGHT };
  }
  const tokens = estimateUnobservedTokens(unobserved, settings);
  if (tokens < settings.observerThresholdTokens) {
    return {
      shouldFire: false,
      unobserved,
      reason: `${OBSERVER_SKIP_THRESHOLD} (${tokens}/${settings.observerThresholdTokens})`,
    };
  }
  return { shouldFire: true, unobserved, reason: `unobserved ${tokens} tokens ≥ ${settings.observerThresholdTokens}` };
}

// --- Builder trigger ------------------------------------------------------

/** Count new (unflushed) wrapper nodes — the Observer's unprocessed arrivals. */
function countNewNodes(): number {
  let count = 0;
  for (const node of getGraphStore().graph.nodes.values()) {
    if (node.state === "new") count += 1;
  }
  return count;
}

/** Measure the non-obsolete ROOT view the same way `try_finish` does — the
 *  rendered node line (icon/id/importance/counts/datetime), chars/4 — so the
 *  on-root-view-threshold trigger and the convergence gate agree on what
 *  counts against `builderRootViewThreshold`. (Summing cached `summaryTokens`
 *  would under-count: it omits every line's framing, so the trigger and the
 *  gate could disagree on whether the root view is over budget.) */
function computeRootViewTokens(): number {
  return measureRootViewTokens(getGraphStore().graph, "builder");
}

/** Read the live session context tokens (null when pi reports unknown).
 *  Prefers a value threaded in by `onTurnEnd` (read once for both evaluators);
 *  falls back to pi's `getContextUsage()` when absent (direct test calls). */
function contextTokens(input: TriggerInput): number | null {
  if (input.prefetchedContextTokens !== undefined) return input.prefetchedContextTokens;
  return input.ctx.getContextUsage()?.tokens ?? null;
}

export interface StageTriggerResult {
  shouldFire: boolean;
  reason: string;
}

const SKIP_MODE_COMPACTION = "mode is on-compaction (compaction owns it)";

/** The Builder trigger (the non-default builderModes at turn_end). */
export function evaluateBuilderTrigger(input: TriggerInput): StageTriggerResult {
  const { settings } = input;
  if (settings.builderMode === "on-compaction") {
    return { shouldFire: false, reason: SKIP_MODE_COMPACTION };
  }
  if (inFlight()) {
    return { shouldFire: false, reason: SKIP_INFLIGHT };
  }
  switch (settings.builderMode) {
    case "each-N-observations": {
      const count = countNewNodes();
      const fire = count >= settings.builderEveryNObservations;
      return { shouldFire: fire, reason: `${count} new nodes (threshold ${settings.builderEveryNObservations})` };
    }
    case "on-session-context-threshold": {
      const tokens = contextTokens(input);
      if (tokens === null) return { shouldFire: false, reason: "context tokens unknown (null)" };
      const fire = tokens >= settings.builderSessionContextThresholdTokens;
      return {
        shouldFire: fire,
        reason: `${tokens} ctx tokens (threshold ${settings.builderSessionContextThresholdTokens})`,
      };
    }
    case "on-root-view-threshold": {
      const tokens = computeRootViewTokens();
      const fire = tokens >= settings.builderRootViewThreshold;
      return {
        shouldFire: fire,
        reason: `${tokens} root-view tokens (threshold ${settings.builderRootViewThreshold})`,
      };
    }
    default:
      return { shouldFire: false, reason: "unhandled builderMode" };
  }
}

// --- Selector trigger ------------------------------------------------------

/** The Selector trigger (only when renderMode is selected-root). */
export function evaluateSelectorTrigger(input: TriggerInput): StageTriggerResult {
  const { settings } = input;
  if (settings.renderMode !== "selected-root") {
    return { shouldFire: false, reason: "renderMode is observations-root (Selector inactive)" };
  }
  if (settings.selectorMode === "on-compaction") {
    return { shouldFire: false, reason: SKIP_MODE_COMPACTION };
  }
  if (inFlight()) {
    return { shouldFire: false, reason: SKIP_INFLIGHT };
  }
  // selectorMode is on-session-context-threshold (the only other variant)
  const tokens = contextTokens(input);
  if (tokens === null) return { shouldFire: false, reason: "context tokens unknown (null)" };
  const fire = tokens >= settings.selectorSessionContextThresholdTokens;
  return {
    shouldFire: fire,
    reason: `${tokens} ctx tokens (threshold ${settings.selectorSessionContextThresholdTokens})`,
  };
}

// --- turn_end entry point ----------------------------------

/** Fire-and-forget launch a stage run: acquire the lock or SKIP;
 *  on acquire, capture ctx synchronously and `void` an async IIFE whose `finally`
 *  releases the handle (the run owns its own AbortController via the handle). The
 *  run is NEVER awaited by the handler (it returns immediately). */
export function launchBackgroundRun(input: TriggerInput, stage: StageName, runFn: RunFn): void {
  const handle = acquireOrSkip(stage);
  if (handle === null) return; // SKIP — a run is in flight; the gap batches on the next trigger
  const { ctx, settings } = input;
  const signal = handle.abortController.signal;
  void (async () => {
    try {
      await runFn({ ctx, settings, signal, scope: null, unobserved: null });
    } catch (err) {
      log.error(`background run (${stage}) failed`, err);
    } finally {
      handle.release();
    }
  })();
}

/** Per-stage run injection (each stage registers their real run functions at
 *  activate; defaults are no-ops so the trigger layer is testable + the turn_end hook doesn't
 *  crash before those land). */
export interface StageRuns {
  runObserver: RunFn;
  runBuilder: RunFn;
  runSelector: RunFn;
}

const NOOP_RUN: RunFn = async () => {};

/** The default (no-op) stage runs — the registry's value before activate wires
 *  the real runs, and the value tests reset to between files. */
const DEFAULT_STAGE_RUNS: StageRuns = {
  runObserver: NOOP_RUN,
  runBuilder: NOOP_RUN,
  runSelector: NOOP_RUN,
};

let stageRuns: StageRuns = { ...DEFAULT_STAGE_RUNS };

/** Register the real stage run functions (called once at activate by the wiring layer). */
export function setStageRuns(runs: StageRuns): void {
  stageRuns = runs;
}

/** Reset the stage-run registry to the no-op defaults (test isolation: undoes a
 *  test's `setStageRuns(fakes)` so they don't leak across files under
 *  isolate:false). */
export function resetStageRuns(): void {
  stageRuns = { ...DEFAULT_STAGE_RUNS };
}

/** The turn_end entry point the hook calls fire-and-forget. Evaluates Observer,
 *  Builder, Selector triggers and launches each that shouldFire, serialized by the
 *  run-lock (Observer first — it produces the `new` nodes Builder/Selector consume;
 *  a colliding later trigger SKIPS). Stage runs are read from the module registry
 *  (set via `setStageRuns`). */
export function onTurnEnd(input: TriggerInput): void {
  if (!input.settings.enabled) return;

  // Observer frontier: the unobserved slice on the active branch path.
  const leafId = input.ctx.sessionManager.getLeafId();
  const branchEntries = input.ctx.sessionManager.getBranch(leafId ?? undefined);
  const unobserved = computeUnobserved(branchEntries, getGraphStore().observerFrontier);

  // Read pi's uncached getContextUsage() ONCE and thread it into the threshold
  // evaluators — but ONLY when at least one of them is on-session-context-
  // threshold (the only modes that read it). The default profile (both
  // on-compaction) never reads it, so no per-turn call is added there.
  const needsContextTokens =
    input.settings.builderMode === "on-session-context-threshold" ||
    input.settings.selectorMode === "on-session-context-threshold";
  const withCtx: TriggerInput = needsContextTokens
    ? { ...input, prefetchedContextTokens: input.ctx.getContextUsage()?.tokens ?? null }
    : input;

  const observer = evaluateObserverTrigger({ ...input, unobserved });
  if (observer.shouldFire) {
    launchBackgroundRun(input, "observe", async (args) => stageRuns.runObserver({ ...args, unobserved }));
  }

  const builder = evaluateBuilderTrigger(withCtx);
  if (builder.shouldFire) {
    launchBackgroundRun(input, "build", stageRuns.runBuilder);
  }

  const selector = evaluateSelectorTrigger(withCtx);
  if (selector.shouldFire) {
    launchBackgroundRun(input, "select", stageRuns.runSelector);
  }
}
