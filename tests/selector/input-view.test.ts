// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import type { AssistantMessage, Message, ThinkingContent, ToolCall, Usage } from "@earendil-works/pi-ai";
import type { SessionEntry, SessionMessageEntry } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { validateGraph } from "../../src/graph/invariants.js";
import { buildTail, buildWorkingCopy, type TailContext } from "../../src/selector/input-view.js";
import type { Node, NodeId, Observation, ObsId } from "../../src/types.js";
import { makeNode, makeObservation, N_GOAL, N_IRRELEVANT, O_INITIAL_PROMPT, SessionOwlGraph } from "../../src/types.js";

function g(): SessionOwlGraph {
  const nodes = new Map<NodeId, Node>();
  const observations = new Map<ObsId, Observation>();
  const nGoal = makeNode({
    id: N_GOAL,
    summary: "the goal",
    importance: "crit",
    parentNode: null,
    state: "active",
    createdAt: "2026-07-28T09:00:00.000Z",
  });
  const nActive = makeNode({
    id: "n3",
    summary: "active root",
    importance: "high",
    parentNode: null,
    state: "active",
    createdAt: "2026-07-28T09:00:00.000Z",
  });
  const nNew = makeNode({
    id: "n4",
    summary: "fresh",
    importance: "med",
    parentNode: null,
    state: "new",
    createdAt: "2026-07-28T09:00:00.000Z",
  });
  const nArchived = makeNode({
    id: "n5",
    summary: "cold",
    importance: "low",
    parentNode: null,
    state: "archived",
    createdAt: "2026-07-28T09:00:00.000Z",
  });
  const nObsolete = makeNode({
    id: "n6",
    summary: "dead",
    importance: "low",
    parentNode: null,
    state: "obsolete",
    supersededBy: "n3",
    createdAt: "2026-07-28T09:00:00.000Z",
  });
  nodes.set(N_GOAL, nGoal);
  nodes.set("n3", nActive);
  nodes.set("n4", nNew);
  nodes.set("n5", nArchived);
  nodes.set("n6", nObsolete);
  const oInit = makeObservation({
    id: O_INITIAL_PROMPT,
    summary: "initial",
    importance: "crit",
    sourceEntryIds: ["u1"],
    parentNode: N_GOAL,
    timestamp: "2026-07-28T09:00:00.000Z",
  });
  const o1 = makeObservation({
    id: "o1",
    summary: "fact",
    importance: "med",
    sourceEntryIds: ["e2"],
    parentNode: "n3",
    timestamp: "2026-07-28T10:00:00.000Z",
  });
  nGoal.observationIds = [O_INITIAL_PROMPT];
  nActive.observationIds = ["o1"];
  observations.set(O_INITIAL_PROMPT, oInit);
  observations.set("o1", o1);
  return new SessionOwlGraph({ nodes, observations, nextObsId: 2, nextNodeId: 7 });
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
      createdAt: "2026-07-28T09:00:00.000Z",
    });
    const nChild = makeNode({
      id: "n10",
      summary: "live child",
      importance: "high",
      parentNode: "n9",
      state: "active",
      createdAt: "2026-07-28T09:00:00.000Z",
    });
    nObs.childNodeIds = ["n10"];
    nodes.set(
      N_GOAL,
      makeNode({
        id: N_GOAL,
        summary: "g",
        importance: "crit",
        parentNode: null,
        state: "active",
        createdAt: "2026-07-28T09:00:00.000Z",
      }),
    );
    nodes.set("n9", nObs);
    nodes.set("n10", nChild);
    const source = new SessionOwlGraph({ nodes, observations, nextObsId: 1, nextNodeId: 11 });
    const { graph } = buildWorkingCopy(source);
    expect(graph.nodes.has("n9")).toBe(false); // obsolete dropped
    expect(graph.nodes.has("n10")).toBe(true); // live child kept
    expect(graph.nodes.get("n10")?.parentNode).toBe(null); // reparented to root
  });

  it("removes a dropped non-root obsolete node from its parent's childNodeIds (no phantom links)", () => {
    const nodes = new Map<NodeId, Node>();
    const observations = new Map<ObsId, Observation>();
    const nGoal = makeNode({
      id: N_GOAL,
      summary: "g",
      importance: "crit",
      parentNode: null,
      state: "active",
      createdAt: "2026-07-28T09:00:00.000Z",
    });
    const nObs = makeNode({
      id: "n9",
      summary: "obsolete child of nGoal",
      importance: "low",
      parentNode: N_GOAL,
      state: "obsolete",
      supersededBy: "n3",
      createdAt: "2026-07-28T09:00:00.000Z",
    });
    nGoal.childNodeIds = ["n9"];
    nGoal.observationIds = [O_INITIAL_PROMPT];
    observations.set(
      O_INITIAL_PROMPT,
      makeObservation({
        id: O_INITIAL_PROMPT,
        summary: "goal",
        importance: "crit",
        sourceEntryIds: ["u1"],
        timestamp: "2026-07-28T09:00:00.000Z",
        parentNode: N_GOAL,
      }),
    );
    nodes.set(N_GOAL, nGoal);
    nodes.set("n9", nObs);
    const source = new SessionOwlGraph({ nodes, observations, nextObsId: 1, nextNodeId: 10 });
    const { graph } = buildWorkingCopy(source);
    expect(graph.nodes.has("n9")).toBe(false); // obsolete dropped
    // No phantom child link — nGoal no longer references the dropped n9.
    expect(graph.nodes.get(N_GOAL)?.childNodeIds).toEqual([]);
    // The working copy is structurally valid (no dangling child links).
    expect(() => validateGraph(graph)).not.toThrow();
  });

  it("excludes observations whose parent node is obsolete (dropped with it)", () => {
    const nodes = new Map<NodeId, Node>();
    const observations = new Map<ObsId, Observation>();
    const nGoal = makeNode({
      id: N_GOAL,
      summary: "g",
      importance: "crit",
      parentNode: null,
      state: "active",
      createdAt: "2026-07-28T09:00:00.000Z",
    });
    const nObs = makeNode({
      id: "n9",
      summary: "obsolete",
      importance: "low",
      parentNode: null,
      state: "obsolete",
      supersededBy: "n3",
      createdAt: "2026-07-28T09:00:00.000Z",
    });
    nObs.observationIds = ["o5"];
    observations.set(
      O_INITIAL_PROMPT,
      makeObservation({
        id: O_INITIAL_PROMPT,
        summary: "goal",
        importance: "crit",
        sourceEntryIds: ["u1"],
        timestamp: "2026-07-28T09:00:00.000Z",
        parentNode: N_GOAL,
      }),
    );
    observations.set(
      "o5",
      makeObservation({
        id: "o5",
        summary: "dead fact",
        importance: "low",
        sourceEntryIds: ["e5"],
        timestamp: "2026-07-28T09:00:00.000Z",
        parentNode: "n9",
      }),
    );
    nGoal.observationIds = [O_INITIAL_PROMPT];
    nodes.set(N_GOAL, nGoal);
    nodes.set("n9", nObs);
    const source = new SessionOwlGraph({ nodes, observations, nextObsId: 2, nextNodeId: 10 });
    const { graph } = buildWorkingCopy(source);
    expect(graph.nodes.has("n9")).toBe(false);
    expect(graph.observations.has("o5")).toBe(false); // obs under obsolete node excluded
    expect(graph.observations.has(O_INITIAL_PROMPT)).toBe(true); // goal obs kept
  });

  it("cleans childNodeIds across a nested obsolete chain (obsolete parent of an obsolete node)", () => {
    // nGoal → n1 (obsolete) → n2 (obsolete) → n3 (active). Dropping n1 and n2
    // must leave n3 reparented to root and n1 removed from nGoal.childNodeIds,
    // with no dangling links anywhere in the chain.
    const nodes = new Map<NodeId, Node>();
    const observations = new Map<ObsId, Observation>();
    const nGoal = makeNode({
      id: N_GOAL,
      summary: "g",
      importance: "crit",
      parentNode: null,
      state: "active",
      createdAt: "2026-07-28T09:00:00.000Z",
    });
    const n1 = makeNode({
      id: "n1",
      summary: "obsolete mid",
      importance: "low",
      parentNode: N_GOAL,
      state: "obsolete",
      supersededBy: "n3",
      createdAt: "2026-07-28T09:00:00.000Z",
    });
    const n2 = makeNode({
      id: "n2",
      summary: "obsolete leaf",
      importance: "low",
      parentNode: "n1",
      state: "obsolete",
      supersededBy: "n3",
      createdAt: "2026-07-28T09:00:00.000Z",
    });
    const n3 = makeNode({
      id: "n3",
      summary: "live grandchild",
      importance: "high",
      parentNode: "n2",
      state: "active",
      createdAt: "2026-07-28T09:00:00.000Z",
    });
    observations.set(
      O_INITIAL_PROMPT,
      makeObservation({
        id: O_INITIAL_PROMPT,
        summary: "goal",
        importance: "crit",
        sourceEntryIds: ["u1"],
        timestamp: "2026-07-28T09:00:00.000Z",
        parentNode: N_GOAL,
      }),
    );
    nGoal.observationIds = [O_INITIAL_PROMPT];
    nGoal.childNodeIds = ["n1"];
    n1.childNodeIds = ["n2"];
    n2.childNodeIds = ["n3"];
    nodes.set(N_GOAL, nGoal);
    nodes.set("n1", n1);
    nodes.set("n2", n2);
    nodes.set("n3", n3);
    const source = new SessionOwlGraph({ nodes, observations, nextObsId: 1, nextNodeId: 4 });
    const { graph } = buildWorkingCopy(source);
    expect(graph.nodes.has("n1")).toBe(false);
    expect(graph.nodes.has("n2")).toBe(false);
    expect(graph.nodes.has("n3")).toBe(true);
    expect(graph.nodes.get("n3")?.parentNode).toBe(null); // reparented to root
    expect(graph.nodes.get(N_GOAL)?.childNodeIds).toEqual([]); // n1 removed from nGoal
    expect(() => validateGraph(graph)).not.toThrow();
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

function assistantWithToolAndThinking(id: string, text: string): SessionMessageEntry {
  const message: AssistantMessage = {
    role: "assistant",
    content: [
      { type: "thinking", thinking: "the thinking" } as ThinkingContent,
      { type: "text", text },
      { type: "toolCall", id: "call1", name: "read", arguments: { path: "/x" } } as ToolCall,
    ],
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

const CHUNK_OPTS = { tokenThreshold: 1000, toolBlockCapTokens: null, includeThinking: false, includeEntryId: false };

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

  it("renders the prelude with ONLY the user block when the last user message has NO preceding agent text (user is the first entry)", () => {
    // branch where the last user message is the FIRST entry — no preceding
    // assistant TEXT to pair it with (precedingAgentIndex === NOT_FOUND)
    const branch: SessionEntry[] = [
      userEntry("u1", "the opening ask"), // first entry — nothing precedes it
      assistantEntry("a1", "tail start"),
    ];
    const out = buildTail(ctxFor(branch), { firstKeptEntryId: "a1" }, CHUNK_OPTS);
    // the user block appears in the prelude (before the truncation marker)...
    const marker = "<truncated events>";
    const prelude = out.slice(0, out.indexOf(marker));
    expect(prelude).toContain("the opening ask");
    // ...but NO <ASSISTANT> agent block in the PRELUDE (there is no preceding agent text)
    expect(prelude).not.toContain("<A");
    // the retained tail still renders (a1 is in the tail)
    expect(out).toContain("tail start");
  });

  it("renders one <ASSISTANT> block per text part in the preceding agent (byte-consistent with the tail)", () => {
    // A multi-text-part assistant: the prelude must emit one <ASSISTANT> per text part,
    // matching what the tail would render for the same entry (not one joined block).
    const message: AssistantMessage = {
      role: "assistant",
      content: [
        { type: "text", text: "First sentence." },
        { type: "text", text: "Second sentence." },
      ],
      api: "anthropic",
      provider: "anthropic",
      model: "m",
      usage: USAGE,
      stopReason: "stop",
      timestamp: 0,
    };
    const multiPart: SessionMessageEntry = { type: "message", id: "a0", parentId: null, timestamp: FIXED_TS, message };
    const branch: SessionEntry[] = [multiPart, userEntry("u0", "the ask"), assistantEntry("a2", "tail begins")];
    const out = buildTail(ctxFor(branch), { firstKeptEntryId: "a2" }, CHUNK_OPTS);
    // Two separate <ASSISTANT> blocks (per part), NOT one joined block.
    expect(out).toContain("<ASSISTANT>First sentence.</ASSISTANT>");
    expect(out).toContain("<ASSISTANT>Second sentence.</ASSISTANT>");
    expect(out).not.toContain("First sentence.Second sentence.");
  });

  it("sanitizes the preceding agent text the same way the tail is (ANSI stripped)", () => {
    // The preceding agent text carries an ANSI color escape; it must be stripped
    // in the prelude just as it is in the tail (consistent sanitization).
    const ansi = "\u001b[31mred text\u001b[0m";
    const branch: SessionEntry[] = [
      assistantEntry("a0", ansi),
      userEntry("u0", "the ask"),
      assistantEntry("a2", "tail begins"),
    ];
    const out = buildTail(ctxFor(branch), { firstKeptEntryId: "a2" }, CHUNK_OPTS);
    expect(out).toContain("red text");
    expect(out).not.toContain("\u001b[31m"); // ANSI stripped in the prelude
  });

  it("skips a textless tool-call assistant turn and pairs an earlier contextual agent text", () => {
    // a0 has text; a1 is a tool-call-only turn (no text) immediately before the
    // user msg — findPrecedingAssistantText must skip a1 and surface a0's text.
    const branch: SessionEntry[] = [
      assistantEntry("a0", "the contextual reply"),
      assistantWithToolAndThinking("a1", ""), // tool-call-only, no text
      userEntry("u0", "the ask"),
      assistantEntry("a2", "tail begins"),
    ];
    const out = buildTail(ctxFor(branch), { firstKeptEntryId: "a2" }, CHUNK_OPTS);
    expect(out).toContain("the contextual reply"); // a0's text, skipping textless a1
  });

  it("pairs the preceding agent message as TEXT-ONLY (no tool calls / thinking)", () => {
    // The preceding agent carries a tool call + thinking; only its text surfaces.
    const branch: SessionEntry[] = [
      assistantWithToolAndThinking("a0", "the text reply"),
      userEntry("u0", "the ask"),
      assistantEntry("a2", "tail begins"),
    ];
    const out = buildTail(ctxFor(branch), { firstKeptEntryId: "a2" }, CHUNK_OPTS);
    expect(out).toContain("the text reply"); // text surfaced
    expect(out).not.toContain("the thinking"); // thinking excluded
    expect(out).not.toContain("<TOOLCALL:"); // tool call excluded (no <TOOLCALL> in prelude)
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

  it("renders the full retained tail with no truncation (a multi-chunk branch is kept whole)", () => {
    // A branch large enough to span multiple chunks (low threshold → many
    // chunks); the tail (from the cut) is rendered in full — the multi-chunk
    // join is exercised and nothing is cut to an arbitrary cap.
    const branch: SessionEntry[] = [];
    for (let i = 0; i < 30; i += 1) {
      branch.push(userEntry(`u${i}`, `message body ${i} with enough text to accumulate tokens`));
    }
    const cutId = "u0"; // whole branch is the tail
    const multiChunkOpts = {
      tokenThreshold: 50,
      toolBlockCapTokens: null,
      includeThinking: false,
      includeEntryId: false,
    };
    const out = buildTail(ctxFor(branch), { firstKeptEntryId: cutId }, multiChunkOpts);
    // First, middle, and last entries all present → multi-chunk join kept it whole.
    expect(out).toContain("message body 0 ");
    expect(out).toContain("message body 15 ");
    expect(out).toContain("message body 29 ");
  });
});

// --- buildTodo tests --------------------------------------------------------

import { buildTodo } from "../../src/selector/input-view.js";
import type { TodoContext, TodoItem } from "../../src/todo/types.js";

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

import { buildSelectorInputView, renderWorkingRoots } from "../../src/selector/input-view.js";

function sourceGraphForAssembly(): SessionOwlGraph {
  const nodes = new Map<NodeId, Node>();
  const observations = new Map<ObsId, Observation>();
  const nGoal = makeNode({
    id: N_GOAL,
    summary: "the goal",
    importance: "crit",
    parentNode: null,
    state: "active",
    createdAt: "2026-07-28T09:00:00.000Z",
  });
  const n3 = makeNode({
    id: "n3",
    summary: "an active root",
    importance: "high",
    parentNode: null,
    state: "active",
    createdAt: "2026-07-28T10:00:00.000Z",
  });
  nodes.set(N_GOAL, nGoal);
  nodes.set("n3", n3);
  observations.set(
    O_INITIAL_PROMPT,
    makeObservation({
      id: O_INITIAL_PROMPT,
      summary: "build it",
      importance: "crit",
      sourceEntryIds: ["u1"],
      timestamp: "2026-07-28T09:00:00.000Z",
      parentNode: N_GOAL,
    }),
  );
  nGoal.observationIds = [O_INITIAL_PROMPT];
  return new SessionOwlGraph({ nodes, observations, nextObsId: 1, nextNodeId: 4 });
}

const ASSEMBLY_OPTS = { tokenThreshold: 1000, toolBlockCapTokens: null, includeThinking: false, includeEntryId: false };

// Reconstruct the full per-pass message body the Selector sends (working tree +
// context), mirroring run.ts passMessages without the preamble.
const assemble = (r: {
  workingCopy: import("../../src/selector/input-view.js").SelectorWorkingCopy;
  contextView: string;
}): string => `Working tree\n\n${renderWorkingRoots(r.workingCopy)}\n\n${r.contextView}`;

describe("buildSelectorInputView", () => {
  it("assembles the three parts in order (working tree, current-task context, legends)", () => {
    const branch: SessionEntry[] = [userEntry("u0", "the ask"), assistantEntry("a2", "tail begins")];
    const view = assemble(
      buildSelectorInputView({
        sourceGraph: sourceGraphForAssembly(),
        tail: { getLeafId: () => "leaf", getBranch: () => branch },
        tailBoundary: { firstKeptEntryId: "a2" },
        todo: { getInProgress: () => null, getPending: () => [] },
        touchedFiles: { getLeafId: () => "leaf", getBranch: () => branch },
        sinceEntryId: "a2",
        chunkOptions: ASSEMBLY_OPTS,
      }),
    );
    // Working tree roots appear before the tail content.
    expect(view.indexOf("the goal")).toBeLessThan(view.indexOf("the ask"));
    // Tail appears before the legends.
    expect(view.indexOf("the ask")).toBeLessThan(view.indexOf("n.. node"));
  });

  it("includes the tree legend (RENDER_LEGEND) and the tail legend WITHOUT entry=", () => {
    const view = assemble(
      buildSelectorInputView({
        sourceGraph: sourceGraphForAssembly(),
        tail: { getLeafId: () => "leaf", getBranch: () => [assistantEntry("a2", "x")] },
        tailBoundary: { firstKeptEntryId: "a2" },
        todo: { getInProgress: () => null, getPending: () => [] },
        touchedFiles: { getLeafId: () => "leaf", getBranch: () => [] },
        sinceEntryId: "a2",
        chunkOptions: ASSEMBLY_OPTS,
      }),
    );
    expect(view).toContain("n.. node"); // tree legend present
    expect(view).toContain("<USER>"); // tail legend present (self-documenting uppercase tags)
    // The tail legend line has no entry= attribute (redundant for the Selector).
    const legendLine = view.split("\n").find((line) => line.includes("<USER>"));
    expect(legendLine).toBeDefined();
    expect(legendLine?.includes("entry=")).toBe(false);
  });

  it("omits the todo section entirely when the bridge is absent (null)", () => {
    const view = assemble(
      buildSelectorInputView({
        sourceGraph: sourceGraphForAssembly(),
        tail: { getLeafId: () => "leaf", getBranch: () => [assistantEntry("a2", "x")] },
        tailBoundary: { firstKeptEntryId: "a2" },
        todo: null,
        touchedFiles: { getLeafId: () => "leaf", getBranch: () => [] },
        sinceEntryId: "a2",
        chunkOptions: ASSEMBLY_OPTS,
      }),
    );
    expect(view).not.toContain("Todo");
  });

  it("renders working-tree roots nGoal-first, then time ascending (oldest first), nIrrelevant-last", () => {
    const nodes = new Map<NodeId, Node>();
    const observations = new Map<ObsId, Observation>();
    nodes.set(
      N_GOAL,
      makeNode({
        id: N_GOAL,
        summary: "goal summary",
        importance: "crit",
        parentNode: null,
        state: "active",
        createdAt: "2026-07-28T09:00:00.000Z",
      }),
    );
    // high (newer) + high (older) + low → after nGoal: high-newer, high-older, low.
    nodes.set(
      "n1",
      makeNode({
        id: "n1",
        summary: "alpha high newer",
        importance: "high",
        parentNode: null,
        state: "active",
        createdAt: "2026-07-29T10:00:00.000Z",
      }),
    );
    nodes.set(
      "n2",
      makeNode({
        id: "n2",
        summary: "bravo high older",
        importance: "high",
        parentNode: null,
        state: "active",
        createdAt: "2026-07-28T10:00:00.000Z",
      }),
    );
    nodes.set(
      "n3",
      makeNode({
        id: "n3",
        summary: "charlie low",
        importance: "low",
        parentNode: null,
        state: "active",
        createdAt: "2026-07-29T10:00:00.000Z",
      }),
    );
    observations.set(
      O_INITIAL_PROMPT,
      makeObservation({
        id: O_INITIAL_PROMPT,
        summary: "goal",
        importance: "crit",
        sourceEntryIds: ["u1"],
        timestamp: "2026-07-28T09:00:00.000Z",
        parentNode: N_GOAL,
      }),
    );
    const nGoal = nodes.get(N_GOAL);
    if (nGoal) nGoal.observationIds = [O_INITIAL_PROMPT];
    const source = new SessionOwlGraph({ nodes, observations, nextObsId: 1, nextNodeId: 5 });
    const view = assemble(
      buildSelectorInputView({
        sourceGraph: source,
        tail: { getLeafId: () => "leaf", getBranch: () => [assistantEntry("a2", "x")] },
        tailBoundary: { firstKeptEntryId: "a2" },
        todo: null,
        touchedFiles: { getLeafId: () => "leaf", getBranch: () => [] },
        sinceEntryId: "a2",
        chunkOptions: ASSEMBLY_OPTS,
      }),
    );
    const treeSection = view.split("Current task")[0] ?? "";
    expect(treeSection.indexOf("goal summary")).toBeLessThan(treeSection.indexOf("bravo high older"));
    // n2 (older) before n1 (newer) — time ascending
    expect(treeSection.indexOf("bravo high older")).toBeLessThan(treeSection.indexOf("alpha high newer"));
    // same time (n1 + n3) → importance tiebreak: high before low
    expect(treeSection.indexOf("alpha high newer")).toBeLessThan(treeSection.indexOf("charlie low"));
    expect(treeSection.indexOf("charlie low")).toBeLessThan(treeSection.indexOf("Irrelevant")); // nIrrelevant last
  });

  it("renders touched files (read + write deduped) in the context section", () => {
    // A branch with a read and a write/edit on the same path + a distinct path.
    const branch: SessionEntry[] = [assistantEntry("a2", "tail")];
    // buildSelectorInputView uses extractTouchedFiles(touchedFiles, sinceEntryId);
    // we feed a context whose getBranch returns toolCall entries below.
    const view = assemble(
      buildSelectorInputView({
        sourceGraph: sourceGraphForAssembly(),
        tail: { getLeafId: () => "leaf", getBranch: () => branch },
        tailBoundary: { firstKeptEntryId: "a2" },
        todo: null,
        touchedFiles: toolCallBranch(),
        sinceEntryId: null,
        chunkOptions: ASSEMBLY_OPTS,
      }),
    );
    expect(view).toContain("src/a.ts");
    expect(view).toContain("write src/a.ts");
    expect(view).toContain("read README.md");
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
