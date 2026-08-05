// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import { describe, expect, it } from "vitest";
import { makeBuilderTools } from "../../src/builder/tools.js";
import { DEFAULT_CONFIG } from "../../src/config/schema.js";
import { MERGE_PARAMS, MKDIR_PARAMS } from "../../src/graph/mutate-tools.js";
import {
  applyCreateNode,
  applyRecordObservation,
  applySetMeta,
  applySupersede,
  setClock,
} from "../../src/graph/mutations.js";
import type { StoreContext } from "../../src/store/graph-store.js";
import { MemkeeperGraph, makeObservation, N_GOAL, type NodeId } from "../../src/types.js";

const NOW = "2026-07-29T09:00:00.000Z";

// --- test graph ------------------------------------------------------------
// roots: nGoal (crit, with oInitialPrompt) + n7 (active, JWT) + n12 (new).
// n7 has child n8 + observation o5.

function buildGraph(): MemkeeperGraph {
  setClock(() => NOW);
  const g = new MemkeeperGraph({ nodes: new Map(), observations: new Map(), nextObsId: 1, nextNodeId: 1 });
  applyCreateNode(g, {
    id: N_GOAL,
    summary: "the public API must stay stable",
    importance: "crit",
    parentNode: null,
    state: "active",
  });
  applyRecordObservation(g, {
    obs: makeObservation({
      id: "oInitialPrompt",
      content: "build a memory extension",
      importance: "crit",
      sourceEntryIds: ["1"],
      timestamp: NOW,
      parentNode: N_GOAL,
    }),
  });
  applyCreateNode(g, {
    id: "n7",
    summary: "Auth migration to JWT",
    importance: "high",
    parentNode: null,
    state: "active",
  });
  applyCreateNode(g, {
    id: "n8",
    summary: "Pick a JWT library",
    importance: "high",
    parentNode: "n7",
    state: "active",
  });
  applyRecordObservation(g, {
    obs: makeObservation({
      id: "o5",
      content: "Chose JWT for stateless auth",
      importance: "high",
      sourceEntryIds: ["2"],
      timestamp: NOW,
      parentNode: "n7",
    }),
  });
  applyCreateNode(g, {
    id: "n12",
    summary: "Build failed: TS2322",
    importance: "med",
    parentNode: null,
    state: "new",
  });
  setClock(null);
  return g;
}

// --- fake store: records every appended entry ------------------------------

interface RecordedEntry {
  customType: string;
  data: unknown;
}

function makeFakeStore(): { ctx: StoreContext; entries: RecordedEntry[] } {
  const entries: RecordedEntry[] = [];
  const ctx: StoreContext = {
    appendEntry: (customType, data) => {
      entries.push({ customType, data });
    },
    getLeafId: () => null,
    getBranch: () => [],
  };
  return { ctx, entries };
}

/** Only the graph_delta entries (the mutate tool's op-log records), unwrapped
 *  from their envelope ({ kind, delta }). */
function graphDeltas(entries: RecordedEntry[]): unknown[] {
  return entries
    .filter((e) => e.customType === "memkeeper.graph_delta")
    .map((e) => (e.data as { delta: unknown }).delta);
}

type ToolResult = { content: { text?: string }[]; details: unknown; terminate?: boolean };

async function callTool(
  tools: ReturnType<typeof makeBuilderTools>,
  name: string,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const tool = tools.find((t) => t.name === name);
  if (tool === undefined) throw new Error(`tool ${name} not found`);
  const result = await tool.execute("call-1", args as unknown as Parameters<typeof tool.execute>[1]);
  return result as unknown as ToolResult;
}

const textOf = (r: ToolResult): string => r.content.map((c) => c.text ?? "").join("\n");
const isError = (r: ToolResult): boolean => (r.details as { error?: boolean } | undefined)?.error === true;

describe("Builder mutate tools", () => {
  describe("mkdir", () => {
    it("creates an active container node at root and records a create_node delta", async () => {
      const g = buildGraph();
      const { ctx, entries } = makeFakeStore();
      const tools = makeBuilderTools(g, ctx, DEFAULT_CONFIG);
      const r = await callTool(tools, "mkdir", { summary: "Database design", importance: "high" });
      expect(isError(r)).toBe(false);
      const deltas = graphDeltas(entries);
      expect(deltas).toHaveLength(1);
      const delta = deltas[0] as { type: string; id: string; summary: string; state: string; importance: string };
      expect(delta.type).toBe("create_node");
      expect(delta.state).toBe("active");
      expect(delta.summary).toBe("Database design");
      expect(delta.importance).toBe("high");
      // the node exists in the graph with zero observations (container OK)
      const created = g.nodes.get(delta.id as NodeId);
      expect(created).toBeDefined();
      expect(created?.observationIds).toHaveLength(0);
      // the new id surfaces in the result text so the model can ls/cat it.
      expect(textOf(r)).toContain(delta.id);
    });

    it("creates a child node when parentId is given", async () => {
      const g = buildGraph();
      const { ctx } = makeFakeStore();
      const tools = makeBuilderTools(g, ctx, DEFAULT_CONFIG);
      const r = await callTool(tools, "mkdir", { summary: "Token signing", importance: "med", parentId: "n7" });
      expect(isError(r)).toBe(false);
      const parent = g.nodes.get("n7");
      // the new node is a child of n7
      const newChild = parent?.childNodeIds.find((id) => g.nodes.get(id)?.summary === "Token signing");
      expect(newChild).toBeDefined();
    });
  });

  describe("mv", () => {
    it("moves an observation into a node and records an mv delta", async () => {
      const g = buildGraph();
      const { ctx, entries } = makeFakeStore();
      const tools = makeBuilderTools(g, ctx, DEFAULT_CONFIG);
      const r = await callTool(tools, "mv", { sourceIds: ["o5"], destId: "n8" });
      expect(isError(r)).toBe(false);
      const deltas = graphDeltas(entries);
      expect(deltas).toHaveLength(1);
      expect((deltas[0] as { type: string }).type).toBe("mv");
      // o5 is now under n8
      expect(g.nodes.get("n8")?.observationIds).toContain("o5");
      expect(g.nodes.get("n7")?.observationIds).not.toContain("o5");
    });

    it("promotes a node to root when destId is null", async () => {
      const g = buildGraph();
      const { ctx } = makeFakeStore();
      const tools = makeBuilderTools(g, ctx, DEFAULT_CONFIG);
      const r = await callTool(tools, "mv", { sourceIds: ["n8"], destId: null });
      expect(isError(r)).toBe(false);
      expect(g.nodes.get("n8")?.parentNode).toBeNull();
    });

    it("rejects moving nGoal (protection matrix) — error result, graph + delta unchanged", async () => {
      const g = buildGraph();
      const { ctx, entries } = makeFakeStore();
      const tools = makeBuilderTools(g, ctx, DEFAULT_CONFIG);
      const before = g.nodes.get(N_GOAL)?.parentNode;
      const r = await callTool(tools, "mv", { sourceIds: [N_GOAL], destId: "n7" });
      expect(isError(r)).toBe(true);
      expect(textOf(r)).toContain("nGoal");
      // unchanged
      expect(g.nodes.get(N_GOAL)?.parentNode).toBe(before);
      expect(graphDeltas(entries)).toHaveLength(0);
    });

    it("rejects detaching oInitialPrompt from nGoal — error result, graph + delta unchanged", async () => {
      const g = buildGraph();
      const { ctx, entries } = makeFakeStore();
      const tools = makeBuilderTools(g, ctx, DEFAULT_CONFIG);
      const before = g.observations.get("oInitialPrompt")?.parentNode;
      const r = await callTool(tools, "mv", { sourceIds: ["oInitialPrompt"], destId: "n7" });
      expect(isError(r)).toBe(true);
      expect(g.observations.get("oInitialPrompt")?.parentNode).toBe(before);
      expect(graphDeltas(entries)).toHaveLength(0);
    });

    it("rewrites the dest summary via newSummary in the same atomic mutate", async () => {
      const g = buildGraph();
      const { ctx } = makeFakeStore();
      const tools = makeBuilderTools(g, ctx, DEFAULT_CONFIG);
      const r = await callTool(tools, "mv", { sourceIds: ["o5"], destId: "n7", newSummary: "Auth (JWT) v2" });
      expect(isError(r)).toBe(false);
      expect(g.nodes.get("n7")?.summary).toBe("Auth (JWT) v2");
      // summaryTokens recompute reflects the new summary.
      expect(g.nodes.get("n7")?.summaryTokens).toBeGreaterThan(0);
    });

    it("ignores newSummary when promoting to root (no dest to rewrite)", async () => {
      const g = buildGraph();
      const { ctx } = makeFakeStore();
      const tools = makeBuilderTools(g, ctx, DEFAULT_CONFIG);
      // newSummary passed but destId is null → it must NOT alter any node.
      const r = await callTool(tools, "mv", { sourceIds: ["n8"], destId: null, newSummary: "should be ignored" });
      expect(isError(r)).toBe(false);
      expect(g.nodes.get("n8")?.parentNode).toBeNull();
      // no node carries the ignored summary.
      const carrier = [...g.nodes.values()].find((n) => n.summary === "should be ignored");
      expect(carrier).toBeUndefined();
    });

    it("rejects moving an observation to the root (observations must stay under a node)", async () => {
      const g = buildGraph();
      const { ctx, entries } = makeFakeStore();
      const tools = makeBuilderTools(g, ctx, DEFAULT_CONFIG);
      const before = g.observations.get("o5")?.parentNode;
      const r = await callTool(tools, "mv", { sourceIds: ["o5"], destId: null });
      expect(isError(r)).toBe(true);
      expect(g.observations.get("o5")?.parentNode).toBe(before);
      expect(graphDeltas(entries)).toHaveLength(0);
    });
  });

  describe("merge", () => {
    it("folds sources into an existing dest with a newSummary and records a merge delta", async () => {
      const g = buildGraph();
      const { ctx, entries } = makeFakeStore();
      const tools = makeBuilderTools(g, ctx, DEFAULT_CONFIG);
      const r = await callTool(tools, "merge", {
        sourceIds: ["n8"],
        destId: "n7",
        newSummary: "Auth migration to JWT (consolidated)",
      });
      expect(isError(r)).toBe(false);
      const deltas = graphDeltas(entries);
      expect(deltas).toHaveLength(1);
      expect((deltas[0] as { type: string }).type).toBe("merge");
      // n8 dissolved (emptied source), its obs relocated to n7
      expect(g.nodes.has("n8")).toBe(false);
      expect(g.nodes.get("n7")?.summary).toBe("Auth migration to JWT (consolidated)");
    });

    it("re-rates an existing dest's importance when importance is passed", async () => {
      const g = buildGraph();
      const { ctx, entries } = makeFakeStore();
      const tools = makeBuilderTools(g, ctx, DEFAULT_CONFIG);
      // n7 starts at high (from buildGraph); the merge re-rates it to crit.
      expect(g.nodes.get("n7")?.importance).toBe("high");
      const r = await callTool(tools, "merge", {
        sourceIds: ["n8"],
        destId: "n7",
        importance: "crit",
      });
      expect(isError(r)).toBe(false);
      const deltas = graphDeltas(entries);
      const delta = deltas[0] as { type: string; importance?: string };
      expect(delta.type).toBe("merge");
      expect(delta.importance).toBe("crit");
      expect(g.nodes.get("n7")?.importance).toBe("crit");
      expect(g.nodes.get("n7")?.state).toBe("active");
    });

    it("creates a new root when destId is null + newSummary provided", async () => {
      const g = buildGraph();
      const { ctx } = makeFakeStore();
      const tools = makeBuilderTools(g, ctx, DEFAULT_CONFIG);
      const r = await callTool(tools, "merge", {
        sourceIds: ["n8"],
        destId: null,
        newSummary: "JWT bundle",
        importance: "high",
      });
      expect(isError(r)).toBe(false);
      const bundle = [...g.nodes.values()].find((n) => n.summary === "JWT bundle");
      expect(bundle).toBeDefined();
      expect(bundle?.parentNode).toBeNull();
      expect(bundle?.state).toBe("active");
      expect(bundle?.importance).toBe("high");
      // the NEW root id surfaces in the result text so the model can ls/cat it.
      expect(textOf(r)).toContain(bundle?.id ?? "(missing)");
    });

    it("rejects destId=null without newSummary — error result, graph + delta unchanged", async () => {
      const g = buildGraph();
      const { ctx, entries } = makeFakeStore();
      const tools = makeBuilderTools(g, ctx, DEFAULT_CONFIG);
      const r = await callTool(tools, "merge", { sourceIds: ["n8"], destId: null });
      expect(isError(r)).toBe(true);
      // The surfaced text carries exactly one op prefix (runMutate strips the
      // mutation-layer duplicate) and keeps the hint about the new root.
      expect(textOf(r)).toBe("merge: newSummary is required when destId is null (names the new root node)");
      expect(textOf(r)).not.toContain("merge: merge:");
      expect(graphDeltas(entries)).toHaveLength(0);
      expect(g.nodes.has("n8")).toBe(true);
    });

    it("rejects destId=null without importance — error result, graph + delta unchanged", async () => {
      const g = buildGraph();
      const { ctx, entries } = makeFakeStore();
      const tools = makeBuilderTools(g, ctx, DEFAULT_CONFIG);
      const r = await callTool(tools, "merge", { sourceIds: ["n8"], destId: null, newSummary: "JWT bundle" });
      expect(isError(r)).toBe(true);
      expect(textOf(r)).toBe("merge: importance is required when destId is null (rates the new root node)");
      expect(textOf(r)).not.toContain("merge: merge:");
      expect(graphDeltas(entries)).toHaveLength(0);
      expect(g.nodes.has("n8")).toBe(true);
    });

    it("rejects nGoal as a merge source — error result", async () => {
      const g = buildGraph();
      const { ctx, entries } = makeFakeStore();
      const tools = makeBuilderTools(g, ctx, DEFAULT_CONFIG);
      const r = await callTool(tools, "merge", { sourceIds: [N_GOAL], destId: "n7", newSummary: "x" });
      expect(isError(r)).toBe(true);
      expect(textOf(r)).toBe("merge: nGoal cannot be a merge source");
      expect(textOf(r)).not.toContain("merge: merge:");
      expect(graphDeltas(entries)).toHaveLength(0);
    });

    it("rejects nGoal as a merge destination — error result", async () => {
      const g = buildGraph();
      const { ctx, entries } = makeFakeStore();
      const tools = makeBuilderTools(g, ctx, DEFAULT_CONFIG);
      const r = await callTool(tools, "merge", { sourceIds: ["n8"], destId: N_GOAL, newSummary: "x" });
      expect(isError(r)).toBe(true);
      expect(textOf(r)).toBe("merge: nGoal cannot be a merge destination");
      expect(textOf(r)).not.toContain("merge: merge:");
      expect(graphDeltas(entries)).toHaveLength(0);
    });
  });

  describe("supersede", () => {
    it("marks nodes obsolete with supersededBy pointing at the replacement + records a supersede delta", async () => {
      const g = buildGraph();
      const { ctx, entries } = makeFakeStore();
      const tools = makeBuilderTools(g, ctx, DEFAULT_CONFIG);
      const r = await callTool(tools, "supersede", { nodeId: "n7", supersededNodeIds: ["n12"] });
      expect(isError(r)).toBe(false);
      const deltas = graphDeltas(entries);
      expect(deltas).toHaveLength(1);
      expect((deltas[0] as { type: string }).type).toBe("supersede");
      expect(g.nodes.get("n12")?.state).toBe("obsolete");
      expect(g.nodes.get("n12")?.supersededBy).toBe("n7");
    });

    it("rejects superseding nGoal — error result, graph + delta unchanged", async () => {
      const g = buildGraph();
      const { ctx, entries } = makeFakeStore();
      const tools = makeBuilderTools(g, ctx, DEFAULT_CONFIG);
      const before = g.nodes.get(N_GOAL)?.state;
      const r = await callTool(tools, "supersede", { nodeId: "n7", supersededNodeIds: [N_GOAL] });
      expect(isError(r)).toBe(true);
      expect(textOf(r)).toBe("supersede: nGoal cannot be superseded");
      expect(textOf(r)).not.toContain("supersede: supersede:");
      expect(g.nodes.get(N_GOAL)?.state).toBe(before);
      expect(graphDeltas(entries)).toHaveLength(0);
    });

    it("rejects an obsolete node as the replacement — error result", async () => {
      const g = buildGraph();
      // make n12 obsolete first
      applySupersede(g, { nodeId: "n7", supersededNodeIds: ["n12"] }, "source");
      const { ctx, entries } = makeFakeStore();
      const tools = makeBuilderTools(g, ctx, DEFAULT_CONFIG);
      const r = await callTool(tools, "supersede", { nodeId: "n12", supersededNodeIds: ["n8"] });
      expect(isError(r)).toBe(true);
      expect(textOf(r)).toBe("supersede: replacement n12 is itself obsolete");
      expect(textOf(r)).not.toContain("supersede: supersede:");
      expect(graphDeltas(entries)).toHaveLength(0);
    });
  });

  describe("set_meta", () => {
    it("re-rates importance + records a set_meta delta", async () => {
      const g = buildGraph();
      const { ctx, entries } = makeFakeStore();
      const tools = makeBuilderTools(g, ctx, DEFAULT_CONFIG);
      const r = await callTool(tools, "set_meta", { nodeId: "n12", importance: "crit" });
      expect(isError(r)).toBe(false);
      expect(g.nodes.get("n12")?.importance).toBe("crit");
      const deltas = graphDeltas(entries);
      expect((deltas[0] as { type: string }).type).toBe("set_meta");
    });

    it("archives a node + records the delta", async () => {
      const g = buildGraph();
      const { ctx } = makeFakeStore();
      const tools = makeBuilderTools(g, ctx, DEFAULT_CONFIG);
      const r = await callTool(tools, "set_meta", { nodeId: "n12", archived: true });
      expect(isError(r)).toBe(false);
      expect(g.nodes.get("n12")?.state).toBe("archived");
    });

    it("rejects obsolete:true (use supersede) — error result, graph + delta unchanged", async () => {
      const g = buildGraph();
      const { ctx, entries } = makeFakeStore();
      const tools = makeBuilderTools(g, ctx, DEFAULT_CONFIG);
      const before = g.nodes.get("n12")?.state;
      const r = await callTool(tools, "set_meta", { nodeId: "n12", obsolete: true });
      expect(isError(r)).toBe(true);
      expect(textOf(r)).toContain("supersede");
      expect(g.nodes.get("n12")?.state).toBe(before);
      expect(graphDeltas(entries)).toHaveLength(0);
    });

    it("rejects nGoal importance/archived (summary-only) — error result", async () => {
      const g = buildGraph();
      const { ctx, entries } = makeFakeStore();
      const tools = makeBuilderTools(g, ctx, DEFAULT_CONFIG);
      const before = g.nodes.get(N_GOAL)?.importance;
      const r = await callTool(tools, "set_meta", { nodeId: N_GOAL, importance: "low" });
      expect(isError(r)).toBe(true);
      expect(g.nodes.get(N_GOAL)?.importance).toBe(before);
      expect(graphDeltas(entries)).toHaveLength(0);
    });

    it("allows nGoal summary update (summary-only restriction)", async () => {
      const g = buildGraph();
      const { ctx } = makeFakeStore();
      const tools = makeBuilderTools(g, ctx, DEFAULT_CONFIG);
      const r = await callTool(tools, "set_meta", { nodeId: N_GOAL, summary: "evolved goal statement" });
      expect(isError(r)).toBe(false);
      expect(g.nodes.get(N_GOAL)?.summary).toBe("evolved goal statement");
    });

    it("resurrects an obsolete node via obsolete:false (clears supersededBy)", async () => {
      const g = buildGraph();
      applySupersede(g, { nodeId: "n7", supersededNodeIds: ["n12"] }, "source");
      const { ctx } = makeFakeStore();
      const tools = makeBuilderTools(g, ctx, DEFAULT_CONFIG);
      const r = await callTool(tools, "set_meta", { nodeId: "n12", obsolete: false });
      expect(isError(r)).toBe(false);
      expect(g.nodes.get("n12")?.state).toBe("active");
      expect(g.nodes.get("n12")?.supersededBy).toBeNull();
    });

    it("un-archives an archived node via archived:false", async () => {
      const g = buildGraph();
      // archive n12 first
      applySetMeta(g, { nodeId: "n12", importance: null, archived: true, obsolete: null, summary: null }, "source");
      expect(g.nodes.get("n12")?.state).toBe("archived");
      const { ctx } = makeFakeStore();
      const tools = makeBuilderTools(g, ctx, DEFAULT_CONFIG);
      const r = await callTool(tools, "set_meta", { nodeId: "n12", archived: false });
      expect(isError(r)).toBe(false);
      expect(g.nodes.get("n12")?.state).toBe("active");
    });
  });

  describe("try_finish", () => {
    it("reports within-budget success + terminate:true when the root view fits the threshold", async () => {
      const g = buildGraph();
      const { ctx } = makeFakeStore();
      // very large threshold → always within budget.
      const tools = makeBuilderTools(g, ctx, { ...DEFAULT_CONFIG, builderRootViewThreshold: 1_000_000 });
      const r = await callTool(tools, "try_finish", {});
      expect(isError(r)).toBe(false);
      expect(r.terminate).toBe(true);
      expect(textOf(r).toLowerCase()).toContain("within budget");
      // details expose the measured tokens + threshold for inspection.
      const details = r.details as { rootsViewTokens: number; threshold: number };
      expect(typeof details.rootsViewTokens).toBe("number");
      expect(details.threshold).toBe(1_000_000);
    });

    it("counts root-view tokens as exactly == threshold as within budget (boundary)", async () => {
      const g = buildGraph();
      const { ctx } = makeFakeStore();
      // first measure the actual root-view tokens, then set the threshold to that.
      const measureTools = makeBuilderTools(g, ctx, { ...DEFAULT_CONFIG, builderRootViewThreshold: 1_000_000 });
      const measure = (await callTool(measureTools, "try_finish", {})).details as { rootsViewTokens: number };
      const tools = makeBuilderTools(g, ctx, { ...DEFAULT_CONFIG, builderRootViewThreshold: measure.rootsViewTokens });
      const r = await callTool(tools, "try_finish", {});
      expect(r.terminate).toBe(true);
    });

    it("reports over-budget rejection + terminate:false with the numbers", async () => {
      const g = buildGraph();
      const { ctx } = makeFakeStore();
      // threshold of 1 token → the root view (nGoal + n7 + n12) is always over.
      const tools = makeBuilderTools(g, ctx, { ...DEFAULT_CONFIG, builderRootViewThreshold: 1 });
      const r = await callTool(tools, "try_finish", {});
      expect(r.terminate).toBe(false);
      const out = textOf(r).toLowerCase();
      expect(out).toContain("over budget");
      // numbers shown (token format)
      expect(textOf(r)).toMatch(/\d/);
    });
  });

  describe("factory", () => {
    it("produces exactly 9 tools", () => {
      const g = buildGraph();
      const { ctx } = makeFakeStore();
      const tools = makeBuilderTools(g, ctx, DEFAULT_CONFIG);
      expect(tools).toHaveLength(9);
      const names = tools.map((t) => t.name).sort();
      expect(names).toEqual(["cat", "find", "ls", "merge", "mkdir", "mv", "set_meta", "supersede", "try_finish"]);
    });
  });

  describe("parameter schema (importance requirement)", () => {
    // the callTool helper bypasses TypeBox schema validation, so the
    // importance requirement is pinned directly against the schema via the
    // TypeBox value checker (a future Type.Optional regression on mkdir
    // importance would otherwise pass the suite).
    it("mkdir rejects a params object missing importance", () => {
      const { Check } = require("typebox/value") as { Check: (schema: unknown, value: unknown) => boolean };
      // importance is required on mkdir — omitting it must fail validation.
      expect(Check(MKDIR_PARAMS, { summary: "a node" })).toBe(false);
      // providing it passes.
      expect(Check(MKDIR_PARAMS, { summary: "a node", importance: "high" })).toBe(true);
    });

    it("merge treats importance as optional (schema-permit, runtime-required on destId:null)", () => {
      const { Check } = require("typebox/value") as { Check: (schema: unknown, value: unknown) => boolean };
      // importance is optional on the merge schema (required only at runtime
      // when destId === null); an existing-dest merge without importance is valid.
      expect(Check(MERGE_PARAMS, { sourceIds: ["n8"], destId: "n7", newSummary: "merged" })).toBe(true);
      expect(Check(MERGE_PARAMS, { sourceIds: ["n8"], destId: "n7", newSummary: "merged", importance: "crit" })).toBe(
        true,
      );
    });
  });
});
