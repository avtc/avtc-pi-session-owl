// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarensenkov@gmail.com>

// Shared multi-pass convergence primitives used by the Builder and Selector
// runs. Both stages run the same shape: an agentLoop pass whose outcome (applied
// mutate count + try_finish convergence) is tracked by inspecting
// tool_execution_end events, and a pass runner that settles errors (rethrow on
// error-before-any-mutate, swallow on error-after-≥1-mutate so partial work is
// kept). The two differ only in their mutate-tool name set and their system
// prompt — extracted here to avoid duplication.

import type { AgentEvent, AgentMessage } from "@earendil-works/pi-agent-core";
import { TRY_FINISH_TOOL } from "../graph/read-tools.js";
import { log } from "../log.js";
import {
  NO_REASONING,
  NO_STAGE_END_HOOK,
  NO_TURN_LIMIT,
  type StageRunInput,
  type StageRunResult,
} from "./agent-loop.js";

const NO_MUTATES = 0;
const NO_LOOP_OVERRIDE = null;

/** A per-pass outcome: applied mutate count + whether try_finish converged. */
export interface ConvergenceOutcome {
  mutates: number;
  converged: boolean;
}

/**
 * Build a per-pass event tracker: an `onEvent` that forwards EVERY event to the
 * downstream sink (the widget) AND inspects `tool_execution_end` to count
 * applied mutates (a tool in `mutateNames` with `details.ok === true` and not
 * `isError`) and detect try_finish convergence (`details.ok === true`). Read
 * tools and rejected mutates do not count.
 */
export function makeConvergenceTracker(
  downstream: (event: AgentEvent) => void,
  mutateNames: ReadonlySet<string>,
): { outcome: ConvergenceOutcome; onEvent: (event: AgentEvent) => void } {
  const outcome: ConvergenceOutcome = { mutates: NO_MUTATES, converged: false };
  const onEvent = (event: AgentEvent): void => {
    downstream(event);
    if (event.type !== "tool_execution_end") return;
    const details = event.result?.details as { ok?: boolean } | undefined;
    if (details?.ok !== true) return;
    if (event.toolName === TRY_FINISH_TOOL) {
      outcome.converged = true;
      return;
    }
    if (mutateNames.has(event.toolName) && !event.isError) {
      outcome.mutates += 1;
    }
  };
  return { outcome, onEvent };
}

/** Args for {@link runConvergencePass}. */
export interface ConvergencePassArgs {
  systemPrompt: string;
  messages: AgentMessage[];
  tools: StageRunInput["tools"];
  model: StageRunInput["model"];
  apiKey: string | undefined;
  signal: AbortSignal;
  onEvent: (event: AgentEvent) => void;
  /** The tracker's outcome — read to settle errors (rethrow vs swallow). */
  outcome: ConvergenceOutcome;
  runStageFn: (input: StageRunInput) => Promise<StageRunResult>;
  /** Stage label for log lines (e.g. "builder" / "selector"). */
  stageLabel: string;
}

/**
 * Run one convergence pass (one agentLoop). Settles errors: error-after-≥1-mutate
 * → swallowed (partial work kept, pass counts as finished); error-before-any-
 * mutate → rethrown (ends the run — nothing happened; retry next trigger).
 */
export async function runConvergencePass(args: ConvergencePassArgs): Promise<void> {
  const stageInput: StageRunInput = {
    systemPrompt: args.systemPrompt,
    messages: args.messages,
    tools: args.tools,
    model: args.model,
    apiKey: args.apiKey,
    signal: args.signal,
    reasoning: NO_REASONING,
    maxTurns: NO_TURN_LIMIT,
    onEvent: args.onEvent,
    onStageEnd: NO_STAGE_END_HOOK,
    loopFn: NO_LOOP_OVERRIDE,
  };
  try {
    await args.runStageFn(stageInput);
  } catch (cause) {
    if (args.outcome.mutates > NO_MUTATES) {
      log.error(`${args.stageLabel} pass failed after partial work (kept)`, cause);
      return;
    }
    log.error(`${args.stageLabel} pass failed before any mutate (ending run)`, cause);
    throw cause;
  }
}
