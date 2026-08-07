// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import type { AgentEvent } from "@earendil-works/pi-agent-core";
import { describe, expect, it } from "vitest";
import { MKDIR_TOOL, MV_TOOL } from "../../src/graph/mutate-tools.js";
import { LS_TOOL, TRY_FINISH_TOOL } from "../../src/graph/read-tools.js";
import type { StageRunInput, StageRunResult, StageUsage } from "../../src/runtime/agent-loop.js";
import { makeConvergenceTracker, runConvergencePass } from "../../src/runtime/convergence.js";

const NAMES = new Set<string>([MKDIR_TOOL, MV_TOOL]);

function endEvent(toolName: string, ok: boolean, isError: boolean): AgentEvent {
  return {
    type: "tool_execution_end",
    toolCallId: `c-${toolName}`,
    toolName,
    result: { content: [], details: { ok } },
    isError,
  } as unknown as AgentEvent;
}

describe("makeConvergenceTracker", () => {
  it("counts applied mutates (ok, not error) for tools in the mutate set", () => {
    const { outcome, onEvent } = makeConvergenceTracker(() => {}, NAMES);
    onEvent(endEvent(MKDIR_TOOL, true, false));
    onEvent(endEvent(MV_TOOL, true, false));
    expect(outcome.mutates).toBe(2);
    expect(outcome.converged).toBe(false);
  });

  it("marks converged on try_finish success", () => {
    const { outcome, onEvent } = makeConvergenceTracker(() => {}, NAMES);
    onEvent(endEvent(TRY_FINISH_TOOL, true, false));
    expect(outcome.converged).toBe(true);
  });

  it("does not mark converged on try_finish reject", () => {
    const { outcome, onEvent } = makeConvergenceTracker(() => {}, NAMES);
    onEvent(endEvent(TRY_FINISH_TOOL, false, false));
    expect(outcome.converged).toBe(false);
  });

  it("ignores a rejected mutate (isError)", () => {
    const { outcome, onEvent } = makeConvergenceTracker(() => {}, NAMES);
    onEvent(endEvent(MV_TOOL, true, true));
    expect(outcome.mutates).toBe(0);
  });

  it("ignores a mutate whose result lacks ok (an error result)", () => {
    const { outcome, onEvent } = makeConvergenceTracker(() => {}, NAMES);
    onEvent({
      type: "tool_execution_end",
      toolCallId: "c1",
      toolName: MV_TOOL,
      result: { content: [], details: { error: true } },
      isError: false,
    } as unknown as AgentEvent);
    expect(outcome.mutates).toBe(0);
  });

  it("ignores read tools", () => {
    const { outcome, onEvent } = makeConvergenceTracker(() => {}, NAMES);
    onEvent(endEvent(LS_TOOL, true, false));
    expect(outcome.mutates).toBe(0);
    expect(outcome.converged).toBe(false);
  });

  it("forwards every event to the downstream sink", () => {
    const forwarded: unknown[] = [];
    const { onEvent } = makeConvergenceTracker((e) => forwarded.push(e), NAMES);
    const a = endEvent(MKDIR_TOOL, true, false);
    const b = { type: "turn_end" } as unknown as AgentEvent;
    onEvent(a);
    onEvent(b);
    expect(forwarded).toEqual([a, b]);
  });

  it("ignores non-tool_execution_end events", () => {
    const { outcome, onEvent } = makeConvergenceTracker(() => {}, NAMES);
    onEvent({ type: "turn_end" } as unknown as AgentEvent);
    onEvent({ type: "message_update" } as unknown as AgentEvent);
    expect(outcome.mutates).toBe(0);
    expect(outcome.converged).toBe(false);
  });
});

describe("runConvergencePass", () => {
  const BASE = {
    systemPrompt: "sys",
    messages: [] as StageRunInput["messages"],
    tools: [] as StageRunInput["tools"],
    model: { provider: "t", id: "m" } as StageRunInput["model"],
    apiKey: undefined,
    signal: new AbortController().signal,
    maxTokens: 8192,
    timeoutMs: null,
    onStageEnd: null as ((usage: StageUsage) => void) | null,
    stageLabel: "test",
  } as const;

  it("resolves normally when the stage succeeds", async () => {
    const { outcome, onEvent } = makeConvergenceTracker(() => {}, NAMES);
    const runStageFn = async (input: StageRunInput): Promise<StageRunResult> => {
      input.onEvent?.(endEvent(MKDIR_TOOL, true, false));
      return {
        messages: [],
        usage: { input: 0, output: 0, cacheRead: 0, cost: 0, turns: 1 },
        outputTokens: 0,
        aborted: false,
      };
    };
    await expect(runConvergencePass({ ...BASE, onEvent, outcome, runStageFn })).resolves.toBeUndefined();
    expect(outcome.mutates).toBe(1);
  });

  it("rethrows when the stage errors before any mutate (0 applied)", async () => {
    const { outcome, onEvent } = makeConvergenceTracker(() => {}, NAMES);
    const runStageFn = async (): Promise<StageRunResult> => {
      throw new Error("boom");
    };
    await expect(runConvergencePass({ ...BASE, onEvent, outcome, runStageFn })).rejects.toThrow("boom");
  });

  it("swallows the error when the stage errors AFTER a mutate (partial kept)", async () => {
    const { outcome, onEvent } = makeConvergenceTracker(() => {}, NAMES);
    const runStageFn = async (input: StageRunInput): Promise<StageRunResult> => {
      input.onEvent?.(endEvent(MKDIR_TOOL, true, false)); // 1 mutate applied
      throw new Error("boom-after");
    };
    await expect(runConvergencePass({ ...BASE, onEvent, outcome, runStageFn })).resolves.toBeUndefined();
    expect(outcome.mutates).toBe(1);
  });

  it("forwards onStageEnd into the stage input (the usage-ledger seam)", async () => {
    const { outcome, onEvent } = makeConvergenceTracker(() => {}, NAMES);
    let receivedHook: ((usage: StageUsage) => void) | null | undefined;
    const runStageFn = async (input: StageRunInput): Promise<StageRunResult> => {
      receivedHook = input.onStageEnd;
      input.onEvent?.(endEvent(MKDIR_TOOL, true, false));
      return {
        messages: [],
        usage: { input: 0, output: 0, cacheRead: 0, cost: 0, turns: 1 },
        outputTokens: 0,
        aborted: false,
      };
    };
    const sink = (_u: StageUsage): void => {};
    await runConvergencePass({
      ...BASE,
      onEvent,
      onStageEnd: sink,
      outcome,
      runStageFn,
    });
    expect(receivedHook).toBe(sink);
  });
});
