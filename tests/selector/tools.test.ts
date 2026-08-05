// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// Tests for the Selector toolset (src/selector/tools.ts):
//   - working-copy graph tools (ls/cat/find/mkdir/mv/merge) — operate on the
//     deep-copied working graph with viewer "nonBuilder" (new→active); mutations
//     apply with MUTATE_WORKING_COPY (nGoal/oInitialPrompt freely rearrangeable,
//     no source-graph protections); nothing reaches the source GraphStore.
//   - set_meta (Selector variant: importance + summary, no lifecycle).
//   - try_finish (nonBuilder viewer, selectorRootViewThreshold).
//   - fs_* read tools (alias pi built-ins).
//   - todo_list (conditional on the todo bridge).
//   - makeSelectorTools assembly (supersede excluded; set_meta is the Selector variant).

import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { MemkeeperConfig } from "../../src/config/schema.js";
import { validateGraph } from "../../src/graph/invariants.js";
import { applyCreateNode, applyRecordObservation, setClock } from "../../src/graph/mutations.js";
import { buildWorkingCopy, type SelectorWorkingCopy } from "../../src/selector/input-view.js";
import {
  FS_FIND_TOOL,
  FS_GREP_TOOL,
  FS_LS_TOOL,
  FS_READ_TOOL,
  makeSelectorGraphTools,
  makeSelectorTools,
  SELECTOR_MUTATE_TOOL_NAMES,
  SELECTOR_SET_META_TOOL,
  TODO_LIST_TOOL,
} from "../../src/selector/tools.js";
import type { TodoBridge } from "../../src/todo/types.js";
import {
  MemkeeperGraph,
  makeObservation,
  N_GOAL,
  type Node,
  type NodeId,
  O_INITIAL_PROMPT,
  type Observation,
  type ObsId,
} from "../../src/types.js";

const NOW = "2026-07-29T09:00:00.000Z";

// buildSource() overrides the clock per test; restore the real clock after the
// file so the frozen-clock module state never leaks across files (isolate:false).
afterAll(() => setClock(null));

// --- source-graph fixture --------------------------------------------------
// nGoal(crit) + oInitialPrompt under it; n7(active, has obs o5) + n8(active,
// child of n7); n12(new, empty); n13(archived). A realistic mix the Selector
// reorganizes.

function buildSource(): MemkeeperGraph {
  setClock(() => NOW);
  const nodes = new Map<NodeId, Node>();
  const observations = new Map<ObsId, Observation>();
  const g = new MemkeeperGraph({ nodes, observations, nextObsId: 1, nextNodeId: 1 });

  applyCreateNode(g, {
    id: N_GOAL,
    summary: "the goal",
    importance: "crit",
    parentNode: null,
    state: "active",
  });
  applyRecordObservation(g, {
    obs: makeObservation({
      id: O_INITIAL_PROMPT,
      content: "the initial prompt",
      importance: "crit",
      sourceEntryIds: ["u1"],
      timestamp: NOW,
      parentNode: N_GOAL,
    }),
  });
  applyCreateNode(g, { id: "n7", summary: "JWT auth", importance: "high", parentNode: null, state: "active" });
  applyRecordObservation(g, {
    obs: makeObservation({
      id: "o5",
      content: "chose JWT",
      importance: "high",
      sourceEntryIds: ["e5"],
      timestamp: NOW,
      parentNode: "n7",
    }),
  });
  applyCreateNode(g, { id: "n8", summary: "JWT lib pick", importance: "med", parentNode: "n7", state: "active" });
  applyCreateNode(g, { id: "n12", summary: "fresh arrival", importance: "med", parentNode: null, state: "new" });
  applyCreateNode(g, { id: "n13", summary: "old config", importance: "low", parentNode: null, state: "archived" });
  return g;
}

// --- helpers ---------------------------------------------------------------

async function callTool(
  tools: AgentTool[],
  name: string,
  args: Record<string, unknown>,
): Promise<AgentToolResult<unknown>> {
  const tool = tools.find((t) => t.name === name);
  if (tool === undefined) throw new Error(`tool ${name} not found`);
  return tool.execute("call-1", args as unknown as Parameters<typeof tool.execute>[1]) as Promise<
    AgentToolResult<unknown>
  >;
}

function textOf(result: AgentToolResult<unknown>): string {
  return result.content.map((c) => (c as { text?: string }).text ?? "").join("\n");
}

const SETTINGS: MemkeeperConfig = {
  selectorRootViewThreshold: 10_000,
} as MemkeeperConfig;

// A minimal stub ExtensionContext carrying cwd for fs_* factory wiring.
function ctxStub(): ExtensionContext {
  return { cwd: "." } as unknown as ExtensionContext;
}

// ===========================================================================

describe("Selector working-copy graph tools (mkdir/mv/merge)", () => {
  let source: MemkeeperGraph;
  let working: SelectorWorkingCopy;

  beforeEach(() => {
    source = buildSource();
    working = buildWorkingCopy(source);
  });

  it("operate on the working copy (source graph unchanged after mutations)", async () => {
    const sourceBefore = JSON.stringify([...source.nodes.values()].map((n) => [n.id, n.parentNode, n.childNodeIds]));
    const tools = makeSelectorGraphTools(working, SETTINGS);
    // mv n8 to root (promote) — mutates the working copy only.
    await callTool(tools, "mv", { sourceIds: ["n8"], destId: null });
    expect(working.graph.nodes.get("n8")?.parentNode).toBeNull();
    // the source graph is byte-identical.
    const sourceAfter = JSON.stringify([...source.nodes.values()].map((n) => [n.id, n.parentNode, n.childNodeIds]));
    expect(sourceAfter).toBe(sourceBefore);
  });

  it("mv may detach oInitialPrompt from nGoal in the copy (workingCopy policy skips that rejection)", async () => {
    // In the source graph this throws; in the working copy it is allowed.
    const tools = makeSelectorGraphTools(working, SETTINGS);
    const res = await callTool(tools, "mv", { sourceIds: [O_INITIAL_PROMPT], destId: "n7" });
    expect(textOf(res).toLowerCase()).not.toContain("cannot be detached");
    expect(working.graph.observations.get(O_INITIAL_PROMPT)?.parentNode).toBe("n7");
  });

  it("mv may move nGoal in the copy (workingCopy policy skips nGoal-immovable)", async () => {
    const tools = makeSelectorGraphTools(working, SETTINGS);
    const res = await callTool(tools, "mv", { sourceIds: [N_GOAL], destId: "n7" });
    expect(textOf(res).toLowerCase()).not.toContain("immovable");
    expect(working.graph.nodes.get(N_GOAL)?.parentNode).toBe("n7");
  });

  it("an emptied non-special node dissolves after mv-out (workingCopy auto-dissolution)", async () => {
    // n8 has no obs, no children → moving it out of n7 then... actually dissolve
    // triggers when a node ends up empty. Build a child node with one obs, move
    // the obs out, the node dissolves.
    const tools = makeSelectorGraphTools(working, SETTINGS);
    // n7 has obs o5 + child n8. Move o5 to nGoal → n7 still has n8 (not empty).
    await callTool(tools, "mv", { sourceIds: ["o5"], destId: N_GOAL });
    expect(working.graph.nodes.has("n7")).toBe(true); // n7 still has child n8
    // now move n8 out of n7 too → n7 is empty → dissolves.
    await callTool(tools, "mv", { sourceIds: ["n8"], destId: null });
    expect(working.graph.nodes.has("n7")).toBe(false); // dissolved
    expect(() => validateGraph(working.graph)).not.toThrow();
  });

  it("mkdir creates a new node in the working copy", async () => {
    const tools = makeSelectorGraphTools(working, SETTINGS);
    const res = await callTool(tools, "mkdir", { summary: "new task group", importance: "med" });
    expect(textOf(res)).toMatch(/Created (n\d+)/);
    const m = textOf(res).match(/Created (n\d+)/);
    expect(m).not.toBeNull();
    const id = (m?.[1] ?? "") as NodeId;
    expect(working.graph.nodes.get(id)?.summary).toBe("new task group");
    expect(working.graph.nodes.get(id)?.parentNode).toBeNull();
    expect(working.graph.nodes.get(id)?.state).toBe("active");
  });

  it("merge folds nodes into a destination in the working copy (absorbed dissolves)", async () => {
    // merge n12 (new, empty) into n7 → n12 dissolves.
    const tools = makeSelectorGraphTools(working, SETTINGS);
    const res = await callTool(tools, "merge", { sourceIds: ["n12"], destId: "n7", newSummary: "auth setup" });
    expect(textOf(res)).toContain("n7");
    expect(working.graph.nodes.has("n12")).toBe(false); // absorbed → dissolved
    expect(working.graph.nodes.get("n7")?.summary).toBe("auth setup");
  });

  it("a structural rejection surfaces as an error result (no throw, graph unchanged)", async () => {
    const tools = makeSelectorGraphTools(working, SETTINGS);
    // moving a node into its own descendant → cycle → rejected.
    const res = await callTool(tools, "mv", { sourceIds: ["n7"], destId: "n8" });
    expect(textOf(res).toLowerCase()).toContain("cycle");
    // n7 still a root (unchanged).
    expect(working.graph.nodes.get("n7")?.parentNode).toBeNull();
  });

  it("ls/find render new nodes WITHOUT the 🆕 glyph (nonBuilder viewer)", async () => {
    const tools = makeSelectorGraphTools(working, SETTINGS);
    const lsOut = textOf(await callTool(tools, "ls", {}));
    expect(lsOut).toContain("n12"); // the new node is listed
    expect(lsOut).not.toContain("🆕");
  });
});

describe("Selector set_meta (importance + summary; no lifecycle)", () => {
  let source: MemkeeperGraph;
  let working: SelectorWorkingCopy;

  beforeEach(() => {
    source = buildSource();
    working = buildWorkingCopy(source);
  });

  it("rewrites a working-copy node's summary and recomputes summaryTokens", async () => {
    const tools = makeSelectorGraphTools(working, SETTINGS);
    await callTool(tools, SELECTOR_SET_META_TOOL, {
      nodeId: "n7",
      summary: "a much longer condensed summary than before",
    });
    const node = working.graph.nodes.get("n7");
    expect(node).toBeDefined();
    expect(node?.summary).toBe("a much longer condensed summary than before");
    // tokens = ceil(len/4). len("a much longer condensed summary than before") = 43 → 11.
    expect(node?.summaryTokens).toBe(11);
  });

  it("re-rates a working-copy node's importance", async () => {
    const tools = makeSelectorGraphTools(working, SETTINGS);
    const before = working.graph.nodes.get("n7")?.importance;
    await callTool(tools, SELECTOR_SET_META_TOOL, { nodeId: "n7", importance: "crit" });
    const node = working.graph.nodes.get("n7");
    expect(node?.importance).toBe("crit");
    expect(node?.importance).not.toBe(before);
  });

  it("structurally forbids archived/obsolete params (schema has no such fields)", () => {
    const tools = makeSelectorGraphTools(working, SETTINGS);
    const tool = tools.find((t) => t.name === SELECTOR_SET_META_TOOL);
    expect(tool).toBeDefined();
    const schema = (tool as AgentTool).parameters as { properties?: Record<string, unknown> };
    const props = schema.properties ?? {};
    expect(Object.keys(props).sort()).toEqual(["importance", "nodeId", "summary"]);
  });

  it("rejects an unknown nodeId with an error result (no throw)", async () => {
    const tools = makeSelectorGraphTools(working, SETTINGS);
    const res = await callTool(tools, SELECTOR_SET_META_TOOL, { nodeId: "nGhost", summary: "x" });
    expect(textOf(res).toLowerCase()).toContain("set_meta");
    expect(textOf(res).toLowerCase()).toContain("nghost");
  });
});

describe("Selector try_finish (nonBuilder, selectorRootViewThreshold)", () => {
  let source: MemkeeperGraph;
  let working: SelectorWorkingCopy;

  beforeEach(() => {
    source = buildSource();
    working = buildWorkingCopy(source);
  });

  it("within threshold → success + terminate", async () => {
    const tools = makeSelectorGraphTools(working, SETTINGS); // threshold 10000
    const res = await callTool(tools, "try_finish", {});
    const text = textOf(res);
    expect(text.toLowerCase()).toContain("within budget");
    expect((res as { terminate?: boolean }).terminate).toBe(true);
  });

  it("over threshold → reject + numbers, no terminate", async () => {
    const tight: MemkeeperConfig = { ...SETTINGS, selectorRootViewThreshold: 5 } as MemkeeperConfig;
    const tools = makeSelectorGraphTools(working, tight);
    const res = await callTool(tools, "try_finish", {});
    const text = textOf(res);
    expect(text.toLowerCase()).toContain("over budget");
    expect((res as { terminate?: boolean }).terminate).toBe(false);
  });
});

describe("Selector fs_* read tools (alias pi built-ins)", () => {
  let source: MemkeeperGraph;
  let working: SelectorWorkingCopy;

  beforeEach(() => {
    source = buildSource();
    working = buildWorkingCopy(source);
  });

  it("the toolset exposes exactly the 4 fs_* tools with fs_ names", () => {
    const tools = makeSelectorTools({ workingCopy: working, settings: SETTINGS, ctx: ctxStub(), todoBridge: null });
    const names = tools.map((t) => t.name);
    expect(names).toContain(FS_READ_TOOL);
    expect(names).toContain(FS_GREP_TOOL);
    expect(names).toContain(FS_FIND_TOOL);
    expect(names).toContain(FS_LS_TOOL);
  });

  it("each fs_* tool carries pi's own parameters (params unchanged)", () => {
    const tools = makeSelectorTools({ workingCopy: working, settings: SETTINGS, ctx: ctxStub(), todoBridge: null });
    const read = tools.find((t) => t.name === FS_READ_TOOL);
    expect(read).toBeDefined();
    // pi's read tool has a `path` parameter — the alias preserves it.
    const props = ((read as AgentTool).parameters as { properties?: Record<string, unknown> }).properties ?? {};
    expect(props).toHaveProperty("path");
  });

  it("bash/edit/write are NOT in the toolset (read-only)", () => {
    const tools = makeSelectorTools({ workingCopy: working, settings: SETTINGS, ctx: ctxStub(), todoBridge: null });
    const names = new Set(tools.map((t) => t.name));
    expect(names.has("bash")).toBe(false);
    expect(names.has("edit")).toBe(false);
    expect(names.has("write")).toBe(false);
  });
});

describe("Selector todo_list (conditional)", () => {
  let source: MemkeeperGraph;
  let working: SelectorWorkingCopy;

  beforeEach(() => {
    source = buildSource();
    working = buildWorkingCopy(source);
  });

  it("is present when the bridge has data and renders items", async () => {
    const bridge: TodoBridge = {
      getItems: () => [
        { id: "t1", name: "ship feature", status: "in_progress", details: "blocker: API" },
        { id: "t2", name: "write tests", status: "pending" },
      ],
    };
    const tools = makeSelectorTools({ workingCopy: working, settings: SETTINGS, ctx: ctxStub(), todoBridge: bridge });
    const names = tools.map((t) => t.name);
    expect(names).toContain(TODO_LIST_TOOL);
    const out = textOf(await callTool(tools, TODO_LIST_TOOL, {}));
    expect(out).toContain("ship feature");
    expect(out).toContain("blocker: API");
    expect(out).toContain("write tests");
  });

  it("is omitted when the bridge is null (avtc-pi-todo not installed)", () => {
    const tools = makeSelectorTools({ workingCopy: working, settings: SETTINGS, ctx: ctxStub(), todoBridge: null });
    expect(tools.map((t) => t.name)).not.toContain(TODO_LIST_TOOL);
  });

  it("the toolset count adjusts (present vs omitted)", () => {
    const without = makeSelectorTools({ workingCopy: working, settings: SETTINGS, ctx: ctxStub(), todoBridge: null });
    const bridge: TodoBridge = { getItems: () => [] };
    const with_ = makeSelectorTools({ workingCopy: working, settings: SETTINGS, ctx: ctxStub(), todoBridge: bridge });
    expect(with_.length).toBe(without.length + 1);
  });

  it("filters by status", async () => {
    const bridge: TodoBridge = {
      getItems: (filter) => {
        const all = [
          { id: "t1", name: "a", status: "in_progress" as const },
          { id: "t2", name: "b", status: "pending" as const },
        ];
        return filter?.status === undefined ? all : all.filter((i) => i.status === filter.status);
      },
    };
    const tools = makeSelectorTools({ workingCopy: working, settings: SETTINGS, ctx: ctxStub(), todoBridge: bridge });
    const out = textOf(await callTool(tools, TODO_LIST_TOOL, { status: "pending" }));
    expect(out).toContain("b");
    expect(out).not.toContain("in_progress · a");
  });

  it("status param is enum-validated at the schema boundary (rejects typos)", () => {
    const bridge: TodoBridge = { getItems: () => [] };
    const tools = makeSelectorTools({ workingCopy: working, settings: SETTINGS, ctx: ctxStub(), todoBridge: bridge });
    const tool = tools.find((t) => t.name === TODO_LIST_TOOL);
    expect(tool).toBeDefined();
    const schema = (tool as AgentTool).parameters as { properties?: { status?: { enum?: unknown[] } } };
    // StringEnum emits a { type: "string", enum: [...] } — a plain Type.String
    // would have no `enum` key, so a revert to Type.String would fail this.
    expect(schema.properties?.status?.enum).toEqual(["in_progress", "pending", "completed"]);
  });
});

describe("Selector toolset composition (supersede excluded)", () => {
  let source: MemkeeperGraph;
  let working: SelectorWorkingCopy;

  beforeEach(() => {
    source = buildSource();
    working = buildWorkingCopy(source);
  });

  it("supersede is NOT in the toolset (Builder-only); set_meta is (importance + summary only)", () => {
    const tools = makeSelectorTools({ workingCopy: working, settings: SETTINGS, ctx: ctxStub(), todoBridge: null });
    const names = new Set(tools.map((t) => t.name));
    expect(names.has("supersede")).toBe(false);
    expect(names.has(SELECTOR_SET_META_TOOL)).toBe(true);
  });

  it("the 8 graph tools are all present", () => {
    const tools = makeSelectorTools({ workingCopy: working, settings: SETTINGS, ctx: ctxStub(), todoBridge: null });
    const names = new Set(tools.map((t) => t.name));
    for (const n of ["ls", "cat", "find", "mkdir", "mv", "merge", SELECTOR_SET_META_TOOL, "try_finish"]) {
      expect(names.has(n)).toBe(true);
    }
  });

  it("SELECTOR_MUTATE_TOOL_NAMES lists the 4 Selector mutates (no-op detection set for the run)", () => {
    expect([...SELECTOR_MUTATE_TOOL_NAMES].sort()).toEqual(["merge", "mkdir", "mv", SELECTOR_SET_META_TOOL]);
    // read tools + try_finish excluded (parity with the Builder's set).
    expect(SELECTOR_MUTATE_TOOL_NAMES.has("ls")).toBe(false);
    expect(SELECTOR_MUTATE_TOOL_NAMES.has("try_finish")).toBe(false);
  });

  it("no mutation reaches the source GraphStore across a run of graph mutates", async () => {
    const tools = makeSelectorGraphTools(working, SETTINGS);
    const sourceSnapshot = JSON.stringify({
      nodes: [...source.nodes.values()].map((n) => [n.id, n.parentNode, n.childNodeIds, n.observationIds]),
      obs: [...source.observations.values()].map((o) => [o.id, o.parentNode]),
    });
    await callTool(tools, "mkdir", { summary: "new group", importance: "low" });
    await callTool(tools, "mv", { sourceIds: ["n8"], destId: null });
    await callTool(tools, "merge", { sourceIds: ["n12"], destId: "n7", newSummary: "x" });
    await callTool(tools, SELECTOR_SET_META_TOOL, { nodeId: "n7", summary: "y" });
    const after = JSON.stringify({
      nodes: [...source.nodes.values()].map((n) => [n.id, n.parentNode, n.childNodeIds, n.observationIds]),
      obs: [...source.observations.values()].map((o) => [o.id, o.parentNode]),
    });
    expect(after).toBe(sourceSnapshot);
  });
});
