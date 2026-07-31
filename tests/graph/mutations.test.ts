// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { GraphInvariantError } from "../../src/graph/invariants.js";
import {
  applyCreateNode,
  applyFlushNew,
  applyMerge,
  applyMv,
  applyRecordObservation,
  applySetMeta,
  applySupersede,
  MUTATE_SOURCE,
  MUTATE_WORKING_COPY,
  setClock,
} from "../../src/graph/mutations.js";
import type { Importance, Node, NodeId, Observation, ObsId } from "../../src/types.js";
import { estimateContentTokens, MemkeeperGraph, makeObservation, N_GOAL } from "../../src/types.js";

const NOW = "2026-07-29 09:00";

beforeEach(() => {
  setClock(() => NOW);
});
afterAll(() => {
  setClock(null);
});

describe("applyCreateNode", () => {
  it("creates a root node and seeds its timestamps", () => {
    const g = bareGraph();
    const delta = applyCreateNode(g, {
      id: "n1",
      summary: "a container",
      importance: "medium",
      parentNode: null,
      state: "active",
    });
    expect(delta).toEqual({
      type: "create_node",
      id: "n1",
      summary: "a container",
      importance: "medium",
      parentNode: null,
      state: "active",
    });
    const node = nodeById(g, "n1");
    expect(node.summary).toBe("a container");
    expect(node.summaryTokens).toBe(estimateContentTokens("a container"));
    expect(node.state).toBe("active");
    expect(node.parentNode).toBeNull();
    expect(node.timestamps.createdAt).toBe(NOW);
    expect(node.timestamps.rangeStart).toBe(NOW);
    expect(node.timestamps.rangeEnd).toBe(NOW);
  });

  it("creates a child node and links it under its parent", () => {
    const g = bareGraphWithRoot("n1");
    applyCreateNode(g, { id: "n2", summary: "child", importance: "high", parentNode: "n1", state: "active" });
    expect(nodeById(g, "n2").parentNode).toBe("n1");
    expect(nodeById(g, "n1").childNodeIds).toContain("n2");
  });

  it("rejects creating a node under a missing parent", () => {
    const g = bareGraph();
    expect(() =>
      applyCreateNode(g, { id: "n2", summary: "x", importance: "low", parentNode: "n999", state: "active" }),
    ).toThrow(GraphInvariantError);
    expect(g.nodes.has("n2")).toBe(false);
  });
});

describe("applyRecordObservation", () => {
  it("appends an observation under its parent node and advances the counter", () => {
    const g = bareGraphWithRoot("n1");
    const obs = makeObservation({
      id: "o1",
      content: "first fact",
      importance: "high",
      sourceEntryIds: ["12"],
      timestamp: "2026-07-29 10:00",
      parentNode: "n1",
    });
    const delta = applyRecordObservation(g, { obs });
    expect(delta).toEqual({ type: "record_observation", obs });
    expect(g.observations.get("o1")).toBe(obs);
    expect(nodeById(g, "n1").observationIds).toEqual(["o1"]);
    expect(g.nextObsId).toBe(2);
  });

  it("maintains the parent node's timestamp range across observations", () => {
    const g = bareGraphWithRoot("n1");
    applyRecordObservation(g, { obs: obsWith({ id: "o1", timestamp: "2026-07-29 10:00", parentNode: "n1" }) });
    expect(nodeById(g, "n1").timestamps.rangeStart).toBe("2026-07-29 10:00");
    expect(nodeById(g, "n1").timestamps.rangeEnd).toBe("2026-07-29 10:00");
    applyRecordObservation(g, { obs: obsWith({ id: "o2", timestamp: "2026-07-29 08:00", parentNode: "n1" }) });
    expect(nodeById(g, "n1").timestamps.rangeStart).toBe("2026-07-29 08:00");
    expect(nodeById(g, "n1").timestamps.rangeEnd).toBe("2026-07-29 10:00");
  });

  it("rejects recording under a missing parent node", () => {
    const g = bareGraph();
    expect(() => applyRecordObservation(g, { obs: obsWith({ id: "o1", timestamp: NOW, parentNode: "n999" }) })).toThrow(
      GraphInvariantError,
    );
    expect(g.observations.has("o1")).toBe(false);
  });
});

describe("applyFlushNew", () => {
  it("sets listed new nodes to active", () => {
    const g = bareGraph();
    applyCreateNode(g, { id: "n1", summary: "a", importance: "low", parentNode: null, state: "new" });
    applyCreateNode(g, { id: "n2", summary: "b", importance: "low", parentNode: null, state: "new" });
    const delta = applyFlushNew(g, { nodeIds: ["n1", "n2"] });
    expect(delta).toEqual({ type: "flush_new", nodeIds: ["n1", "n2"] });
    expect(nodeById(g, "n1").state).toBe("active");
    expect(nodeById(g, "n2").state).toBe("active");
  });

  it("is a no-op for ids that are not new (dissolved during the stage)", () => {
    const g = bareGraph();
    applyCreateNode(g, { id: "n1", summary: "a", importance: "low", parentNode: null, state: "new" });
    // n2 was never created (dissolved) — it must simply be absent from the flush.
    expect(() => applyFlushNew(g, { nodeIds: ["n1", "n2"] })).not.toThrow();
    expect(nodeById(g, "n1").state).toBe("active");
  });
});

describe("applyMv", () => {
  it("moves an observation between nodes", () => {
    const g = graphWithTwoRoots();
    applyRecordObservation(g, { obs: obsWith({ id: "o1", timestamp: "2026-07-29 10:00", parentNode: "n1" }) });
    applyRecordObservation(g, { obs: obsWith({ id: "o2", timestamp: "2026-07-29 10:00", parentNode: "n1" }) });
    const delta = applyMv(g, { sourceIds: ["o1"], destId: "n2" }, MUTATE_SOURCE);
    expect(delta).toEqual({ type: "mv", sourceIds: ["o1"], destId: "n2" });
    expect(nodeById(g, "n1").observationIds).toEqual(["o2"]);
    expect(nodeById(g, "n2").observationIds).toEqual(["o1"]);
    expect(obsById(g, "o1").parentNode).toBe("n2");
  });

  it("reparents a node under a new parent", () => {
    const g = graphWithTwoRoots();
    applyMv(g, { sourceIds: ["n2"], destId: "n1" }, MUTATE_SOURCE);
    expect(nodeById(g, "n2").parentNode).toBe("n1");
    expect(nodeById(g, "n1").childNodeIds).toContain("n2");
  });

  it("dissolves a non-special source node emptied by the move", () => {
    const g = graphWithTwoRoots();
    applyRecordObservation(g, { obs: obsWith({ id: "o1", timestamp: "2026-07-29 10:00", parentNode: "n1" }) });
    applyMv(g, { sourceIds: ["o1"], destId: "n2" }, MUTATE_SOURCE);
    // n1 had only o1 and no children -> emptied -> dissolved
    expect(g.nodes.has("n1")).toBe(false);
    expect(nodeById(g, "n2").observationIds).toEqual(["o1"]);
  });

  it("dissolves an emptied obsolete source node", () => {
    const g = graphWithTwoRoots();
    applyRecordObservation(g, { obs: obsWith({ id: "o1", timestamp: "2026-07-29 10:00", parentNode: "n1" }) });
    applySetMeta(g, { nodeId: "n1", importance: null, archived: null, obsolete: null, summary: null }, MUTATE_SOURCE);
    // mark n1 obsolete via supersede into n2
    applySupersede(g, { nodeId: "n2", supersededNodeIds: ["n1"] }, MUTATE_SOURCE);
    expect(nodeById(g, "n1").state).toBe("obsolete");
    // move the obs out of the obsolete n1 -> it empties and dissolves
    applyMv(g, { sourceIds: ["o1"], destId: "n2" }, MUTATE_SOURCE);
    expect(g.nodes.has("n1")).toBe(false);
  });

  it("rewrites the destination summary when newSummary is provided", () => {
    const g = graphWithTwoRoots();
    applyMv(g, { sourceIds: ["n2"], destId: "n1", newSummary: "merged root" }, MUTATE_SOURCE);
    expect(nodeById(g, "n1").summary).toBe("merged root");
    expect(nodeById(g, "n1").summaryTokens).toBe(estimateContentTokens("merged root"));
  });

  it("moves to the root when destId is null", () => {
    const g = graphWithTwoRoots();
    // parent n2 under n1 first, then move it back to root; n1 held only n2 so it dissolves
    applyMv(g, { sourceIds: ["n2"], destId: "n1" }, MUTATE_SOURCE);
    applyMv(g, { sourceIds: ["n2"], destId: null }, MUTATE_SOURCE);
    expect(nodeById(g, "n2").parentNode).toBeNull();
    expect(g.nodes.has("n1")).toBe(false);
  });

  it("rejects a move that would create a cycle", () => {
    const g = graphWithTwoRoots();
    applyMv(g, { sourceIds: ["n2"], destId: "n1" }, MUTATE_SOURCE);
    // now n1 -> n2 is false; reparent n1 under n2 (its descendant) -> cycle
    expect(() => applyMv(g, { sourceIds: ["n1"], destId: "n2" }, MUTATE_SOURCE)).toThrow(GraphInvariantError);
    expect(nodeById(g, "n1").parentNode).toBeNull();
  });

  it("rejects moving an unknown source id", () => {
    const g = graphWithTwoRoots();
    expect(() => applyMv(g, { sourceIds: ["o999"], destId: "n1" }, MUTATE_SOURCE)).toThrow(GraphInvariantError);
  });

  it("rejects moving an observation to the root (observations must stay under a node)", () => {
    const g = graphWithTwoRoots();
    applyRecordObservation(g, { obs: obsWith({ id: "o1", timestamp: "2026-07-29 10:00", parentNode: "n1" }) });
    applyRecordObservation(g, { obs: obsWith({ id: "o2", timestamp: "2026-07-29 10:00", parentNode: "n1" }) });
    expect(() => applyMv(g, { sourceIds: ["o1"], destId: null }, MUTATE_SOURCE)).toThrow(GraphInvariantError);
    // rejected call leaves the graph unchanged
    expect(nodeById(g, "n1").observationIds).toEqual(["o1", "o2"]);
  });
});

describe("timestamp range propagation", () => {
  it("recomputes ancestor ranges when a descendant observation changes", () => {
    const g = bareGraph();
    applyCreateNode(g, { id: "n1", summary: "root", importance: "medium", parentNode: null, state: "active" });
    applyCreateNode(g, { id: "n2", summary: "child", importance: "medium", parentNode: "n1", state: "active" });
    // record an obs under n2 at 10:00 -> n1 and n2 ranges must both span it
    applyRecordObservation(g, { obs: obsWith({ id: "o1", timestamp: "2026-07-29 10:00", parentNode: "n2" }) });
    expect(nodeById(g, "n1").timestamps.rangeStart).toBe("2026-07-29 10:00");
    expect(nodeById(g, "n2").timestamps.rangeStart).toBe("2026-07-29 10:00");
    // move the obs out of n2 to a new root n3 -> n2 and n1 ranges must update
    applyCreateNode(g, { id: "n3", summary: "other", importance: "medium", parentNode: null, state: "active" });
    applyRecordObservation(g, { obs: obsWith({ id: "o2", timestamp: "2026-07-29 10:00", parentNode: "n2" }) });
    applyMv(g, { sourceIds: ["o2"], destId: "n3" }, MUTATE_SOURCE);
    // n2 still has o1 (10:00); n3 now has o2 (10:00) — both stay 10:00
    expect(nodeById(g, "n2").timestamps.rangeStart).toBe("2026-07-29 10:00");
    expect(nodeById(g, "n3").timestamps.rangeEnd).toBe("2026-07-29 10:00");
  });

  it("recomputes the ancestor range when a grandchild observation moves away", () => {
    const g = bareGraph();
    applyCreateNode(g, { id: "n1", summary: "root", importance: "medium", parentNode: null, state: "active" });
    applyCreateNode(g, { id: "n2", summary: "mid", importance: "medium", parentNode: "n1", state: "active" });
    applyCreateNode(g, { id: "n3", summary: "leaf", importance: "medium", parentNode: "n2", state: "active" });
    // n2 keeps its own observation so the chain survives n3's dissolution
    applyRecordObservation(g, { obs: obsWith({ id: "o9", timestamp: "2026-07-29 09:00", parentNode: "n2" }) });
    applyRecordObservation(g, { obs: obsWith({ id: "o1", timestamp: "2026-07-29 08:00", parentNode: "n3" }) });
    // n1 (grandparent) range spans o1 (08:00) and oKeep (09:00)
    expect(nodeById(g, "n1").timestamps.rangeStart).toBe("2026-07-29 08:00");
    expect(nodeById(g, "n1").timestamps.rangeEnd).toBe("2026-07-29 09:00");
    // move o1 out to a fresh root; n3 dissolves but n1/n2 survive on oKeep
    applyCreateNode(g, { id: "n4", summary: "fresh", importance: "medium", parentNode: null, state: "active" });
    applyMv(g, { sourceIds: ["o1"], destId: "n4" }, MUTATE_SOURCE);
    expect(g.nodes.has("n3")).toBe(false);
    expect(nodeById(g, "n4").timestamps.rangeStart).toBe("2026-07-29 08:00");
    // n1/n2 now reflect only oKeep (09:00) — the 08:00 obs is gone from their subtree
    expect(nodeById(g, "n1").timestamps.rangeStart).toBe("2026-07-29 09:00");
    expect(nodeById(g, "n2").timestamps.rangeStart).toBe("2026-07-29 09:00");
  });
});

describe("applyMerge", () => {
  it("folds sources into a destination, relocating observations and dissolving sources", () => {
    const g = graphWithTwoRoots();
    applyRecordObservation(g, { obs: obsWith({ id: "o1", timestamp: "2026-07-29 10:00", parentNode: "n1" }) });
    applyRecordObservation(g, { obs: obsWith({ id: "o2", timestamp: "2026-07-29 11:00", parentNode: "n2" }) });
    const delta = applyMerge(g, { sourceIds: ["n2"], destId: "n1", newSummary: "combined" }, MUTATE_SOURCE);
    expect(delta).toEqual({ type: "merge", sourceIds: ["n2"], destId: "n1", newSummary: "combined" });
    expect(g.nodes.has("n2")).toBe(false);
    expect(nodeById(g, "n1").observationIds.sort()).toEqual(["o1", "o2"]);
    expect(nodeById(g, "n1").summary).toBe("combined");
    expect(obsById(g, "o2").parentNode).toBe("n1");
  });

  it("creates a new root when destId is null (newSummary required)", () => {
    const g = graphWithTwoRoots();
    applyRecordObservation(g, { obs: obsWith({ id: "o1", timestamp: "2026-07-29 10:00", parentNode: "n1" }) });
    applyRecordObservation(g, { obs: obsWith({ id: "o2", timestamp: "2026-07-29 11:00", parentNode: "n2" }) });
    const before = g.nextNodeId;
    applyMerge(g, { sourceIds: ["n1", "n2"], destId: null, newSummary: "fresh root" }, MUTATE_SOURCE);
    expect(g.nextNodeId).toBeGreaterThan(before);
    const found = [...g.nodes.values()].find((n) => n.summary === "fresh root");
    expect(found).toBeDefined();
    expect(found?.parentNode).toBeNull();
    expect(g.nodes.has("n1")).toBe(false);
    expect(g.nodes.has("n2")).toBe(false);
  });

  it("merges into an existing destination without newSummary, keeping its summary", () => {
    const g = graphWithTwoRoots();
    applyRecordObservation(g, { obs: obsWith({ id: "o1", timestamp: "2026-07-29 10:00", parentNode: "n2" }) });
    applyMerge(g, { sourceIds: ["n2"], destId: "n1" }, MUTATE_SOURCE);
    expect(nodeById(g, "n1").summary).toBe("root one");
    expect(nodeById(g, "n1").observationIds).toContain("o1");
  });
});

describe("applySupersede", () => {
  it("marks nodes obsolete pointing at the replacement and retains their observations", () => {
    const g = graphWithTwoRoots();
    applyRecordObservation(g, { obs: obsWith({ id: "o1", timestamp: "2026-07-29 10:00", parentNode: "n1" }) });
    const delta = applySupersede(g, { nodeId: "n2", supersededNodeIds: ["n1"] }, MUTATE_SOURCE);
    expect(delta).toEqual({ type: "supersede", nodeId: "n2", supersededNodeIds: ["n1"] });
    expect(nodeById(g, "n1").state).toBe("obsolete");
    expect(nodeById(g, "n1").supersededBy).toBe("n2");
    expect(nodeById(g, "n1").observationIds).toEqual(["o1"]);
  });

  it("rejects a replacement that is itself obsolete", () => {
    const g = graphWithTwoRoots();
    applySupersede(g, { nodeId: "n2", supersededNodeIds: ["n1"] }, MUTATE_SOURCE);
    expect(() => applySupersede(g, { nodeId: "n1", supersededNodeIds: ["n2"] }, MUTATE_SOURCE)).toThrow(
      GraphInvariantError,
    );
  });

  it("requires newSummary when creating a new root via merge", () => {
    const g = graphWithTwoRoots();
    expect(() => applyMerge(g, { sourceIds: ["n1", "n2"], destId: null }, MUTATE_SOURCE)).toThrow(GraphInvariantError);
    // rejected call leaves the graph unchanged — no stray new root
    expect([...g.nodes.values()].filter((n) => n.parentNode === null).length).toBe(2);
  });

  it("rejects merging an ancestor source into its descendant destination (cycle)", () => {
    const g = graphWithTwoRoots();
    // build n1 -> n2 (n2 child of n1)
    applyMv(g, { sourceIds: ["n2"], destId: "n1" }, MUTATE_SOURCE);
    // merging n1 (ancestor) into n2 (descendant) would make n2 its own ancestor
    expect(() => applyMerge(g, { sourceIds: ["n1"], destId: "n2", newSummary: "x" }, MUTATE_SOURCE)).toThrow(
      GraphInvariantError,
    );
    // rejected call leaves the graph unchanged: n1 still root, n2 still under n1
    expect(nodeById(g, "n1").parentNode).toBeNull();
    expect(nodeById(g, "n2").parentNode).toBe("n1");
  });
});

describe("applySetMeta", () => {
  it("re-rates importance", () => {
    const g = graphWithTwoRoots();
    const delta = applySetMeta(
      g,
      { nodeId: "n1", importance: "critical", archived: null, obsolete: null, summary: null },
      MUTATE_SOURCE,
    );
    expect(delta.importance).toBe("critical");
    expect(nodeById(g, "n1").importance).toBe("critical");
  });

  it("archives and resurrects from archived", () => {
    const g = graphWithTwoRoots();
    applySetMeta(g, { nodeId: "n1", importance: null, archived: true, obsolete: null, summary: null }, MUTATE_SOURCE);
    expect(nodeById(g, "n1").state).toBe("archived");
    applySetMeta(g, { nodeId: "n1", importance: null, archived: false, obsolete: null, summary: null }, MUTATE_SOURCE);
    expect(nodeById(g, "n1").state).toBe("active");
  });

  it("resurrects from obsolete, clearing supersededBy", () => {
    const g = graphWithTwoRoots();
    applySupersede(g, { nodeId: "n2", supersededNodeIds: ["n1"] }, MUTATE_SOURCE);
    applySetMeta(g, { nodeId: "n1", importance: null, archived: null, obsolete: false, summary: null }, MUTATE_SOURCE);
    expect(nodeById(g, "n1").state).toBe("active");
    expect(nodeById(g, "n1").supersededBy).toBeNull();
  });

  it("archiving an obsolete node clears its supersededBy link", () => {
    const g = graphWithTwoRoots();
    applySupersede(g, { nodeId: "n2", supersededNodeIds: ["n1"] }, MUTATE_SOURCE);
    applySetMeta(g, { nodeId: "n1", importance: null, archived: true, obsolete: null, summary: null }, MUTATE_SOURCE);
    expect(nodeById(g, "n1").state).toBe("archived");
    expect(nodeById(g, "n1").supersededBy).toBeNull();
  });

  it("rewrites the summary and recomputes its token count", () => {
    const g = graphWithTwoRoots();
    applySetMeta(
      g,
      { nodeId: "n1", importance: null, archived: null, obsolete: null, summary: "new summary text" },
      MUTATE_SOURCE,
    );
    expect(nodeById(g, "n1").summary).toBe("new summary text");
    expect(nodeById(g, "n1").summaryTokens).toBe(estimateContentTokens("new summary text"));
  });

  it("rejects obsolete:true (use supersede)", () => {
    const g = graphWithTwoRoots();
    expect(() =>
      applySetMeta(g, { nodeId: "n1", importance: null, archived: null, obsolete: true, summary: null }, MUTATE_SOURCE),
    ).toThrow(GraphInvariantError);
  });
});

describe("protection matrix (policy: source)", () => {
  it("rejects moving nGoal", () => {
    const g = graphWithNGoal();
    expect(() => applyMv(g, { sourceIds: [N_GOAL], destId: "n1" }, MUTATE_SOURCE)).toThrow(GraphInvariantError);
  });

  it("rejects detaching oInitialPrompt from nGoal", () => {
    const g = graphWithNGoal();
    expect(() => applyMv(g, { sourceIds: ["oInitialPrompt"], destId: "n1" }, MUTATE_SOURCE)).toThrow(
      GraphInvariantError,
    );
  });

  it("rejects superseding nGoal", () => {
    const g = graphWithNGoal();
    expect(() => applySupersede(g, { nodeId: "n1", supersededNodeIds: [N_GOAL] }, MUTATE_SOURCE)).toThrow(
      GraphInvariantError,
    );
  });

  it("rejects changing nGoal importance (summary-only)", () => {
    const g = graphWithNGoal();
    expect(() =>
      applySetMeta(
        g,
        { nodeId: N_GOAL, importance: "low", archived: null, obsolete: null, summary: null },
        MUTATE_SOURCE,
      ),
    ).toThrow(GraphInvariantError);
  });

  it("allows rewriting nGoal summary", () => {
    const g = graphWithNGoal();
    applySetMeta(
      g,
      { nodeId: N_GOAL, importance: null, archived: null, obsolete: null, summary: "evolved goal" },
      MUTATE_SOURCE,
    );
    expect(nodeById(g, N_GOAL).summary).toBe("evolved goal");
  });

  it("rejects merging nGoal as a source", () => {
    const g = graphWithNGoal();
    expect(() => applyMerge(g, { sourceIds: [N_GOAL], destId: "n1", newSummary: "x" }, MUTATE_SOURCE)).toThrow(
      GraphInvariantError,
    );
  });

  it("rejects nGoal as a merge destination (with or without newSummary)", () => {
    const g = graphWithNGoal();
    applyRecordObservation(g, { obs: obsWith({ id: "o1", timestamp: NOW, parentNode: "n1" }) });
    // without newSummary
    expect(() => applyMerge(g, { sourceIds: ["n1"], destId: N_GOAL }, MUTATE_SOURCE)).toThrow(GraphInvariantError);
    // with newSummary
    expect(() =>
      applyMerge(g, { sourceIds: ["n1"], destId: N_GOAL, newSummary: "overwritten" }, MUTATE_SOURCE),
    ).toThrow(GraphInvariantError);
    // rejected calls leave the graph unchanged
    expect(nodeById(g, N_GOAL).summary).toBe("the goal");
    expect(nodeById(g, N_GOAL).observationIds).not.toContain("o1");
    expect(g.nodes.has("n1")).toBe(true);
  });
});

describe("working-copy policy", () => {
  it("allows moving nGoal in the working copy", () => {
    const g = graphWithNGoal();
    applyMv(g, { sourceIds: [N_GOAL], destId: "n1" }, MUTATE_WORKING_COPY);
    expect(nodeById(g, N_GOAL).parentNode).toBe("n1");
  });

  it("allows detaching oInitialPrompt in the working copy", () => {
    const g = graphWithNGoal();
    applyMv(g, { sourceIds: ["oInitialPrompt"], destId: "n1" }, MUTATE_WORKING_COPY);
    expect(obsById(g, "oInitialPrompt").parentNode).toBe("n1");
  });

  it("allows merging INTO nGoal in the working copy (Selector may rearrange it)", () => {
    const g = graphWithNGoal();
    applyRecordObservation(g, { obs: obsWith({ id: "o1", timestamp: NOW, parentNode: "n1" }) });
    applyMerge(g, { sourceIds: ["n1"], destId: N_GOAL }, MUTATE_WORKING_COPY);
    expect(nodeById(g, N_GOAL).observationIds).toContain("o1");
    expect(g.nodes.has("n1")).toBe(false);
  });

  it("still rejects cycles under the working-copy policy (structural rules apply)", () => {
    const g = graphWithTwoRoots();
    applyMv(g, { sourceIds: ["n2"], destId: "n1" }, MUTATE_WORKING_COPY);
    expect(() => applyMv(g, { sourceIds: ["n1"], destId: "n2" }, MUTATE_WORKING_COPY)).toThrow(GraphInvariantError);
  });
});

function bareGraph(): MemkeeperGraph {
  return new MemkeeperGraph({ nodes: new Map(), observations: new Map(), nextObsId: 1, nextNodeId: 1 });
}

function bareGraphWithRoot(id: NodeId): MemkeeperGraph {
  const g = bareGraph();
  applyCreateNode(g, { id, summary: "root", importance: "medium", parentNode: null, state: "active" });
  return g;
}

/** Two active root nodes n1, n2 (no observations). */
function graphWithTwoRoots(): MemkeeperGraph {
  const g = bareGraph();
  applyCreateNode(g, { id: "n1", summary: "root one", importance: "medium", parentNode: null, state: "active" });
  applyCreateNode(g, { id: "n2", summary: "root two", importance: "medium", parentNode: null, state: "active" });
  return g;
}

/** nGoal (critical, root) with oInitialPrompt attached, plus an empty root n1. */
function graphWithNGoal(): MemkeeperGraph {
  const g = bareGraph();
  applyCreateNode(g, { id: N_GOAL, summary: "the goal", importance: "critical", parentNode: null, state: "active" });
  applyRecordObservation(g, {
    obs: makeObservation({
      id: "oInitialPrompt",
      content: "the initial prompt",
      importance: "critical",
      sourceEntryIds: ["1"],
      timestamp: NOW,
      parentNode: N_GOAL,
    }),
  });
  applyCreateNode(g, { id: "n1", summary: "other root", importance: "medium", parentNode: null, state: "active" });
  return g;
}

function nodeById(g: MemkeeperGraph, id: NodeId): Node {
  const n = g.nodes.get(id);
  if (n === undefined) throw new Error(`missing node ${id}`);
  return n;
}

function obsById(g: MemkeeperGraph, id: ObsId): Observation {
  const o = g.observations.get(id);
  if (o === undefined) throw new Error(`missing observation ${id}`);
  return o;
}

function obsWith(overrides: Partial<Observation> & Pick<Observation, "id" | "timestamp" | "parentNode">): Observation {
  const content = overrides.content ?? "content";
  return {
    id: overrides.id,
    content,
    contentTokens: estimateContentTokens(content),
    importance: overrides.importance ?? ("medium" as Importance),
    sourceEntryIds: overrides.sourceEntryIds ?? ["1"],
    timestamp: overrides.timestamp,
    parentNode: overrides.parentNode,
  };
}
