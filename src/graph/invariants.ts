// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// Pure validators over a MemkeeperGraph — no mutation. Used by the mutation
// engine (graph/mutations.ts) as the live per-call validation gate, and by
// tests.

import { type MemkeeperGraph, N_GOAL, N_IRRELEVANT, type Node, O_INITIAL_PROMPT } from "../types.js";

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
export function everyObservationAttached(graph: MemkeeperGraph): boolean {
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
export function exactlyOneNodePerObservation(graph: MemkeeperGraph): boolean {
  const ownerOf = new Map<string, Node>();
  for (const node of graph.nodes.values()) {
    for (const obsId of node.observationIds) {
      const obs = graph.observations.get(obsId);
      if (obs === undefined) return false; // phantom obs id in a node list
      if (ownerOf.has(obsId)) return false; // listed under more than one node
      if (obs.parentNode !== node.id) return false; // listed node != obs.parentNode
      ownerOf.set(obsId, node);
    }
  }
  // every observation must appear in some node's list
  return ownerOf.size === graph.observations.size;
}

/**
 * Containment child-links are bidirectionally consistent: every id in a node's
 * `childNodeIds` is a real node whose `parentNode` points back, and every
 * non-root node is listed in its parent's `childNodeIds`. No phantom children,
 * no dangling parents.
 */
export function childLinksConsistent(graph: MemkeeperGraph): boolean {
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
 * following `parentNode` pointers never loops. Detects a cycle by walking each
 * node's ancestor chain.
 */
export function noCycles(graph: MemkeeperGraph): boolean {
  for (const start of graph.nodes.keys()) {
    const seen = new Set<string>();
    let current: string | null = start;
    while (current !== null) {
      if (seen.has(current)) return false;
      seen.add(current);
      const node = graph.nodes.get(current as Node["id"]);
      if (node === undefined) return false;
      current = node.parentNode;
    }
  }
  return true;
}

/**
 * The predefined goal node invariants: nGoal exists, sits at the root, is
 * active and critical, carries no supersession, and the permanent seed
 * observation `oInitialPrompt` is attached to it (and thus undetachable).
 */
export function nGoalInvariants(graph: MemkeeperGraph): boolean {
  const goal = graph.nodes.get(N_GOAL);
  if (goal === undefined) return false;
  if (goal.parentNode !== null) return false;
  if (goal.state !== "active") return false;
  if (goal.importance !== "critical") return false;
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
 * Run all structural validators. Returns true for a well-formed graph; throws
 * `GraphInvariantError` on the first violation (used as the per-mutate gate).
 */
export function validateGraph(graph: MemkeeperGraph): boolean {
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
  return true;
}
