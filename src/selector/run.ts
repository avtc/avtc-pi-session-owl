// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarensenkov@gmail.com>

// The Selector run: builds the input-view (a deep-copied working copy + task
// context), runs a multi-pass convergence loop over that copy with the Selector
// tools, and persists the resulting selected tree as a self-contained snapshot.
//
// The Selector mutates a TRANSIENT working copy (never the source graph) and
// persists only once at run completion — so the store's selectedTree is stale
// mid-run; per pass the run pushes working-copy counts to the widget so it can
// render live `selected` deltas.
//
// The run honors `signal` and owns NO run-lock (the caller — the compaction hook
// or a background trigger — owns the lifecycle). Partial work from a failing
// pass is KEPT (no rollback): each mutate is atomic on the working copy, and the
// run commits whatever tree exists at the end.

import type { AgentEvent, AgentMessage } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { MemkeeperConfig } from "../config/schema.js";
import { measureRootViewTokens, nonObsoleteRoots } from "../graph/read-tools.js";
import { toStoreContext } from "../lifecycle.js";
import { log } from "../log.js";
import { notify } from "../notify.js";
import { SELECTOR_SYSTEM } from "../prompts/selector.js";
import { runStage, type StageRunInput, type StageRunResult } from "../runtime/agent-loop.js";
import { type ConvergenceOutcome, makeConvergenceTracker, runConvergencePass } from "../runtime/convergence.js";
import { makeLedgerHook } from "../runtime/ledger-hook.js";
import { resolveStageModel } from "../runtime/model.js";
import { decodeNode, encodeSelection } from "../store/codecs.js";
import { getGraphStore, persistSelectedTree, type StoreContext } from "../store/graph-store.js";
import {
  type MemkeeperGraph as Graph,
  MemkeeperGraph,
  type Node,
  type NodeId,
  O_INITIAL_PROMPT,
  type Observation,
  type ObsId,
} from "../types.js";
import type { WidgetController } from "../widget/tracker.js";
import {
  buildSelectorInputView,
  renderWorkingRoots,
  type SelectorInputView,
  type TailBoundary,
  type TodoContext,
} from "./input-view.js";
import { makeSelectorTools, SELECTOR_MUTATE_TOOL_NAMES, type TodoBridge } from "./tools.js";

// --- named constants (no bare literals at call sites) ----------------------

const SELECT_STAGE = "select";
const FIRST_PASS = 1;
const NO_MUTATES = 0;
const NO_PROMPT_OBS = null;
const NON_BUILDER = "nonBuilder" as const;

/** A per-pass outcome: applied mutate count + whether try_finish converged. */
export interface SelectorPassOutcome extends ConvergenceOutcome {}

/**
 * Build a per-pass event tracker: an `onEvent` that forwards EVERY event to the
 * downstream sink (the widget) AND inspects `tool_execution_end` to count
 * applied Selector mutates (the four mutate tools with `details.ok === true`
 * and not `isError`) and detect try_finish convergence (`details.ok === true`).
 * Read tools and rejected mutates do not count.
 *
 * Delegates to the shared convergence tracker (the Builder and Selector share
 * the same tracking shape; only the mutate-name set differs). */
export function makeSelectorPassTracker(downstream: (event: AgentEvent) => void): {
  outcome: SelectorPassOutcome;
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

  const resolved = await resolveStageModel(input.ctx, input.settings.selectorModel ?? input.settings.defaultModel);
  if (!resolved.ok) {
    notify(input.ctx, `Selector skipped a run: ${resolved.error}`, "warning");
    return;
  }

  const store = toStoreContext(input.pi, input.ctx);
  const graphStore = getGraphStore();
  const runStageFn = input.runStageFn ?? runStage;

  // Ensure-ready fast-path (AD9 + #b3e3ea63ccc4): a cached tree whose root view
  // is under threshold AND still covers the current observation frontier is
  // reused — no pass runs. No stage is opened (no startStage).
  if (canReuseCachedTree(graphStore, input.settings.selectorRootViewThreshold)) return;

  // Build the input-view once (the working copy + task context). The working
  // copy persists across passes within this run; the context (tail/todo/touched/
  // legends) is stable, so only the working-tree section is re-rendered per pass
  // (it mutates across passes).
  const { contextView, workingCopy } = buildInputView(graphStore.graph, input);

  let stageOpened = false;
  let pass = FIRST_PASS;
  try {
    input.widget.startStage(SELECT_STAGE, { pass });
    stageOpened = true;
    // Build the toolset once (operates on the working copy for the whole run).
    const tools = makeSelectorTools({
      workingCopy,
      settings: input.settings,
      ctx: input.ctx,
      todoBridge: input.todoBridge,
    });
    // Push the initial working-copy counts (the live delta source).
    pushSelectedCounts(input.widget, workingCopy.graph);
    // eslint-disable-next-line no-constant-condition -- loop bounded by breaks below
    while (true) {
      if (input.signal.aborted) break; // abort → run ended early

      const { outcome } = await runPass(input, workingCopy, contextView, resolved, tools, runStageFn, pass);
      pushSelectedCounts(input.widget, workingCopy.graph);

      // try_finish success → converged, stop.
      if (outcome.converged) break;
      // no-op pass (0 mutates, not converged) → stop.
      if (outcome.mutates === NO_MUTATES) break;

      pass += 1;
      if (pass > input.settings.maxSelectorPasses) break; // max
      input.widget.setPass(pass);
    }
  } catch (cause) {
    // A run-ending error (error-before-any-mutate rethrown by runPass). Applied
    // mutates on the working copy are kept; whatever tree exists is committed.
    log.error("selector run failed", cause);
  } finally {
    // Persist the resulting tree whenever a stage opened (a working copy exists)
    // — on convergence / no-op / max, on a run-ending error, AND on an abort-
    // during-run (decision #39: committed partial work is kept): the working copy
    // is the best available curation and committing it keeps mk_recall's target
    // alive. (Aborted-before-start leaves no working copy; stageOpened is false.)
    if (stageOpened) persistResult(store, graphStore, workingCopy.graph);
    if (stageOpened) input.widget.endStage();
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
): Promise<{ outcome: SelectorPassOutcome }> {
  const { outcome, onEvent } = makeSelectorPassTracker((event) => input.widget.onEvent(event));
  const messages = passMessages(working, contextView, pass);
  const store = toStoreContext(input.pi, input.ctx);
  await runConvergencePass({
    systemPrompt: SELECTOR_SYSTEM,
    messages,
    tools,
    model: resolved.model,
    apiKey: resolved.apiKey,
    signal: input.signal,
    onEvent,
    onStageEnd: makeLedgerHook(store, "select"),
    outcome,
    runStageFn,
    stageLabel: SELECT_STAGE,
  });
  return { outcome };
}

/** Build the per-pass user message: the task + the pass number + the CURRENT
 *  working-tree render (re-rendered each pass — the working copy mutates across
 *  passes) + the stable context (tail/todo/touched/legends). */
function passMessages(working: SelectorInputView["workingCopy"], contextView: string, pass: number): AgentMessage[] {
  const workingTree = renderWorkingRoots(working);
  const text =
    `Shape the active-set for the current task (pass ${pass}). Promote what matters, demote what doesn't into nIrrelevant, consolidate and condense to fit the budget.\n\n` +
    `Working tree\n\n${workingTree}\n\n${contextView}`;
  return [{ role: "user", content: text } as AgentMessage];
}

// --- fast-path -------------------------------------------------------------

/** Reuse the cached tree when it exists, fits the threshold, and still covers
 *  the current observation frontier (not stale). */
function canReuseCachedTree(store: ReturnType<typeof getGraphStore>, threshold: number): boolean {
  const cached = store.selectedTree;
  if (cached === null) return false; // nothing cached → build
  const rootViewTokens = measureRootViewTokens(materializeSnapshot(cached), NON_BUILDER);
  if (rootViewTokens >= threshold) return false; // over budget → rebuild
  // Staleness: the cached tree's frontier must match the current frontier
  // (no new observations since build). A mismatch → rebuild.
  return cached.coveredFrontier === store.observerFrontier;
}

/** Materialize a cached snapshot's nodes into a throwaway graph so the shared
 *  `renderRootView` measures it exactly as try_finish would. Bounded by the
 *  cached tree size (≤ selectorRootViewThreshold); cheap for a fast-path that
 *  skips an LLM run. */
function materializeSnapshot(cached: NonNullable<ReturnType<typeof getGraphStore>["selectedTree"]>): Graph {
  const nodes = new Map<NodeId, Node>();
  for (const sn of cached.nodes) {
    const node = decodeNode(sn);
    if (node !== null) nodes.set(node.id, node);
  }
  return new MemkeeperGraph({
    nodes,
    observations: new Map<ObsId, Observation>(),
    nextObsId: cached.nextObsId,
    nextNodeId: cached.nextNodeId,
  });
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
    },
  });
}

// --- persist ---------------------------------------------------------------

/** Persist the working copy as a self-contained selected-tree snapshot. */
function persistResult(store: StoreContext, graphStore: ReturnType<typeof getGraphStore>, workingGraph: Graph): void {
  const oInitialPromptId = workingGraph.observations.has(O_INITIAL_PROMPT) ? O_INITIAL_PROMPT : NO_PROMPT_OBS;
  const snapshot = encodeSelection(workingGraph, oInitialPromptId, graphStore.observerFrontier);
  persistSelectedTree(store, snapshot);
}

// --- widget counts ---------------------------------------------------------

/** Push the working copy's current root counts to the widget (live deltas). */
function pushSelectedCounts(widget: WidgetController, workingGraph: Graph): void {
  const rootCount = nonObsoleteRoots(workingGraph).length;
  const rootViewTokens = measureRootViewTokens(workingGraph, NON_BUILDER);
  widget.setSelectedCounts(rootCount, rootViewTokens);
}
