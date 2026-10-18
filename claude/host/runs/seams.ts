// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// The run modules' shared seams — spelled import-free so they sit inside the
// hooks closure wherever the wiring lands:
//
//   StageWidget  the widget surface the runs drive (pi's WidgetController
//               subset; the widget port implements it over the engine's
//               ui.render band + $.ui.status fallback — the same method
//               contract pi's tracker publishes);
//   StageNotify  pi's notify(ctx, message, level) transport — the ui.log
//               adapter the binding wires in (loggerNotify stays the
//               logger-only default for callers without a surface);
//               messages + levels are pi's verbatim;
//   runsLog      the runs' log seam (see below);
//   the shared convergence primitives (makeCountedExecutor, isTimeoutClass,
//   countCompactionsFromBranch) — the host counterpart of pi's shared
//   runtime/convergence.ts: the Builder and Selector runs consume the same
//   counting/classification bodies, differing only in their mutate-name set.
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { StoreContext, StoreEntry } from "../../core/src/store/graph-store.js";
import type { StageRunResultLike } from "../../shims/pi-agent-core/index.js";
import type { NotifyLevel } from "../notify/adapter.js";

export type { NotifyLevel };

import type { CoreHandle } from "../core-instances.js";
import { noteAccepted } from "../stage/runs.js";
import type { StageToolExecutor } from "../stage/tools.js";

const TRY_FINISH_TOOL = "try_finish";

/** Wrap one vendored tool as a stage executor, counting applied mutates +
 *  try_finish convergence into the pass outcome (the port's counterpart of
 *  pi's event-stream convergence tracker — the counts land at the same
 *  apply-then-persist seam the events reported). The two runs differ only
 *  in their mutate-tool name set. */
export function makeCountedExecutor(
  tool: AgentTool,
  outcome: PassOutcome,
  agentRef: { id: string | null },
  mutateNames: ReadonlySet<string>,
): StageToolExecutor {
  return async (e) => {
    const toolCallId = typeof e.tool_call_id === "string" ? e.tool_call_id : "";
    try {
      const result = (await tool.execute(toolCallId, e as never)) as {
        details?: { ok?: boolean };
        isError?: boolean;
      };
      const ok = result?.details?.ok === true;
      if (ok && tool.name === TRY_FINISH_TOOL) {
        outcome.converged = true;
        const agentId = agentRef.id;
        if (agentId !== null) noteAccepted(agentId, 1); // progress: the gate answered
      } else if (ok && !result.isError && mutateNames.has(tool.name)) {
        outcome.mutates += 1;
        const agentId = agentRef.id;
        if (agentId !== null) noteAccepted(agentId, 1);
      }
      // The engine validates a tool.call answer against its output shape:
      // with no declared output schema the result must be a STRING (or
      // content-block array) — an OBJECT answer is REJECTED as
      // "does not match its output shape" and the call retried forever. The
      // counting reads the object; the model reads the text.
      return { result: toolResultText(result) };
    } catch (err) {
      // a throwing tool body = pi's isError tool result: the model reads the
      // error, the pass continues, the mutate does not count
      const message = err instanceof Error ? err.message : String(err);
      return { result: `Error: ${message}` };
    }
  };
}

/** The model-facing text of a pi tool result: its content blocks' text
 *  joined, a bare string as-is, anything else its JSON (never an object —
 *  the engine's default output shape rejects objects). */
export function toolResultText(result: unknown): string {
  if (typeof result === "string") return result;
  const content = (result as { content?: unknown }).content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const text = content
      .map((b) => (typeof (b as { text?: unknown }).text === "string" ? (b as { text: string }).text : ""))
      .join("");
    if (text !== "") return text;
  }
  return JSON.stringify(result);
}

/** pi's WidgetStage: the three maintenance stages the tracker displays. */
export type WidgetStage = "observe" | "build" | "select";

/** An observe-style batch counter (done/total chunks or batches). */
export interface BatchProgress {
  done: number;
  total: number;
}

/** Live selected-counts pull (the Selector's working copy). */
export type SelectedCountsProvider = () => { count: number; viewTokens: number };

/** One agent event the widget consumes (structural — the tracker reads
 *  message_end/message_update; the port derives them from rows). */
export interface WidgetAgentEvent {
  type: string;
  [field: string]: unknown;
}

/** The widget surface the stage runs drive (pi's StageController +
 *  render()). The widget port implements this over the engine's surfaces;
 *  tests use the recorder or NO_OP_WIDGET. */
export interface StageWidget {
  /** Begin a stage, optionally seeding its pass/batch; snapshots the
   *  baseline. An omitted batch preserves an in-flight observe batch (the
   *  mid-catch-up Builder runs inside the observe run that owns it). */
  startStage(
    stage: WidgetStage,
    init?: { pass?: number; batch?: BatchProgress; selectedCounts?: SelectedCountsProvider },
  ): void;
  setPass(pass: number): void;
  setBatch(done: number, total: number): void;
  /** End the stage (idle → the line hides); clears any in-flight batch. */
  endStage(): void;
  /** Consume one agent event (the port feeds row-derived events). */
  onEvent(event: WidgetAgentEvent): void;
  /** Drop the cached root counts so the next render recomputes them. */
  invalidateRoots(): void;
  /** Re-render now (post-write refreshes outside tool calls). */
  render(): void;
}

const NO_OP = (): void => {};

/** A no-op widget (the pre-widget default + tests). */
export const NO_OP_WIDGET: StageWidget = {
  startStage: NO_OP,
  setPass: NO_OP,
  setBatch: NO_OP,
  endStage: NO_OP,
  onEvent: NO_OP,
  invalidateRoots: NO_OP,
  render: NO_OP,
};

/** The notify adapter interface: pi's notify(ctx, message, level) with the
 *  ctx folded into the adapter closure. The ui.log adapter implements this
 *  over the engine surface; the runs take a StageNotify so the transport is
 *  injected. */
export type StageNotify = (message: string, level: NotifyLevel) => void;

/** The logger-only default adapter (pre-ui.log): one line per notify, the
 *  message prefixed "session-owl: " so the sink lines are attributable.
 *  Multi-line splitting is the ui.log adapter's rule, not this stub's.  */
export function loggerNotify(log: (message: string) => void): StageNotify {
  return (message, _level) => {
    log(`session-owl: ${message}`);
  };
}

/** The stateful seams one run receives (the conversation's core handle —
 *  getCore resolved by the caller BEFORE the run-lock, so no swap can
 *  interleave a running stage). */
export type StageCore = CoreHandle;

/** The runs' log seam. pi routes these lines through the logger (info/warn/
 *  error); the vendored core's log module imports the logger library — a bare
 *  edge the engine loader refuses — so the run modules log through this seam
 *  instead and the logger-runtime integration swaps the sink in one place.
 *  The default sink writes to stderr (the plugin host's log stream); the
 *  register installs the file logger at load (one place, one swap). */
let runsLogSink: ((message: string, cause?: unknown) => void) | null = null;

const DEFAULT_RUNS_LOG_SINK = (message: string, cause?: unknown): void => {
  console.error(message, ...(cause === undefined ? [] : [cause]));
};

/** Swap runsLog's sink (called once by the hooks module at load). */
export function installRunsLogSink(sink: (message: string, cause?: unknown) => void): void {
  runsLogSink = sink;
}

/** Restore the default stderr sink (test isolation — suite files share this
 *  module's registry, so a leaked file-logger sink would silence other
 *  suites' console.error spies). */
export function resetRunsLogSink(): void {
  runsLogSink = null;
}

export function runsLog(message: string, cause?: unknown): void {
  (runsLogSink ?? DEFAULT_RUNS_LOG_SINK)(message, cause);
}

/** A per-pass convergence outcome: applied mutate count + whether
 *  try_finish converged (the shared loop state the Builder and Selector
 *  runs track). */
export interface PassOutcome {
  mutates: number;
  converged: boolean;
  timedOut: boolean;
}

/** The model side was unavailable during a stage run (an engine api_error
 *  system row in the run's stream): the run's output is not a verdict and
 *  no range is covered. The compaction takeover skips with this reason —
 *  the session stays uncompacted for the person to fix and retry. */
export class ModelUnavailableError extends Error {
  constructor(detail: string) {
    super(detail);
    this.name = "ModelUnavailableError";
  }
}

/** A relay-detected timeout-class abort (the caller's own signal stayed
 *  live): the run maps it to the stage-timeout skip-and-notify path. */
export function isTimeoutClass(result: StageRunResultLike, signal: AbortSignal): boolean {
  if (!result.aborted || signal.aborted) return false;
  return result.abortReason === "timeout";
}

/** The compaction count for the tree-total (host seam: the branch's
 *  compaction entries — pi's countCompactions(sessionManager) fold; derived
 *  inside the run, never an input). */
/** The session's birth from the ACTIVE BRANCH's first entry timestamp —
 *  pi's readSessionBounds duration half: a --resume keeps the conversation's
 *  original birth (the first row predates the process), where a process-start
 *  clock would reset to ~0 on every resume. Empty branch or unparseable
 *  timestamp falls back (never NaN — pi's guard). */
export function sessionStartMsFromBranch(
  branch: readonly { timestamp?: string; type?: string; id?: string; parentId?: string | null }[],
  fallbackMs: number,
): number {
  const first = branch[0];
  if (first === undefined) return fallbackMs;
  const ms = Date.parse(first.timestamp ?? "1970-01-01T00:00:00.000Z");
  return Number.isNaN(ms) ? fallbackMs : ms;
}

export function countCompactionsFromBranch(store: StoreContext): number {
  const branch: readonly StoreEntry[] = store.getBranch(store.getLeafId());
  let n = 0;
  for (const e of branch) {
    if (e.type === "compaction") n += 1;
  }
  return n;
}
