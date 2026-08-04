// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import { describe, expect, it } from "vitest";
import {
  childLinksConsistent,
  dissolvable,
  everyObservationAttached,
  exactlyOneNodePerObservation,
  GraphInvariantError,
  isSpecial,
  nGoalInvariants,
  noCycles,
  supersededByCorrelatesState,
  validateGraph,
} from "../../src/graph/invariants.js";
import type { Importance, Node, NodeId, Observation, ObsId } from "../../src/types.js";
import { estimateContentTokens, MemkeeperGraph, N_GOAL, N_IRRELEVANT, O_INITIAL_PROMPT } from "../../src/types.js";

describe("isSpecial", () => {
  it("treats nGoal and oInitialPrompt as source-graph specials", () => {
    expect(isSpecial(N_GOAL)).toBe(true);
    expect(isSpecial(O_INITIAL_PROMPT)).toBe(true);
  });

  it("does NOT treat nIrrelevant as a source-graph special", () => {
    expect(isSpecial(N_IRRELEVANT)).toBe(false);
  });

  it("does not treat generated ids as special", () => {
    expect(isSpecial("n1" as NodeId)).toBe(false);
    expect(isSpecial("o1" as ObsId)).toBe(false);
  });
});

describe("dissolvable", () => {
  it("dissolves an emptied ordinary node", () => {
    const node = nodeWith({ id: "n5", observationIds: [], childNodeIds: [] });
    expect(dissolvable(node)).toBe(true);
  });

  it("dissolves an emptied obsolete node", () => {
    const node = nodeWith({ id: "n5", state: "obsolete", observationIds: [], childNodeIds: [] });
    expect(dissolvable(node)).toBe(true);
  });

  it("does not dissolve a node with observations", () => {
    const node = nodeWith({ id: "n5", observationIds: ["o1" as ObsId] });
    expect(dissolvable(node)).toBe(false);
  });

  it("does not dissolve a node with children", () => {
    const node = nodeWith({ id: "n5", childNodeIds: ["n6" as NodeId] });
    expect(dissolvable(node)).toBe(false);
  });

  it("never dissolves nGoal", () => {
    const node = nodeWith({ id: N_GOAL, observationIds: [], childNodeIds: [] });
    expect(dissolvable(node)).toBe(false);
  });

  it("never dissolves nIrrelevant (the working-copy demote bin stays when empty)", () => {
    const node = nodeWith({ id: N_IRRELEVANT, observationIds: [], childNodeIds: [] });
    expect(dissolvable(node)).toBe(false);
  });
});

describe("structural validators", () => {
  it("pass for a well-formed graph", () => {
    const g = validGraph();
    expect(everyObservationAttached(g)).toBe(true);
    expect(exactlyOneNodePerObservation(g)).toBe(true);
    expect(noCycles(g)).toBe(true);
    expect(nGoalInvariants(g)).toBe(true);
    expect(validateGraph(g)).toBe(true);
  });

  it("everyObservationAttached fails when an observation's parent node is missing", () => {
    const g = validGraph();
    g.observations.set("o9" as ObsId, obsWith({ id: "o9", parentNode: "n999" as NodeId }));
    expect(everyObservationAttached(g)).toBe(false);
  });

  it("exactlyOneNodePerObservation fails when an obs is double-listed under two nodes", () => {
    const g = validGraph();
    node(g, "n5" as NodeId).observationIds.push("o1" as ObsId);
    expect(exactlyOneNodePerObservation(g)).toBe(false);
  });

  it("exactlyOneNodePerObservation fails when a node lists an obs whose parentNode is a different node", () => {
    const g = validGraph();
    // o2 is legitimately under n5; reparent o2 to n6 but leave n5 still listing it
    observation(g, "o2" as ObsId).parentNode = "n6" as NodeId;
    expect(exactlyOneNodePerObservation(g)).toBe(false);
  });

  it("noCycles fails when a node is parented to its own descendant", () => {
    const g = validGraph();
    // n5 -> n6 (child). Re-parent n5 under n6 to form a cycle.
    const n5 = node(g, "n5" as NodeId);
    const n6 = node(g, "n6" as NodeId);
    n5.parentNode = "n6" as NodeId;
    n6.childNodeIds.push("n5" as NodeId);
    expect(noCycles(g)).toBe(false);
  });

  it("nGoalInvariants fails when nGoal is archived", () => {
    const g = validGraph();
    node(g, N_GOAL).state = "archived";
    expect(nGoalInvariants(g)).toBe(false);
  });

  it("nGoalInvariants fails when nGoal is missing", () => {
    const g = validGraph();
    g.nodes.delete(N_GOAL);
    expect(nGoalInvariants(g)).toBe(false);
  });

  it("nGoalInvariants fails when oInitialPrompt is not under nGoal", () => {
    const g = validGraph();
    observation(g, O_INITIAL_PROMPT).parentNode = "n5" as NodeId;
    expect(nGoalInvariants(g)).toBe(false);
  });

  it("nGoalInvariants fails when nGoal carries a supersededBy link", () => {
    const g = validGraph();
    node(g, N_GOAL).supersededBy = "n5" as NodeId;
    expect(nGoalInvariants(g)).toBe(false);
  });

  it("nGoalInvariants fails when nGoal is not at the root", () => {
    const g = validGraph();
    node(g, N_GOAL).parentNode = "n5" as NodeId;
    expect(nGoalInvariants(g)).toBe(false);
  });

  it("nGoalInvariants fails when nGoal importance is not critical", () => {
    const g = validGraph();
    node(g, N_GOAL).importance = "low";
    expect(nGoalInvariants(g)).toBe(false);
  });
});

describe("reverse-direction consistency", () => {
  it("exactlyOneNodePerObservation fails when a node lists a phantom observation id", () => {
    const g = validGraph();
    node(g, "n5" as NodeId).observationIds.push("oGhost" as ObsId);
    expect(exactlyOneNodePerObservation(g)).toBe(false);
  });

  it("exactlyOneNodePerObservation fails when an observation is unlisted (orphaned in the ledger)", () => {
    const g = validGraph();
    g.observations.set("o9" as ObsId, obsWith({ id: "o9", parentNode: "n5" as NodeId }));
    expect(exactlyOneNodePerObservation(g)).toBe(false);
  });

  it("childLinksConsistent fails when a child is listed but does not point back to the parent", () => {
    const g = validGraph();
    node(g, "n5" as NodeId).childNodeIds.push("n6" as NodeId); // already a child; instead break n6's back-link
    node(g, "n6" as NodeId).parentNode = null;
    expect(childLinksConsistent(g)).toBe(false);
  });

  it("childLinksConsistent fails when a node lists a phantom child id", () => {
    const g = validGraph();
    node(g, "n5" as NodeId).childNodeIds.push("nGhost" as NodeId);
    expect(childLinksConsistent(g)).toBe(false);
  });

  it("childLinksConsistent fails when a non-root node's parent does not list it", () => {
    const g = validGraph();
    node(g, "n5" as NodeId).childNodeIds = []; // n6 is parented to n5 but n5 no longer lists it
    expect(childLinksConsistent(g)).toBe(false);
  });
});

describe("validateGraph", () => {
  it("returns true for a valid graph", () => {
    expect(validateGraph(validGraph())).toBe(true);
  });

  it("throws GraphInvariantError for an invalid graph", () => {
    const g = validGraph();
    g.observations.set("o9" as ObsId, obsWith({ id: "o9", parentNode: "n999" as NodeId }));
    expect(() => validateGraph(g)).toThrow(GraphInvariantError);
  });
});

describe("supersededByCorrelatesState", () => {
  it("holds for a graph with no obsolete nodes", () => {
    expect(supersededByCorrelatesState(validGraph())).toBe(true);
  });

  it("holds for an obsolete node carrying its replacement", () => {
    const g = validGraph();
    node(g, "n5").state = "obsolete";
    node(g, "n5").supersededBy = "n6" as NodeId;
    expect(supersededByCorrelatesState(g)).toBe(true);
  });

  it("fails when an obsolete node has a null supersededBy", () => {
    const g = validGraph();
    node(g, "n5").state = "obsolete";
    // supersededBy stays null — obsolete without a replacement ref
    expect(supersededByCorrelatesState(g)).toBe(false);
  });

  it("fails when a non-obsolete node carries a supersededBy link", () => {
    const g = validGraph();
    node(g, "n5").state = "archived";
    node(g, "n5").supersededBy = "n6" as NodeId; // dangling ref on an archived node
    expect(supersededByCorrelatesState(g)).toBe(false);
    expect(() => validateGraph(g)).toThrow(GraphInvariantError);
  });
});

// --- test helpers ----------------------------------------------------------

function nodeWith(overrides: Partial<Node> & Pick<Node, "id">): Node {
  const summary = overrides.summary ?? "summary";
  return {
    id: overrides.id,
    summary,
    summaryTokens: estimateContentTokens(summary),
    importance: overrides.importance ?? ("medium" as Importance),
    state: overrides.state ?? "active",
    parentNode: overrides.parentNode ?? null,
    observationIds: overrides.observationIds ?? [],
    childNodeIds: overrides.childNodeIds ?? [],
    supersededBy: overrides.supersededBy ?? null,
    timestamps: overrides.timestamps ?? {
      createdAt: "2026-07-29T09:00:00.000Z",
      updatedAt: "2026-07-29T09:00:00.000Z",
      rangeStart: "2026-07-29T09:00:00.000Z",
      rangeEnd: "2026-07-29T09:00:00.000Z",
    },
  };
}

function obsWith(overrides: Partial<Observation> & Pick<Observation, "id" | "parentNode">): Observation {
  const content = overrides.content ?? "content";
  return {
    id: overrides.id,
    content,
    contentTokens: estimateContentTokens(content),
    importance: overrides.importance ?? "medium",
    sourceEntryIds: overrides.sourceEntryIds ?? ["1"],
    timestamp: overrides.timestamp ?? "2026-07-29T09:00:00.000Z",
    parentNode: overrides.parentNode,
  };
}

/** Fetch a node by id, throwing if absent (avoids non-null assertions). */
function node(graph: MemkeeperGraph, id: NodeId): Node {
  const n = graph.nodes.get(id);
  if (n === undefined) throw new Error(`test fixture missing node ${id}`);
  return n;
}

/** Fetch an observation by id, throwing if absent (avoids non-null assertions). */
function observation(graph: MemkeeperGraph, id: ObsId): Observation {
  const o = graph.observations.get(id);
  if (o === undefined) throw new Error(`test fixture missing observation ${id}`);
  return o;
}

/** A small well-formed graph: nGoal(root, +oInitialPrompt +o1), n5(root, o2), n6(child of n5, o3). */
function validGraph(): MemkeeperGraph {
  const nodes = new Map<NodeId, Node>();
  const observations = new Map<ObsId, Observation>();
  nodes.set(N_GOAL, nodeWith({ id: N_GOAL, importance: "critical", state: "active" }));
  nodes.set("n5" as NodeId, nodeWith({ id: "n5", summary: "branch five", parentNode: null }));
  nodes.set("n6" as NodeId, nodeWith({ id: "n6", summary: "child six", parentNode: "n5" as NodeId }));
  nodes.get("n5")?.childNodeIds.push("n6" as NodeId);

  const oInit = obsWith({ id: O_INITIAL_PROMPT, content: "the goal", importance: "critical", parentNode: N_GOAL });
  const o1 = obsWith({ id: "o1", content: "first", parentNode: N_GOAL });
  const o2 = obsWith({ id: "o2", content: "second", parentNode: "n5" as NodeId });
  const o3 = obsWith({ id: "o3", content: "third", parentNode: "n6" as NodeId });
  for (const o of [oInit, o1, o2, o3]) observations.set(o.id, o);
  nodes.get(N_GOAL)?.observationIds.push(O_INITIAL_PROMPT, "o1" as ObsId);
  nodes.get("n5")?.observationIds.push("o2" as ObsId);
  nodes.get("n6")?.observationIds.push("o3" as ObsId);

  return new MemkeeperGraph({ nodes, observations, nextObsId: 4, nextNodeId: 7 });
}
