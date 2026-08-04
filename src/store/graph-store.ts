// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// GraphStore: the single in-memory source of truth for the memkeeper graph.
// Holds the reconstructed graph, the persisted selected tree, the usage ledger,
// and the Observer frontier pointer. Persistence is append-only custom entries;
// reconstruction = last snapshot + fold deltas-since.
//
// The store is PERSIST-ONLY for appends: callers own in-memory mutation via the
// mutators (apply-then-persist), then call the store to record the delta. The
// store applies mutations ONLY during load() reconstruction (event-sourcing).

import { type GraphDelta, recomputeRange } from "../graph/mutations.js";
import { applyDelta } from "../graph/replay.js";
import { log } from "../log.js";
import { MemkeeperGraph, makeNode, type Node, type NodeId, type Observation, type ObsId } from "../types.js";
import {
  cloneLedger,
  decodeDetails,
  decodeObservation,
  decodeSelection,
  decodeUsage,
  EMPTY_LEDGER,
  GRAPH_DELTA_TYPE,
  type GraphDeltaEntry,
  type MemkeeperDetails,
  OBSERVATION_TYPE,
  type ObservationEntry,
  SELECTION_TYPE,
  type SerializedSelection,
  USAGE_TYPE,
  type UsageLedger,
} from "./codecs.js";

// --- StoreContext port (narrow, for DI/testability) ------------------------

/** A compaction entry as the store consumes it (pi CompactionEntry subset). */
export interface StoreCompactionEntry {
  type: "compaction";
  id: string;
  details?: unknown;
}

/** A custom entry as the store consumes it (pi CustomEntry subset). */
export interface StoreCustomEntry {
  type: "custom";
  id: string;
  customType: string;
  data?: unknown;
}

/** Any session entry the store reads during reconstruction. */
export type StoreEntry = StoreCompactionEntry | StoreCustomEntry;

/**
 * Narrow port over the pi ExtensionContext the store needs. Injected (not the
 * full context) so tests pass a fake. `getBranch` returns the active branch
 * path only (NOT `getEntries`, which mixes all branches).
 */
export interface StoreContext {
  /** Append a custom entry; returns void (pi API). */
  appendEntry: (customType: string, data: unknown) => void;
  /** The current leaf entry id (null at session start before any entry). */
  getLeafId: () => string | null;
  /** The active branch path entries (NOT all-branches `getEntries`). */
  getBranch: (leafId: string | null) => StoreEntry[];
}

// --- Store state -----------------------------------------------------------

/** The in-memory store: the reconstructed graph + cached projection state. */
export interface GraphStore {
  graph: MemkeeperGraph;
  selectedTree: SerializedSelection | null;
  usageLedger: UsageLedger;
  /** The cumulative ledger captured at the last compaction (the /mk:status
   *  "since last compaction" baseline). `null` until the first compaction on
   *  this branch — then since-last-compaction == since-session-start. */
  lastCompactionLedger: UsageLedger | null;
  /** coversUpToId of the latest replayed observation delta; null when none. */
  observerFrontier: string | null;
}

let store: GraphStore | null = null;

/** Access the module singleton (lazily created). */
export function getGraphStore(): GraphStore {
  if (store === null) {
    store = {
      graph: new MemkeeperGraph({
        nodes: new Map(),
        observations: new Map(),
        nextObsId: 1,
        nextNodeId: 1,
      }),
      selectedTree: null,
      usageLedger: cloneLedger(EMPTY_LEDGER),
      lastCompactionLedger: null,
      observerFrontier: null,
    };
  }
  return store;
}

/** Drop all in-memory state (`/new` starts a fresh graph). */
export function resetForNewSession(): void {
  store = null;
}

// --- persist (PERSIST-ONLY) ------------------------------------------------

/** Persist an observation batch. */
export function appendObservation(ctx: StoreContext, entry: ObservationEntry): void {
  ctx.appendEntry(OBSERVATION_TYPE, entry);
  // advance the frontier to this batch's coversUpToId (the Observer progress
  // pointer; mirrors the in-memory cache refresh persistSelectedTree/appendUsage do)
  getGraphStore().observerFrontier = entry.coversUpToId;
}

/** Persist a recorded graph delta (the caller already applied it in-memory). */
export function appendGraphDelta(ctx: StoreContext, delta: GraphDelta): void {
  const envelope: GraphDeltaEntry = { kind: "graph_delta", delta };
  ctx.appendEntry(GRAPH_DELTA_TYPE, envelope);
}

/** Persist a batch of recorded graph deltas in ONE entry (the caller already
 *  applied them in-memory) — e.g. an Observer run's wrapper create_node set.
 *  Reduces N per-delta writes to one on the background/compaction path. */
export function appendGraphDeltaBatch(ctx: StoreContext, deltas: GraphDelta[]): void {
  if (deltas.length === 0) return;
  const envelope: GraphDeltaEntry = { kind: "graph_delta", deltas };
  ctx.appendEntry(GRAPH_DELTA_TYPE, envelope);
}

/** Persist + hold the selected-tree snapshot. */
export function persistSelectedTree(ctx: StoreContext, snapshot: SerializedSelection): void {
  ctx.appendEntry(SELECTION_TYPE, snapshot);
  getGraphStore().selectedTree = snapshot;
}

/** Persist + hold the cumulative usage ledger. */
export function appendUsage(ctx: StoreContext, ledger: UsageLedger): void {
  ctx.appendEntry(USAGE_TYPE, { ledger });
  getGraphStore().usageLedger = ledger;
}

// --- load (reconstruction) ------------------------------------------------

function isCustomEntry(e: StoreEntry): e is StoreCustomEntry {
  return e.type === "custom";
}

function isCompactionEntry(e: StoreEntry): e is StoreCompactionEntry {
  return e.type === "compaction";
}

/** Find the latest compaction entry whose details decode as MemkeeperDetails. */
function findLatestSnapshot(entries: StoreEntry[]): { details: MemkeeperDetails; index: number } | null {
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const e = entries[i];
    if (e === undefined || !isCompactionEntry(e)) continue;
    const details = decodeDetails(e.details);
    if (details !== null) return { details, index: i };
    // Selective logging: a native/Pi compaction legitimately fails decodeDetails
    // (no `version` field) and must stay silent. A details that RESEMBLES a
    // memkeeper snapshot (has a `version`) but fails validation is a corrupt
    // snapshot worth surfacing — fall back to deltas-only + log.
    if (typeof e.details === "object" && e.details !== null && "version" in e.details) {
      log.warn(`graph-store: corrupt memkeeper snapshot at ${e.id} — falling back to deltas-only`);
    }
  }
  return null;
}

/** Materialize the node graph + id counters + oInitialPrompt from a snapshot. */
function materializeBase(details: MemkeeperDetails): MemkeeperGraph {
  const nodes = new Map<NodeId, Node>();
  const observations = new Map<ObsId, Observation>();
  for (const sn of details.nodes) {
    const node = makeNode({
      id: sn.id as NodeId,
      summary: sn.summary,
      importance: sn.importance,
      state: sn.state,
      parentNode: sn.parentNode === null ? null : (sn.parentNode as NodeId),
      observationIds: sn.observationIds as ObsId[],
      childNodeIds: sn.childNodeIds as NodeId[],
      supersededBy: sn.supersededBy === null ? null : (sn.supersededBy as NodeId),
      createdAt: sn.timestamps.createdAt,
      rangeStart: sn.timestamps.rangeStart,
      rangeEnd: sn.timestamps.rangeEnd,
    });
    // Honor the snapshot's cached summaryTokens (recomputed by makeNode; matches).
    nodes.set(node.id, node);
  }
  if (details.oInitialPrompt !== null) {
    const obs = decodeObservation(details.oInitialPrompt);
    if (obs !== null) observations.set(obs.id, obs);
  }
  return new MemkeeperGraph({
    nodes,
    observations,
    nextObsId: details.nextObsId,
    nextNodeId: details.nextNodeId,
  });
}

/** Reconcile observation→node links; drop obs whose parent node is gone. */
function reconcileLinks(graph: MemkeeperGraph): void {
  // Collect the parents whose observation set grew (a newly-linked post-snapshot
  // obs extends its time range) and recompute each parent's range ONCE — not
  // once per newly-linked obs (recomputeRange re-scans the parent's evidence, so
  // K new obs under one parent would otherwise trigger K identical subtree walks).
  // Build a per-parent existing-obs Set once so the membership check is O(1)
  // (a `.includes` per obs would be O(K) → O(K²) over a parent's evidence).
  const existing = new Map<string, Set<string>>();
  for (const node of graph.nodes.values()) {
    if (node.observationIds.length > 0) existing.set(node.id, new Set(node.observationIds));
  }
  const touchedParents = new Set<string>();
  for (const [obsId, obs] of graph.observations) {
    const parent = graph.nodes.get(obs.parentNode);
    if (parent === undefined) {
      // Parent node was dissolved/never created — drop the orphaned obs from the
      // in-memory graph (persisted record survives for a future repair). Keeps
      // the graph invariant-satisfiable.
      graph.observations.delete(obsId);
      continue;
    }
    const have = existing.get(parent.id);
    if (have === undefined || !have.has(obsId)) {
      parent.observationIds.push(obsId);
      have?.add(obsId);
      touchedParents.add(parent.id);
    }
  }
  for (const parentId of touchedParents) {
    const parent = graph.nodes.get(parentId as NodeId);
    if (parent !== undefined) recomputeRange(graph, parent);
  }
}

/**
 * Reconstruct the in-memory graph from the active branch: latest snapshot +
 * folded deltas-since. Tolerant — a corrupt snapshot/delta is skipped,
 * never poisoning the session.
 */
export async function load(ctx: StoreContext): Promise<void> {
  const entries = ctx.getBranch(ctx.getLeafId());
  const storeState = getGraphStore();
  // reset the frontier — re-derived below from the replayed observation entries
  storeState.observerFrontier = null;

  // 1. find the latest valid snapshot (or start empty)
  const snapshot = findLatestSnapshot(entries);
  let graph: MemkeeperGraph;
  let replayFrom = 0;
  if (snapshot !== null) {
    graph = materializeBase(snapshot.details);
    storeState.selectedTree = snapshot.details.selectedTree;
    storeState.usageLedger = cloneLedger(snapshot.details.lastCompactionLedger ?? EMPTY_LEDGER);
    storeState.lastCompactionLedger = snapshot.details.lastCompactionLedger ?? null;
    replayFrom = snapshot.index + 1;
  } else {
    graph = new MemkeeperGraph({
      nodes: new Map(),
      observations: new Map(),
      nextObsId: 1,
      nextNodeId: 1,
    });
  }

  // 2. populate the observation content index from EVERY observation entry
  //    (observations are immutable + never pruned, so all entries contribute).
  for (const e of entries) {
    if (!isCustomEntry(e) || e.customType !== OBSERVATION_TYPE) continue;
    const payload = e.data as ObservationEntry | undefined;
    if (payload === undefined) continue;
    if (typeof payload.coversUpToId === "string") {
      storeState.observerFrontier = payload.coversUpToId;
    }
    if (!Array.isArray(payload.records)) continue;
    for (const rec of payload.records) {
      const obs = decodeObservation(rec);
      if (obs !== null) graph.observations.set(obs.id, obs);
    }
  }

  // 3. replay post-snapshot graph deltas (structural mutations) via the mutators.
  //    Bad deltas are skipped (tolerant reader).
  for (let i = replayFrom; i < entries.length; i += 1) {
    const e = entries[i];
    if (e === undefined || !isCustomEntry(e) || e.customType !== GRAPH_DELTA_TYPE) continue;
    const payload = e.data as GraphDeltaEntry | undefined;
    if (payload === undefined || payload.kind !== "graph_delta") continue;
    const batch = payload.deltas ?? (payload.delta !== undefined ? [payload.delta] : []);
    for (const delta of batch) {
      try {
        applyDelta(graph, delta, "source");
      } catch (err) {
        // skip corrupt/inapplicable delta — reconstruction continues (logged)
        log.warn(`graph-store: skipping inapplicable graph_delta at ${e.id}: ${String(err)}`);
      }
    }
  }

  // 4. reconcile observation links (post-snapshot obs → their wrapper nodes).
  reconcileLinks(graph);

  // 5. latest selected tree + usage ledger win over the snapshot baseline.
  for (const e of entries) {
    if (!isCustomEntry(e)) continue;
    if (e.customType === SELECTION_TYPE) {
      const tree = decodeSelection(e.data);
      if (tree !== null) storeState.selectedTree = tree;
    } else if (e.customType === USAGE_TYPE) {
      const usage = decodeUsage((e.data as { ledger?: unknown } | undefined)?.ledger);
      if (usage !== null) storeState.usageLedger = usage;
    }
  }

  storeState.graph = graph;
}
