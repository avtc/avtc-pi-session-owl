// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// Replay dispatcher: apply a serialized `GraphDelta` to an in-memory graph by
// delegating to the mutators. Used by GraphStore.load() to fold append-only
// deltas onto the compaction snapshot (event-sourcing).
//
// The mutators re-validate each op live; a corrupt/foreign-id delta
// throws `GraphInvariantError`, which the store's replay loop catches and skips
// (tolerant reader). This module is a thin dispatcher — it owns no state
// and adds no mutation logic of its own.

import type { MemkeeperGraph } from "../types.js";
import { GraphInvariantError } from "./invariants.js";
import type { MutationPolicy } from "./mutations.js";
import {
  applyCreateNode,
  applyFlushNew,
  applyMerge,
  applyMv,
  applyRecordObservation,
  applySetMeta,
  applySupersede,
  type GraphDelta,
} from "./mutations.js";

/**
 * Apply one recorded delta to the graph via the corresponding mutator.
 * Throws `GraphInvariantError` on a bad delta (caller decides skip/abort).
 */
export function applyDelta(graph: MemkeeperGraph, delta: GraphDelta, policy: MutationPolicy): void {
  switch (delta.type) {
    case "create_node":
      applyCreateNode(graph, {
        id: delta.id,
        summary: delta.summary,
        importance: delta.importance,
        parentNode: delta.parentNode,
        state: delta.state,
      });
      return;
    case "record_observation":
      applyRecordObservation(graph, { obs: delta.obs });
      return;
    case "mv":
      applyMv(graph, { sourceIds: delta.sourceIds, destId: delta.destId, newSummary: delta.newSummary }, policy);
      return;
    case "merge":
      applyMerge(graph, { sourceIds: delta.sourceIds, destId: delta.destId, newSummary: delta.newSummary }, policy);
      return;
    case "supersede":
      applySupersede(graph, { nodeId: delta.nodeId, supersededNodeIds: delta.supersededNodeIds }, policy);
      return;
    case "set_meta":
      applySetMeta(
        graph,
        {
          nodeId: delta.nodeId,
          importance: delta.importance,
          archived: delta.archived,
          obsolete: delta.obsolete,
          summary: delta.summary,
        },
        policy,
      );
      return;
    case "flush_new":
      applyFlushNew(graph, { nodeIds: delta.nodeIds });
      return;
    default:
      // Exhaustiveness guard: an unknown delta type is a corrupt entry.
      throw new GraphInvariantError(`applyDelta: unknown delta type ${String((delta as { type: string }).type)}`);
  }
}
