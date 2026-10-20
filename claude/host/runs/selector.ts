// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// The Selector run — HOST PORT of src/selector/run.ts (the pi file
// value-imports lifecycle surfaces, so it is not vendored). The orchestration
// is pi's verbatim over the port's seams: the working copy + context view
// come from the input-view port, the toolset from the selector-tools port
// (bound per spawn through the executor layer, mutates counted at the
// execute seam, try_finish ok = convergence), and the tree persists ONCE at
// run completion — on convergence / no-op / max, on error, AND on an abort
// mid-run (committed partial work is kept); an abort before start leaves no
// working copy and persists nothing.

import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { SessionOwlConfig } from "../../core/src/config/schema.js";
import { renderStageInputMessages } from "../../core/src/format/chunk.js";
import { renderTreeTotal } from "../../core/src/format/render.js";
import { formatTokens } from "../../core/src/format/tokens.js";
import { measureRootViewTokens, nonObsoleteRoots, renderRootViewFromRoots } from "../../core/src/graph/read-tools.js";
import { selectorSystemPrompt } from "../../core/src/prompts/selector.js";
import { makeLedgerHook, persistLedger } from "../../core/src/runtime/ledger-hook.js";
import { encodeSelection } from "../../core/src/store/codecs.js";
import type { StoreContext } from "../../core/src/store/graph-store.js";
import type { TodoBridge, TodoContext } from "../../core/src/todo/types.js";
import { estimateContentTokens, O_INITIAL_PROMPT } from "../../core/src/types.js";
import { type EngineStageRunInput, runStage, type StageRunResultLike } from "../../shims/pi-agent-core/index.js";
import { type CoreHandle, reassertCore } from "../core-instances.js";
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
  type SelectedCountsProvider,
  type StageCore,
  type StageWidget,
} from "./seams.js";
import {
  buildSelectorInputView,
  renderWorkingRoots,
  type SelectorInputView,
  type TailContext,
} from "./selector-input-view.js";
import { makeSelectorGraphTools, makeTodoListTool, SELECTOR_MUTATE_TOOL_NAMES } from "./selector-tools.js";
import { StageTimeoutError } from "./stage-errors.js";

// --- named constants --------------------------------------------------------

const SELECT_STAGE = "selector" as const;
const WIDGET_STAGE = "select" as const;
const NO_PROMPT_OBS = null;
const INDEX_NOT_FOUND = -1;
const PREV_ENTRY = 1; // prev(firstKeptEntryId) = firstKeptEntryId position − 1
const FIRST_PASS = 1;
const NO_MUTATES = 0;
/** pi's CONVERGENCE_NO_PROGRESS_TURNS for the Selector loop (the Builder
 *  value — long read-only scouting interleaves legitimately). */
const CONVERGENCE_NO_PROGRESS_TURNS = 50;

// --- run input -------------------------------------------------------------

/** Input to `runSelector`. The run honors `signal` only — the caller owns the
 *  run-lock. */
export interface SelectorRunInput {
  core: StageCore;
  store: StoreContext;
  settings: SessionOwlConfig;
  signal: AbortSignal;
  widget: StageWidget;
  /** The compaction cut; null at mid-session. */
  scope: { firstKeptEntryId: string | null } | null;
  /** The (optional) todo context for the input-view's todo section; null omits it. */
  todo: TodoContext | null;
  /** The (optional) todo bridge — appends the conditional todo_list tool
   *  (pi's makeSelectorTools parity; null = no tool). */
  todoBridge?: TodoBridge | null;
  /** The active branch as pi-shaped entries (host seam: the capture layer's
   *  entry view over the storage rows — the store's own branch serves row
   *  markers, which carry ids but not message payloads; the tail + touched
   *  files + cache checks read THIS). */
  readBranch: () => SessionEntry[];
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
 * Run the Selector: cached-tree fast-path, then a multi-pass convergence
 * loop over the working copy, then persist the resulting selected tree once.
 */
export async function runSelector(input: SelectorRunInput): Promise<void> {
  if (input.signal.aborted) return;

  const store = input.store;
  const core = input.core;
  // Re-pin before capturing the live store state (cross-key window after the
  // awaits that resolved this stage).
  await reassertCore(core.key);
  const graphStore = core.store.getGraphStore();
  const model = input.settings.selectorModel ?? input.settings.defaultModel;
  const run = input.runStageFn ?? runStage;

  if (input.signal.aborted) return;

  // Ensure-ready fast-path: a cached tree that still covers the compacted-away
  // block (compaction) or the current frontier (background) is reused.
  if (canReuseCachedTree(graphStore, input.readBranch(), input.scope?.firstKeptEntryId ?? null)) {
    // unit boundary upheld even on the idle fast path (an empty buffer is a
    // no-op write)
    if (input.flushLedger !== undefined) {
      try {
        await input.flushLedger();
      } catch (flushErr) {
        runsLog("selector unit flush failed", flushErr);
      }
    }
    return;
  }

  // Build the input-view once (the working copy + task context); the context
  // is stable across passes, only the working-tree section re-renders.
  const tail: TailContext = { getBranch: () => input.readBranch(), getLeafId: () => store.getLeafId() };
  const { contextView, workingCopy } = buildSelectorInputView({
    sourceGraph: graphStore.graph,
    tail,
    tailBoundary: { firstKeptEntryId: input.scope?.firstKeptEntryId ?? null },
    todo: input.todo,
    touchedFiles: tail,
    sinceEntryId: input.scope?.firstKeptEntryId ?? null,
    chunkOptions: {
      tokenThreshold: input.settings.observerThresholdTokens,
      toolBlockCapTokens: input.settings.observerToolBlockCapTokens,
      includeThinking: input.settings.observerIncludeThinking,
      includeEntryId: false,
    },
  });
  const treeTotal = renderTreeTotal(graphStore.graph, countCompactionsFromBranch(store));

  let stageOpened = false;
  let pass = FIRST_PASS;
  const ledger = makeLedgerHook(WIDGET_STAGE);
  const dumpHandle =
    input.dumps !== undefined && input.dumps !== null && input.settings.debugDumpLimit > 0
      ? openStageDump(SELECT_STAGE, input.settings.debugDumpLimit, { ...input.dumps, now: Date.now() })
      : null;
  enableStageDumpArchive(SELECT_STAGE, dumpHandle !== null);
  let toolsForDump: AgentTool[] = [];
  let headerWritten = false;
  try {
    input.widget.startStage(WIDGET_STAGE, {
      pass,
      selectedCounts: makeSelectedCountsProvider(workingCopy.graph),
    });
    stageOpened = true;
    const tools: AgentTool[] = makeSelectorGraphTools(workingCopy, input.settings);
    if (input.todoBridge !== undefined && input.todoBridge !== null) tools.push(makeTodoListTool(input.todoBridge));
    toolsForDump = tools;
    const baseInput: EngineStageRunInput = {
      stage: SELECT_STAGE,
      systemPrompt: selectorSystemPrompt(input.settings),
      messages: [],
      model,
      signal: input.signal,
      maxTokens: input.settings.selectorMaxTokens,
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
        break; // abort → run ended early (the copy still commits)
      }

      const outcome: PassOutcome = { mutates: NO_MUTATES, converged: false, timedOut: false };
      const agentRef = { id: null as string | null };
      const passInput: EngineStageRunInput = {
        ...baseInput,
        messages: passMessages(workingCopy, contextView, pass, treeTotal, input.settings),
        onStageEnd: ledger.onStageEnd as unknown as EngineStageRunInput["onStageEnd"],
        onSpawn: (agentId) => {
          agentRef.id = agentId;
          const bodies: Record<string, StageToolExecutor> = {};
          for (const tool of tools)
            bodies[tool.name] = makeCountedExecutor(tool, outcome, agentRef, SELECTOR_MUTATE_TOOL_NAMES);
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
              stageDumpHeader(SELECT_STAGE, dumpHandle.startedIso, selectorSystemPrompt(input.settings), toolsForDump, {
                session: dumpHandle.session,
                agent: dumpHandle.agent,
              }),
            );
            if (!placed) runsLog("selector dump header not placed after retry");
          }
          await appendDump(
            input.dumps.fs,
            dumpHandle,
            `<input>\n${renderStageInputMessages(passInput.messages as unknown as Parameters<typeof renderStageInputMessages>[0])}\n</input>\n`,
          );
        }
        result = await run(passInput);
        if (result.timedOut) outcome.timedOut = true;
      } finally {
        // unbind only — the pass's dump section closes at completion
        // (completeStageRun flushes the opener's pendingCloser)
        if (agentRef.id !== null) unbindAgentTools(agentRef.id);
      }
      if (ledger.hasUsage()) persistLedger(store);
      // the pass's rows/sections drain NOW (per-pass durability — a crash in
      // a LATER pass keeps this one's dump content)
      if (dumpHandle !== null && input.dumps !== undefined && input.dumps !== null) {
        try {
          await appendRunParts(
            input.dumps.fs,
            dumpHandle,
            partsFromArchive(takeStageDump(SELECT_STAGE) ?? EMPTY_ARCHIVE),
          );
        } catch (drainErr) {
          runsLog("selector dump drain failed", drainErr);
        }
      }

      if (outcome.converged) break;
      const fatalModel = takeStageFatalModelError(SELECT_STAGE);
      if (fatalModel !== null) throw new ModelUnavailableError(fatalModel);
      if (outcome.timedOut || isTimeoutClass(result, input.signal)) {
        throw new StageTimeoutError("Selector", input.settings.llmCallTimeoutMs);
      }
      if (outcome.mutates === NO_MUTATES) break;

      pass += 1;
      if (pass > input.settings.maxSelectorPasses) break; // max
      input.widget.setPass(pass);
    }
  } catch (cause) {
    runsLog("selector run failed", cause);
    throw cause;
  } finally {
    // unit boundary: the run drains its buffered mutations exactly once
    // (success, error, or abort) — a failed flush logs and retries at the
    // next boundary (the buffer survives flush failures)
    if (input.flushLedger !== undefined) {
      try {
        await input.flushLedger();
      } catch (flushErr) {
        runsLog("selector unit flush failed", flushErr);
      }
    }
    try {
      // Persist the resulting tree whenever a stage opened (a working copy
      // exists) — on convergence / no-op / max, on error, AND on abort mid-run:
      // the copy is the best available curation and committing keeps
      // owl_recall's target alive.
      if (stageOpened) persistResult(core, store, workingCopy.graph);
    } catch (cleanupErr) {
      runsLog("selector stage teardown cleanup failed", cleanupErr);
    }
    if (stageOpened) {
      try {
        input.widget.endStage();
      } catch (endErr) {
        runsLog("selector endStage failed", endErr);
      }
    }
    if (dumpHandle !== null && headerWritten && input.dumps !== undefined && input.dumps !== null) {
      try {
        // the final drain + footer (header, inputs, and earlier passes landed).
        // headerWritten guards a run that ended BEFORE its first call — a
        // footer-only append would claim a slot and evict the oldest REAL
        // dump (pi guards the same way in every run module)
        await flushRunDump(input.dumps.fs, dumpHandle, partsFromArchive(takeStageDump(SELECT_STAGE) ?? EMPTY_ARCHIVE));
      } catch (dumpErr) {
        runsLog("selector dump flush failed", dumpErr);
      }
    }
  }
}

/** Build the per-pass user message: the task + the CURRENT working-tree
 *  render + the stable context (pi's passMessages verbatim, folded into the
 *  render helpers). */
function passMessages(
  working: SelectorInputView["workingCopy"],
  contextView: string,
  pass: number,
  treeTotal: string,
  settings: SessionOwlConfig,
): EngineStageRunInput["messages"] {
  const workingTree = renderWorkingRoots(working);
  const roots = nonObsoleteRoots(working.graph).length;
  const nodePart =
    settings.rootViewTargetNodes === null ? `${roots} nodes` : `${roots}/${settings.rootViewTargetNodes} nodes`;
  const text =
    `Shape the active-set for the current task (pass ${pass}). Promote what matters, demote what doesn't into nIrrelevant, consolidate and condense to fit the budget. ` +
    `Root view: ${nodePart}, ${formatTokens(measureRootViewTokens(working.graph))}/${formatTokens(settings.selectorRootViewThreshold)} tokens.\n\n` +
    `Working tree\n\n${workingTree}\n${treeTotal}\n\n${contextView}`;
  return [{ role: "user", content: text }];
}

/** Reuse the cached tree when it exists and still covers the current
 *  observation frontier (pi's canReuseCachedTree, branch-position math). */
function canReuseCachedTree(
  graphStore: ReturnType<CoreHandle["store"]["getGraphStore"]>,
  branch: readonly SessionEntry[],
  firstKeptEntryId: string | null,
): boolean {
  const cached = graphStore.selectedTree;
  if (cached === null) return false; // nothing cached → build
  if (firstKeptEntryId === null) {
    return cached.coveredFrontier === graphStore.observerFrontier;
  }
  if (cached.coveredFrontier === null) return false; // legacy tree → rebuild
  const cutIndex = branch.findIndex((entry) => entry.id === firstKeptEntryId);
  if (cutIndex === INDEX_NOT_FOUND) return false; // cut absent → rebuild (safe)
  const lastCompactedIndex = cutIndex - PREV_ENTRY;
  const coveredIndex = branch.findIndex((entry) => entry.id === cached.coveredFrontier);
  if (coveredIndex === INDEX_NOT_FOUND) return false; // coveredFrontier stale → rebuild
  return coveredIndex >= lastCompactedIndex;
}

/** Persist the working copy as a self-contained selected-tree snapshot. */
function persistResult(
  core: CoreHandle,
  store: StoreContext,
  workingGraph: Parameters<typeof encodeSelection>[0],
): void {
  const graphStore = core.store.getGraphStore();
  const oInitialPromptId = workingGraph.observations.has(O_INITIAL_PROMPT) ? O_INITIAL_PROMPT : NO_PROMPT_OBS;
  const snapshot = encodeSelection(workingGraph, oInitialPromptId, graphStore.observerFrontier);
  core.store.persistSelectedTree(store, snapshot);
}

/** Build the live selected-counts provider over the working copy (pi's
 *  makeSelectedCountsProvider — the working-tree render's token estimate). */
function makeSelectedCountsProvider(workingGraph: SelectorInputView["workingCopy"]["graph"]): SelectedCountsProvider {
  return () => {
    const roots = nonObsoleteRoots(workingGraph);
    return {
      count: roots.length,
      viewTokens: estimateContentTokens(renderRootViewFromRoots(roots, workingGraph.observations)),
    };
  };
}
