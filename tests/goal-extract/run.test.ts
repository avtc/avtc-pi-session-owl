// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { _resetGetMemkeeperSettings, _setGetMemkeeperSettings, DEFAULT_CONFIG } from "../../src/config/schema.js";
import {
  _resetGoalExtract,
  abortGoalExtract,
  type GoalExtractInput,
  runGoalExtract,
} from "../../src/goal-extract/run.js";
import { applyCreateNode } from "../../src/graph/mutations.js";
import type { StageRunInput, StageRunResult } from "../../src/runtime/agent-loop.js";
import { _resetRunLock } from "../../src/runtime/run-lock.js";
import { getGraphStore, resetForNewSession, type StoreContext } from "../../src/store/graph-store.js";
import { N_GOAL } from "../../src/types.js";
import { NO_OP_WIDGET } from "../../src/widget/tracker.js";

// --- fakes -----------------------------------------------------------------

/** A ctx whose model resolves (defaultModel null → session model). */
function makeFakeCtx(): ExtensionContext {
  const fakeModel = { provider: "test", id: "goal-model" } as unknown as Model<never>;
  return {
    modelRegistry: {
      find: () => fakeModel,
      getApiKeyAndHeaders: async () => ({ ok: true as const, apiKey: "key" }),
    } as unknown as ExtensionContext["modelRegistry"],
    model: fakeModel,
    ui: { notify: () => {} },
  } as unknown as ExtensionContext;
}

/** A ctx whose default-model reference resolves to nothing (model gap). */
function makeNoModelCtx(): ExtensionContext {
  return {
    modelRegistry: {
      find: () => undefined,
      getApiKeyAndHeaders: async () => ({ ok: true as const, apiKey: "key" }),
    } as unknown as ExtensionContext["modelRegistry"],
    model: undefined,
    ui: { notify: () => {} },
  } as unknown as ExtensionContext;
}

/** A recording StoreContext (runGoalExtract only uses appendEntry). */
function makeRecordingStore(): { store: StoreContext; appended: [string, unknown][] } {
  const appended: [string, unknown][] = [];
  const store: StoreContext = {
    appendEntry: (customType, data) => {
      appended.push([customType, data]);
    },
    getLeafId: () => "leaf-1",
    getBranch: () => [],
  };
  return { store, appended };
}

/** Seed nGoal (active/crit/empty summary) into the singleton graph. */
function seedNGoal(summary: string): void {
  applyCreateNode(getGraphStore().graph, {
    id: N_GOAL,
    summary,
    importance: "crit",
    parentNode: null,
    state: "active",
  });
}

/** A clean (non-aborted) runStage result carrying one assistant text reply. */
function assistantResult(text: string): StageRunResult {
  return {
    messages: [{ role: "assistant", content: text, timestamp: 0 } as unknown as AgentMessage],
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1, elapsedMs: 0 },
    outputTokens: 0,
    aborted: false,
    timedOut: false,
  };
}

/** A no-reply result (no assistant message). */
const EMPTY_RESULT: StageRunResult = {
  messages: [],
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1, elapsedMs: 0 },
  outputTokens: 0,
  aborted: false,
  timedOut: false,
};

/** Build a GoalExtractInput with the common fields + overrides. */
function makeInput(
  overrides: Partial<GoalExtractInput> & { runStageFn: GoalExtractInput["runStageFn"] },
): GoalExtractInput {
  const { store } = makeRecordingStore();
  return {
    ctx: makeFakeCtx(),
    settings: { ...DEFAULT_CONFIG },
    store,
    widget: NO_OP_WIDGET,
    verbatimText: "Fix the login bug in auth.ts",
    ...overrides,
  };
}

/** Count persisted set_meta graph_deltas targeting nGoal. */
function nGoalSetMetaCount(appended: readonly [string, unknown][]): number {
  return appended.filter(
    ([type, data]) =>
      type === "memkeeper.graph_delta" &&
      (data as { delta?: { type: string; nodeId?: string } }).delta?.type === "set_meta" &&
      (data as { delta?: { nodeId?: string } }).delta?.nodeId === N_GOAL,
  ).length;
}

// --- tests -----------------------------------------------------------------

describe("runGoalExtract", () => {
  beforeEach(() => {
    resetForNewSession();
    _resetGoalExtract();
    _resetRunLock();
    _setGetMemkeeperSettings(() => ({ ...DEFAULT_CONFIG }));
    seedNGoal("");
  });
  afterEach(() => {
    _resetGetMemkeeperSettings();
  });

  it("sets nGoal.summary from the assistant's one-line reply + persists set_meta", async () => {
    const { store, appended } = makeRecordingStore();
    await runGoalExtract({
      ctx: makeFakeCtx(),
      settings: { ...DEFAULT_CONFIG },
      store,
      widget: NO_OP_WIDGET,
      verbatimText: "Fix the login bug in auth.ts",
      runStageFn: async () => assistantResult("Fix the login bug"),
    });

    expect(getGraphStore().graph.nodes.get(N_GOAL)?.summary).toBe("Fix the login bug");
    expect(nGoalSetMetaCount(appended)).toBe(1);
  });

  it("leaves nGoal.summary empty when the reply carries no assistant text", async () => {
    await runGoalExtract(makeInput({ runStageFn: async () => EMPTY_RESULT }));
    expect(getGraphStore().graph.nodes.get(N_GOAL)?.summary).toBe("");
  });

  it("leaves nGoal.summary empty when the model is unavailable", async () => {
    const input = makeInput({
      ctx: makeNoModelCtx(),
      runStageFn: async () => assistantResult("should not be used"),
    });
    await runGoalExtract(input);
    expect(getGraphStore().graph.nodes.get(N_GOAL)?.summary).toBe("");
  });

  it("leaves nGoal.summary empty when the run was aborted", async () => {
    await runGoalExtract(
      makeInput({
        runStageFn: async () => ({ ...EMPTY_RESULT, aborted: true }),
      }),
    );
    expect(getGraphStore().graph.nodes.get(N_GOAL)?.summary).toBe("");
  });

  it("does not clobber an nGoal.summary the Builder already set", async () => {
    resetForNewSession();
    seedNGoal("existing builder goal");
    await runGoalExtract(makeInput({ runStageFn: async () => assistantResult("late extraction goal") }));
    expect(getGraphStore().graph.nodes.get(N_GOAL)?.summary).toBe("existing builder goal");
  });

  it("trims whitespace and strips ANSI from the reply", async () => {
    const ansiRed = "\u001b[31m";
    const ansiReset = "\u001b[0m";
    await runGoalExtract(
      makeInput({
        runStageFn: async () => assistantResult(`  ${ansiRed}Fix the login bug${ansiReset}  `),
      }),
    );
    expect(getGraphStore().graph.nodes.get(N_GOAL)?.summary).toBe("Fix the login bug");
  });

  it("passes the verbatim prompt as the single user message", async () => {
    let received: AgentMessage[] | undefined;
    await runGoalExtract(
      makeInput({
        verbatimText: "Build me a memory keeper",
        runStageFn: async (input) => {
          received = input.messages;
          return assistantResult("goal");
        },
      }),
    );
    expect(received).toEqual([{ role: "user", content: "Build me a memory keeper" }]);
  });

  it("aborts an in-flight call's signal on shutdown (abortGoalExtract) → no write", async () => {
    let resolveGate: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      resolveGate = resolve;
    });
    let signalEntered!: () => void;
    const entered = new Promise<void>((resolve) => {
      signalEntered = resolve;
    });
    let observedSignal: AbortSignal | undefined;
    const runStageFn = async (input: StageRunInput): Promise<StageRunResult> => {
      observedSignal = input.signal;
      signalEntered();
      await gate;
      // mirror the real runStage: an aborted signal surfaces as aborted:true
      return input.signal.aborted ? { ...EMPTY_RESULT, aborted: true } : assistantResult("should not be written");
    };
    const promise = runGoalExtract(makeInput({ runStageFn }));
    await entered; // runStageFn entered, signal captured, now awaiting the gate
    expect(observedSignal?.aborted).toBe(false);
    abortGoalExtract(); // session shutdown
    resolveGate();
    await promise;
    expect(getGraphStore().graph.nodes.get(N_GOAL)?.summary).toBe("");
  });
});
