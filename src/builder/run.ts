// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// The Builder run: a multi-pass convergence loop over the source graph using
// BUILDER_TOOLS, with an ensure-ready fast-path. Each pass is one agentLoop;
// the pass ends when the Builder calls try_finish (converged) or the loop stops
// (no-op / context-limit / turn cap). try_finish gates the non-obsolete root
// view against builderRootViewThreshold. `new` nodes flush to `active` only
// after a run that actually consolidated (converged or ≥1 applied mutate); a
// no-op or fast-path-skipped run preserves them for the next trigger (🆕 is a
// Builder-only glyph — non-Builder consumers never render it).
//
// The run honors `signal` and owns NO run-lock (the caller — background trigger
// or compaction hook — owns the lifecycle). Partial work from a failing pass is
// KEPT (no rollback): each mutate is atomic and already persisted at call time.

import type { AgentEvent, AgentMessage } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { MemkeeperConfig } from "../config/schema.js";
import { BUILDER, renderTreeTotal } from "../format/render.js";
import { applyFlushNew } from "../graph/mutations.js";
import { toStoreContext } from "../lifecycle.js";
import { log } from "../log.js";
import { BUILDER_SYSTEM } from "../prompts/builder.js";
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
import { appendGraphDelta, getGraphStore, type StoreContext } from "../store/graph-store.js";
import type { MemkeeperGraph, NodeId } from "../types.js";
import type { WidgetController } from "../widget/tracker.js";
import { MUTATE_TOOL_NAMES, makeBuilderTools, measureRootViewTokens, renderRootView } from "./tools.js";

// --- named constants (no bare literals at call sites) ----------------------

const BUILD_STAGE = "build" as const;
const NO_NEW_NODES = 0;
const EMPTY_ROOT_VIEW = "";

/** Build a per-pass event tracker: forwards every event to the downstream
 *  sink (widget) and inspects `tool_execution_end` to count applied Builder
 *  mutates + detect try_finish convergence. Delegates to the shared
 *  convergence tracker (Builder/Selector share the same shape; only the
 *  mutate-name set differs). */
export function makeBuilderPassTracker(downstream: (event: AgentEvent) => void): {
  outcome: ConvergenceOutcome;
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
  /** The compaction cut; null at turn_end. Carried for contract completeness
   *  (the Observer uses it for its gap-driven catch-up). The Builder ignores it:
   *  at compaction it processes ALL `new` nodes across the whole graph, not just
   *  the compacted block. */
  scope: { firstKeptEntryId: string | null } | null;
  /** Test seam — fake stage runner, or omitted for the real `runStage`. */
  runStageFn?: (input: StageRunInput) => Promise<StageRunResult>;
}

// --- the run ---------------------------------------------------------------

/**
 * Run the Builder: ensure-ready fast-path, then a multi-pass convergence loop
 * over the source graph, then a conditional stage-end flush of `new` nodes.
 *
 * Flush semantics: `new` nodes flush to `active` only when the run ended
 * NORMALLY and actually consolidated — try_finish convergence or ≥1 applied
 * mutate (covers max-passes / context-limit runs that did work). A no-op run
 * (0 mutates, not converged), a fast-path skip (builderSkipWithinBudget, root
 * view under threshold), an ABNORMAL end (signal abort, or an error that ends
 * the run), and a model-unavailable skip all PRESERVE `new` — a build that
 * folded nothing must not discharge the each-N trigger's pending arrivals;
 * they retry on the next fire. `new` renders as 🆕 for the Builder viewer only,
 * so the Selector and the compaction summary are unaffected either way.
 *
 * Honors `signal`; persists applied mutates + flush_new at call time. Never
 * throws — a model-unavailable skip notifies the user; a run-ending error logs
 * (the caller may surface user-facing failure). Partial work kept.
 */
export async function runBuilder(input: BuilderRunInput): Promise<void> {
  // Aborted before start → nothing to do; `new` nodes stay `new`.
  if (input.signal.aborted) return;

  const resolved = await resolveStageModelOrNotify(
    input.ctx,
    "Builder",
    input.settings.builderModel ?? input.settings.defaultModel,
  );
  if (!resolved.ok) {
    return;
  }

  const store = toStoreContext(input.pi, input.ctx);
  const graph = getGraphStore().graph;
  const runStageFn = input.runStageFn ?? runStage;

  // Ensure-ready fast-path (opt-in via builderSkipWithinBudget): when the
  // root view is already under the threshold it is render-ready — skip the
  // LLM passes entirely and PRESERVE `new` arrivals (no flush: nothing was
  // folded, so the each-N trigger keeps its pending work and retries on the
  // next fire — a skip must not silently discharge the consolidation duty).
  // No stage is opened (no startStage). Default off — the Builder always runs
  // at least one pass. Re-check abort after the model-resolution await:
  // compaction may have signalled during it, and abort must preserve `new`
  // (mirrors the convergence-loop guard).
  if (input.signal.aborted) return;
  if (
    input.settings.builderSkipWithinBudget &&
    measureRootViewTokens(graph, BUILDER) < input.settings.builderRootViewThreshold
  ) {
    return;
  }

  // Multi-pass convergence loop. startStage opens the stage (inside the try so a
  // throw still reaches the finally). The finally flushes `new` ONLY on a normal
  // stage-end (normalEnd); abort / run-ending error preserve `new`. `stageOpened`
  // guards endStage so a startStage throw can't leave an unbalanced close.
  let normalEnd = true;
  let stageOpened = false;
  let pass = FIRST_PASS;
  let totalMutates = NO_MUTATES;
  let converged = false;
  const ledger = makeLedgerHook(BUILD_STAGE);
  try {
    input.widget.startStage(BUILD_STAGE, { pass });
    stageOpened = true;
    const tools = makeBuilderTools(graph, store, input.settings);
    // computed once per run — the source graph + the session branch are stable
    // across passes (only the working graph mutates).
    const compactionCount = countCompactions(input.ctx.sessionManager);
    // convergence loop — bounded by the break conditions below (budget met / no-op / context limit / signal)
    while (true) {
      if (input.signal.aborted) {
        normalEnd = false; // abort → preserve `new` (run ended early)
        break;
      }

      const { outcome } = await runPass(
        input,
        graph,
        resolved,
        tools,
        runStageFn,
        pass,
        compactionCount,
        ledger.onStageEnd,
      );
      totalMutates += outcome.mutates;
      // persist the cumulative usage ledger PER PASS so an interrupted run keeps
      // the usage tally for every completed pass — matching the per-mutate
      // durability of the graph deltas (the two stay consistent).
      if (ledger.hasUsage()) persistLedger(store);

      // try_finish success → converged, stop (normal end).
      if (outcome.converged) {
        converged = true;
        break;
      }
      // a per-LLM-call timeout — a stage-stopping error: THROW so the compaction
      // hook cancels compaction + surfaces a visible error (a slow/oversized
      // Builder call must not silently produce a partial/wrong summary).
      if (outcome.timedOut) {
        throw new StageTimeoutError("Builder", input.settings.llmCallTimeoutMs);
      }
      // no-op pass (0 mutates, not converged) → stop (normal end).
      if (outcome.mutates === NO_MUTATES) break;

      pass += 1;
      if (pass > input.settings.maxBuilderPasses) break; // normal end (max)
      input.widget.setPass(pass);
    }
  } catch (cause) {
    // Propagate the error (timeout / LLM failure / server down) so the
    // compaction hook cancels compaction + notifies the user. Applied mutates
    // are already persisted; `new` nodes stay `new` (run ended early).
    normalEnd = false;
    log.error("builder run failed", cause);
    throw cause;
  } finally {
    // Best-effort teardown: a throw in one cleanup must not skip the others or
    // escape (the never-throws teardown contract). `endStage` always runs when a
    // stage opened so the widget never gets stuck showing a stage.
    try {
      // Flush `new`→`active` only when the run ended normally AND actually
      // consolidated (converged via try_finish, or ≥1 applied mutate). A no-op
      // run folded nothing — its arrivals stay `new` and retry on the next
      // trigger; abort/error preserve `new` as before.
      if (normalEnd && (converged || totalMutates > NO_MUTATES)) flushNew(input.widget, store);
    } catch (cleanupErr) {
      log.error("builder stage teardown cleanup failed", cleanupErr);
    }
    if (stageOpened) {
      try {
        input.widget.endStage();
      } catch (endErr) {
        log.error("builder endStage failed", endErr);
      }
    }
  }
}

// --- one pass --------------------------------------------------------------

/** Run a single Builder pass (one agentLoop) and return its outcome. A pass
 *  that THROWS is settled here: 0 applied mutates → rethrow (ends the run);
 *  ≥1 applied mutates → swallowed (counts as a finished pass, partial kept). */
async function runPass(
  input: BuilderRunInput,
  graph: MemkeeperGraph,
  resolved: { model: StageRunInput["model"]; apiKey: string | undefined },
  tools: ReturnType<typeof makeBuilderTools>,
  runStageFn: (input: StageRunInput) => Promise<StageRunResult>,
  pass: number,
  compactionCount: number,
  onStageEnd: (usage: StageUsage) => void,
): Promise<{ outcome: ConvergenceOutcome }> {
  const { outcome, onEvent } = makeBuilderPassTracker((event) => input.widget.onEvent(event));
  const messages = passMessages(graph, pass, compactionCount);
  await runConvergencePass({
    systemPrompt: BUILDER_SYSTEM,
    messages,
    tools,
    model: resolved.model,
    apiKey: resolved.apiKey,
    signal: input.signal,
    maxTokens: input.settings.builderMaxTokens,
    timeoutMs: input.settings.llmCallTimeoutMs,
    reasoning: resolveStageReasoning(
      input.settings.builderThinkingLevel,
      input.settings.defaultThinkingLevel,
      input.ctx.thinkingLevel,
    ),
    onEvent,
    onStageEnd,
    outcome,
    runStageFn,
    stageLabel: BUILD_STAGE,
  });
  return { outcome };
}

/** Build the per-pass user message: the task + the current root view snapshot
 *  + the source-tree totals (the scale behind the view). */
function passMessages(graph: MemkeeperGraph, pass: number, compactionCount: number): AgentMessage[] {
  const rootView = renderRootView(graph, BUILDER) || EMPTY_ROOT_VIEW;
  const text =
    "Organize the memory graph. Process the new arrivals and consolidate the root view to fit the budget.\n\n" +
    `Current root view (pass ${pass}):\n${rootView}\n${renderTreeTotal(graph, compactionCount)}`;
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
