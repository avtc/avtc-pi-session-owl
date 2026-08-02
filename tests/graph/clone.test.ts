// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import { describe, expect, it } from "vitest";
import { cloneGraph } from "../../src/graph/clone.js";
import type { Node, NodeId, Observation, ObsId } from "../../src/types.js";
import { MemkeeperGraph, makeNode, makeObservation, N_GOAL, O_INITIAL_PROMPT } from "../../src/types.js";

function seededGraph(): MemkeeperGraph {
  const nodes = new Map<NodeId, Node>();
  const observations = new Map<ObsId, Observation>();
  const nGoal = makeNode({
    id: N_GOAL,
    summary: "the goal",
    importance: "critical",
    parentNode: null,
    state: "active",
    createdAt: "2026-07-28T09:00:00.000Z",
  });
  const n3 = makeNode({
    id: "n3",
    summary: "child",
    importance: "high",
    parentNode: N_GOAL,
    state: "active",
    createdAt: "2026-07-28T09:00:00.000Z",
  });
  nGoal.childNodeIds = ["n3"];
  nodes.set(N_GOAL, nGoal);
  nodes.set("n3", n3);
  const o1 = makeObservation({
    id: O_INITIAL_PROMPT,
    content: "initial",
    importance: "critical",
    sourceEntryIds: ["u1"],
    parentNode: N_GOAL,
    timestamp: "2026-07-28T09:00:00.000Z",
  });
  const o2 = makeObservation({
    id: "o1",
    content: "fact",
    importance: "medium",
    sourceEntryIds: ["e2"],
    parentNode: "n3",
    timestamp: "2026-07-28T10:00:00.000Z",
  });
  n3.observationIds = ["o1"];
  observations.set(O_INITIAL_PROMPT, o1);
  observations.set("o1", o2);
  return new MemkeeperGraph({ nodes, observations, nextObsId: 2, nextNodeId: 4 });
}

describe("cloneGraph", () => {
  it("produces an independent deep copy (mutating the clone does not affect the source)", () => {
    const source = seededGraph();
    const clone = cloneGraph(source);

    // Mutate the clone.
    const goalClone = clone.nodes.get(N_GOAL);
    if (goalClone) goalClone.summary = "changed";
    const n3Clone = clone.nodes.get("n3");
    if (n3Clone) n3Clone.childNodeIds.push("n99");
    const o1Clone = clone.observations.get("o1");
    if (o1Clone) o1Clone.sourceEntryIds.push("e99");
    clone.nextObsId = 999;
    clone.nextNodeId = 999;

    // Source is untouched.
    expect(source.nodes.get(N_GOAL)?.summary).toBe("the goal");
    expect(source.nodes.get("n3")?.childNodeIds).toEqual([]);
    expect(source.observations.get("o1")?.sourceEntryIds).toEqual(["e2"]);
    expect(source.nextObsId).toBe(2);
    expect(source.nextNodeId).toBe(4);
  });

  it("preserves all nodes, observations, and the hasInitialPrompt getter", () => {
    const source = seededGraph();
    const clone = cloneGraph(source);
    expect([...clone.nodes.keys()].sort()).toEqual(["n3", N_GOAL].sort());
    expect([...clone.observations.keys()].sort()).toEqual([O_INITIAL_PROMPT, "o1"].sort());
    expect(clone.hasInitialPrompt).toBe(true);
    expect(clone.nodes.get("n3")?.observationIds).toEqual(["o1"]);
  });

  it("deep-copies nested arrays and timestamps objects (no shared references)", () => {
    const source = seededGraph();
    const clone = cloneGraph(source);
    const srcNode = source.nodes.get(N_GOAL);
    const cloneNode = clone.nodes.get(N_GOAL);
    expect(cloneNode?.childNodeIds).not.toBe(srcNode?.childNodeIds);
    expect(cloneNode?.observationIds).not.toBe(srcNode?.observationIds);
    expect(cloneNode?.timestamps).not.toBe(srcNode?.timestamps);
    const srcObs = source.observations.get("o1");
    const cloneObs = clone.observations.get("o1");
    expect(cloneObs?.sourceEntryIds).not.toBe(srcObs?.sourceEntryIds);
  });
});
