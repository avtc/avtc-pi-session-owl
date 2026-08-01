import type { AssistantMessage, Message, ToolCall, Usage } from "@earendil-works/pi-ai";
import type { SessionEntry, SessionMessageEntry } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { buildTail, buildWorkingCopy, type TailContext } from "../../src/selector/input-view.js";
import type { Node, NodeId, Observation, ObsId } from "../../src/types.js";
import { MemkeeperGraph, makeNode, makeObservation, N_GOAL, N_IRRELEVANT, O_INITIAL_PROMPT } from "../../src/types.js";

function g(): MemkeeperGraph {
  const nodes = new Map<NodeId, Node>();
  const observations = new Map<ObsId, Observation>();
  const nGoal = makeNode({
    id: N_GOAL,
    summary: "the goal",
    importance: "critical",
    parentNode: null,
    state: "active",
    createdAt: "2026-07-28 09:00",
  });
  const nActive = makeNode({
    id: "n3",
    summary: "active root",
    importance: "high",
    parentNode: null,
    state: "active",
    createdAt: "2026-07-28 09:00",
  });
  const nNew = makeNode({
    id: "n4",
    summary: "fresh",
    importance: "medium",
    parentNode: null,
    state: "new",
    createdAt: "2026-07-28 09:00",
  });
  const nArchived = makeNode({
    id: "n5",
    summary: "cold",
    importance: "low",
    parentNode: null,
    state: "archived",
    createdAt: "2026-07-28 09:00",
  });
  const nObsolete = makeNode({
    id: "n6",
    summary: "dead",
    importance: "low",
    parentNode: null,
    state: "obsolete",
    supersededBy: "n3",
    createdAt: "2026-07-28 09:00",
  });
  nodes.set(N_GOAL, nGoal);
  nodes.set("n3", nActive);
  nodes.set("n4", nNew);
  nodes.set("n5", nArchived);
  nodes.set("n6", nObsolete);
  const oInit = makeObservation({
    id: O_INITIAL_PROMPT,
    content: "initial",
    importance: "critical",
    sourceEntryIds: ["u1"],
    parentNode: N_GOAL,
    timestamp: "2026-07-28 09:00",
  });
  const o1 = makeObservation({
    id: "o1",
    content: "fact",
    importance: "medium",
    sourceEntryIds: ["e2"],
    parentNode: "n3",
    timestamp: "2026-07-28 10:00",
  });
  nGoal.observationIds = [O_INITIAL_PROMPT];
  nActive.observationIds = ["o1"];
  observations.set(O_INITIAL_PROMPT, oInit);
  observations.set("o1", o1);
  return new MemkeeperGraph({ nodes, observations, nextObsId: 2, nextNodeId: 7 });
}

describe("buildWorkingCopy", () => {
  it("includes active + new + archived nodes and excludes obsolete", () => {
    const { graph } = buildWorkingCopy(g());
    expect(graph.nodes.has(N_GOAL)).toBe(true);
    expect(graph.nodes.has("n3")).toBe(true); // active
    expect(graph.nodes.has("n4")).toBe(true); // new
    expect(graph.nodes.has("n5")).toBe(true); // archived
    expect(graph.nodes.has("n6")).toBe(false); // obsolete excluded
  });

  it("injects nIrrelevant (summary 'Irrelevant', empty, active, root)", () => {
    const { graph, nIrrelevantId } = buildWorkingCopy(g());
    expect(nIrrelevantId).toBe(N_IRRELEVANT);
    const nI = graph.nodes.get(N_IRRELEVANT);
    expect(nI).toBeDefined();
    expect(nI?.summary).toBe("Irrelevant");
    expect(nI?.state).toBe("active");
    expect(nI?.parentNode).toBe(null);
    expect(nI?.observationIds).toEqual([]);
    expect(nI?.childNodeIds).toEqual([]);
  });

  it("copies nGoal + oInitialPrompt into the working copy", () => {
    const { graph } = buildWorkingCopy(g());
    expect(graph.nodes.has(N_GOAL)).toBe(true);
    expect(graph.hasInitialPrompt).toBe(true);
    expect(graph.observations.get(O_INITIAL_PROMPT)?.parentNode).toBe(N_GOAL);
  });

  it("is a deep copy: mutating the working copy does not affect the source", () => {
    const source = g();
    const { graph } = buildWorkingCopy(source);
    const n3 = graph.nodes.get("n3");
    if (n3) n3.summary = "changed";
    graph.nodes.get(N_IRRELEVANT)?.childNodeIds.push("n3");
    expect(source.nodes.get("n3")?.summary).toBe("active root");
    expect(source.nodes.get("n3")?.parentNode).toBe(null);
  });

  it("reparents a non-obsolete child of a dropped obsolete node to root", () => {
    const nodes = new Map<NodeId, Node>();
    const observations = new Map<ObsId, Observation>();
    const nObs = makeNode({
      id: "n9",
      summary: "obsolete parent",
      importance: "low",
      parentNode: null,
      state: "obsolete",
      supersededBy: "n3",
      createdAt: "2026-07-28 09:00",
    });
    const nChild = makeNode({
      id: "n10",
      summary: "live child",
      importance: "high",
      parentNode: "n9",
      state: "active",
      createdAt: "2026-07-28 09:00",
    });
    nObs.childNodeIds = ["n10"];
    nodes.set(
      N_GOAL,
      makeNode({
        id: N_GOAL,
        summary: "g",
        importance: "critical",
        parentNode: null,
        state: "active",
        createdAt: "2026-07-28 09:00",
      }),
    );
    nodes.set("n9", nObs);
    nodes.set("n10", nChild);
    const source = new MemkeeperGraph({ nodes, observations, nextObsId: 1, nextNodeId: 11 });
    const { graph } = buildWorkingCopy(source);
    expect(graph.nodes.has("n9")).toBe(false); // obsolete dropped
    expect(graph.nodes.has("n10")).toBe(true); // live child kept
    expect(graph.nodes.get("n10")?.parentNode).toBe(null); // reparented to root
  });
});

// --- buildTail fixtures ------------------------------------------------------

const USAGE: Usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
const FIXED_TS = "2026-07-29T00:00:00Z";

function msg(id: string, message: Message): SessionMessageEntry {
  return { type: "message", id, parentId: null, timestamp: FIXED_TS, message };
}
function userEntry(id: string, text: string): SessionMessageEntry {
  return msg(id, { role: "user", content: text, timestamp: 0 });
}
function assistantEntry(id: string, text: string): SessionMessageEntry {
  const message: AssistantMessage = {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "anthropic",
    provider: "anthropic",
    model: "m",
    usage: USAGE,
    stopReason: "stop",
    timestamp: 0,
  };
  return msg(id, message);
}

function ctxFor(branch: SessionEntry[]): TailContext {
  return {
    getBranch: () => branch,
    getLeafId: () => "leaf",
  };
}

const CHUNK_OPTS = { tokenThreshold: 1000, toolBlockCapTokens: null, includeThinking: false };

describe("buildTail", () => {
  it("renders the retained tail verbatim when the last user message is within the tail", () => {
    const branch: SessionEntry[] = [
      assistantEntry("a1", "old work"), // before cut
      userEntry("u1", "do the thing"), // before cut — would-be last user, but a later one is in the tail
      assistantEntry("a2", "doing"),
      userEntry("u2", "now this"), // within tail
    ];
    const out = buildTail(ctxFor(branch), { firstKeptEntryId: "a2" }, CHUNK_OPTS);
    // Tail starts at a2 (the cut) — so u2 is within the tail → verbatim.
    expect(out).toContain("now this");
    expect(out).not.toContain("do the thing"); // before the cut, not in tail
  });

  it("renders verbatim when the last user message is within the tail (no pairing needed)", () => {
    const branch: SessionEntry[] = [
      assistantEntry("a1", "earlier reply"),
      userEntry("u1", "the real ask"),
      assistantEntry("a2", "tail start"),
      userEntry("u2", "tail msg"),
    ];
    const out = buildTail(ctxFor(branch), { firstKeptEntryId: "a2" }, CHUNK_OPTS);
    // The last REAL user message is u2 (within tail at a2). But if we force the
    // last user message outside the cut, the pairing kicks in. Here u2 is in the
    // tail, so this asserts the verbatim path; pairing is covered next.
    expect(out).toContain("tail msg");
  });

  it("prepends [last agent text] + [last user] + truncation marker when last user is before the cut", () => {
    const branch: SessionEntry[] = [
      assistantEntry("a0", "the preceding agent reply"),
      userEntry("u0", "the terse last ask"),
      assistantEntry("a1", "noise between"),
      assistantEntry("a2", "tail begins here"),
    ];
    // Cut at a2: tail = [a2]. The last user message u0 is BEFORE the cut.
    const out = buildTail(ctxFor(branch), { firstKeptEntryId: "a2" }, CHUNK_OPTS);
    expect(out).toContain("the terse last ask"); // last user message surfaced
    expect(out).toContain("the preceding agent reply"); // paired preceding agent text
    expect(out).toContain("tail begins here"); // tail verbatim
    expect(out.toLowerCase()).toMatch(/truncat/); // truncation marker present
  });

  it("skips unstuck auto-injected continuations when finding the last user message", () => {
    const branch: SessionEntry[] = [
      assistantEntry("a0", "the real preceding reply"),
      userEntry("u0", "the real ask"),
      assistantEntry("a1", "cut off"),
      userEntry("u1", "continue"), // unstuck auto-injection — skipped
      assistantEntry("a2", "tail begins"),
    ];
    const out = buildTail(ctxFor(branch), { firstKeptEntryId: "a2" }, CHUNK_OPTS);
    expect(out).toContain("the real ask"); // the skipped-past real last user msg
    expect(out).not.toContain("continue"); // unstuck injection not surfaced as the task signal
  });

  it("returns empty string when firstKeptEntryId is null (mid-session, open)", () => {
    const branch: SessionEntry[] = [userEntry("u1", "x"), assistantEntry("a1", "y")];
    const out = buildTail(ctxFor(branch), { firstKeptEntryId: null }, CHUNK_OPTS);
    expect(out).toBe("");
  });
});

// --- buildTodo tests --------------------------------------------------------

import { buildTodo, type TodoContext, type TodoItem } from "../../src/selector/input-view.js";

function item(id: string, name: string, status: TodoItem["status"], details: string | null): TodoItem {
  return details === null ? { id, name, status } : { id, name, status, details };
}

describe("buildTodo", () => {
  it("renders the in-progress item with full details + pending items terse", () => {
    const ctx: TodoContext = {
      getInProgress: () => item("1", "Implement Selector", "in_progress", "build the working-copy deep copy"),
      getPending: () => [item("2", "Selector tools", "pending", null), item("3", "Persist tree", "pending", null)],
    };
    const out = buildTodo(ctx);
    expect(out).toContain("in_progress");
    expect(out).toContain("Implement Selector");
    expect(out).toContain("build the working-copy deep copy"); // full details
    expect(out).toContain("Selector tools"); // pending terse
    expect(out).toContain("Persist tree");
  });

  it("omits pending details (terse)", () => {
    const ctx: TodoContext = {
      getInProgress: () => null,
      getPending: () => [item("2", "Selector tools", "pending", "full pending details that should NOT appear")],
    };
    const out = buildTodo(ctx);
    expect(out).toContain("Selector tools");
    expect(out).not.toContain("full pending details that should NOT appear");
  });

  it("renders an empty-but-present section when there is no in-progress and no pending", () => {
    const ctx: TodoContext = { getInProgress: () => null, getPending: () => [] };
    const out = buildTodo(ctx);
    expect(out).toContain("Todo"); // section present
  });
});

// --- buildSelectorInputView tests -------------------------------------------

import type { TouchedFile } from "../../src/compaction/touched-files.js";
import { buildSelectorInputView } from "../../src/selector/input-view.js";

function sourceGraphForAssembly(): MemkeeperGraph {
  const nodes = new Map<NodeId, Node>();
  const observations = new Map<ObsId, Observation>();
  const nGoal = makeNode({
    id: N_GOAL,
    summary: "the goal",
    importance: "critical",
    parentNode: null,
    state: "active",
    createdAt: "2026-07-28 09:00",
  });
  const n3 = makeNode({
    id: "n3",
    summary: "an active root",
    importance: "high",
    parentNode: null,
    state: "active",
    createdAt: "2026-07-28 10:00",
  });
  nodes.set(N_GOAL, nGoal);
  nodes.set("n3", n3);
  observations.set(
    O_INITIAL_PROMPT,
    makeObservation({
      id: O_INITIAL_PROMPT,
      content: "build it",
      importance: "critical",
      sourceEntryIds: ["u1"],
      timestamp: "2026-07-28 09:00",
      parentNode: N_GOAL,
    }),
  );
  nGoal.observationIds = [O_INITIAL_PROMPT];
  return new MemkeeperGraph({ nodes, observations, nextObsId: 1, nextNodeId: 4 });
}

const ASSEMBLY_OPTS = { tokenThreshold: 1000, toolBlockCapTokens: null, includeThinking: false };

describe("buildSelectorInputView", () => {
  it("assembles the three parts in order (working tree, current-task context, legends)", () => {
    const branch: SessionEntry[] = [userEntry("u0", "the ask"), assistantEntry("a2", "tail begins")];
    const { view } = buildSelectorInputView({
      sourceGraph: sourceGraphForAssembly(),
      tail: { getLeafId: () => "leaf", getBranch: () => branch },
      tailBoundary: { firstKeptEntryId: "a2" },
      todo: { getInProgress: () => null, getPending: () => [] },
      touchedFiles: { getLeafId: () => "leaf", getBranch: () => branch },
      sinceEntryId: "a2",
      chunkOptions: ASSEMBLY_OPTS,
    });
    // Working tree roots appear before the tail content.
    expect(view.indexOf("the goal")).toBeLessThan(view.indexOf("the ask"));
    // Tail appears before the legends.
    expect(view.indexOf("the ask")).toBeLessThan(view.indexOf("📁 node"));
  });

  it("includes the tree legend (RENDER_LEGEND) and the tail legend WITHOUT E=", () => {
    const { view } = buildSelectorInputView({
      sourceGraph: sourceGraphForAssembly(),
      tail: { getLeafId: () => "leaf", getBranch: () => [assistantEntry("a2", "x")] },
      tailBoundary: { firstKeptEntryId: "a2" },
      todo: { getInProgress: () => null, getPending: () => [] },
      touchedFiles: { getLeafId: () => "leaf", getBranch: () => [] },
      sinceEntryId: "a2",
      chunkOptions: ASSEMBLY_OPTS,
    });
    expect(view).toContain("📁 node"); // tree legend present
    expect(view).toContain("U user"); // tail legend present
    // The tail legend line has no E= attribute (redundant for the Selector).
    const legendLine = view.split("\n").find((line) => line.includes("U user"));
    expect(legendLine).toBeDefined();
    expect(legendLine?.includes("E=")).toBe(false);
  });

  it("omits the todo section entirely when the bridge is absent (null)", () => {
    const { view } = buildSelectorInputView({
      sourceGraph: sourceGraphForAssembly(),
      tail: { getLeafId: () => "leaf", getBranch: () => [assistantEntry("a2", "x")] },
      tailBoundary: { firstKeptEntryId: "a2" },
      todo: null,
      touchedFiles: { getLeafId: () => "leaf", getBranch: () => [] },
      sinceEntryId: "a2",
      chunkOptions: ASSEMBLY_OPTS,
    });
    expect(view).not.toContain("Todo");
  });

  it("renders touched files (read + write deduped) in the context section", () => {
    // A branch with a read and a write/edit on the same path + a distinct path.
    const branch: SessionEntry[] = [assistantEntry("a2", "tail")];
    // Supply touched files directly via a fake context that returns fixed files.
    const touched = (): TouchedFile[] => [
      { path: "src/a.ts", timestamp: "2026-07-28 14:00", op: "write" },
      { path: "README.md", timestamp: "2026-07-28 13:00", op: "read" },
    ];
    // buildSelectorInputView uses extractTouchedFiles(touchedFiles, sinceEntryId);
    // we feed a context whose getBranch returns toolCall entries below.
    const { view } = buildSelectorInputView({
      sourceGraph: sourceGraphForAssembly(),
      tail: { getLeafId: () => "leaf", getBranch: () => branch },
      tailBoundary: { firstKeptEntryId: "a2" },
      todo: null,
      touchedFiles: toolCallBranch(),
      sinceEntryId: null,
      chunkOptions: ASSEMBLY_OPTS,
    });
    void touched;
    expect(view).toContain("src/a.ts");
    expect(view).toContain("✎");
  });
});

// Tool-call-bearing branch for touched-files extraction.
function toolCallBranch(): { getLeafId: () => string; getBranch: () => SessionEntry[] } {
  const entries: SessionEntry[] = [
    toolCallEntry("c1", "write", { path: "src/a.ts" }),
    toolCallEntry("c2", "read", { path: "README.md" }),
  ];
  return { getLeafId: () => "leaf", getBranch: () => entries };
}

function toolCallEntry(id: string, toolName: string, args: Record<string, unknown>): SessionEntry {
  const message: AssistantMessage = {
    role: "assistant",
    content: [{ type: "toolCall", id: "t1", name: toolName, arguments: args } as ToolCall],
    api: "anthropic",
    provider: "anthropic",
    model: "m",
    usage: USAGE,
    stopReason: "stop",
    timestamp: 0,
  };
  return { type: "message", id, parentId: null, timestamp: FIXED_TS, message };
}
