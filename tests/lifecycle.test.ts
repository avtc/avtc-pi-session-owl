// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { _resetGetSessionOwlSettings, _setGetSessionOwlSettings, DEFAULT_CONFIG } from "../src/config/schema.js";
import { runRegexTests } from "../src/graph/regex-runner.js";
import {
  buildEntryResolver,
  captureInitialPromptIfAbsent,
  extractMessageText,
  isUnstuckAutoContinue,
  onSessionShutdown,
  onSessionStart,
  onSessionTree,
} from "../src/lifecycle.js";
import { _setBaseLoggerForTest, clearLogSessionScope, log } from "../src/log.js";
import { _resetRunLock, acquireOrSkip, inFlight, type RunHandle } from "../src/runtime/run-lock.js";
import {
  _resetSessionAffinity,
  getStageAffinityId,
  setSessionOwlSessionBase,
} from "../src/runtime/session-affinity.js";
import { OBSERVATION_TYPE } from "../src/store/codecs.js";
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
    timestamp: "2026-07-28T14:30:00.000Z",
    message: { role: "user", content: text, timestamp: Date.now() },
  };
}

function assistantEntry(id: string, text: string): FakeEntry {
  return {
    id,
    type: "message",
    parentId: null,
    timestamp: "2026-07-28T14:31:00.000Z",
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

function toolCallEntry(id: string, toolCallId: string, name: string, args: Record<string, unknown>): FakeEntry {
  return {
    id,
    type: "message",
    parentId: null,
    timestamp: "2026-07-28T14:31:00.000Z",
    message: {
      role: "assistant",
      content: [{ type: "toolCall", id: toolCallId, name, arguments: args }],
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

function toolResultEntry(id: string, toolCallId: string, content: string): FakeEntry {
  return {
    id,
    type: "message",
    parentId: null,
    timestamp: "2026-07-28T14:32:00.000Z",
    message: {
      role: "toolResult",
      toolCallId,
      toolName: "bash",
      content,
      isError: false,
      timestamp: Date.now(),
    } as unknown as AgentMessage,
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
      getEntry: (id: string) => branch.find((e) => e.id === id),
      getSessionId: () => "01a02596-de2e-707b-8016-1df74d3f13ce",
    },
  };
  return { ctx: ctx as unknown as ExtensionContext, appended, pi: pi as unknown as ExtensionAPI };
}

const noopWidget: WidgetController = {
  setConflict: () => {},
  setCtx: () => {},
  clearCtx: () => {},
  render: () => {},
  startStage: () => {},
  setPass: () => {},
  setBatch: () => {},
  endStage: () => {},
  onEvent: () => {},
  invalidateRoots: () => {},
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
  beforeEach(() => {
    resetForNewSession();
    _resetGetSessionOwlSettings();
    _resetSessionAffinity();
    clearLogSessionScope();
  });
  afterEach(() => {
    _resetGetSessionOwlSettings();
    clearLogSessionScope();
  });

  it("loads the store + seeds nGoal on an empty graph (no oInitialPrompt)", async () => {
    const { ctx, pi } = makeCtx([]); // empty branch -> empty graph after load
    await onSessionStart({ type: "session_start", reason: "startup" }, ctx, pi, noopWidget);
    const graph = getGraphStore().graph;
    expect(graph.nodes.has(N_GOAL)).toBe(true);
    const ngoal = graph.nodes.get(N_GOAL);
    expect(ngoal?.importance).toBe("crit");
    expect(ngoal?.state).toBe("active");
    expect(ngoal?.summary).toBe("");
    expect(graph.hasInitialPrompt).toBe(false); // empty branch -> no user message to capture
  });

  it("tags log lines with the session's short id (set on start, cleared on shutdown)", async () => {
    const sink = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
    _setBaseLoggerForTest(sink);
    const { ctx, pi } = makeCtx([]);
    await onSessionStart({ type: "session_start", reason: "startup" }, ctx, pi, noopWidget);
    log.info("attributed");
    expect(sink.info).toHaveBeenCalledWith("[s-01a025] attributed");
    onSessionShutdown({ type: "session_shutdown", reason: "quit" }, noopWidget);
    log.info("bare");
    expect(sink.info).toHaveBeenCalledWith("bare");
    _setBaseLoggerForTest(null);
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
    const deltas = appended.filter(([t]) => t === "session-owl.graph_delta");
    expect(deltas.length).toBe(1);
  });

  it("does NOT seed nGoal (writes no graph_delta) when enabled=false", async () => {
    _setGetSessionOwlSettings(() => ({ ...DEFAULT_CONFIG, enabled: false }));
    const { ctx, pi, appended } = makeCtx([]);
    await onSessionStart({ type: "session_start", reason: "startup" }, ctx, pi, noopWidget);
    const deltas = appended.filter(([t]) => t === "session-owl.graph_delta");
    expect(deltas.length).toBe(0);
    // reconstruction still ran (graph is empty, just no seed write)
    expect(getGraphStore().graph.nodes.has(N_GOAL)).toBe(false);
  });

  it("sets the per-session affinity base (maintenance stages get a stage id)", async () => {
    expect(getStageAffinityId("build")).toBeNull();
    const { ctx, pi } = makeCtx([]);
    await onSessionStart({ type: "session_start", reason: "startup" }, ctx, pi, noopWidget);
    // a non-null, stage-suffixed id is now resolvable for each maintenance stage
    expect(getStageAffinityId("observe")).toMatch(/^.+:observe$/);
    expect(getStageAffinityId("build")).toMatch(/^.+:build$/);
    expect(getStageAffinityId("select")).toMatch(/^.+:select$/);
    // each session gets a fresh base (not a fixed constant)
    const first = getStageAffinityId("build");
    _resetSessionAffinity();
    await onSessionStart({ type: "session_start", reason: "startup" }, ctx, pi, noopWidget);
    expect(getStageAffinityId("build")).not.toBe(first);
  });

  it("captures oInitialPrompt at startup when the branch already has a first user message (resumed session)", async () => {
    // A resumed pre-session-owl session: the branch already contains the first
    // user message, but no turn_end has fired yet. session_start must capture it
    // so a compaction before any turn_end doesn't lose it (or observe it as a
    // regular observation instead of oInitialPrompt).
    const branch = [userEntry("u1", "Build me a memory keeper"), assistantEntry("a1", "ok")];
    const { ctx, pi } = makeCtx(branch);
    await onSessionStart({ type: "session_start", reason: "resume" }, ctx, pi, noopWidget);

    const graph = getGraphStore().graph;
    expect(graph.hasInitialPrompt).toBe(true);
    expect(graph.observations.get(O_INITIAL_PROMPT)?.summary).toBe("Build me a memory keeper");
    // nGoal.summary is left empty for the goal-extract stage (no mechanical seed).
    expect(graph.nodes.get(N_GOAL)?.summary).toBe("");
    // frontier advanced past the first user message (Observer never re-observes it)
    expect(getGraphStore().observerFrontier).toBe("u1");
  });
});

describe("onSessionTree", () => {
  beforeEach(() => {
    resetForNewSession();
    _resetRunLock();
    _resetGetSessionOwlSettings();
    _resetSessionAffinity();
    clearLogSessionScope();
  });
  afterEach(() => {
    _resetGetSessionOwlSettings();
    clearLogSessionScope();
  });

  it("aborts + awaits an in-flight run, re-derives the frontier from the new branch (off-branch pointer heals), and rebuilds the resolver", async () => {
    // the session ran on branch A: initial prompt captured, frontier advanced
    const branchA = [userEntry("u1", "task"), assistantEntry("a1", "work")];
    const old = makeCtx(branchA);
    await onSessionStart({ type: "session_start", reason: "startup" }, old.ctx, old.pi, noopWidget);
    expect(getGraphStore().observerFrontier).toBe("u1");

    // an observer run is in flight when the user navigates /tree to a new
    // branch — its chunk ranges belong to the OLD branch, and the in-memory
    // frontier already points off the new one (the live poison)
    const handle = acquireOrSkip("observe") as RunHandle;
    getGraphStore().observerFrontier = "abandoned-tail";

    // the new branch: shared prefix u1..a1, an observation entry that covers
    // through a1, then new-branch work
    const obsEntry = {
      id: "obs-ok",
      type: "custom",
      parentId: null,
      timestamp: "2026-07-28T14:35:00.000Z",
      customType: OBSERVATION_TYPE,
      data: { coversFromId: "u1", coversUpToId: "a1", records: [], tokenCount: 0 },
    } as unknown as (typeof branchA)[number];
    const branchB = [branchA[0] as (typeof branchA)[number], branchA[1] as (typeof branchA)[number], obsEntry];
    const next = makeCtx(branchB);

    const treeDone = onSessionTree(
      { type: "session_tree", newLeafId: "leaf-2", oldLeafId: "leaf-1" },
      next.ctx,
      next.pi,
      noopWidget,
    );
    // the run was aborted; it unwinds and releases in its finally
    expect(handle.abortController.signal.aborted).toBe(true);
    handle.release();
    await treeDone;

    // the lock is free again and the frontier re-derived from the NEW branch's
    // on-branch observation entry — the off-branch pointer is gone
    expect(inFlight()).toBe(false);
    expect(getGraphStore().observerFrontier).toBe("a1");
    // the resolver was rebuilt against the new branch (resolves its entries)
    const resolver = getGraphStore().resolveEntries;
    expect(resolver).not.toBeNull();
    const resolved = (resolver as NonNullable<typeof resolver>)(["u1"]) as Array<{ id: string }>;
    expect(resolved[0]?.id).toBe("u1");
  });

  it("no-ops the in-flight abort when idle (a plain navigation between turns)", async () => {
    const branch = [userEntry("u1", "task"), assistantEntry("a1", "work")];
    const { ctx, pi } = makeCtx(branch);
    await onSessionTree({ type: "session_tree", newLeafId: "leaf-2", oldLeafId: "leaf-1" }, ctx, pi, noopWidget);
    expect(inFlight()).toBe(false);
    // the graph reloaded (nGoal re-seeded on the empty reconstructed graph)
    expect(getGraphStore().graph.nodes.has(N_GOAL)).toBe(true);
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
    expect(obs?.summary).toBe("Build me a CLI tool");
    expect(obs?.parentNode).toBe(N_GOAL);
    expect(obs?.sourceEntryIds).toEqual(["u1"]);
    expect(obs?.importance).toBe("crit");
    // nGoal.summary is left empty for the goal-extract stage (no mechanical seed).
    expect(graph.nodes.get(N_GOAL)?.summary).toBe("");
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

  it("is a no-op when the first user message has no extractable text (image-only)", async () => {
    // An image-only first message (content parts with no text part) extracts to
    // ""; the empty-text guard must skip capture rather than record an empty
    // oInitialPrompt under nGoal.
    const branch = [
      {
        type: "message",
        id: "u1",
        timestamp: "2026-07-29T10:00:00.000Z",
        message: { role: "user", content: [{ type: "image", source: { data: "<bytes>" } }], timestamp: Date.now() },
      },
    ] as unknown as FakeEntry[];
    const { ctx, pi } = makeCtx(branch);
    await onSessionStart({ type: "session_start", reason: "startup" }, ctx, pi, noopWidget);
    captureInitialPromptIfAbsent(ctx, pi);
    const graph = getGraphStore().graph;
    expect(graph.hasInitialPrompt).toBe(false);
    expect(graph.observations.has(O_INITIAL_PROMPT)).toBe(false);
    // nGoal summary stays empty (no first line to seed from)
    expect(graph.nodes.get(N_GOAL)?.summary).toBe("");
  });

  it("leaves nGoal.summary empty for the goal-extract stage (no mechanical seed)", async () => {
    // The capture no longer seeds nGoal.summary from the first line — the
    // goal-extract stage distills it from the verbatim prompt. The summary
    // stays empty here (no goal-extract model wired in this unit test).
    const branch = [userEntry("u1", "  \nBuild the memory extension\nDetails follow")];
    const { ctx, pi } = makeCtx(branch);
    await onSessionStart({ type: "session_start", reason: "startup" }, ctx, pi, noopWidget);
    captureInitialPromptIfAbsent(ctx, pi);
    expect(getGraphStore().graph.nodes.get(N_GOAL)?.summary).toBe("");
    // the verbatim multi-line prompt is still captured whole as oInitialPrompt
    expect(getGraphStore().graph.observations.get(O_INITIAL_PROMPT)?.summary).toBe(
      "  \nBuild the memory extension\nDetails follow",
    );
  });

  it("strips ANSI escape sequences from the captured prompt (same surface as Observer)", async () => {
    // A pasted ANSI sequence (e.g. a color code) must not leak into the stored
    // oInitialPrompt / injected summary — every observation is sanitized.
    const ansiRed = "\u001b[31m";
    const branch = [userEntry("u1", `${ansiRed}Build the memory extension`)];
    const { ctx, pi } = makeCtx(branch);
    await onSessionStart({ type: "session_start", reason: "startup" }, ctx, pi, noopWidget);
    captureInitialPromptIfAbsent(ctx, pi);
    const obs = getGraphStore().graph.observations.get(O_INITIAL_PROMPT);
    expect(obs?.summary).toBe("Build the memory extension");
    expect(obs?.summary).not.toContain(ansiRed);
  });

  it("persist the capture (observation entry + nGoal seed + record_observation link deltas)", async () => {
    const branch = [userEntry("u1", "do the thing")];
    const { ctx, pi, appended } = makeCtx(branch);
    await onSessionStart({ type: "session_start", reason: "startup" }, ctx, pi, noopWidget);
    captureInitialPromptIfAbsent(ctx, pi);
    const obs = appended.filter(([t]) => t === "session-owl.observation");
    expect(obs.length).toBe(1);
    // coversUpToId = the first user entry (frontier advances past it)
    expect((obs[0][1] as { coversUpToId: string }).coversUpToId).toBe("u1");
    // graph_delta log: create_node (nGoal seed) + record_observation (the
    // oInitialPrompt link — replay re-executes the capture exactly). nGoal.summary
    // is set by the goal-extract stage, not a capture-time set_meta.
    const deltas = appended.filter(([t]) => t === "session-owl.graph_delta");
    expect(deltas.length).toBe(2);
    const create = deltas[0][1] as { delta: { type: string; id: string } };
    const record = deltas[1][1] as { delta: { type: string; obs: { id: string; parentNode: string } } };
    expect(create.delta.type).toBe("create_node");
    expect(create.delta.id).toBe("nGoal");
    expect(record.delta.type).toBe("record_observation");
    expect(record.delta.obs.id).toBe("oInitialPrompt");
    expect(record.delta.obs.parentNode).toBe("nGoal");
    const setMetas = deltas.filter(([, d]) => (d as { delta: { type: string } }).delta?.type === "set_meta");
    expect(setMetas.length).toBe(0);
  });
});

describe("onSessionShutdown", () => {
  beforeEach(() => {
    resetForNewSession();
    _resetRunLock();
    _resetSessionAffinity();
  });

  it("ends the widget stage display and clears the ctx", () => {
    const widget = { ...noopWidget, clearCtx: vi.fn(), endStage: vi.fn() };
    onSessionShutdown({ type: "session_shutdown", reason: "quit" }, widget);
    expect(widget.endStage).toHaveBeenCalledTimes(1);
    expect(widget.clearCtx).toHaveBeenCalledTimes(1);
  });

  it("aborts an in-flight run (so it stops wasting tokens on a discarded session)", () => {
    const handle = acquireOrSkip("observe") as RunHandle;
    expect(handle.abortController.signal.aborted).toBe(false);
    onSessionShutdown({ type: "session_shutdown", reason: "reload" }, noopWidget);
    expect(handle.abortController.signal.aborted).toBe(true);
    handle.release();
  });

  it("terminates the regex worker so it does not leak across reload", async () => {
    // first call spawns the shared worker
    await runRegexTests(/foo/, ["foobar"], 5000);
    onSessionShutdown({ type: "session_shutdown", reason: "reload" }, noopWidget);
    // the worker was discarded; a subsequent call must respawn cleanly
    const res = await runRegexTests(/foo/, ["foobar"], 5000);
    expect("results" in res).toBe(true);
  });

  it("clears the per-session affinity base", () => {
    setSessionOwlSessionBase("abc-123");
    expect(getStageAffinityId("build")).toBe("abc-123:build");
    onSessionShutdown({ type: "session_shutdown", reason: "quit" }, noopWidget);
    expect(getStageAffinityId("observe")).toBeNull();
    expect(getStageAffinityId("build")).toBeNull();
    expect(getStageAffinityId("select")).toBeNull();
  });
});

describe("session-entry resolver (buildEntryResolver + lifecycle wiring)", () => {
  beforeEach(() => {
    resetForNewSession();
    _resetGetSessionOwlSettings();
  });
  afterEach(() => _resetGetSessionOwlSettings());

  it("buildEntryResolver resolves known ids and drops missing ones (branch order)", () => {
    const { ctx } = makeCtx([userEntry("u1", "first"), userEntry("u2", "second")]);
    const resolve = buildEntryResolver(ctx);
    // both known ids resolve; an unknown id is silently dropped; output is in
    // BRANCH order (not input order) so tool call/result pairing works.
    const out = resolve(["u2", "missing", "u1"]) as { id: string }[];
    expect(out.map((e) => e.id)).toEqual(["u1", "u2"]);
  });

  it("augments a lone toolResult with its matching toolCall (no orphan result)", () => {
    const branch = [
      userEntry("u1", "do it"),
      toolCallEntry("a1", "call1", "bash", { cmd: "ls" }),
      toolResultEntry("r1", "call1", "output"),
    ];
    const { ctx } = makeCtx(branch);
    const resolve = buildEntryResolver(ctx);
    // citing ONLY the result → the call is pulled in so the pair renders whole.
    const out = resolve(["r1"]) as { id: string }[];
    expect(out.map((e) => e.id)).toEqual(["a1", "r1"]);
  });

  it("augments a lone toolCall with its matching toolResult (no orphan call)", () => {
    const branch = [
      userEntry("u1", "do it"),
      toolCallEntry("a1", "call1", "bash", { cmd: "ls" }),
      toolResultEntry("r1", "call1", "output"),
    ];
    const { ctx } = makeCtx(branch);
    const resolve = buildEntryResolver(ctx);
    // citing ONLY the assistant call → the result is pulled in so the pair
    // renders whole (call immediately followed by its result).
    const out = resolve(["a1"]) as { id: string }[];
    expect(out.map((e) => e.id)).toEqual(["a1", "r1"]);
  });

  it("onSessionStart installs the resolver (refresh on every session_start)", async () => {
    const { ctx, pi } = makeCtx([userEntry("u1", "first")]);
    expect(getGraphStore().resolveEntries).toBeNull();
    await onSessionStart({ type: "session_start", reason: "startup" }, ctx, pi, noopWidget);
    const resolver = getGraphStore().resolveEntries;
    expect(resolver).not.toBeNull();
    const out = resolver !== null ? resolver(["u1", "nope"]) : [];
    expect((out as { id: string }[]).map((e) => e.id)).toEqual(["u1"]);
  });

  it("onSessionShutdown clears the resolver (no dead-session reads)", async () => {
    const { ctx, pi } = makeCtx([userEntry("u1", "first")]);
    await onSessionStart({ type: "session_start", reason: "startup" }, ctx, pi, noopWidget);
    expect(getGraphStore().resolveEntries).not.toBeNull();
    onSessionShutdown({ type: "session_shutdown", reason: "quit" }, noopWidget);
    expect(getGraphStore().resolveEntries).toBeNull();
  });
});
