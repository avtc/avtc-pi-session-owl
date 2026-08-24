// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// The Selector run: builds the input-view (a deep-copied working copy + task
// context), runs a multi-pass convergence loop over that copy with the Selector
// tools, and persists the resulting selected tree as a self-contained snapshot.
//
// The Selector mutates a TRANSIENT working copy (never the source graph) and
// persists only once at run completion — so the store's selectedTree is stale
// mid-run; the run registers a live working-copy counts provider with the
// widget so it renders `selected` deltas as each mutate applies.
//
// The run honors `signal` and owns NO run-lock (the caller — the compaction hook
// or a background trigger — owns the lifecycle). Partial work from a failing
// pass is KEPT (no rollback): each mutate is atomic on the working copy, and the
// run commits whatever tree exists at the end.

import type { AgentEvent, AgentMessage } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { MemkeeperConfig } from "../config/schema.js";
import { NON_BUILDER, renderTreeTotal } from "../format/render.js";
import { nonObsoleteRoots, renderRootViewFromRoots } from "../graph/read-tools.js";
import { toStoreContext } from "../lifecycle.js";
import { log } from "../log.js";
import { selectorSystemPrompt } from "../prompts/selector.js";
// jscpd:ignore-start — shared stage-run runtime surface (Builder + Selector import the same infra)
import {
  runStage,
  type StageRunInput,
  type StageRunResult,
  StageTimeoutError,
  type StageUsage,
} from "../runtime/agent-loop.js";
import type { ConvergenceOutcome } from "../runtime/convergence.js";
import { FIRST_PASS, makeConvergenceTracker, NO_MUTATES, runConvergencePass } from "../runtime/convergence.js";
import { makeLedgerHook, persistLedger } from "../runtime/ledger-hook.js";
import { resolveStageModelOrNotify, resolveStageReasoning } from "../runtime/model.js";
import { countCompactions } from "../status/command.js";
// jscpd:ignore-end
import { encodeSelection } from "../store/codecs.js";
import { type GraphStore, getGraphStore, persistSelectedTree, type StoreContext } from "../store/graph-store.js";
import type { TodoBridge, TodoContext } from "../todo/types.js";
import { estimateContentTokens, type MemkeeperGraph as Graph, O_INITIAL_PROMPT } from "../types.js";
import type { SelectedCountsProvider, WidgetController } from "../widget/tracker.js";
import { buildSelectorInputView, renderWorkingRoots, type SelectorInputView, type TailBoundary } from "./input-view.js";
import { makeSelectorTools, SELECTOR_MUTATE_TOOL_NAMES } from "./tools.js";

// --- named constants (no bare literals at call sites) ----------------------

const SELECT_STAGE = "select" as const;
const NO_PROMPT_OBS = null;
const INDEX_NOT_FOUND = -1;
const PREV_ENTRY = 1; // prev(firstKeptEntryId) = firstKeptEntryId position − 1

/** Build a per-pass event tracker: forwards every event to the downstream
 *  sink (widget) and inspects `tool_execution_end` to count applied Selector
 *  mutates + detect try_finish convergence. Delegates to the shared
 *  convergence tracker (Builder/Selector share the same shape; only the
 *  mutate-name set differs). */
export function makeSelectorPassTracker(downstream: (event: AgentEvent) => void): {
  outcome: ConvergenceOutcome;
  onEvent: (event: AgentEvent) => void;
} {
  return makeConvergenceTracker(downstream, SELECTOR_MUTATE_TOOL_NAMES);
}

// --- run input -------------------------------------------------------------

/** Input to `runSelector`. The run honors `signal` only — the caller owns the
 *  run-lock (the compaction hook holds it; a background trigger releases in its
 *  IIFE). */
export interface SelectorRunInput {
  ctx: ExtensionContext;
  pi: ExtensionAPI;
  settings: MemkeeperConfig;
  signal: AbortSignal;
  widget: WidgetController;
  /** The compaction cut; null at mid-session. */
  scope: { firstKeptEntryId: string | null } | null;
  /** The (optional) avtc-pi-todo context for the input-view's todo section;
   *  null when avtc-pi-todo is not installed (the section is omitted). */
  todo: TodoContext | null;
  /** The (optional) avtc-pi-todo bridge for the `todo_list` drill-down tool;
   *  null when avtc-pi-todo is not installed (the tool is omitted). */
  todoBridge: TodoBridge | null;
  /** Test seam — fake stage runner, or omitted for the real `runStage`. */
  runStageFn?: (input: StageRunInput) => Promise<StageRunResult>;
}

// --- the run ---------------------------------------------------------------

/**
 * Run the Selector: ensure-ready fast-path, then a multi-pass convergence loop
 * over the working copy, then persist the resulting selected tree.
 *
 * Honors `signal`; persists the selected tree once at run completion. Never
 * throws — a model-unavailable skip notifies the user; a run-ending error logs
 * (the caller may surface user-facing failure). Partial work is kept: whatever
 * tree exists at the end is committed.
 */
export async function runSelector(input: SelectorRunInput): Promise<void> {
  // Aborted before start → nothing to do.
  if (input.signal.aborted) return;

  const resolved = await resolveStageModelOrNotify(
    input.ctx,
    "Selector",
    input.settings.selectorModel ?? input.settings.defaultModel,
  );
  if (!resolved.ok) {
    return;
  }

  const store = toStoreContext(input.pi, input.ctx);
  const graphStore = getGraphStore();
  const runStageFn = input.runStageFn ?? runStage;

  // Re-check abort after the model-resolution await: compaction may have
  // signalled during it (mirrors the Builder guard).
  if (input.signal.aborted) return;

  // Ensure-ready fast-path: a cached tree that still covers the
  // compacted-away block (compaction) or the current frontier (background) is
  // reused — no pass runs. No stage is opened (no startStage).
  if (canReuseCachedTree(graphStore, input.ctx, input.scope?.firstKeptEntryId ?? null)) return;

  // Build the input-view once (the working copy + task context). The working
  // copy persists across passes within this run; the context (tail/todo/touched/
  // legends) is stable, so only the working-tree section is re-rendered per pass
  // (it mutates across passes).
  const { contextView, workingCopy } = buildInputView(graphStore.graph, input);
  // The source-tree totals (computed once — the source graph + session branch
  // are stable across passes; only the working copy mutates): the scale the
  // Selector curates from, shown with the working tree each pass.
  const treeTotal = renderTreeTotal(graphStore.graph, countCompactions(input.ctx.sessionManager));

  let stageOpened = false;
  let pass = FIRST_PASS;
  const ledger = makeLedgerHook(SELECT_STAGE);
  try {
    // Register the live working-copy counts provider at stage start: the widget
    // anchors its `selected` baseline on the pristine copy now, then re-pulls
    // after every tool_execution_end — per-mutate live `selected` updates,
    // mirroring the Builder's live source-graph roots.
    input.widget.startStage(SELECT_STAGE, {
      pass,
      selectedCounts: makeSelectedCountsProvider(workingCopy.graph),
    });
    stageOpened = true;
    // Build the toolset once (operates on the working copy for the whole run).
    const tools = makeSelectorTools({
      workingCopy,
      settings: input.settings,
      ctx: input.ctx,
      todoBridge: input.todoBridge,
    });
    // convergence loop — bounded by the break conditions below (budget met / no-op / context limit / signal)
    while (true) {
      if (input.signal.aborted) {
        break; // abort → run ended early
      }

      const { outcome } = await runPass(
        input,
        workingCopy,
        contextView,
        resolved,
        tools,
        runStageFn,
        pass,
        treeTotal,
        ledger.onStageEnd,
      );

      // persist the cumulative usage ledger PER PASS so an interrupted run keeps
      // the usage tally for every completed pass — matching the per-mutate
      // durability of the working-copy deltas (the two stay consistent).
      if (ledger.hasUsage()) persistLedger(store);

      // try_finish success → converged, stop.
      if (outcome.converged) break;
      // a per-LLM-call timeout — a stage-stopping error: THROW so the compaction
      // hook cancels compaction + surfaces a visible error.
      if (outcome.timedOut) {
        throw new StageTimeoutError("Selector", input.settings.llmCallTimeoutMs);
      }
      // no-op pass (0 mutates, not converged) → stop.
      if (outcome.mutates === NO_MUTATES) break;

      pass += 1;
      if (pass > input.settings.maxSelectorPasses) break; // max
      input.widget.setPass(pass);
    }
  } catch (cause) {
    // Propagate (timeout / LLM failure / server down) so the compaction hook
    // cancels compaction + notifies the user. Applied working-copy mutates are
    // kept; whatever tree exists is committed in the finally.
    log.error("selector run failed", cause);
    throw cause;
  } finally {
    // Best-effort teardown: a throw in one cleanup must not skip the others or
    // escape (the never-throws teardown contract). `endStage` always runs when a
    // stage opened so the widget never gets stuck showing a stage.
    try {
      // Persist the resulting tree whenever a stage opened (a working copy exists)
      // — on convergence / no-op / max, on a run-ending error, AND on an abort-
      // during-run (committed partial work is kept): the working copy is the best
      // available curation and committing it keeps mk_recall's target alive.
      // (Aborted-before-start leaves no working copy; stageOpened is false.)
      if (stageOpened) persistResult(store, graphStore, workingCopy.graph);
    } catch (cleanupErr) {
      log.error("selector stage teardown cleanup failed", cleanupErr);
    }
    if (stageOpened) {
      try {
        input.widget.endStage();
      } catch (endErr) {
        log.error("selector endStage failed", endErr);
      }
    }
  }
}

// --- one pass --------------------------------------------------------------

/** Run a single Selector pass (one agentLoop) and return its outcome. A pass
 *  that THROWS is settled here: 0 applied mutates → rethrow (ends the run);
 *  ≥1 applied mutates → swallowed (counts as a finished pass, partial kept). */
async function runPass(
  input: SelectorRunInput,
  working: SelectorInputView["workingCopy"],
  contextView: string,
  resolved: { model: StageRunInput["model"]; apiKey: string | undefined },
  tools: ReturnType<typeof makeSelectorTools>,
  runStageFn: (input: StageRunInput) => Promise<StageRunResult>,
  pass: number,
  treeTotal: string,
  onStageEnd: (usage: StageUsage) => void,
): Promise<{ outcome: ConvergenceOutcome }> {
  const { outcome, onEvent } = makeSelectorPassTracker((event) => input.widget.onEvent(event));
  const messages = passMessages(working, contextView, pass, treeTotal);
  await runConvergencePass({
    systemPrompt: selectorSystemPrompt(input.settings),
    messages,
    tools,
    model: resolved.model,
    apiKey: resolved.apiKey,
    signal: input.signal,
    maxTokens: input.settings.selectorMaxTokens,
    timeoutMs: input.settings.llmCallTimeoutMs,
    reasoning: resolveStageReasoning(
      input.settings.selectorThinkingLevel,
      input.settings.defaultThinkingLevel,
      input.ctx.thinkingLevel,
    ),
    onEvent,
    onStageEnd,
    outcome,
    runStageFn,
    stageLabel: SELECT_STAGE,
  });
  return { outcome };
}

/** Build the per-pass user message: the task + the pass number + the CURRENT
 *  working-tree render (re-rendered each pass — the working copy mutates across
 *  passes) + the stable context (tail/todo/touched/legends). The tree-total
 *  block (computed once per run from the SOURCE graph) rides with the working
 *  tree: the scale it curates from, which the pass's copy mutations don't
 *  change. */
function passMessages(
  working: SelectorInputView["workingCopy"],
  contextView: string,
  pass: number,
  treeTotal: string,
): AgentMessage[] {
  const workingTree = renderWorkingRoots(working);
  const text =
    `Shape the active-set for the current task (pass ${pass}). Promote what matters, demote what doesn't into nIrrelevant, consolidate and condense to fit the budget.\n\n` +
    `Working tree\n\n${workingTree}\n${treeTotal}\n\n${contextView}`;
  return [{ role: "user", content: text } as AgentMessage];
}

// --- fast-path -------------------------------------------------------------

/** Reuse the cached tree when it exists and still covers the current
 *  observation frontier (not stale). */
function canReuseCachedTree(store: GraphStore, ctx: ExtensionContext, firstKeptEntryId: string | null): boolean {
  const cached = store.selectedTree;
  if (cached === null) return false; // nothing cached → build
  // Staleness = the cached tree must COVER the compacted-away block.
  // Compaction path (firstKeptEntryId non-null): the compacted block is
  //   branch[0..cutIndex), whose last entry is prev(firstKeptEntryId) at
  //   cutIndex - 1; the cached tree's coveredFrontier (the observerFrontier at
  //   build time) must be at or past that position. Compared by BRANCH POSITION
  //   (indexOf), not string equality — firstKeptEntryId is the first RETAINED
  //   entry, so a naive id comparison would be off by one.
  // Background path (firstKeptEntryId null, mid-session): no compaction cut →
  //   fall back to strict frontier-equality (rebuild on any new observations).
  if (firstKeptEntryId === null) {
    return cached.coveredFrontier === store.observerFrontier;
  }
  if (cached.coveredFrontier === null) return false; // legacy tree → rebuild
  const branch = ctx.sessionManager.getBranch(ctx.sessionManager.getLeafId() ?? undefined);
  const cutIndex = branch.findIndex((entry) => entry.id === firstKeptEntryId);
  if (cutIndex === INDEX_NOT_FOUND) return false; // cut absent on this branch → rebuild (safe)
  const lastCompactedIndex = cutIndex - PREV_ENTRY;
  const coveredIndex = branch.findIndex((entry) => entry.id === cached.coveredFrontier);
  if (coveredIndex === INDEX_NOT_FOUND) return false; // coveredFrontier stale → rebuild
  return coveredIndex >= lastCompactedIndex;
}
// --- input-view wiring -----------------------------------------------------

/** Build the Selector input-view from the source graph + task context. */
function buildInputView(sourceGraph: Graph, input: SelectorRunInput): SelectorInputView {
  const firstKeptEntryId = input.scope?.firstKeptEntryId ?? null;
  const tailBoundary: TailBoundary = { firstKeptEntryId };
  return buildSelectorInputView({
    sourceGraph,
    tail: input.ctx.sessionManager,
    tailBoundary,
    todo: input.todo,
    touchedFiles: input.ctx.sessionManager,
    sinceEntryId: firstKeptEntryId,
    chunkOptions: {
      tokenThreshold: input.settings.observerThresholdTokens,
      toolBlockCapTokens: input.settings.observerToolBlockCapTokens,
      includeThinking: input.settings.observerIncludeThinking,
      includeEntryId: false,
    },
  });
}

// --- persist ---------------------------------------------------------------

/** Persist the working copy as a self-contained selected-tree snapshot. */
function persistResult(store: StoreContext, graphStore: GraphStore, workingGraph: Graph): void {
  const oInitialPromptId = workingGraph.observations.has(O_INITIAL_PROMPT) ? O_INITIAL_PROMPT : NO_PROMPT_OBS;
  const snapshot = encodeSelection(workingGraph, oInitialPromptId, graphStore.observerFrontier);
  persistSelectedTree(store, snapshot);
}

// --- widget counts ---------------------------------------------------------

/** Build the live selected-counts provider over the working copy: non-obsolete
 *  root count + rendered view tokens derived from ONE collected+sorted roots
 *  array per pull (mirrors the widget's `rootViewCounts`). The widget pulls per
 *  render — its cache is invalidated on every tool_execution_end — so each
 *  applied mutate shows immediately, like the Builder's source-graph roots. */
function makeSelectedCountsProvider(workingGraph: Graph): SelectedCountsProvider {
  return () => {
    const roots = nonObsoleteRoots(workingGraph);
    return {
      count: roots.length,
      viewTokens: estimateContentTokens(renderRootViewFromRoots(roots, NON_BUILDER, workingGraph.observations)),
    };
  };
}
