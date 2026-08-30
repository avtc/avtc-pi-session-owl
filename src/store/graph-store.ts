// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// GraphStore: the single in-memory source of truth for the session-owl graph.
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
  SessionOwlGraph,
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
  type SessionOwlDetails,
  OBSERVATION_TYPE,
  type ObservationEntry,
  RESCAN_MODE_REUSE,
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
  graph: SessionOwlGraph;
  selectedTree: SerializedSelection | null;
  usageLedger: UsageLedger;
  /** The cumulative ledger captured at the last compaction (the /owl:status
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
      graph: new SessionOwlGraph({
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
  // advance the frontier to this batch's coversUpToId — FORWARD-ONLY: a
  // re-observe of a skipped (zero-observation) range appends a coversUpToId
  // that sits EARLIER on the branch than the current frontier; it must not
  // regress the pointer past already-observed entries (they would re-observe
  // and duplicate). Mirrors the in-memory cache refresh other persists do.
  const branch = ctx.getBranch(ctx.getLeafId());
  advanceFrontierForward(getGraphStore(), entry.coversUpToId, (id) => entryPosition(branch, id));
}

/** The entry's position on a branch (-1 = not present). */
function entryPosition(branch: StoreEntry[], id: string): number {
  return branch.findIndex((e) => e.id === id);
}

/** Advance `store.observerFrontier` to `coversUpToId` unless it resolves
 *  EARLIER on the branch than the current frontier (a skipped-range re-observe
 *  — hold the pointer). An unresolvable id keeps the legacy assign behavior
 *  (fresh appends' sources are always the newest entries; only repair appends
 *  target older ranges, and those always resolve). */
function advanceFrontierForward(
  store: { observerFrontier: string | null },
  coversUpToId: string,
  positionOf: (id: string) => number,
): void {
  const current = store.observerFrontier;
  if (current === coversUpToId) return;
  if (current !== null) {
    const newPos = positionOf(coversUpToId);
    if (newPos !== -1) {
      const curPos = positionOf(current);
      if (curPos !== -1 && newPos < curPos) return; // earlier on the branch — hold
    }
  }
  store.observerFrontier = coversUpToId;
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

/** `/owl:rescan`: void everything before now (persist a rescan marker) and reset
 *  the in-memory graph to empty (reseed nGoal on the next session_start /
 *  Observer run). The Observer frontier is cleared so the next trigger observes
 *  the entire branch from the first user message. The old entries stay in the
 *  session file (append-only) but load ignores them past the marker. */
export function resetGraphForRescan(ctx: StoreContext): void {
  ctx.appendEntry(RESCAN_TYPE, { at: nowStoredTimestamp() });
  const s = getGraphStore();
  s.graph = new SessionOwlGraph({
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

/** `/owl:rescan --reuse-observations`: void the STRUCTURE at/before now (persist
 *  a reuse-mode rescan marker) and reset the in-memory graph to empty structure,
 *  KEEPING the collected observation records (the ledger), the Observer
 *  frontier, and the usage ledger — the rebuild pipeline re-wraps the records
 *  into a fresh graph without re-running the Observer LLM. Old entries stay in
 *  the session file (append-only) but load ignores structure at/before the
 *  marker. */
export function resetGraphForReuse(ctx: StoreContext): void {
  ctx.appendEntry(RESCAN_TYPE, { at: nowStoredTimestamp(), mode: RESCAN_MODE_REUSE });
  const s = getGraphStore();
  s.graph = new SessionOwlGraph({
    nodes: new Map(),
    observations: s.graph.observations,
    nextObsId: s.graph.nextObsId,
    nextNodeId: 1,
  });
  s.selectedTree = null;
}

// --- load (reconstruction) ------------------------------------------------

function isCustomEntry(e: StoreEntry): e is StoreCustomEntry {
  return e.type === "custom";
}

function isCompactionEntry(e: StoreEntry): e is StoreCompactionEntry {
  return e.type === "compaction";
}

/** Find the latest compaction entry whose details decode as SessionOwlDetails. */
function findLatestSnapshot(
  entries: StoreEntry[],
  rescanCutoff: number,
): { details: SessionOwlDetails; index: number } | null {
  for (let i = entries.length - 1; i > rescanCutoff; i -= 1) {
    const e = entries[i];
    if (e === undefined || !isCompactionEntry(e)) continue;
    const details = decodeDetails(e.details);
    if (details !== null) return { details, index: i };
    // Discriminate by the producer MARKER (`type`), not the generic `version`:
    // `details` is shared + last-writer-wins, so only a snapshot session-owl itself
    // wrote (type === "session-owl") that fails decode is genuine corruption (warn).
    // A foreign snapshot (another extension's compaction details, a native compaction,
    // or a future unknown producer) legitimately fails decode — expected when
    // switching extensions, so it stays debug-level (silent unless debugLog on)
    // instead of flooding the log on every load.
    const raw = e.details as { type?: unknown };
    if (raw.type === DETAILS_TYPE) {
      log.warn(`graph-store: corrupt session-owl snapshot at ${e.id} — falling back to deltas-only`);
    } else {
      log.debug(`graph-store: non-session-owl snapshot at ${e.id} — skipped`);
    }
  }
  return null;
}

/** The index of the latest `/owl:rescan` markers. `structureAt` = the latest
 *  marker of ANY mode (structure at/before it is void: nodes, graph deltas,
 *  snapshots, selected tree). `plainAt` = the latest FULL marker (additionally
 *  voids the observation ledger + frontier at/before it). A reuse-mode marker
 *  (`/owl:rescan --reuse-observations`) voids structure only — the collected
 *  observation records survive it for the structure rebuild. */
function findLatestRescanMarkers(entries: StoreEntry[]): { plainAt: number; structureAt: number } {
  let plainAt = -1;
  let structureAt = -1;
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const e = entries[i];
    if (e === undefined || !isCustomEntry(e) || e.customType !== RESCAN_TYPE) continue;
    if (structureAt === -1) structureAt = i;
    const mode = (e.data as { mode?: unknown } | undefined)?.mode;
    if (mode !== RESCAN_MODE_REUSE) {
      plainAt = i;
      break;
    }
  }
  return { plainAt, structureAt };
}

/** Materialize the node graph + id counters + oInitialPrompt from a snapshot. */
function materializeBase(details: SessionOwlDetails): SessionOwlGraph {
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
  return new SessionOwlGraph({
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
 *  Each node whose evidence set changed has its range recomputed once.
 *  Returns the number of re-wrapped orphans (a corruption diagnostic). */
function reconcileLinks(graph: SessionOwlGraph): number {
  const touched = new Set<NodeId>();
  let rewrapped = 0;
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
    if (wrapper !== null) {
      touched.add(wrapper);
      rewrapped += 1;
    }
  }
  for (const id of touched) {
    const n = graph.nodes.get(id);
    if (n !== undefined) recomputeRange(graph, n);
  }
  return rewrapped;
}

/** Re-wrap an orphaned record in a fresh root node mirroring the Observer's
 *  capture pairing (`oK` under `nK`, `state:"new"`). Deterministic across
 *  loads — the id derives from the record id (or the id counter when that id
 *  is taken), so re-derivation mints the identical node. Returns the wrapper
 *  id, or null when the record id carries no numeric sequence (unrepresentable). */
function rewrapOrphan(graph: SessionOwlGraph, obs: Observation): NodeId | null {
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

/** Load outcome counters (diagnostics for the caller). A clean load of a
 *  complete op stream is all zeros; non-zero values mean a corrupt/truncated
 *  tail — surfaced once as a summary warn so the damage is visible, not silent. */
export interface LoadResult {
  /** graph deltas skipped as inapplicable (corrupt/truncated tail). */
  skippedDeltas: number;
  /** orphaned observation records re-wrapped in fresh roots by the
   *  reconciliation pass (their listing was lost to a skipped delta). */
  rewrappedOrphans: number;
}

/**
 * Reconstruct the in-memory graph from the active branch: latest snapshot +
 * chronological fold of the entries since. ONE pass in file order — the exact
 * op sequence the live pipeline executed (observation entries index records +
 * advance the frontier; graph_delta entries re-apply mutations; selection and
 * usage are latest-wins). Tolerant — a corrupt snapshot/delta is skipped,
 * never poisoning the session.
 */
export async function load(ctx: StoreContext): Promise<LoadResult> {
  const entries = ctx.getBranch(ctx.getLeafId());
  const storeState = getGraphStore();
  // reset the frontier — re-derived below from the replayed observation entries
  storeState.observerFrontier = null;
  // id → position over the branch: O(1) frontier advancement during replay
  const positionById = new Map<string, number>();
  for (let i = 0; i < entries.length; i += 1) positionById.set(entries[i].id, i);

  // `/owl:rescan` markers: the latest of ANY mode voids structure at/before it;
  //  the latest PLAIN marker additionally voids the observation ledger +
  //  frontier (a reuse-mode marker keeps them for the structure rebuild).
  const { plainAt, structureAt } = findLatestRescanMarkers(entries);

  // 1. find the latest valid snapshot AFTER the structure cutoff (or start empty)
  const snapshot = findLatestSnapshot(entries, structureAt);
  let graph: SessionOwlGraph;
  let replayFrom = structureAt + 1;
  if (snapshot !== null) {
    graph = materializeBase(snapshot.details);
    storeState.selectedTree = snapshot.details.selectedTree;
    storeState.usageLedger = cloneLedger(snapshot.details.lastCompactionLedger ?? EMPTY_LEDGER);
    storeState.lastCompactionLedger = snapshot.details.lastCompactionLedger ?? null;
    replayFrom = snapshot.index + 1;
  } else {
    graph = new SessionOwlGraph({
      nodes: new Map(),
      observations: new Map(),
      nextObsId: 1,
      nextNodeId: 1,
    });
  }

  // 2. ONE chronological pass over the ledger span (from the latest PLAIN marker
  //    forward), in file order = live op order: observation entries index their
  //    records (immutable, never pruned — all contribute) + advance the frontier;
  //    usage is latest-wins across the span; graph_delta entries re-apply their
  //    ops via the mutators — but ONLY from the snapshot forward (earlier deltas
  //    are already baked into the snapshot's node lists). Bad deltas are skipped
  //    (tolerant reader) and counted — the summary warn makes the loss visible.
  //    The selected tree is structure: latest-wins only AFTER the structure
  //    cutoff (a reuse marker voids earlier trees).
  let skippedDeltas = 0;
  for (let i = plainAt + 1; i < entries.length; i += 1) {
    const e = entries[i];
    if (e === undefined || !isCustomEntry(e)) continue;
    if (e.customType === OBSERVATION_TYPE) {
      const payload = e.data as ObservationEntry | undefined;
      if (payload === undefined) continue;
      if (typeof payload.coversUpToId === "string") {
        // forward-only (same rule as appendObservation): a repair entry appended
        // later in file order but covering an older range must not regress the
        // re-derived frontier past already-observed entries
        advanceFrontierForward(storeState, payload.coversUpToId, (id) => positionById.get(id) ?? -1);
      }
      if (!Array.isArray(payload.records)) continue;
      for (const rec of payload.records) {
        const obs = decodeObservation(rec);
        if (obs !== null) graph.observations.set(obs.id, obs);
      }
    } else if (e.customType === SELECTION_TYPE && i > structureAt) {
      const tree = decodeSelection(e.data);
      if (tree !== null) storeState.selectedTree = tree;
    } else if (e.customType === USAGE_TYPE) {
      const usage = decodeUsage((e.data as { ledger?: unknown } | undefined)?.ledger);
      if (usage !== null) storeState.usageLedger = usage;
    } else if (e.customType === GRAPH_DELTA_TYPE && i >= replayFrom) {
      const payload = e.data as GraphDeltaEntry | undefined;
      if (payload === undefined || payload.kind !== "graph_delta") continue;
      const batch = payload.deltas ?? (payload.delta !== undefined ? [payload.delta] : []);
      for (const delta of batch) {
        try {
          applyDelta(graph, delta, "source");
        } catch (err) {
          skippedDeltas += 1;
          // skip corrupt/inapplicable delta — reconstruction continues (logged)
          log.warn(`graph-store: skipping inapplicable graph_delta at ${e.id}: ${String(err)}`);
        }
      }
    }
  }

  // 3. reconcile observation links (node lists are the authority; unlisted
  //    records link into their wrapper or are re-wrapped in a fresh root).
  const rewrappedOrphans = reconcileLinks(graph);

  // 4. Guarantee the id counters are past every loaded node/observation id.
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

  // 5. Final whole-graph structural check. Per-delta assertStructural was
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
  if (skippedDeltas > 0 || rewrappedOrphans > 0) {
    log.warn(
      `graph-store: load skipped ${skippedDeltas} graph delta(s) and re-wrapped ${rewrappedOrphans} orphaned observation(s) — a corrupt/truncated tail; the affected structure rebuilds on the next Builder run`,
    );
  }
  return { skippedDeltas, rewrappedOrphans };
}
