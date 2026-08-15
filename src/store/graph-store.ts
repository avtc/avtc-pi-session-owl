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

import { clearDetailsCache, type EntryResolver } from "../format/details.js";
import {
  childLinksConsistent,
  everyObservationAttached,
  exactlyOneNodePerObservation,
  noCycles,
} from "../graph/invariants.js";
import { type GraphDelta, parseSeq, recomputeRange } from "../graph/mutations.js";
import { applyDelta } from "../graph/replay.js";
import { log } from "../log.js";
import {
  MemkeeperGraph,
  makeNode,
  type Node,
  type NodeId,
  nowStoredTimestamp,
  O_INITIAL_PROMPT,
  type Observation,
  type ObsId,
} from "../types.js";
import {
  cloneLedger,
  DETAILS_TYPE,
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
  RESCAN_TYPE,
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
 * Resolves source-entry ids to their session entries (for verbatim-source
 * details re-rendering). Loosely typed (`unknown`) so the store stays decoupled
 * from the pi `SessionEntry` shape; the details renderer narrows. Returns the
 * entries that exist (missing ids are dropped — graceful cross-branch drill).
 */

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
  /** Resolves source-entry ids to session entries for verbatim-source details
   *  re-rendering. `null` outside an active session (set at activate, refreshed
   *  on session_start, cleared on session_shutdown). */
  resolveEntries: EntryResolver | null;
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
      resolveEntries: null,
    };
  }
  return store;
}

/** Drop all in-memory state (`/new` starts a fresh graph). Also clears the
 *  per-observation details cache (entry ids + renders are per-session). */
export function resetForNewSession(): void {
  store = null;
  clearDetailsCache();
}

/** Install the session-entry resolver. Refreshed on every session_start (a
 *  ctx captured once goes stale across session changes) so recall always reads
 *  the active session's entries. */
export function setEntryResolver(resolver: EntryResolver): void {
  getGraphStore().resolveEntries = resolver;
}

/** Clear the session-entry resolver (session_shutdown) so recall never reads a
 *  dead session's manager. */
export function clearEntryResolver(): void {
  getGraphStore().resolveEntries = null;
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

/** `/mk:rescan`: void everything before now (persist a rescan marker) and reset
 *  the in-memory graph to empty (reseed nGoal on the next session_start /
 *  Observer run). The Observer frontier is cleared so the next trigger observes
 *  the entire branch from the first user message. The old entries stay in the
 *  session file (append-only) but load ignores them past the marker. */
export function resetGraphForRescan(ctx: StoreContext): void {
  ctx.appendEntry(RESCAN_TYPE, { at: nowStoredTimestamp() });
  const s = getGraphStore();
  s.graph = new MemkeeperGraph({
    nodes: new Map(),
    observations: new Map(),
    nextObsId: 1,
    nextNodeId: 1,
  });
  s.selectedTree = null;
  s.observerFrontier = null;
  s.usageLedger = cloneLedger(EMPTY_LEDGER);
  s.lastCompactionLedger = null;
}

// --- load (reconstruction) ------------------------------------------------

function isCustomEntry(e: StoreEntry): e is StoreCustomEntry {
  return e.type === "custom";
}

function isCompactionEntry(e: StoreEntry): e is StoreCompactionEntry {
  return e.type === "compaction";
}

/** Find the latest compaction entry whose details decode as MemkeeperDetails. */
function findLatestSnapshot(
  entries: StoreEntry[],
  rescanCutoff: number,
): { details: MemkeeperDetails; index: number } | null {
  for (let i = entries.length - 1; i > rescanCutoff; i -= 1) {
    const e = entries[i];
    if (e === undefined || !isCompactionEntry(e)) continue;
    const details = decodeDetails(e.details);
    if (details !== null) return { details, index: i };
    // Discriminate by the producer MARKER (`type`), not the generic `version`:
    // `details` is shared + last-writer-wins, so only a snapshot memkeeper itself
    // wrote (type === "memkeeper") that fails decode is genuine corruption (warn).
    // A foreign snapshot (another extension's compaction details, a native compaction,
    // or a future unknown producer) legitimately fails decode — expected when
    // switching extensions, so it stays debug-level (silent unless debugLog on)
    // instead of flooding the log on every load.
    const raw = e.details as { type?: unknown };
    if (raw.type === DETAILS_TYPE) {
      log.warn(`graph-store: corrupt memkeeper snapshot at ${e.id} — falling back to deltas-only`);
    } else {
      log.debug(`graph-store: non-memkeeper snapshot at ${e.id} — skipped`);
    }
  }
  return null;
}

/** The index of the latest `/mk:rescan` marker, or -1 when none. On load,
 *  everything at or before this index is void (the graph rebuilds from the
 *  marker forward). */
function findLatestRescanMarker(entries: StoreEntry[]): number {
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const e = entries[i];
    if (e !== undefined && isCustomEntry(e) && e.customType === RESCAN_TYPE) return i;
  }
  return -1;
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

/** Reconcile observation→node links after reconstruction. The node lists
 *  (snapshot ∘ post-snapshot deltas) are the AUTHORITY for membership: a
 *  persisted record's `parentNode` is capture-time only — an mv/merge that ran
 *  before the snapshot rewired the graph without rewriting the immutable
 *  record, so the record can name a wrapper that dissolved long ago.
 *  - a listing whose record never persisted is pruned (dead weight);
 *  - an observation listed under one node is repaired to that node (stale
 *    pointer or duplicate listing — the first listing wins);
 *  - an unlisted observation links into its record's parent when that node
 *    exists (post-snapshot capture, mid-pair repair); otherwise it is
 *    re-wrapped in a fresh deterministic root — the ledger is never pruned on
 *    load, so nothing captured is ever dropped.
 *  Each node whose evidence set changed has its range recomputed once. */
function reconcileLinks(graph: MemkeeperGraph): void {
  const touched = new Set<NodeId>();
  // Pass 1: prune phantom listings; collect the surviving listers per record.
  const listersOf = new Map<ObsId, NodeId[]>();
  for (const node of graph.nodes.values()) {
    let pruned = false;
    const kept: ObsId[] = [];
    for (const obsId of node.observationIds) {
      if (!graph.observations.has(obsId)) {
        pruned = true;
        continue;
      }
      kept.push(obsId);
      const listers = listersOf.get(obsId);
      if (listers === undefined) listersOf.set(obsId, [node.id]);
      else listers.push(node.id);
    }
    if (pruned) {
      node.observationIds = kept;
      touched.add(node.id);
    }
  }
  // Pass 2: every listed observation belongs to its first listing node —
  // repair the record's pointer and delist any duplicate.
  for (const [obsId, listers] of listersOf) {
    const keep = listers[0];
    if (keep === undefined) continue;
    for (const dup of listers.slice(1)) {
      const n = graph.nodes.get(dup);
      if (n !== undefined) {
        n.observationIds = n.observationIds.filter((id) => id !== obsId);
        touched.add(dup);
      }
    }
    const obs = graph.observations.get(obsId);
    if (obs !== undefined && obs.parentNode !== keep) {
      obs.parentNode = keep;
      touched.add(keep);
    }
  }
  // Pass 3: unlisted records. oInitialPrompt is nGoal's permanent seed — the
  // session-start seeding owns it when nGoal itself is absent (a fresh branch
  // recaptures the prompt), so it is never re-wrapped or dropped here.
  for (const [obsId, obs] of graph.observations) {
    if (listersOf.has(obsId)) continue;
    const parent = graph.nodes.get(obs.parentNode);
    if (parent !== undefined) {
      if (!parent.observationIds.includes(obsId)) parent.observationIds.push(obsId);
      touched.add(parent.id);
      continue;
    }
    if (obs.id === O_INITIAL_PROMPT) continue;
    const wrapper = rewrapOrphan(graph, obs);
    if (wrapper !== null) touched.add(wrapper);
  }
  for (const id of touched) {
    const n = graph.nodes.get(id);
    if (n !== undefined) recomputeRange(graph, n);
  }
}

/** Re-wrap an orphaned record in a fresh root node mirroring the Observer's
 *  capture pairing (`oK` under `nK`, `state:"new"`). Deterministic across
 *  loads — the id derives from the record id (or the id counter when that id
 *  is taken), so re-derivation mints the identical node. Returns the wrapper
 *  id, or null when the record id carries no numeric sequence (unrepresentable). */
function rewrapOrphan(graph: MemkeeperGraph, obs: Observation): NodeId | null {
  const seq = parseSeq(obs.id);
  if (seq <= 0) return null;
  const preferred = `n${seq}` as NodeId;
  const id = graph.nodes.has(preferred) ? (`n${graph.nextNodeId}` as NodeId) : preferred;
  graph.nodes.set(
    id,
    makeNode({
      id,
      summary: obs.summary,
      importance: obs.importance,
      state: "new",
      parentNode: null,
      observationIds: [obs.id],
      childNodeIds: [],
      supersededBy: null,
      createdAt: obs.timestamp,
      rangeStart: obs.timestamp,
      rangeEnd: obs.timestamp,
    }),
  );
  obs.parentNode = id;
  if (graph.nextNodeId <= parseSeq(id)) graph.nextNodeId = parseSeq(id) + 1;
  return id;
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

  // `/mk:rescan` voids everything at or before the latest marker — reconstruct
  // from the marker forward (empty graph, reseed nGoal).
  const rescanAt = findLatestRescanMarker(entries);

  // 1. find the latest valid snapshot AFTER the rescan marker (or start empty)
  const snapshot = findLatestSnapshot(entries, rescanAt);
  let graph: MemkeeperGraph;
  let replayFrom = rescanAt + 1;
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

  // 2. single pass over the branch (from the rescan marker forward): populate
  //    the observation content index (from EVERY observation entry — they are
  //    immutable + never pruned, so all contribute), replay nothing here, and
  //    pick up the latest-wins selected tree + usage ledger. Folding the
  //    selection/usage latest-wins into the observation pass avoids a second
  //    full-branch scan.
  for (let i = rescanAt + 1; i < entries.length; i += 1) {
    const e = entries[i];
    if (e === undefined || !isCustomEntry(e)) continue;
    if (e.customType === OBSERVATION_TYPE) {
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
    } else if (e.customType === SELECTION_TYPE) {
      const tree = decodeSelection(e.data);
      if (tree !== null) storeState.selectedTree = tree;
    } else if (e.customType === USAGE_TYPE) {
      const usage = decodeUsage((e.data as { ledger?: unknown } | undefined)?.ledger);
      if (usage !== null) storeState.usageLedger = usage;
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

  // 4. reconcile observation links (node lists are the authority; unlisted
  //    records link into their wrapper or are re-wrapped in a fresh root).
  reconcileLinks(graph);

  // 5. Guarantee the id counters are past every loaded node/observation id.
  //    The snapshot fields + graph_delta replay advance them in the common case,
  //    but a deltas-only load enters observation records directly into the map
  //    (not via a mutator), leaving nextObsId at the seed — a later Observer run
  //    would collide on a low id ("observation o1 already exists"). A skipped
  //    inapplicable graph_delta could likewise leave nextNodeId low. Recompute
  //    both from the loaded ids as a backstop (never lowers them).
  for (const id of graph.observations.keys()) {
    const seq = parseSeq(id);
    if (graph.nextObsId <= seq) graph.nextObsId = seq + 1;
  }
  for (const id of graph.nodes.keys()) {
    const seq = parseSeq(id);
    if (graph.nextNodeId <= seq) graph.nextNodeId = seq + 1;
  }

  storeState.graph = graph;

  // 6. Final whole-graph structural check. Per-delta assertStructural was
  //    skipped during replay (the graph is mid-rebuild there — an observation
  //    can reference a sibling node not yet created this batch); this catches a
  //    genuinely corrupt/truncated delta sequence. Structural invariants only
  //    (not nGoal/seed — those hold via seedNGoal). WARN, not throw (tolerant).
  const structurallyValid =
    everyObservationAttached(graph) &&
    exactlyOneNodePerObservation(graph) &&
    childLinksConsistent(graph) &&
    noCycles(graph);
  if (!structurallyValid) {
    log.warn("graph-store: reconstructed graph failed final structural validation");
  }
}
