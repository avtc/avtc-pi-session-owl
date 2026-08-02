// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarensenkov@gmail.com>

// The Builder run: a multi-pass convergence loop over the source graph using
// BUILDER_TOOLS, with an ensure-ready fast-path. Each pass is one agentLoop;
// the pass ends when the Builder calls try_finish (converged) or the loop stops
// (no-op / context-limit / turn cap). try_finish gates the non-obsolete root
// view against builderRootViewThreshold. At stage-end every remaining `new`
// node flushes to `active` (a flush_new graph_delta) so non-Builder consumers
// never see `new`.
//
// The run honors `signal` and owns NO run-lock (the caller — background trigger
// or compaction hook — owns the lifecycle). Partial work from a failing pass is
// KEPT (no rollback): each mutate is atomic and already persisted at call time.

import type { AgentEvent, AgentMessage } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { MemkeeperConfig } from "../config/schema.js";
import { applyFlushNew } from "../graph/mutations.js";
import { toStoreContext } from "../lifecycle.js";
import { log } from "../log.js";
import { notify } from "../notify.js";
import { BUILDER_SYSTEM } from "../prompts/builder.js";
import { runStage, type StageRunInput, type StageRunResult } from "../runtime/agent-loop.js";
import { type ConvergenceOutcome, makeConvergenceTracker, runConvergencePass } from "../runtime/convergence.js";
import { makeLedgerHook } from "../runtime/ledger-hook.js";
import { resolveStageModel } from "../runtime/model.js";
import { appendGraphDelta, getGraphStore, type StoreContext } from "../store/graph-store.js";
import type { MemkeeperGraph, NodeId } from "../types.js";
import type { WidgetController } from "../widget/tracker.js";
import { MUTATE_TOOL_NAMES, makeBuilderTools, measureRootViewTokens, renderRootView } from "./tools.js";

// --- named constants (no bare literals at call sites) ----------------------

const BUILD_STAGE = "build";
const FIRST_PASS = 1;
const NO_MUTATES = 0;
const NO_NEW_NODES = 0;
const EMPTY_ROOT_VIEW = "";

/** A per-pass outcome: applied mutate count + whether try_finish converged. */
export interface PassOutcome extends ConvergenceOutcome {}

/**
 * Build a per-pass event tracker: an `onEvent` that forwards EVERY event to the
 * downstream sink (the widget) AND inspects `tool_execution_end` to count
 * applied mutates (the five mutate tools with `details.ok === true` and not
 * `isError`) and detect try_finish convergence (`details.ok === true`). Read
 * tools and rejected mutates do not count.
 *
 * Delegates to the shared convergence tracker (the Builder and Selector share
 * the same tracking shape; only the mutate-name set differs). */
export function makePassTracker(downstream: (event: AgentEvent) => void): {
  outcome: PassOutcome;
  onEvent: (event: AgentEvent) => void;
} {
  return makeConvergenceTracker(downstream, MUTATE_TOOL_NAMES);
}

// --- run input -------------------------------------------------------------

/** Input to `runBuilder`. The run honors `signal` only — the caller owns the
 *  run-lock (background trigger releases in its IIFE; compaction holds). */
export interface BuilderRunInput {
  ctx: ExtensionContext;
  pi: ExtensionAPI;
  settings: MemkeeperConfig;
  signal: AbortSignal;
  widget: WidgetController;
  /** The compaction cut; null at turn_end. Carried for contract completeness —
   *  the Builder processes all current `new` nodes (the Observer's gap-driven
   *  catch-up scopes them to the compacted block in the default profile). */
  scope: { firstKeptEntryId: string | null } | null;
  /** Test seam — fake stage runner, or omitted for the real `runStage`. */
  runStageFn?: (input: StageRunInput) => Promise<StageRunResult>;
}

// --- the run ---------------------------------------------------------------

/**
 * Run the Builder: ensure-ready fast-path, then a multi-pass convergence loop
 * over the source graph, then a stage-end flush of `new` nodes.
 *
 * Flush semantics: `new` nodes flush to `active` only on a NORMAL
 * stage-end — fast-path skip (render-ready), try_finish convergence, no-op,
 * max-passes, or context-limit. On an ABNORMAL end (signal abort, or an error
 * that ends the run) `new` nodes STAY `new` so the next run / ensure-ready gate
 * re-processes them (the Builder didn't finish its chance). A model-unavailable
 * run never starts, so `new` nodes stay `new` there too.
 *
 * Honors `signal`; persists applied mutates + flush_new at call time. Never
 * throws — a model-unavailable skip notifies the user; a run-ending error logs
 * (the caller may surface user-facing failure). Partial work kept.
 */
export async function runBuilder(input: BuilderRunInput): Promise<void> {
  // Aborted before start → nothing to do; `new` nodes stay `new`.
  if (input.signal.aborted) return;

  const resolved = await resolveStageModel(input.ctx, input.settings.builderModel ?? input.settings.defaultModel);
  if (!resolved.ok) {
    notify(input.ctx, `Builder skipped a run: ${resolved.error}`, "warning");
    return;
  }

  const store = toStoreContext(input.pi, input.ctx);
  const graph = getGraphStore().graph;
  const runStageFn = input.runStageFn ?? runStage;

  // Ensure-ready fast-path: a root view already under the threshold is
  // render-ready — skip the LLM passes entirely, just flush `new` arrivals so
  // they never linger as stale glyphs. A deliberate skip IS a normal stage-end
  // for flush purposes. No stage is opened (no startStage).
  if (measureRootViewTokens(graph, "builder") < input.settings.builderRootViewThreshold) {
    flushNew(input.widget, store);
    return;
  }

  // Multi-pass convergence loop. startStage opens the stage (inside the try so a
  // throw still reaches the finally). The finally flushes `new` ONLY on a normal
  // stage-end (normalEnd); abort / run-ending error preserve `new`. `stageOpened`
  // guards endStage so a startStage throw can't leave an unbalanced close.
  let normalEnd = true;
  let stageOpened = false;
  let pass = FIRST_PASS;
  try {
    input.widget.startStage(BUILD_STAGE, { pass });
    stageOpened = true;
    const tools = makeBuilderTools(graph, store, input.settings);
    // eslint-disable-next-line no-constant-condition -- loop bounded by breaks below
    while (true) {
      if (input.signal.aborted) {
        normalEnd = false; // abort → preserve `new` (run ended early)
        break;
      }

      const { outcome } = await runPass(input, graph, resolved, tools, runStageFn, pass);

      // try_finish success → converged, stop (normal end).
      if (outcome.converged) break;
      // no-op pass (0 mutates, not converged) → stop (normal end).
      if (outcome.mutates === NO_MUTATES) break;

      pass += 1;
      if (pass > input.settings.maxBuilderPasses) break; // normal end (max)
      input.widget.setPass(pass);
    }
  } catch (cause) {
    // A run-ending error (error-before-any-mutate rethrown by runPass). Applied
    // mutates are already persisted; `new` nodes stay `new` (run ended early).
    normalEnd = false;
    log.error("builder run failed", cause);
  } finally {
    // Flush `new`→`active` only on a normal stage-end; abort/error preserve it.
    if (normalEnd) flushNew(input.widget, store);
    if (stageOpened) input.widget.endStage();
  }
}

// --- one pass --------------------------------------------------------------

/** Run a single Builder pass (one agentLoop) and return its outcome. A pass
 *  that THROWS is settled here: 0 applied mutates → rethrow (ends the run);
 *  ≥1 applied mutates → swallowed (counts as a finished pass, partial kept). */
async function runPass(
  input: BuilderRunInput,
  graph: ReturnType<typeof getGraphStore>["graph"],
  resolved: { model: StageRunInput["model"]; apiKey: string | undefined },
  tools: ReturnType<typeof makeBuilderTools>,
  runStageFn: (input: StageRunInput) => Promise<StageRunResult>,
  pass: number,
): Promise<{ outcome: PassOutcome }> {
  const { outcome, onEvent } = makePassTracker((event) => input.widget.onEvent(event));
  const messages = passMessages(graph, pass);
  const store = toStoreContext(input.pi, input.ctx);
  await runConvergencePass({
    systemPrompt: BUILDER_SYSTEM,
    messages,
    tools,
    model: resolved.model,
    apiKey: resolved.apiKey,
    signal: input.signal,
    onEvent,
    onStageEnd: makeLedgerHook(store, "build"),
    outcome,
    runStageFn,
    stageLabel: BUILD_STAGE,
  });
  return { outcome };
}

/** Build the per-pass user message: the task + the current root view snapshot. */
function passMessages(graph: MemkeeperGraph, pass: number): AgentMessage[] {
  const rootView = renderRootView(graph, "builder") || EMPTY_ROOT_VIEW;
  const text =
    "Organize the memory graph. Process the new arrivals and consolidate the root view to fit the budget.\n\n" +
    `Current root view (pass ${pass}):\n${rootView}`;
  return [{ role: "user", content: text } as AgentMessage];
}

// --- flush_new -------------------------------------------------------------

/** Collect all `new` nodes, apply flush_new in-memory, persist its delta. */
function flushNew(widget: WidgetController, store: StoreContext): void {
  const graph = getGraphStore().graph;
  const nodeIds: NodeId[] = [];
  for (const node of graph.nodes.values()) {
    if (node.state === "new") nodeIds.push(node.id);
  }
  if (nodeIds.length === NO_NEW_NODES) return;
  const delta = applyFlushNew(graph, { nodeIds });
  appendGraphDelta(store, delta);
  widget.render();
}
