// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import type { Node, NodeId, Observation, ObsId } from "../types.js";
import { MemkeeperGraph } from "../types.js";

/**
 * Produce a fully independent deep copy of a graph: every node and observation
 * is cloned (including nested arrays and the timestamps object), and the id
 * counters are copied. Mutating the returned graph never affects the source.
 *
 * The deep copy is structural — `structuredClone` would also work for these
 * plain data shapes, but an explicit clone keeps it free of prototype/`Map`
 * edge cases and documents the contract.
 */
export function cloneGraph(graph: MemkeeperGraph): MemkeeperGraph {
  const nodes = new Map<NodeId, Node>();
  for (const [id, node] of graph.nodes) {
    nodes.set(id, cloneNode(node));
  }
  const observations = new Map<ObsId, Observation>();
  for (const [id, obs] of graph.observations) {
    observations.set(id, cloneObservation(obs));
  }
  return new MemkeeperGraph({
    nodes,
    observations,
    nextObsId: graph.nextObsId,
    nextNodeId: graph.nextNodeId,
  });
}

function cloneNode(node: Node): Node {
  return {
    ...node,
    observationIds: [...node.observationIds],
    childNodeIds: [...node.childNodeIds],
    supersededBy: node.supersededBy,
    timestamps: { ...node.timestamps },
  };
}

function cloneObservation(obs: Observation): Observation {
  return {
    ...obs,
    sourceEntryIds: [...obs.sourceEntryIds],
  };
}
