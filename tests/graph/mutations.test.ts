// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { exactlyOneNodePerObservation, GraphInvariantError } from "../../src/graph/invariants.js";
import {
  applyAttachObservation,
  applyCreateNode,
  applyFlushNew,
  applyMerge,
  applyMv,
  applyRecordObservation,
  applySetMeta,
  applySupersede,
  assertGraphStructure,
  MUTATE_SOURCE,
  MUTATE_WORKING_COPY,
  setClock,
} from "../../src/graph/mutations.js";
import type { Importance, Node, NodeId, Observation, ObsId } from "../../src/types.js";
import { countLines, estimateContentTokens, makeObservation, N_GOAL, SessionOwlGraph } from "../../src/types.js";

const NOW = "2026-07-29T09:00:00.000Z";

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
      importance: "med",
      parentNode: null,
      state: "active",
    });
    expect(delta).toEqual({
      type: "create_node",
      id: "n1",
      summary: "a container",
      importance: "med",
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

  it("rejects creating a node whose id already exists (load-bearing for replay identity)", () => {
    const g = bareGraphWithRoot("n1");
    expect(() =>
      applyCreateNode(g, { id: "n1", summary: "dup", importance: "low", parentNode: null, state: "active" }),
    ).toThrow(GraphInvariantError);
    // the original node is untouched
    expect(nodeById(g, "n1").summary).toBe("root");
  });
});

describe("applyRecordObservation", () => {
  it("appends an observation under its parent node and advances the counter", () => {
    const g = bareGraphWithRoot("n1");
    const obs = makeObservation({
      id: "o1",
      summary: "first fact",
      importance: "high",
      sourceEntryIds: ["12"],
      timestamp: "2026-07-29T10:00:00.000Z",
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
    applyRecordObservation(g, { obs: obsWith({ id: "o1", timestamp: "2026-07-29T10:00:00.000Z", parentNode: "n1" }) });
    expect(nodeById(g, "n1").timestamps.rangeStart).toBe("2026-07-29T10:00:00.000Z");
    expect(nodeById(g, "n1").timestamps.rangeEnd).toBe("2026-07-29T10:00:00.000Z");
    applyRecordObservation(g, { obs: obsWith({ id: "o2", timestamp: "2026-07-29T08:00:00.000Z", parentNode: "n1" }) });
    expect(nodeById(g, "n1").timestamps.rangeStart).toBe("2026-07-29T08:00:00.000Z");
    expect(nodeById(g, "n1").timestamps.rangeEnd).toBe("2026-07-29T10:00:00.000Z");
  });

  it("rejects recording under a missing parent node", () => {
    const g = bareGraph();
    expect(() => applyRecordObservation(g, { obs: obsWith({ id: "o1", timestamp: NOW, parentNode: "n999" }) })).toThrow(
      GraphInvariantError,
    );
    expect(g.observations.has("o1")).toBe(false);
  });

  it("rejects recording an observation whose id already exists (idempotency invariant)", () => {
    const g = bareGraphWithRoot("n1");
    applyRecordObservation(g, { obs: obsWith({ id: "o1", timestamp: NOW, parentNode: "n1" }) });
    // replaying the same id (e.g. a re-applied delta) is rejected, not silently overwritten
    expect(() => applyRecordObservation(g, { obs: obsWith({ id: "o1", timestamp: NOW, parentNode: "n1" }) })).toThrow(
      GraphInvariantError,
    );
    expect(nodeById(g, "n1").observationIds).toEqual(["o1"]);
  });
});

describe("applyAttachObservation", () => {
  it("re-points an already-recorded observation to a new parent (unlink + link)", () => {
    const g = bareGraphWithRoot("n1");
    applyCreateNode(g, { id: "n2", summary: "dest", importance: "med", parentNode: null, state: "active" });
    applyRecordObservation(g, { obs: obsWith({ id: "o1", timestamp: NOW, parentNode: "n1" }) });
    const delta = applyAttachObservation(g, { obsId: "o1", parentNode: "n2" });
    expect(delta.type).toBe("record_observation");
    expect(nodeById(g, "n1").observationIds).toEqual([]);
    expect(nodeById(g, "n2").observationIds).toEqual(["o1"]);
    expect(g.observations.get("o1")?.parentNode).toBe("n2");
  });

  it("is tolerant of a dissolved old parent (the stale unlink is skipped)", () => {
    const g = bareGraphWithRoot("n1");
    applyCreateNode(g, { id: "n2", summary: "dest", importance: "med", parentNode: null, state: "active" });
    applyRecordObservation(g, { obs: obsWith({ id: "o1", timestamp: NOW, parentNode: "n1" }) });
    // simulate the old parent dissolving (a merge that relocated the listing);
    // the record's parentNode is now stale — attach must still link cleanly
    g.nodes.delete("n1");
    applyAttachObservation(g, { obsId: "o1", parentNode: "n2" });
    expect(nodeById(g, "n2").observationIds).toEqual(["o1"]);
    expect(g.observations.get("o1")?.parentNode).toBe("n2");
  });

  it("is idempotent when the record is already listed under the target", () => {
    const g = bareGraphWithRoot("n1");
    applyRecordObservation(g, { obs: obsWith({ id: "o1", timestamp: NOW, parentNode: "n1" }) });
    applyAttachObservation(g, { obsId: "o1", parentNode: "n1" });
    expect(nodeById(g, "n1").observationIds).toEqual(["o1"]);
  });

  it("throws when the record or the target node does not exist", () => {
    const g = bareGraphWithRoot("n1");
    expect(() => applyAttachObservation(g, { obsId: "oMissing" as ObsId, parentNode: "n1" })).toThrow(
      GraphInvariantError,
    );
    applyRecordObservation(g, { obs: obsWith({ id: "o1", timestamp: NOW, parentNode: "n1" }) });
    expect(() => applyAttachObservation(g, { obsId: "o1", parentNode: "nMissing" as NodeId })).toThrow(
      GraphInvariantError,
    );
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
    applyRecordObservation(g, { obs: obsWith({ id: "o1", timestamp: "2026-07-29T10:00:00.000Z", parentNode: "n1" }) });
    applyRecordObservation(g, { obs: obsWith({ id: "o2", timestamp: "2026-07-29T10:00:00.000Z", parentNode: "n1" }) });
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
    applyRecordObservation(g, { obs: obsWith({ id: "o1", timestamp: "2026-07-29T10:00:00.000Z", parentNode: "n1" }) });
    applyMv(g, { sourceIds: ["o1"], destId: "n2" }, MUTATE_SOURCE);
    // n1 had only o1 and no children -> emptied -> dissolved
    expect(g.nodes.has("n1")).toBe(false);
    expect(nodeById(g, "n2").observationIds).toEqual(["o1"]);
  });

  it("dissolves an emptied obsolete source node", () => {
    const g = graphWithTwoRoots();
    applyRecordObservation(g, { obs: obsWith({ id: "o1", timestamp: "2026-07-29T10:00:00.000Z", parentNode: "n1" }) });
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
    applyRecordObservation(g, { obs: obsWith({ id: "o1", timestamp: "2026-07-29T10:00:00.000Z", parentNode: "n1" }) });
    applyRecordObservation(g, { obs: obsWith({ id: "o2", timestamp: "2026-07-29T10:00:00.000Z", parentNode: "n1" }) });
    expect(() => applyMv(g, { sourceIds: ["o1"], destId: null }, MUTATE_SOURCE)).toThrow(GraphInvariantError);
    // rejected call leaves the graph unchanged
    expect(nodeById(g, "n1").observationIds).toEqual(["o1", "o2"]);
  });

  it("cascades dissolution up a multi-level emptied chain in one move", () => {
    // chain: n1 -> n2 -> n3, where n3 holds the only observation. Moving that
    // obs out empties n3 → dissolves → empties n2 → dissolves → empties n1 →
    // dissolves. The whole chain collapses from a SINGLE applyMv.
    const g = graphWithTwoRoots();
    // reparent n2 under n1, add n3 under n2
    applyMv(g, { sourceIds: ["n2"], destId: "n1" }, MUTATE_SOURCE);
    applyCreateNode(g, { id: "n3", summary: "leaf", importance: "med", parentNode: "n2", state: "active" });
    applyRecordObservation(g, { obs: obsWith({ id: "o1", timestamp: "2026-07-29T10:00:00.000Z", parentNode: "n3" }) });
    // move the sole observation to n2's sibling root (the other root from graphWithTwoRoots)
    applyMv(g, { sourceIds: ["o1"], destId: "n1" }, MUTATE_SOURCE);
    // the whole n2->n3 chain (both emptied) dissolved in the one move
    expect(g.nodes.has("n3")).toBe(false);
    expect(g.nodes.has("n2")).toBe(false);
    // n1 survives — it now holds o1 (the moved obs)
    expect(g.nodes.has("n1")).toBe(true);
    expect(nodeById(g, "n1").observationIds).toEqual(["o1"]);
    expect(nodeById(g, "n1").childNodeIds).toEqual([]);
  });
});

describe("timestamp range propagation", () => {
  it("recomputes ancestor ranges when a descendant observation changes", () => {
    const g = bareGraph();
    applyCreateNode(g, { id: "n1", summary: "root", importance: "med", parentNode: null, state: "active" });
    applyCreateNode(g, { id: "n2", summary: "child", importance: "med", parentNode: "n1", state: "active" });
    // record an obs under n2 at 10:00 -> n1 and n2 ranges must both span it
    applyRecordObservation(g, { obs: obsWith({ id: "o1", timestamp: "2026-07-29T10:00:00.000Z", parentNode: "n2" }) });
    expect(nodeById(g, "n1").timestamps.rangeStart).toBe("2026-07-29T10:00:00.000Z");
    expect(nodeById(g, "n2").timestamps.rangeStart).toBe("2026-07-29T10:00:00.000Z");
    // move the obs out of n2 to a new root n3 -> n2 and n1 ranges must update
    applyCreateNode(g, { id: "n3", summary: "other", importance: "med", parentNode: null, state: "active" });
    applyRecordObservation(g, { obs: obsWith({ id: "o2", timestamp: "2026-07-29T10:00:00.000Z", parentNode: "n2" }) });
    applyMv(g, { sourceIds: ["o2"], destId: "n3" }, MUTATE_SOURCE);
    // n2 still has o1 (10:00); n3 now has o2 (10:00) — both stay 10:00
    expect(nodeById(g, "n2").timestamps.rangeStart).toBe("2026-07-29T10:00:00.000Z");
    expect(nodeById(g, "n3").timestamps.rangeEnd).toBe("2026-07-29T10:00:00.000Z");
  });

  it("recomputes the ancestor range when a grandchild observation moves away", () => {
    const g = bareGraph();
    applyCreateNode(g, { id: "n1", summary: "root", importance: "med", parentNode: null, state: "active" });
    applyCreateNode(g, { id: "n2", summary: "mid", importance: "med", parentNode: "n1", state: "active" });
    applyCreateNode(g, { id: "n3", summary: "leaf", importance: "med", parentNode: "n2", state: "active" });
    // n2 keeps its own observation so the chain survives n3's dissolution
    applyRecordObservation(g, { obs: obsWith({ id: "o9", timestamp: "2026-07-29T09:00:00.000Z", parentNode: "n2" }) });
    applyRecordObservation(g, { obs: obsWith({ id: "o1", timestamp: "2026-07-29T08:00:00.000Z", parentNode: "n3" }) });
    // n1 (grandparent) range spans o1 (08:00) and oKeep (09:00)
    expect(nodeById(g, "n1").timestamps.rangeStart).toBe("2026-07-29T08:00:00.000Z");
    expect(nodeById(g, "n1").timestamps.rangeEnd).toBe("2026-07-29T09:00:00.000Z");
    // move o1 out to a fresh root; n3 dissolves but n1/n2 survive on oKeep
    applyCreateNode(g, { id: "n4", summary: "fresh", importance: "med", parentNode: null, state: "active" });
    applyMv(g, { sourceIds: ["o1"], destId: "n4" }, MUTATE_SOURCE);
    expect(g.nodes.has("n3")).toBe(false);
    expect(nodeById(g, "n4").timestamps.rangeStart).toBe("2026-07-29T08:00:00.000Z");
    // n1/n2 now reflect only oKeep (09:00) — the 08:00 obs is gone from their subtree
    expect(nodeById(g, "n1").timestamps.rangeStart).toBe("2026-07-29T09:00:00.000Z");
    expect(nodeById(g, "n2").timestamps.rangeStart).toBe("2026-07-29T09:00:00.000Z");
  });
});

describe("applyMerge", () => {
  it("folds sources into a destination, relocating observations and dissolving sources", () => {
    const g = graphWithTwoRoots();
    applyRecordObservation(g, { obs: obsWith({ id: "o1", timestamp: "2026-07-29T10:00:00.000Z", parentNode: "n1" }) });
    applyRecordObservation(g, { obs: obsWith({ id: "o2", timestamp: "2026-07-29T11:00:00.000Z", parentNode: "n2" }) });
    const delta = applyMerge(g, { sourceIds: ["n2"], destId: "n1", newSummary: "combined" }, MUTATE_SOURCE);
    expect(delta).toEqual({ type: "merge", sourceIds: ["n2"], destId: "n1", newSummary: "combined" });
    expect(g.nodes.has("n2")).toBe(false);
    expect(nodeById(g, "n1").observationIds.sort()).toEqual(["o1", "o2"]);
    expect(nodeById(g, "n1").summary).toBe("combined");
    expect(obsById(g, "o2").parentNode).toBe("n1");
  });

  it("creates a new root when destId is null (newSummary required)", () => {
    const g = graphWithTwoRoots();
    applyRecordObservation(g, { obs: obsWith({ id: "o1", timestamp: "2026-07-29T10:00:00.000Z", parentNode: "n1" }) });
    applyRecordObservation(g, { obs: obsWith({ id: "o2", timestamp: "2026-07-29T11:00:00.000Z", parentNode: "n2" }) });
    const before = g.nextNodeId;
    applyMerge(
      g,
      { sourceIds: ["n1", "n2"], destId: null, newSummary: "fresh root", importance: "high" },
      MUTATE_SOURCE,
    );
    expect(g.nextNodeId).toBeGreaterThan(before);
    const found = [...g.nodes.values()].find((n) => n.summary === "fresh root");
    expect(found).toBeDefined();
    expect(found?.parentNode).toBeNull();
    expect(found?.importance).toBe("high");
    expect(g.nodes.has("n1")).toBe(false);
    expect(g.nodes.has("n2")).toBe(false);
  });

  it("records resolvedDestId for a new-root merge so replay is identity-stable", () => {
    const g = graphWithTwoRoots();
    applyRecordObservation(g, { obs: obsWith({ id: "o1", timestamp: "2026-07-29T10:00:00.000Z", parentNode: "n1" }) });
    applyRecordObservation(g, { obs: obsWith({ id: "o2", timestamp: "2026-07-29T11:00:00.000Z", parentNode: "n2" }) });
    const delta = applyMerge(
      g,
      { sourceIds: ["n1", "n2"], destId: null, newSummary: "fresh root", importance: "med" },
      MUTATE_SOURCE,
    );
    expect(delta.destId).toBeNull();
    expect(delta.resolvedDestId).toBeDefined();
    expect(delta.importance).toBe("med");
    // replay on a graph whose nextNodeId counter is LOWER than at original apply
    // (simulating a skipped counter-advancing delta): the resolved id must win.
    const g2 = graphWithTwoRoots();
    g2.nextNodeId = 5; // lower than the original graph's counter
    applyMerge(
      g2,
      {
        sourceIds: ["n1", "n2"],
        destId: null,
        newSummary: "fresh root",
        importance: "med",
        resolvedDestId: delta.resolvedDestId,
      },
      MUTATE_SOURCE,
    );
    expect(g2.nodes.has(delta.resolvedDestId as NodeId)).toBe(true);
  });

  it("merges into an existing destination without newSummary, keeping its summary", () => {
    const g = graphWithTwoRoots();
    applyRecordObservation(g, { obs: obsWith({ id: "o1", timestamp: "2026-07-29T10:00:00.000Z", parentNode: "n2" }) });
    applyMerge(g, { sourceIds: ["n2"], destId: "n1" }, MUTATE_SOURCE);
    expect(nodeById(g, "n1").summary).toBe("root one");
    expect(nodeById(g, "n1").observationIds).toContain("o1");
  });

  it("requires newSummary when creating a new root via merge (destId null)", () => {
    const g = graphWithTwoRoots();
    expect(() => applyMerge(g, { sourceIds: ["n1", "n2"], destId: null, importance: "high" }, MUTATE_SOURCE)).toThrow(
      GraphInvariantError,
    );
    // rejected call leaves the graph unchanged — no stray new root
    expect([...g.nodes.values()].filter((n) => n.parentNode === null).length).toBe(2);
  });

  it("requires importance when creating a new root via merge (destId null)", () => {
    const g = graphWithTwoRoots();
    expect(() =>
      applyMerge(g, { sourceIds: ["n1", "n2"], destId: null, newSummary: "fresh root" }, MUTATE_SOURCE),
    ).toThrow(GraphInvariantError);
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

describe("applySupersede", () => {
  it("marks nodes obsolete pointing at the replacement and retains their observations", () => {
    const g = graphWithTwoRoots();
    applyRecordObservation(g, { obs: obsWith({ id: "o1", timestamp: "2026-07-29T10:00:00.000Z", parentNode: "n1" }) });
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

  it("rejects a supersession that would form a cycle (n1→n2, then n2 by n1)", () => {
    // build a chain: n1 is superseded by n2 (n1.supersededBy = n2)
    const g = graphWithTwoRoots();
    applySupersede(g, { nodeId: "n2", supersededNodeIds: ["n1"] }, MUTATE_SOURCE);
    expect(nodeById(g, "n1").supersededBy).toBe("n2");
    // superseding n2 by n1 would form a cycle (n1 → n2 → n1) — the replacement's
    // supersededBy-walk reaches the target n1
    expect(() => applySupersede(g, { nodeId: "n1", supersededNodeIds: ["n2"] }, MUTATE_SOURCE)).toThrow(
      GraphInvariantError,
    );
  });

  it("rejects supersede when the replacement (nodeId) does not exist", () => {
    const g = graphWithTwoRoots();
    expect(() => applySupersede(g, { nodeId: "n999", supersededNodeIds: ["n1"] }, MUTATE_SOURCE)).toThrow(
      GraphInvariantError,
    );
    // rejected call leaves the graph unchanged
    expect(nodeById(g, "n1").state).toBe("active");
    expect(nodeById(g, "n1").supersededBy).toBeNull();
  });

  it("rejects supersede when a target id does not exist", () => {
    const g = graphWithTwoRoots();
    expect(() => applySupersede(g, { nodeId: "n2", supersededNodeIds: ["n999"] }, MUTATE_SOURCE)).toThrow(
      GraphInvariantError,
    );
    expect(nodeById(g, "n2").state).toBe("active");
  });
});

describe("applySetMeta", () => {
  it("re-rates importance", () => {
    const g = graphWithTwoRoots();
    const delta = applySetMeta(
      g,
      { nodeId: "n1", importance: "crit", archived: null, obsolete: null, summary: null },
      MUTATE_SOURCE,
    );
    expect(delta.importance).toBe("crit");
    expect(nodeById(g, "n1").importance).toBe("crit");
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

  it("archiving an obsolete node exits obsolete and clears its supersededBy link", () => {
    const g = graphWithTwoRoots();
    applySupersede(g, { nodeId: "n2", supersededNodeIds: ["n1"] }, MUTATE_SOURCE);
    applySetMeta(g, { nodeId: "n1", importance: null, archived: true, obsolete: null, summary: null }, MUTATE_SOURCE);
    expect(nodeById(g, "n1").state).toBe("archived");
    // archived:true exits the obsolete state, so the supersession link is
    // cleared — supersededBy tracks obsolete only (a dangling replacement
    // ref on an archived node violates the state correlation).
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

describe("assertGraphStructure", () => {
  it("passes silently on a well-formed graph", () => {
    const g = graphWithNGoal();
    applyRecordObservation(g, { obs: obsWith({ id: "o1", timestamp: NOW, parentNode: "n1" }) });
    expect(() => assertGraphStructure(g, "gate")).not.toThrow();
  });

  it("names a phantom listing (a node list entry with no record)", () => {
    const g = graphWithNGoal();
    nodeById(g, "n1").observationIds.push("o404" as ObsId);
    expect(() => assertGraphStructure(g, "gate")).toThrow("gate: a node references a missing observation");
  });

  it("names a double listing, a parent/list drift, and an unlisted record", () => {
    const g = graphWithNGoal();
    applyRecordObservation(g, { obs: obsWith({ id: "o1", timestamp: NOW, parentNode: "n1" }) });
    // double listing: oInitialPrompt (legitimately under nGoal) also listed under n1
    nodeById(g, "n1").observationIds.push("oInitialPrompt" as ObsId);
    expect(() => assertGraphStructure(g, "gate")).toThrow("gate: an observation is listed under multiple nodes");
    nodeById(g, "n1").observationIds.pop();
    // drift: the record's parentNode is not the listing node
    obsById(g, "o1").parentNode = N_GOAL;
    expect(() => assertGraphStructure(g, "gate")).toThrow("gate: an observation's parent does not match its listing");
    obsById(g, "o1").parentNode = "n1";
    // unlisted: the record exists but appears in no node's list
    nodeById(g, "n1").observationIds = [];
    expect(() => assertGraphStructure(g, "gate")).toThrow("gate: an observation is not listed under any node");
  });

  it("surfaces the specific reason through a mutator's post-condition guard", () => {
    const g = graphWithNGoal();
    nodeById(g, "n1").observationIds.push("o404" as ObsId);
    expect(() =>
      applyCreateNode(g, { id: "n9", summary: "x", importance: "med", parentNode: null, state: "active" }),
    ).toThrow("create_node: a node references a missing observation");
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

// --- always-attached invariant: every observation is attached to exactly one node ---
// (never orphaned, never double-parented) — asserted independently after each
// core relocate/merge/supersede, the highest-risk paths for parent drift.
describe("always-attached invariant holds after core mutations", () => {
  /** nGoal(root) + n1(root, obs o1) + n2(root, child n3, obs o2 under n3). */
  function graphWithObs(): SessionOwlGraph {
    const g = graphWithNGoal();
    applyRecordObservation(g, {
      obs: makeObservation({
        id: "o1",
        summary: "first",
        importance: "high",
        sourceEntryIds: ["1"],
        timestamp: NOW,
        parentNode: "n1",
      }),
    });
    applyCreateNode(g, { id: "n2", summary: "second root", importance: "med", parentNode: null, state: "active" });
    applyCreateNode(g, { id: "n3", summary: "child", importance: "med", parentNode: "n2", state: "active" });
    applyRecordObservation(g, {
      obs: makeObservation({
        id: "o2",
        summary: "second",
        importance: "low",
        sourceEntryIds: ["2"],
        timestamp: NOW,
        parentNode: "n3",
      }),
    });
    return g;
  }

  it("holds after mv-ing an observation between nodes", () => {
    const g = graphWithObs();
    applyMv(g, { sourceIds: ["o2"], destId: "n1" }, MUTATE_SOURCE);
    expect(exactlyOneNodePerObservation(g)).toBe(true);
  });

  it("holds after mv-ing a subtree (node + its obs) under another node", () => {
    const g = graphWithObs();
    applyMv(g, { sourceIds: ["n3"], destId: "n1" }, MUTATE_SOURCE);
    expect(exactlyOneNodePerObservation(g)).toBe(true);
  });

  it("holds after merge: absorbed node's obs + children relocate, source dissolves", () => {
    const g = graphWithObs();
    applyMerge(g, { sourceIds: ["n3"], destId: "n1", newSummary: "combined" }, MUTATE_SOURCE);
    expect(exactlyOneNodePerObservation(g)).toBe(true);
  });

  it("holds after supersede: retained (tombstone) node keeps its obs under it", () => {
    const g = graphWithObs();
    applySupersede(g, { nodeId: "n2", supersededNodeIds: ["n1"] }, MUTATE_SOURCE);
    expect(exactlyOneNodePerObservation(g)).toBe(true);
  });
});

function bareGraph(): SessionOwlGraph {
  return new SessionOwlGraph({ nodes: new Map(), observations: new Map(), nextObsId: 1, nextNodeId: 1 });
}

function bareGraphWithRoot(id: NodeId): SessionOwlGraph {
  const g = bareGraph();
  applyCreateNode(g, { id, summary: "root", importance: "med", parentNode: null, state: "active" });
  return g;
}

/** Two active root nodes n1, n2 (no observations). */
function graphWithTwoRoots(): SessionOwlGraph {
  const g = bareGraph();
  applyCreateNode(g, { id: "n1", summary: "root one", importance: "med", parentNode: null, state: "active" });
  applyCreateNode(g, { id: "n2", summary: "root two", importance: "med", parentNode: null, state: "active" });
  return g;
}

/** nGoal (crit, root) with oInitialPrompt attached, plus an empty root n1. */
function graphWithNGoal(): SessionOwlGraph {
  const g = bareGraph();
  applyCreateNode(g, { id: N_GOAL, summary: "the goal", importance: "crit", parentNode: null, state: "active" });
  applyRecordObservation(g, {
    obs: makeObservation({
      id: "oInitialPrompt",
      summary: "the initial prompt",
      importance: "crit",
      sourceEntryIds: ["1"],
      timestamp: NOW,
      parentNode: N_GOAL,
    }),
  });
  applyCreateNode(g, { id: "n1", summary: "other root", importance: "med", parentNode: null, state: "active" });
  return g;
}

function nodeById(g: SessionOwlGraph, id: NodeId): Node {
  const n = g.nodes.get(id);
  if (n === undefined) throw new Error(`missing node ${id}`);
  return n;
}

function obsById(g: SessionOwlGraph, id: ObsId): Observation {
  const o = g.observations.get(id);
  if (o === undefined) throw new Error(`missing observation ${id}`);
  return o;
}

function obsWith(overrides: Partial<Observation> & Pick<Observation, "id" | "timestamp" | "parentNode">): Observation {
  const summary = overrides.summary ?? "content";
  return {
    id: overrides.id,
    summary,
    summaryTokens: estimateContentTokens(summary),
    detailsLines: overrides.detailsLines ?? countLines(summary),
    detailsTokens: overrides.detailsTokens ?? estimateContentTokens(summary),
    importance: overrides.importance ?? ("med" as Importance),
    sourceEntryIds: overrides.sourceEntryIds ?? ["1"],
    timestamp: overrides.timestamp,
    parentNode: overrides.parentNode,
  };
}
