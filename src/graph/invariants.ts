// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// Pure validators over a SessionOwlGraph — no mutation. Used by the mutation
// engine as the live per-call validation gate, and by tests.

import { N_GOAL, N_IRRELEVANT, type Node, O_INITIAL_PROMPT, type SessionOwlGraph } from "../types.js";

/** Raised when a structural invariant does not hold. */
export class GraphInvariantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GraphInvariantError";
  }
}

/**
 * Source-graph specials only: the predefined goal node and its permanent
 * seed observation. `nIrrelevant` is a working-copy-only id and is NOT special
 * here (it is merely exempt from auto-dissolution — see `dissolvable`).
 */
export function isSpecial(id: string): boolean {
  return id === N_GOAL || id === O_INITIAL_PROMPT;
}

/**
 * Every observation is attached to an existing node. Since
 * `Observation.parentNode` is a non-null `NodeId`, a root-level observation is
 * unrepresentable by construction; the only failure mode is a dangling parent
 * reference (the node was removed but the obs still points at it).
 */
export function everyObservationAttached(graph: SessionOwlGraph): boolean {
  for (const obs of graph.observations.values()) {
    if (!graph.nodes.has(obs.parentNode)) return false;
  }
  return true;
}

/**
 * Each observation is listed under exactly one node, that node is the
 * observation's own `parentNode`, and no node references a phantom observation.
 * Catches double-listing, parent/list drift, and dangling obs ids. Single pass
 * over nodes (linear in node + edge count) — not nested in the obs count.
 */
export function exactlyOneNodePerObservation(graph: SessionOwlGraph): boolean {
  return observationParentingError(graph) === null;
}

/**
 * The specific way `exactlyOneNodePerObservation` is violated, or null when it
 * holds. Names the actual condition so a rejection tells the model (and the
 * logs) what broke — a phantom listing, a double listing, a parent/list drift,
 * or an unlisted observation — instead of one conflated message.
 */
export function observationParentingError(graph: SessionOwlGraph): string | null {
  const ownerOf = new Map<string, Node>();
  for (const node of graph.nodes.values()) {
    for (const obsId of node.observationIds) {
      const obs = graph.observations.get(obsId);
      if (obs === undefined) return "a node references a missing observation";
      if (ownerOf.has(obsId)) return "an observation is listed under multiple nodes";
      if (obs.parentNode !== node.id) return "an observation's parent does not match its listing";
      ownerOf.set(obsId, node);
    }
  }
  if (ownerOf.size !== graph.observations.size) return "an observation is not listed under any node";
  return null;
}

/**
 * Containment child-links are bidirectionally consistent: every id in a node's
 * `childNodeIds` is a real node whose `parentNode` points back, and every
 * non-root node is listed in its parent's `childNodeIds`. No phantom children,
 * no dangling parents.
 */
export function childLinksConsistent(graph: SessionOwlGraph): boolean {
  for (const node of graph.nodes.values()) {
    for (const childId of node.childNodeIds) {
      const child = graph.nodes.get(childId);
      if (child === undefined) return false; // phantom child id
      if (child.parentNode !== node.id) return false; // child does not point back
    }
    if (node.parentNode !== null) {
      const parent = graph.nodes.get(node.parentNode);
      if (parent === undefined) return false; // parent missing
      if (!parent.childNodeIds.includes(node.id)) return false; // parent does not list this child
    }
  }
  return true;
}

/**
 * Containment is a strict tree: every non-root node has one parent, and
 * following `parentNode` pointers never loops. Single-pass functional-graph
 * cycle detection (O(N) total, one status map): each node has ≤1 parent, so a
 * walk from any node is a linear chain; coloring (unvisited → on-path → done)
 * lets every node's chain share work — a node already known acyclic short-
 * circuits any later walk that reaches it.
 */
export function noCycles(graph: SessionOwlGraph): boolean {
  const DONE = 2; // fully walked, chain reaches the root without looping
  const ON_PATH = 1; // on the current walk
  const status = new Map<string, number>();
  for (const start of graph.nodes.keys()) {
    if (status.get(start) === DONE) continue;
    const path: string[] = [];
    let current: string | null = start;
    while (current !== null) {
      const s = status.get(current);
      if (s === ON_PATH) return false; // revisited a node on this walk → cycle
      if (s === DONE) break; // reaches a known-acyclic chain → safe
      status.set(current, ON_PATH);
      path.push(current);
      const node = graph.nodes.get(current as Node["id"]);
      if (node === undefined) return false;
      current = node.parentNode;
    }
    for (const id of path) status.set(id, DONE);
  }
  return true;
}

/**
 * The predefined goal node invariants: nGoal exists, sits at the root, is
 * active and crit, carries no supersession, and the permanent seed
 * observation `oInitialPrompt` is attached to it (and thus undetachable).
 */
export function nGoalInvariants(graph: SessionOwlGraph): boolean {
  const goal = graph.nodes.get(N_GOAL);
  if (goal === undefined) return false;
  if (goal.parentNode !== null) return false;
  if (goal.state !== "active") return false;
  if (goal.importance !== "crit") return false;
  if (goal.supersededBy !== null) return false;
  const seed = graph.observations.get(O_INITIAL_PROMPT);
  if (seed === undefined) return false;
  if (seed.parentNode !== N_GOAL) return false;
  return true;
}

/**
 * Whether a node may auto-dissolve: it is non-special (neither nGoal nor the
 * working-copy demote bin nIrrelevant) and holds no observations and no
 * children. Obsolete nodes are NOT exempt — an emptied obsolete node dissolves.
 * The nIrrelevant exemption is a no-op in the source graph (which never
 * contains it) and lets the Selector working copy keep an empty demote bin
 * under the same rule.
 */
export function dissolvable(node: Node): boolean {
  if (node.id === N_GOAL) return false;
  if (node.id === N_IRRELEVANT) return false;
  return node.observationIds.length === 0 && node.childNodeIds.length === 0;
}

/**
 * `supersededBy` tracks the obsolete state: a node carries a replacement id
 * ONLY when it is obsolete, and null otherwise. Catches the obsolete→archived
 * transition that would leave a dangling replacement ref (the supersession
 * link must not survive a state change away from obsolete).
 */
export function supersededByCorrelatesState(graph: SessionOwlGraph): boolean {
  for (const node of graph.nodes.values()) {
    if (node.state === "obsolete") {
      // an obsolete node must carry its replacement (supersede always sets it).
      if (node.supersededBy === null) return false;
    } else if (node.supersededBy !== null) {
      // a non-obsolete node must not carry a replacement ref.
      return false;
    }
  }
  return true;
}

/**
 * Run all structural validators. Returns true for a well-formed graph; throws
 * `GraphInvariantError` on the first violation (used as the per-mutate gate).
 */
export function validateGraph(graph: SessionOwlGraph): boolean {
  if (!everyObservationAttached(graph)) {
    throw new GraphInvariantError("an observation is not attached to an existing node");
  }
  if (!exactlyOneNodePerObservation(graph)) {
    throw new GraphInvariantError("an observation is not under exactly one matching node");
  }
  if (!childLinksConsistent(graph)) {
    throw new GraphInvariantError("a containment child-link is inconsistent");
  }
  if (!noCycles(graph)) {
    throw new GraphInvariantError("the containment tree has a cycle");
  }
  if (!nGoalInvariants(graph)) {
    throw new GraphInvariantError("the nGoal invariants do not hold");
  }
  if (!supersededByCorrelatesState(graph)) {
    throw new GraphInvariantError("a supersededBy link does not correlate with the obsolete state");
  }
  return true;
}
