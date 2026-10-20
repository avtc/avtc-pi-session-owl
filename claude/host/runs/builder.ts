// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// The Builder run — HOST PORT of src/builder/run.ts (the pi file
// value-imports lifecycle/notify/runtime-model, so it is not vendored). The
// multi-pass convergence loop is pi's verbatim over the port's engine seams:
// one shim runStage per pass (fresh messages each — the same one-loop-per-call
// shape as pi's runConvergencePass), the vendored Builder tool bodies bound
// per spawn through the executor layer (mutates counted at the execute seam,
// try_finish's ok-answer is the convergence signal — the event-stream tracker
// counterpart), and the relay's no-progress knob set to pi's
// CONVERGENCE_NO_PROGRESS_TURNS.
//
// Pass errors rethrow (pi's runConvergencePass behavior — the applied mutates
// are already persisted per-call, so propagating loses nothing; the caller
// surfaces it). `new` nodes flush to `active` only after a run that actually
// consolidated (try_finish convergence or ≥1 applied mutate); a no-op, a
// fast-path skip, an abort, or an error preserves them.

import type { AgentTool } from "@earendil-works/pi-agent-core";
import {
  MUTATE_TOOL_NAMES,
  makeBuilderTools,
  measureRootViewTokens,
  renderRootView,
} from "../../core/src/builder/tools.js";
import type { SessionOwlConfig } from "../../core/src/config/schema.js";
import { renderStageInputMessages } from "../../core/src/format/chunk.js";
import { renderTreeTotal } from "../../core/src/format/render.js";
import { formatTokens } from "../../core/src/format/tokens.js";
import { applyFlushNew } from "../../core/src/graph/mutations.js";
import { nonObsoleteRoots } from "../../core/src/graph/read-tools.js";
import { builderSystemPrompt } from "../../core/src/prompts/builder.js";
import { makeLedgerHook, persistLedger } from "../../core/src/runtime/ledger-hook.js";
import type { StoreContext } from "../../core/src/store/graph-store.js";
import type { NodeId } from "../../core/src/types.js";
import { type EngineStageRunInput, runStage, type StageRunResultLike } from "../../shims/pi-agent-core/index.js";
import { reassertCore } from "../core-instances.js";
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
import { recordDumpSection } from "../stage/dumps.js";
import { enableStageDumpArchive, getStageRun, takeStageDump, takeStageFatalModelError } from "../stage/runs.js";
import { bindAgentTools, type StageToolExecutor, unbindAgentTools } from "../stage/tools.js";
import { lookupModelRates } from "../usage/inputs.js";
import {
  countCompactionsFromBranch,
  isTimeoutClass,
  ModelUnavailableError,
  makeCountedExecutor,
  type PassOutcome,
  runsLog,
  type StageCore,
  type StageWidget,
} from "./seams.js";
import { StageTimeoutError } from "./stage-errors.js";

// --- named constants --------------------------------------------------------

const BUILD_STAGE = "builder" as const;
const WIDGET_STAGE = "build" as const;
const NO_NEW_NODES = 0;
const EMPTY_ROOT_VIEW = "";
const FIRST_PASS = 1;
const NO_MUTATES = 0;
/** pi's CONVERGENCE_NO_PROGRESS_TURNS: consecutive zero-mutate steps before
 *  the relay trips (read-only scouting interleaves legitimately — the
 *  Builder may examine the graph for many turns before its first change). */
const CONVERGENCE_NO_PROGRESS_TURNS = 50;

// --- run input -------------------------------------------------------------

/** Input to `runBuilder`. The run honors `signal` only — the caller owns the
 *  run-lock. `scope` is the compaction cut (null at turn_end). */
export interface BuilderRunInput {
  core: StageCore;
  store: StoreContext;
  settings: SessionOwlConfig;
  signal: AbortSignal;
  widget: StageWidget;
  /** The compaction cut; null at turn_end. */
  scope: { firstKeptEntryId: string | null } | null;
  /** True ONLY for the final post-catch-up (ensure-ready) call at compaction —
   *  the sole call eligible for the builderSkipWithinBudget fast-path. The
   *  Observer's mid-catch-up folding and every turn_end trigger run never
   *  skip: a fired trigger must run. */
  ensureReady: boolean;
  /** Test seam — fake stage runner. */
  runStageFn?: (input: EngineStageRunInput) => Promise<StageRunResultLike>;
  /** The dump seam (null/undefined = no dump — debugDumpLimit 0 or
   *  unwired).  */
  dumps?: StageDumpLocation | null;
  /** The unit-commit boundary: drained exactly once when the run ends. */
  flushLedger?: () => Promise<void>;
}

// --- the run ---------------------------------------------------------------

/**
 * Run the Builder: ensure-ready fast-path (final post-catch-up call at
 * compaction only), then a multi-pass convergence loop over the source graph,
 * then a conditional flush of `new` nodes. Honors `signal`; never flushes on
 * an abnormal end.
 */
export async function runBuilder(input: BuilderRunInput): Promise<void> {
  if (input.signal.aborted) return;

  const store = input.store;
  const core = input.core;
  // Re-pin this run's conversation before capturing the run's graph: the
  // process-global core may sit on a parallel conversation after the awaits
  // that resolved this stage (a foreign capture corrupts both directions —
  // mutations applied to/against the wrong graph).
  await reassertCore(core.key);
  const graph = core.store.getGraphStore().graph;
  // trace seam: the base view this run computes against (stale-base forensics)
  runsLog(
    `builder base: key=${core.key} nodes=${graph.nodes.size} obs=${graph.observations.size} oids=${[...graph.observations.keys()].join(",")}` +
      ` trace#${String((graph as unknown as { owlTrace?: number }).owlTrace ?? "?")}`,
  );
  const model = input.settings.builderModel ?? input.settings.defaultModel;
  const run = input.runStageFn ?? runStage;

  // Ensure-ready fast-path (builderSkipWithinBudget, final post-catch-up call
  // only — scope !== null AND ensureReady): under the threshold the view is
  // render-ready — skip the LLM passes and PRESERVE `new` (the each-N trigger
  // keeps its pending work). The Observer's mid-catch-up folding never takes
  // it: folding the accumulated `new` roots during a long catch-up is what
  // keeps it bounded.
  if (input.signal.aborted) return;
  if (
    input.scope !== null &&
    input.ensureReady &&
    input.settings.builderSkipWithinBudget &&
    measureRootViewTokens(graph) < input.settings.builderRootViewThreshold
  ) {
    return;
  }

  let normalEnd = true;
  let stageOpened = false;
  let pass = FIRST_PASS;
  let totalMutates = NO_MUTATES;
  let converged = false;
  const ledger = makeLedgerHook(WIDGET_STAGE);
  const dumpHandle =
    input.dumps !== undefined && input.dumps !== null && input.settings.debugDumpLimit > 0
      ? openStageDump(BUILD_STAGE, input.settings.debugDumpLimit, { ...input.dumps, now: Date.now() })
      : null;
  enableStageDumpArchive(BUILD_STAGE, dumpHandle !== null);
  let toolsForDump: AgentTool[] = [];
  let headerWritten = false;
  // computed once per run — the source graph + the session branch are stable
  // across passes (only the working graph mutates): pi's countCompactions fold.
  const compactionCount = countCompactionsFromBranch(store);
  try {
    input.widget.startStage(WIDGET_STAGE, { pass });
    stageOpened = true;
    const tools: AgentTool[] = makeBuilderTools(graph, store, input.settings);
    toolsForDump = tools;
    const builderInput: EngineStageRunInput = {
      stage: BUILD_STAGE,
      systemPrompt: builderSystemPrompt(input.settings),
      messages: [],
      model,
      signal: input.signal,
      maxTokens: input.settings.builderMaxTokens,
      timeoutMs: input.settings.llmCallTimeoutMs,
      noProgressTurns: CONVERGENCE_NO_PROGRESS_TURNS,
      onEvent: (event) => input.widget.onEvent(event as never),
      onStageEnd: null,
      modelRates: lookupModelRates,
      dumpPath: null,
      onSpawn: null,
    };
    while (true) {
      if (input.signal.aborted) {
        normalEnd = false; // abort → preserve `new` (run ended early)
        break;
      }

      const outcome: PassOutcome = { mutates: NO_MUTATES, converged: false, timedOut: false };
      const agentRef = { id: null as string | null };
      const passInput: EngineStageRunInput = {
        ...builderInput,
        onStageEnd: ledger.onStageEnd as unknown as EngineStageRunInput["onStageEnd"],
        messages: passMessages(graph, pass, compactionCount, input.settings),
        onSpawn: (agentId) => {
          agentRef.id = agentId;
          const bodies: Record<string, StageToolExecutor> = {};
          for (const tool of tools) bodies[tool.name] = makeCountedExecutor(tool, outcome, agentRef, MUTATE_TOOL_NAMES);
          bindAgentTools(agentId, bodies);
          const runState = getStageRun(agentId);
          if (runState !== undefined) recordDumpSection(runState, `<pass n="${pass}">\n`);
        },
      };
      let result: StageRunResultLike;
      try {
        if (dumpHandle !== null && input.dumps !== undefined && input.dumps !== null) {
          // the header once, then EVERY pass's input PRE-CALL (pi's
          // durability: a call that dies still leaves its input record)
          if (!headerWritten) {
            headerWritten = true;
            const placed = await appendHeaderDurable(
              input.dumps.fs,
              dumpHandle,
              stageDumpHeader(BUILD_STAGE, dumpHandle.startedIso, builderSystemPrompt(input.settings), toolsForDump, {
                session: dumpHandle.session,
                agent: dumpHandle.agent,
              }),
            );
            if (!placed) runsLog("builder dump header not placed after retry");
          }
          await appendDump(
            input.dumps.fs,
            dumpHandle,
            `<input>
${renderStageInputMessages(passInput.messages as unknown as Parameters<typeof renderStageInputMessages>[0])}
</input>
`,
          );
        }
        result = await run(passInput);
        if (result.timedOut) outcome.timedOut = true;
      } finally {
        // unbind only — the pass's dump section closes at completion
        // (completeStageRun flushes the opener's pendingCloser)
        if (agentRef.id !== null) unbindAgentTools(agentRef.id);
      }
      totalMutates += outcome.mutates;
      if (ledger.hasUsage()) persistLedger(store);
      // the pass's rows/sections drain NOW (per-pass durability)
      if (dumpHandle !== null && input.dumps !== undefined && input.dumps !== null) {
        try {
          await appendRunParts(
            input.dumps.fs,
            dumpHandle,
            partsFromArchive(takeStageDump(BUILD_STAGE) ?? EMPTY_ARCHIVE),
          );
        } catch (drainErr) {
          runsLog("builder dump drain failed", drainErr);
        }
      }

      if (outcome.converged) {
        converged = true;
        break;
      }
      // a per-LLM-call timeout or a relay timeout-class abort — pi's
      // StageTimeoutError path (skip-and-notify at the caller).
      const fatalModel = takeStageFatalModelError(BUILD_STAGE);
      if (fatalModel !== null) throw new ModelUnavailableError(fatalModel);
      if (outcome.timedOut || isTimeoutClass(result, input.signal)) {
        throw new StageTimeoutError("Builder", input.settings.llmCallTimeoutMs);
      }
      // no-op pass (0 mutates, not converged) → stop (normal end).
      if (outcome.mutates === NO_MUTATES) break;

      pass += 1;
      if (pass > input.settings.maxBuilderPasses) break; // normal end (max)
      input.widget.setPass(pass);
    }
  } catch (cause) {
    // Applied mutates are already persisted; `new` stays `new`.
    normalEnd = false;
    runsLog("builder run failed", cause);
    throw cause;
  } finally {
    // unit boundary: the run drains its buffered mutations exactly once
    // (success, error, or abort) — a failed flush logs and retries at the
    // next boundary (the buffer survives flush failures)
    if (input.flushLedger !== undefined) {
      try {
        await input.flushLedger();
      } catch (flushErr) {
        runsLog("builder unit flush failed", flushErr);
      }
    }
    try {
      if (normalEnd && (converged || totalMutates > NO_MUTATES)) flushNew(input.widget, core, graph, store);
    } catch (cleanupErr) {
      runsLog("builder stage teardown cleanup failed", cleanupErr);
    }
    if (stageOpened) {
      try {
        input.widget.endStage();
      } catch (endErr) {
        runsLog("builder endStage failed", endErr);
      }
    }
    if (dumpHandle !== null && headerWritten && input.dumps !== undefined && input.dumps !== null) {
      try {
        // the final drain + footer (header, inputs, and earlier passes landed)
        await flushRunDump(input.dumps.fs, dumpHandle, partsFromArchive(takeStageDump(BUILD_STAGE) ?? EMPTY_ARCHIVE));
      } catch (dumpErr) {
        runsLog("builder dump flush failed", dumpErr);
      }
    }
  }
}

/** Build the per-pass user message: the task + the current root view snapshot
 *  + the source-tree totals (pi's passMessages verbatim). */
function passMessages(
  graph: Parameters<typeof renderRootView>[0],
  pass: number,
  compactionCount: number,
  settings: SessionOwlConfig,
): EngineStageRunInput["messages"] {
  const rootView = renderRootView(graph) || EMPTY_ROOT_VIEW;
  const roots = nonObsoleteRoots(graph).length;
  const nodePart =
    settings.rootViewTargetNodes === null ? `${roots} nodes` : `${roots}/${settings.rootViewTargetNodes} nodes`;
  const text =
    "Organize the memory graph. Process the new arrivals and consolidate the root view to fit the budget. " +
    `Root view: ${nodePart}, ${formatTokens(measureRootViewTokens(graph))}/${formatTokens(settings.builderRootViewThreshold)} tokens.\n\n` +
    `Current root view (pass ${pass}):\n${rootView}\n${renderTreeTotal(graph, compactionCount)}`;
  return [{ role: "user", content: text }];
}

/** Collect all `new` nodes, apply flush_new in-memory, persist its delta.
 *  `graph` is the run's CAPTURED graph — never a live re-read of the
 *  process-global (a parallel swap between passes must not flip which graph
 *  this final flush touches). */
function flushNew(
  widget: StageWidget,
  core: StageCore,
  graph: ReturnType<StageCore["store"]["getGraphStore"]>["graph"],
  store: StoreContext,
): void {
  const nodeIds: NodeId[] = [];
  for (const node of graph.nodes.values()) {
    if (node.state === "new") nodeIds.push(node.id);
  }
  if (nodeIds.length === NO_NEW_NODES) return;
  const delta = applyFlushNew(graph, { nodeIds });
  core.store.appendGraphDelta(store, delta);
  widget.render();
}
