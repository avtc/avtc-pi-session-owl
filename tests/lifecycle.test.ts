// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  captureInitialPromptIfAbsent,
  extractMessageText,
  isUnstuckAutoContinue,
  onSessionShutdown,
  onSessionStart,
} from "../src/lifecycle.js";
import { _resetRunLock, acquireOrSkip, type RunHandle } from "../src/runtime/run-lock.js";
import { getGraphStore, resetForNewSession } from "../src/store/graph-store.js";
import { N_GOAL, O_INITIAL_PROMPT } from "../src/types.js";
import type { WidgetController } from "../src/widget/tracker.js";

// --- fakes -----------------------------------------------------------------

interface FakeEntry {
  id: string;
  type: string;
  parentId: string | null;
  timestamp: string;
  message?: AgentMessage;
}

function userEntry(id: string, text: string): FakeEntry {
  return {
    id,
    type: "message",
    parentId: null,
    timestamp: "2026-07-28 14:30",
    message: { role: "user", content: text, timestamp: Date.now() },
  };
}

function assistantEntry(id: string, text: string): FakeEntry {
  return {
    id,
    type: "message",
    parentId: null,
    timestamp: "2026-07-28 14:31",
    message: {
      role: "assistant",
      content: [{ type: "text", text }],
      api: "anthropic",
      provider: "anthropic",
      model: "m",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: Date.now(),
    } as AgentMessage,
  };
}

function makeCtx(branch: FakeEntry[]): {
  ctx: ExtensionContext;
  appended: [string, unknown][];
  pi: ExtensionAPI;
} {
  const appended: [string, unknown][] = [];
  const pi = {
    appendEntry: (customType: string, data: unknown) => {
      appended.push([customType, data]);
    },
  };
  const ctx = {
    sessionManager: {
      getLeafId: () => "leaf-1",
      getBranch: () => branch,
    },
  };
  return { ctx: ctx as unknown as ExtensionContext, appended, pi: pi as unknown as ExtensionAPI };
}

const noopWidget: WidgetController = {
  setCtx: () => {},
  clearCtx: () => {},
  render: () => {},
  startStage: () => {},
  setPass: () => {},
  setBatch: () => {},
  endStage: () => {},
  onEvent: () => {},
};

// --- tests -----------------------------------------------------------------

describe("extractMessageText", () => {
  it("returns the string content verbatim", () => {
    expect(extractMessageText({ role: "user", content: "hello world", timestamp: 0 } as AgentMessage)).toBe(
      "hello world",
    );
  });

  it("joins TextContent parts", () => {
    const msg = {
      role: "user",
      content: [
        { type: "text", text: "part one " },
        { type: "text", text: "part two" },
      ],
      timestamp: 0,
    } as AgentMessage;
    expect(extractMessageText(msg)).toBe("part one part two");
  });
});

describe("isUnstuckAutoContinue", () => {
  const phrases = ["continue", "please continue"];
  it.each(phrases)("matches the unstuck phrase %p exactly", (phrase) => {
    const msg = { role: "user", content: phrase, timestamp: 0 } as AgentMessage;
    expect(isUnstuckAutoContinue(msg)).toBe(true);
  });

  it("matches the unstuck length-stall prompt", () => {
    const msg = {
      role: "user",
      content: "Your response was cut off due to length. Please provide a shorter, more concise response.",
      timestamp: 0,
    } as AgentMessage;
    expect(isUnstuckAutoContinue(msg)).toBe(true);
  });

  it("does not match a real user message", () => {
    const msg = { role: "user", content: "please continue with the next task", timestamp: 0 } as AgentMessage;
    expect(isUnstuckAutoContinue(msg)).toBe(false);
  });

  it("is case-sensitive (a capitalized 'Continue' is not skipped)", () => {
    const msg = { role: "user", content: "Continue", timestamp: 0 } as AgentMessage;
    expect(isUnstuckAutoContinue(msg)).toBe(false);
  });
});

describe("onSessionStart", () => {
  beforeEach(() => resetForNewSession());

  it("loads the store + seeds nGoal on an empty graph (no oInitialPrompt)", async () => {
    const { ctx, pi } = makeCtx([]); // empty branch -> empty graph after load
    await onSessionStart({ type: "session_start", reason: "startup" }, ctx, pi, noopWidget);
    const graph = getGraphStore().graph;
    expect(graph.nodes.has(N_GOAL)).toBe(true);
    const ngoal = graph.nodes.get(N_GOAL);
    expect(ngoal?.importance).toBe("critical");
    expect(ngoal?.state).toBe("active");
    expect(ngoal?.summary).toBe("");
    expect(graph.hasInitialPrompt).toBe(false); // oInitialPrompt NOT captured here
  });

  it("does not re-seed nGoal when the graph already has it (reload)", async () => {
    // seed once
    const { ctx, pi } = makeCtx([]);
    await onSessionStart({ type: "session_start", reason: "startup" }, ctx, pi, noopWidget);
    expect(getGraphStore().graph.nodes.has(N_GOAL)).toBe(true);
    // a second session_start (reload) on a graph that already has nGoal is a no-op for seeding
    await onSessionStart({ type: "session_start", reason: "reload" }, ctx, pi, noopWidget);
    expect(getGraphStore().graph.nodes.size).toBe(1); // still just nGoal
  });

  it("persists the nGoal seed as a graph_delta (so reload reconstructs it)", async () => {
    const { ctx, pi, appended } = makeCtx([]);
    await onSessionStart({ type: "session_start", reason: "startup" }, ctx, pi, noopWidget);
    const deltas = appended.filter(([t]) => t === "memkeeper.graph_delta");
    expect(deltas.length).toBe(1);
  });
});

describe("captureInitialPromptIfAbsent", () => {
  beforeEach(() => resetForNewSession());

  it("finds the first user message on the branch + captures verbatim under nGoal", async () => {
    const branch = [assistantEntry("a1", "hi"), userEntry("u1", "Build me a CLI tool"), assistantEntry("a2", "ok")];
    const { ctx, pi } = makeCtx(branch);
    await onSessionStart({ type: "session_start", reason: "startup" }, ctx, pi, noopWidget);

    captureInitialPromptIfAbsent(ctx, pi);

    const graph = getGraphStore().graph;
    expect(graph.hasInitialPrompt).toBe(true);
    const obs = graph.observations.get(O_INITIAL_PROMPT);
    expect(obs?.content).toBe("Build me a CLI tool");
    expect(obs?.parentNode).toBe(N_GOAL);
    expect(obs?.sourceEntryIds).toEqual(["u1"]);
    expect(obs?.importance).toBe("critical");
    // nGoal summary seeded from the first non-empty line
    expect(graph.nodes.get(N_GOAL)?.summary).toBe("Build me a CLI tool");
    // frontier advanced past the first user message (Observer never re-observes it)
    expect(getGraphStore().observerFrontier).toBe("u1");
  });

  it("is a no-op when oInitialPrompt is already present", async () => {
    const branch = [userEntry("u1", "first")];
    const { ctx, pi, appended } = makeCtx(branch);
    await onSessionStart({ type: "session_start", reason: "startup" }, ctx, pi, noopWidget);
    captureInitialPromptIfAbsent(ctx, pi);
    const firstCount = appended.length;
    // capture again -> no new appends (already present)
    captureInitialPromptIfAbsent(ctx, pi);
    expect(appended.length).toBe(firstCount);
  });

  it("is a no-op when there is no user message yet", async () => {
    const branch = [assistantEntry("a1", "hi")]; // no user message
    const { ctx, pi } = makeCtx(branch);
    await onSessionStart({ type: "session_start", reason: "startup" }, ctx, pi, noopWidget);
    captureInitialPromptIfAbsent(ctx, pi);
    expect(getGraphStore().graph.hasInitialPrompt).toBe(false);
  });

  it("seeds nGoal.summary from the first non-empty line (multi-line prompt)", async () => {
    const branch = [userEntry("u1", "  \nBuild the memory extension\nDetails follow")];
    const { ctx, pi } = makeCtx(branch);
    await onSessionStart({ type: "session_start", reason: "startup" }, ctx, pi, noopWidget);
    captureInitialPromptIfAbsent(ctx, pi);
    expect(getGraphStore().graph.nodes.get(N_GOAL)?.summary).toBe("Build the memory extension");
  });

  it("persist the capture (observation entry + graph deltas incl. set_meta)", async () => {
    const branch = [userEntry("u1", "do the thing")];
    const { ctx, pi, appended } = makeCtx(branch);
    await onSessionStart({ type: "session_start", reason: "startup" }, ctx, pi, noopWidget);
    captureInitialPromptIfAbsent(ctx, pi);
    const obs = appended.filter(([t]) => t === "memkeeper.observation");
    expect(obs.length).toBe(1);
    // coversUpToId = the first user entry (frontier advances past it)
    expect((obs[0][1] as { coversUpToId: string }).coversUpToId).toBe("u1");
    // graph_delta log: create_node (nGoal seed) + set_meta (nGoal summary)
    const deltas = appended.filter(([t]) => t === "memkeeper.graph_delta");
    expect(deltas.length).toBe(2);
    const setMetas = deltas.filter(([, d]) => (d as { delta: { type: string } }).delta?.type === "set_meta");
    expect(setMetas.length).toBe(1);
  });
});

describe("onSessionShutdown", () => {
  beforeEach(() => {
    resetForNewSession();
    _resetRunLock();
  });

  it("calls widget.clearCtx", () => {
    const widget = { ...noopWidget, clearCtx: vi.fn() };
    onSessionShutdown({ type: "session_shutdown", reason: "quit" }, widget);
    expect(widget.clearCtx).toHaveBeenCalledTimes(1);
  });

  it("aborts an in-flight run (so it stops wasting tokens on a discarded session)", () => {
    const handle = acquireOrSkip("observe") as RunHandle;
    expect(handle.abortController.signal.aborted).toBe(false);
    onSessionShutdown({ type: "session_shutdown", reason: "reload" }, noopWidget);
    expect(handle.abortController.signal.aborted).toBe(true);
    handle.release();
  });
});
