// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// Event-sourced mutation engine: pure functions that apply ONE mutation to a
// MemkeeperGraph in place, validate it live (throwing GraphInvariantError on a
// rejected call — which appends no delta), and return the serializable delta
// that was applied. The append-only log records these deltas as-is for replay.

import {
  estimateContentTokens,
  type Importance,
  type MemkeeperGraph,
  N_GOAL,
  type Node,
  type NodeId,
  nowStoredTimestamp,
  O_INITIAL_PROMPT,
  type Observation,
  type ObsId,
} from "../types.js";
import {
  childLinksConsistent,
  dissolvable,
  everyObservationAttached,
  exactlyOneNodePerObservation,
  GraphInvariantError,
  noCycles,
} from "./invariants.js";

/** Whether special-node protection (nGoal/oInitialPrompt) is enforced. */
export type MutationPolicy = "source" | "workingCopy";
export const MUTATE_SOURCE = "source" as const satisfies MutationPolicy;
export const MUTATE_WORKING_COPY = "workingCopy" as const satisfies MutationPolicy;

// --- delta shapes (serializable; recorded as-is for replay) ----------------

export interface CreateNodeDelta {
  type: "create_node";
  id: NodeId;
  summary: string;
  importance: Importance;
  parentNode: NodeId | null;
  state: Node["state"];
}
export interface RecordObservationDelta {
  type: "record_observation";
  obs: Observation;
}
export interface MvDelta {
  type: "mv";
  sourceIds: Array<ObsId | NodeId>;
  destId: NodeId | null;
  newSummary?: string;
}
export interface MergeDelta {
  type: "merge";
  sourceIds: NodeId[];
  destId: NodeId | null;
  newSummary?: string;
  /** Set when the merge re-rates the destination (always present for a new root
   *  created with `destId === null`, where importance is required at creation;
   *  present for an existing dest only when the caller re-rates it). */
  importance?: Importance;
  /** When destId === null (a new root is created), the resolved id of that
   *  node — recorded so replay is identity-stable even if the store's tolerant
   *  reader skipped an earlier counter-advancing delta. Absent when destId is
   *  non-null (no new node is minted). */
  resolvedDestId?: NodeId;
}
export interface SupersedeDelta {
  type: "supersede";
  nodeId: NodeId;
  supersededNodeIds: NodeId[];
}
export interface SetMetaDelta {
  type: "set_meta";
  nodeId: NodeId;
  importance: Importance | null;
  archived: boolean | null;
  obsolete: boolean | null;
  summary: string | null;
}
export interface FlushNewDelta {
  type: "flush_new";
  nodeIds: NodeId[];
}
export type GraphDelta =
  | CreateNodeDelta
  | RecordObservationDelta
  | MvDelta
  | MergeDelta
  | SupersedeDelta
  | SetMetaDelta
  | FlushNewDelta;

// --- shared helpers --------------------------------------------------------

/** Require a node to exist, else throw. */
function requireNode(graph: MemkeeperGraph, id: NodeId, what: string): Node {
  const node = graph.nodes.get(id);
  if (node === undefined) throw new GraphInvariantError(`${what}: node ${id} does not exist`);
  return node;
}

/** Post-condition guard: structural invariants (not the nGoal seed invariant). */
function assertStructural(graph: MemkeeperGraph, what: string): void {
  if (!everyObservationAttached(graph)) throw new GraphInvariantError(`${what}: an observation is detached`);
  if (!exactlyOneNodePerObservation(graph))
    throw new GraphInvariantError(`${what}: an observation is multi/root parented`);
  if (!childLinksConsistent(graph)) throw new GraphInvariantError(`${what}: a containment child-link is inconsistent`);
  if (!noCycles(graph)) throw new GraphInvariantError(`${what}: the containment tree has a cycle`);
}

/** The set of node ids reachable under `rootId` (inclusive of rootId). */
function subtreeNodeIds(graph: MemkeeperGraph, rootId: NodeId): Set<NodeId> {
  const seen = new Set<NodeId>();
  const stack: NodeId[] = [rootId];
  while (stack.length > 0) {
    const id = stack.pop();
    if (id === undefined) break;
    if (seen.has(id)) continue;
    seen.add(id);
    const node = graph.nodes.get(id);
    if (node !== undefined) {
      for (const child of node.childNodeIds) stack.push(child);
    }
  }
  return seen;
}

/**
 * Recompute a node's timestamp range from all observations in its subtree.
 * A node with no observations keeps rangeStart === rangeEnd === createdAt.
 */
export function recomputeRange(graph: MemkeeperGraph, node: Node): void {
  let min: string | null = null;
  let max: string | null = null;
  for (const id of subtreeNodeIds(graph, node.id)) {
    const n = graph.nodes.get(id);
    if (n === undefined) continue;
    for (const obsId of n.observationIds) {
      const obs = graph.observations.get(obsId);
      if (obs === undefined) continue;
      if (min === null || obs.timestamp < min) min = obs.timestamp;
      if (max === null || obs.timestamp > max) max = obs.timestamp;
    }
  }
  node.timestamps.rangeStart = min ?? node.timestamps.createdAt;
  node.timestamps.rangeEnd = max ?? node.timestamps.createdAt;
}

/** Touch a node's updatedAt and recompute its range AND every ancestor's range
 *  (rangeStart/rangeEnd span a node's whole subtree, so an ancestor's range can
 *  change when a descendant's content moves). */
function touchAndRecompute(graph: MemkeeperGraph, node: Node): void {
  const now = currentTimestamp();
  let current: Node | undefined = node;
  while (current !== undefined) {
    current.timestamps.updatedAt = now;
    recomputeRange(graph, current);
    current = current.parentNode === null ? undefined : graph.nodes.get(current.parentNode);
  }
}

/**
 * Remove an emptied, dissolvable node and unlink it from its parent. Cascades
 * upward: a parent emptied by this removal is re-checked (a chain of emptied
 * containers collapses). nGoal and nIrrelevant are exempt and never dissolve.
 * Returns the ids removed and the surviving parents that lost a child (their
 * ranges need recompute).
 */
function dissolveEmptied(
  graph: MemkeeperGraph,
  candidates: NodeId[],
): { removed: Set<NodeId>; orphanedParents: Set<NodeId> } {
  const removed = new Set<NodeId>();
  const orphanedParents = new Set<NodeId>();
  const queue = [...candidates];
  while (queue.length > 0) {
    const id = queue.pop();
    if (id === undefined) continue;
    if (removed.has(id)) continue;
    const node = graph.nodes.get(id);
    if (node === undefined) continue;
    if (!dissolvable(node)) continue;
    // unlink from parent
    if (node.parentNode !== null) {
      const parent = graph.nodes.get(node.parentNode);
      if (parent !== undefined) {
        parent.childNodeIds = parent.childNodeIds.filter((c) => c !== id);
        orphanedParents.add(parent.id);
        queue.push(parent.id);
      }
    }
    graph.nodes.delete(id);
    removed.add(id);
  }
  return { removed, orphanedParents };
}

/** A stable "now" for timestamps (overridable via setClock in tests). */
function currentTimestamp(): string {
  return clockFn();
}
let clockFn: () => string = defaultClock;
function defaultClock(): string {
  return nowStoredTimestamp();
}
/** Override the timestamp source (tests). Pass null to restore the default. */
export function setClock(fn: (() => string) | null): void {
  clockFn = fn ?? defaultClock;
}

// --- mutators --------------------------------------------------------------

export function applyCreateNode(
  graph: MemkeeperGraph,
  args: {
    id: NodeId;
    summary: string;
    importance: Importance;
    parentNode: NodeId | null;
    state: Node["state"];
    /** Skip the trailing assertStructural when the caller asserts itself right
     *  after (e.g. applyMerge creates a new root then validates the whole merge).
     *  Default false — standalone mkdir keeps its check. */
    skipStructural?: boolean;
  },
): CreateNodeDelta {
  if (graph.nodes.has(args.id)) {
    throw new GraphInvariantError(`create_node: node ${args.id} already exists`);
  }
  if (args.parentNode !== null) requireNode(graph, args.parentNode, "create_node");
  const now = currentTimestamp();
  const node: Node = {
    id: args.id,
    summary: args.summary,
    summaryTokens: estimateContentTokens(args.summary),
    importance: args.importance,
    state: args.state,
    parentNode: args.parentNode,
    observationIds: [],
    childNodeIds: [],
    supersededBy: null,
    timestamps: { createdAt: now, updatedAt: now, rangeStart: now, rangeEnd: now },
  };
  graph.nodes.set(args.id, node);
  if (args.parentNode !== null) {
    const parent = graph.nodes.get(args.parentNode);
    if (parent !== undefined && !parent.childNodeIds.includes(args.id)) {
      parent.childNodeIds.push(args.id);
    }
  }
  if (graph.nextNodeId <= parseSeq(args.id)) graph.nextNodeId = parseSeq(args.id) + 1;
  if (args.skipStructural !== true) assertStructural(graph, "create_node");
  const { skipStructural: _omit, ...delta } = args;
  void _omit;
  return { ...delta, type: "create_node" };
}

export function applyRecordObservation(graph: MemkeeperGraph, args: { obs: Observation }): RecordObservationDelta {
  const obs = args.obs;
  const parent = requireNode(graph, obs.parentNode, "record_observation");
  if (graph.observations.has(obs.id)) {
    throw new GraphInvariantError(`record_observation: observation ${obs.id} already exists`);
  }
  graph.observations.set(obs.id, obs);
  if (!parent.observationIds.includes(obs.id)) parent.observationIds.push(obs.id);
  touchAndRecompute(graph, parent);
  if (graph.nextObsId <= parseSeq(obs.id)) graph.nextObsId = parseSeq(obs.id) + 1;
  assertStructural(graph, "record_observation");
  return { type: "record_observation", obs };
}

export function applyFlushNew(graph: MemkeeperGraph, args: { nodeIds: NodeId[] }): FlushNewDelta {
  for (const id of args.nodeIds) {
    const node = graph.nodes.get(id);
    if (node !== undefined && node.state === "new") {
      node.state = "active";
      node.timestamps.updatedAt = currentTimestamp();
    }
  }
  return { type: "flush_new", nodeIds: args.nodeIds };
}

export function applyMv(
  graph: MemkeeperGraph,
  args: { sourceIds: Array<ObsId | NodeId>; destId: NodeId | null; newSummary?: string },
  policy: MutationPolicy,
): MvDelta {
  const dest = args.destId === null ? null : requireNode(graph, args.destId, "mv");
  // validate + classify sources
  const obsSources: Observation[] = [];
  const nodeSources: Node[] = [];
  for (const id of args.sourceIds) {
    const obs = graph.observations.get(id as ObsId);
    if (obs !== undefined) {
      obsSources.push(obs);
      continue;
    }
    const node = graph.nodes.get(id as NodeId);
    if (node !== undefined) {
      nodeSources.push(node);
      continue;
    }
    throw new GraphInvariantError(`mv: source ${id} does not exist`);
  }
  if (args.destId === null && obsSources.length > 0) {
    throw new GraphInvariantError("mv: observations cannot be moved to the root");
  }
  if (policy === MUTATE_SOURCE) {
    if (nodeSources.some((n) => n.id === N_GOAL)) {
      throw new GraphInvariantError("mv: nGoal is immovable");
    }
    if (obsSources.some((o) => o.id === O_INITIAL_PROMPT)) {
      throw new GraphInvariantError("mv: oInitialPrompt cannot be detached from nGoal");
    }
  }
  // cycle check: dest must not lie within any moved node's subtree
  if (dest !== null) {
    for (const src of nodeSources) {
      if (subtreeNodeIds(graph, src.id).has(dest.id)) {
        throw new GraphInvariantError(`mv: moving ${src.id} under ${dest.id} would create a cycle`);
      }
    }
  }
  // apply: unlink from old parents, relink to dest
  const oldParents = new Set<NodeId>();
  for (const obs of obsSources) {
    if (dest === null) continue; // unreachable: observations-to-root were rejected above
    const oldParent = graph.nodes.get(obs.parentNode);
    if (oldParent !== undefined) {
      oldParent.observationIds = oldParent.observationIds.filter((o) => o !== obs.id);
      oldParents.add(oldParent.id);
    }
    obs.parentNode = dest.id;
  }
  for (const node of nodeSources) {
    if (node.parentNode !== null) {
      const oldParent = graph.nodes.get(node.parentNode);
      if (oldParent !== undefined) {
        oldParent.childNodeIds = oldParent.childNodeIds.filter((c) => c !== node.id);
        oldParents.add(oldParent.id);
      }
    }
    node.parentNode = dest === null ? null : dest.id;
  }
  if (dest !== null) {
    for (const obs of obsSources) {
      if (!dest.observationIds.includes(obs.id)) dest.observationIds.push(obs.id);
    }
    for (const node of nodeSources) {
      if (!dest.childNodeIds.includes(node.id)) dest.childNodeIds.push(node.id);
    }
    if (args.newSummary !== undefined) {
      dest.summary = args.newSummary;
      dest.summaryTokens = estimateContentTokens(args.newSummary);
    }
  }
  // dissolve emptied old parents, then recompute ranges on survivors + dest
  const dissolveResult = dissolveEmptied(graph, [...oldParents]);
  const recomputeIds = new Set<NodeId>([...oldParents, ...dissolveResult.orphanedParents]);
  if (dest !== null) recomputeIds.add(dest.id);
  for (const id of recomputeIds) {
    const n = graph.nodes.get(id);
    if (n !== undefined) touchAndRecompute(graph, n);
  }
  assertStructural(graph, "mv");
  return {
    type: "mv",
    sourceIds: args.sourceIds,
    destId: args.destId,
    ...(args.newSummary !== undefined ? { newSummary: args.newSummary } : {}),
  };
}

export function applyMerge(
  graph: MemkeeperGraph,
  args: {
    sourceIds: NodeId[];
    destId: NodeId | null;
    newSummary?: string;
    importance?: Importance;
    resolvedDestId?: NodeId;
  },
  policy: MutationPolicy,
): MergeDelta {
  if (args.destId === null && args.newSummary === undefined) {
    throw new GraphInvariantError("merge: newSummary is required when destId is null (names the new root node)");
  }
  if (args.destId === null && args.importance === undefined) {
    throw new GraphInvariantError("merge: importance is required when destId is null (rates the new root node)");
  }
  const sources = args.sourceIds.map((id) => requireNode(graph, id, "merge"));
  if (policy === MUTATE_SOURCE) {
    if (sources.some((n) => n.id === N_GOAL)) {
      throw new GraphInvariantError("merge: nGoal cannot be a merge source");
    }
    if (args.destId === N_GOAL) {
      // nGoal is a predefined root curated via set_meta + mv-in, never a fold target
      throw new GraphInvariantError("merge: nGoal cannot be a merge destination");
    }
  }
  // cycle pre-check (BEFORE creating any dest node, so a rejected call leaves
  // the graph unchanged): a source must not contain the destination. A brand-
  // new root destination (destId === null) is never an ancestor of anything, so
  // only the non-null case needs the subtree check.
  const existingDest = args.destId === null ? null : requireNode(graph, args.destId, "merge");
  for (const src of sources) {
    if (existingDest !== null) {
      if (src.id === existingDest.id) {
        throw new GraphInvariantError(`merge: source ${src.id} is the destination`);
      }
      if (subtreeNodeIds(graph, src.id).has(existingDest.id)) {
        throw new GraphInvariantError(`merge: source ${src.id} contains destination ${existingDest.id} (cycle)`);
      }
    }
  }
  // resolve or create the destination
  let dest: Node;
  if (args.destId === null) {
    const newId = args.resolvedDestId ?? (`n${graph.nextNodeId}` as NodeId);
    applyCreateNode(graph, {
      id: newId,
      summary: args.newSummary ?? "",
      importance: args.importance as Importance,
      parentNode: null,
      state: "active",
      skipStructural: true,
    });
    dest = requireNode(graph, newId, "merge");
  } else {
    dest = existingDest as Node;
  }
  const oldParents = new Set<NodeId>();
  for (const src of sources) {
    if (src.id === dest.id) continue;
    // relocate observations
    for (const obsId of [...src.observationIds]) {
      const obs = graph.observations.get(obsId);
      if (obs !== undefined) {
        obs.parentNode = dest.id;
        if (!dest.observationIds.includes(obsId)) dest.observationIds.push(obsId);
      }
    }
    // relocate children
    for (const childId of [...src.childNodeIds]) {
      const child = graph.nodes.get(childId);
      if (child !== undefined) {
        child.parentNode = dest.id;
        if (!dest.childNodeIds.includes(childId)) dest.childNodeIds.push(childId);
      }
    }
    src.observationIds = [];
    src.childNodeIds = [];
    if (src.parentNode !== null) oldParents.add(src.parentNode);
  }
  if (args.newSummary !== undefined) {
    dest.summary = args.newSummary;
    dest.summaryTokens = estimateContentTokens(args.newSummary);
  }
  // re-rate the destination when an importance was supplied (always, for a new
  // root; optionally, for an existing dest the caller chose to re-rate)
  if (args.importance !== undefined) {
    dest.importance = args.importance;
  }
  // dissolve the emptied sources + any emptied old parents
  const toDissolve = [...sources.filter((s) => s.id !== dest.id).map((s) => s.id), ...oldParents];
  const dissolveResult = dissolveEmptied(graph, toDissolve);
  const recomputeIds = new Set<NodeId>([dest.id, ...oldParents, ...dissolveResult.orphanedParents]);
  for (const id of recomputeIds) {
    const n = graph.nodes.get(id);
    if (n !== undefined) touchAndRecompute(graph, n);
  }
  assertStructural(graph, "merge");
  return {
    type: "merge",
    sourceIds: args.sourceIds,
    destId: args.destId,
    ...(args.newSummary !== undefined ? { newSummary: args.newSummary } : {}),
    ...(args.importance !== undefined ? { importance: args.importance } : {}),
    ...(args.destId === null ? { resolvedDestId: dest.id } : {}),
  };
}

export function applySupersede(
  graph: MemkeeperGraph,
  args: { nodeId: NodeId; supersededNodeIds: NodeId[] },
  policy: MutationPolicy,
): SupersedeDelta {
  const replacement = requireNode(graph, args.nodeId, "supersede");
  if (replacement.state === "obsolete") {
    throw new GraphInvariantError(`supersede: replacement ${args.nodeId} is itself obsolete`);
  }
  if (policy === MUTATE_SOURCE) {
    if (args.nodeId === N_GOAL || args.supersededNodeIds.includes(N_GOAL)) {
      throw new GraphInvariantError("supersede: nGoal cannot be superseded");
    }
  }
  for (const id of args.supersededNodeIds) {
    requireNode(graph, id, "supersede");
  }
  // supersession-cycle check: walking supersededBy from the replacement must not reach a target
  for (const target of args.supersededNodeIds) {
    let cursor: NodeId | null = replacement.id;
    const guard = new Set<NodeId>();
    while (cursor !== null) {
      if (cursor === target) {
        throw new GraphInvariantError(`supersede: ${target} would form a supersession cycle via ${replacement.id}`);
      }
      if (guard.has(cursor)) break;
      guard.add(cursor);
      const node = graph.nodes.get(cursor);
      cursor = node === undefined ? null : node.supersededBy;
    }
  }
  for (const id of args.supersededNodeIds) {
    const node = requireNode(graph, id, "supersede");
    node.state = "obsolete";
    node.supersededBy = replacement.id;
    node.timestamps.updatedAt = currentTimestamp();
  }
  assertStructural(graph, "supersede");
  return { type: "supersede", nodeId: args.nodeId, supersededNodeIds: args.supersededNodeIds };
}

export function applySetMeta(
  graph: MemkeeperGraph,
  args: {
    nodeId: NodeId;
    importance: Importance | null;
    archived: boolean | null;
    obsolete: boolean | null;
    summary: string | null;
  },
  policy: MutationPolicy,
): SetMetaDelta {
  const node = requireNode(graph, args.nodeId, "set_meta");
  if (args.obsolete === true) {
    throw new GraphInvariantError("set_meta: obsolete:true is not allowed (use supersede)");
  }
  if (policy === MUTATE_SOURCE && node.id === N_GOAL) {
    if (args.importance !== null || args.archived !== null || args.obsolete !== null) {
      throw new GraphInvariantError("set_meta: nGoal allows summary only");
    }
  }
  if (args.importance !== null) node.importance = args.importance;
  if (args.archived === true) {
    node.state = "archived";
    if (node.supersededBy !== null) node.supersededBy = null;
  }
  if (args.archived === false && node.state === "archived") node.state = "active";
  if (args.obsolete === false && node.state === "obsolete") {
    node.state = "active";
    node.supersededBy = null;
  }
  if (args.summary !== null) {
    node.summary = args.summary;
    node.summaryTokens = estimateContentTokens(args.summary);
  }
  node.timestamps.updatedAt = currentTimestamp();
  assertStructural(graph, "set_meta");
  return {
    type: "set_meta",
    nodeId: args.nodeId,
    importance: args.importance,
    archived: args.archived,
    obsolete: args.obsolete,
    summary: args.summary,
  };
}

/** Parse the numeric sequence suffix off an id (n12 -> 12); specials -> 0. */
function parseSeq(id: string): number {
  const match = id.match(/^[no](\d+)$/);
  return match ? Number(match[1]) : 0;
}
