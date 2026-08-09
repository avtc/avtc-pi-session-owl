// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// Test helpers for the Builder run: a no-op + recording widget
// controller, and a scripted runStage that emits tool_execution_end events to
// drive the multi-pass loop without a real LLM.

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { StageRunInput, StageRunResult, StageUsage } from "../../src/runtime/agent-loop.js";
import type { WidgetController } from "../../src/widget/tracker.js";

/** A scripted tool call within a pass: tool name + ok flag + whether it errored. */
export interface ScriptedTool {
  name: string;
  ok: boolean;
  /** When true, the tool result carries isError (a rejected mutate). */
  isError?: boolean;
}

/** A scripted pass: the tool_execution_end events emitted in order. */
interface ScriptedPass {
  tools: ScriptedTool[];
}

/** A multi-pass script: pass N's tools run on the Nth runStage call. */
export interface FakeRunScript {
  passes: ScriptedPass[];
}

function zeroUsage(): StageUsage {
  return { input: 0, output: 0, cacheRead: 0, cost: 0, turns: 1 };
}

/**
 * Build a scripted runStage: each call emits the next pass's tool_execution_end
 * events (via input.onEvent), then resolves. Passes beyond the script throw
 * (test mis-spec) unless the script's `errorOnPass` is set.
 */
export function scriptRunStage(script: FakeRunScript): (input: StageRunInput) => Promise<StageRunResult> {
  let calls = 0;
  return async (input: StageRunInput) => {
    const pass = script.passes[calls];
    calls += 1;
    if (pass === undefined) {
      throw new Error(`scriptRunStage: no pass scripted for call ${calls}`);
    }
    for (const tool of pass.tools) {
      input.onEvent?.({
        type: "tool_execution_end",
        toolCallId: `c-${calls}-${tool.name}`,
        toolName: tool.name,
        result: { content: [], details: { ok: tool.ok } },
        isError: tool.isError === true,
      });
    }
    return {
      messages: [] as AgentMessage[],
      usage: zeroUsage(),
      outputTokens: 0,
      aborted: false,
    };
  };
}

/** A runStage variant where a specified pass THROWS after emitting some tools
 *  (to test error-after-mutate and error-before-mutate semantics). */
export interface ErrorScript {
  /** Tools to emit (via onEvent) BEFORE the throw, on the error pass. */
  toolsBeforeError: ScriptedTool[];
  /** The pass index (0-based) that throws. */
  errorPassIndex: number;
}

export function scriptRunStageWithError(
  script: FakeRunScript,
  error: ErrorScript,
): (input: StageRunInput) => Promise<StageRunResult> {
  const base = scriptRunStage(script);
  let calls = 0;
  return async (input: StageRunInput) => {
    const idx = calls;
    calls += 1;
    if (idx === error.errorPassIndex) {
      for (const tool of error.toolsBeforeError) {
        input.onEvent?.({
          type: "tool_execution_end",
          toolCallId: `c-${idx}-${tool.name}`,
          toolName: tool.name,
          result: { content: [], details: { ok: tool.ok } },
          isError: tool.isError === true,
        });
      }
      throw new Error("scripted stage failure");
    }
    return base(input);
  };
}

/** A no-op widget controller (the stub). */
export const NO_OP_WIDGET: WidgetController = {
  setCtx: () => {},
  clearCtx: () => {},
  render: () => {},
  startStage: () => {},
  setPass: () => {},
  setBatch: () => {},
  setSelectedCounts: () => {},
  endStage: () => {},
  onEvent: () => {},
  invalidateRoots: () => {},
};

/** A recording widget controller: records startStage/setPass/endStage calls. */
export function recordingWidget(): WidgetController & {
  calls: string[];
} {
  const calls: string[] = [];
  return {
    setCtx: () => {},
    clearCtx: () => {},
    render: () => {},
    startStage: (stage, init) => {
      calls.push(`start:${stage}${init?.pass !== undefined ? `:${init.pass}` : ""}`);
    },
    setPass: (pass) => {
      calls.push(`pass:${pass}`);
    },
    setBatch: () => {},
    setSelectedCounts: () => {},
    endStage: () => {
      calls.push("end");
    },
    onEvent: () => {},
    invalidateRoots: () => {},
    get calls() {
      return calls;
    },
  };
}
