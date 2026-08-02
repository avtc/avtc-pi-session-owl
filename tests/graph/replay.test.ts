// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import { describe, expect, it } from "vitest";
import { GraphInvariantError } from "../../src/graph/invariants.js";
import type { GraphDelta, MergeDelta, MvDelta, SetMetaDelta, SupersedeDelta } from "../../src/graph/mutations.js";
import { applyCreateNode, applyRecordObservation, MUTATE_SOURCE } from "../../src/graph/mutations.js";
import { applyDelta } from "../../src/graph/replay.js";
import type { Importance, Node, NodeId, ObsId } from "../../src/types.js";
import { MemkeeperGraph, makeNode, makeObservation, N_GOAL } from "../../src/types.js";

// --- fixtures ---------------------------------------------------------------

/** A small well-formed graph: nGoal (root) > n1; o1 under n1. */
function seedGraph(): MemkeeperGraph {
  const graph = new MemkeeperGraph({
    nodes: new Map(),
    observations: new Map(),
    nextObsId: 2,
    nextNodeId: 2,
  });
  const goal = makeNode({
    id: N_GOAL,
    summary: "the goal",
    importance: "critical" as Importance,
    state: "active",
    parentNode: null,
    createdAt: "2026-07-29T09:00:00.000Z",
  });
  const n1 = makeNode({
    id: "n1" as NodeId,
    summary: "branch one",
    importance: "medium" as Importance,
    state: "active",
    parentNode: N_GOAL,
    createdAt: "2026-07-29T10:00:00.000Z",
  });
  graph.nodes.set(N_GOAL, goal);
  graph.nodes.set("n1", n1);
  goal.childNodeIds.push("n1" as NodeId);
  const o1 = makeObservation({
    id: "o1" as ObsId,
    content: "first fact",
    importance: "medium" as Importance,
    sourceEntryIds: ["5"],
    timestamp: "2026-07-29T10:00:00.000Z",
    parentNode: "n1" as NodeId,
  });
  graph.observations.set("o1", o1);
  n1.observationIds.push("o1" as ObsId);
  return graph;
}

function node(graph: MemkeeperGraph, id: NodeId): Node {
  const n = graph.nodes.get(id);
  if (n === undefined) throw new Error(`node ${id} missing`);
  return n;
}

describe("applyDelta replay dispatcher", () => {
  it("applies a create_node delta", () => {
    const g = seedGraph();
    const delta = {
      type: "create_node" as const,
      id: "n2" as NodeId,
      summary: "new branch",
      importance: "high" as Importance,
      parentNode: N_GOAL,
      state: "active" as const,
    };
    applyDelta(g, delta, MUTATE_SOURCE);
    expect(g.nodes.has("n2")).toBe(true);
    expect(node(g, "n2").summary).toBe("new branch");
    expect(node(g, N_GOAL).childNodeIds).toContain("n2");
  });

  it("applies a record_observation delta", () => {
    const g = seedGraph();
    const obs = makeObservation({
      id: "o5" as ObsId,
      content: "fifth fact",
      importance: "low" as Importance,
      sourceEntryIds: ["7"],
      timestamp: "2026-07-29T11:00:00.000Z",
      parentNode: "n1" as NodeId,
    });
    applyDelta(g, { type: "record_observation", obs }, MUTATE_SOURCE);
    expect(g.observations.has("o5")).toBe(true);
    expect(node(g, "n1").observationIds).toContain("o5");
  });

  it("applies an mv delta (reparent)", () => {
    const g = seedGraph();
    applyCreateNode(g, {
      id: "n2" as NodeId,
      summary: "dest",
      importance: "medium" as Importance,
      parentNode: N_GOAL,
      state: "active",
    });
    const delta: MvDelta = { type: "mv", sourceIds: ["o1" as ObsId], destId: "n2" as NodeId };
    applyDelta(g, delta, MUTATE_SOURCE);
    expect(node(g, "n2").observationIds).toContain("o1");
    // n1 had only o1; moving it away empties n1 → it dissolves
    expect(g.nodes.has("n1")).toBe(false);
  });

  it("applies a merge delta", () => {
    const g = seedGraph();
    applyCreateNode(g, {
      id: "n2" as NodeId,
      summary: "to absorb into n1",
      importance: "low" as Importance,
      parentNode: N_GOAL,
      state: "active",
    });
    applyRecordObservation(g, {
      obs: makeObservation({
        id: "o9" as ObsId,
        content: "in n2",
        importance: "low" as Importance,
        sourceEntryIds: ["8"],
        timestamp: "2026-07-29T12:00:00.000Z",
        parentNode: "n2" as NodeId,
      }),
    });
    const delta: MergeDelta = {
      type: "merge",
      sourceIds: ["n2" as NodeId],
      destId: "n1" as NodeId,
      newSummary: "merged branch one",
    };
    applyDelta(g, delta, MUTATE_SOURCE);
    expect(node(g, "n1").summary).toBe("merged branch one");
    expect(node(g, "n1").observationIds).toContain("o9");
    expect(g.nodes.has("n2")).toBe(false);
  });

  it("applies a supersede delta", () => {
    const g = seedGraph();
    applyCreateNode(g, {
      id: "n2" as NodeId,
      summary: "replacement",
      importance: "high" as Importance,
      parentNode: N_GOAL,
      state: "active",
    });
    const delta: SupersedeDelta = { type: "supersede", nodeId: "n2" as NodeId, supersededNodeIds: ["n1" as NodeId] };
    applyDelta(g, delta, MUTATE_SOURCE);
    expect(node(g, "n1").state).toBe("obsolete");
    expect(node(g, "n1").supersededBy).toBe("n2");
  });

  it("applies a set_meta delta", () => {
    const g = seedGraph();
    const delta: SetMetaDelta = {
      type: "set_meta",
      nodeId: "n1" as NodeId,
      importance: "critical" as Importance,
      archived: null,
      obsolete: null,
      summary: "retitled",
    };
    applyDelta(g, delta, MUTATE_SOURCE);
    expect(node(g, "n1").importance).toBe("critical");
    expect(node(g, "n1").summary).toBe("retitled");
  });

  it("applies a flush_new delta", () => {
    const g = seedGraph();
    applyCreateNode(g, {
      id: "n2" as NodeId,
      summary: "fresh",
      importance: "medium" as Importance,
      parentNode: N_GOAL,
      state: "new",
    });
    applyDelta(g, { type: "flush_new", nodeIds: ["n2" as NodeId] }, MUTATE_SOURCE);
    expect(node(g, "n2").state).toBe("active");
  });

  it("rethrows GraphInvariantError on a bad delta (caller catches)", () => {
    const g = seedGraph();
    // mv to a non-existent dest
    const delta: MvDelta = { type: "mv", sourceIds: ["o1" as ObsId], destId: "n99" as NodeId };
    expect(() => applyDelta(g, delta, MUTATE_SOURCE)).toThrow(GraphInvariantError);
  });

  it("throws on an unknown delta type", () => {
    const g = seedGraph();
    expect(() => applyDelta(g, { type: "bogus" } as unknown as GraphDelta, MUTATE_SOURCE)).toThrow();
  });
});
