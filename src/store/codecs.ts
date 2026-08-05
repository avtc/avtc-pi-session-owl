// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// Custom-entry codecs: encode/decode the four `memkeeper.*` custom-entry
// payloads + the `MemkeeperDetails` compaction-entry details snapshot.
//
// Tolerant-reader contract: decoders return `null` on any
// malformed input rather than throwing — a single bad entry/details is skipped,
// never poisoning the session. Unknown additive fields are ignored (forward-
// compatible). `summaryTokens`/`summaryTokens` are recomputed on decode (never
// trusted from the wire).

import type { GraphDelta } from "../graph/mutations.js";
import {
  IMPORTANCE_VALUES,
  type Importance,
  type MemkeeperGraph,
  makeNode,
  makeObservation,
  NODE_STATE_VALUES,
  type Node,
  type NodeId,
  type NodeState,
  O_INITIAL_PROMPT,
  type Observation,
  type ObsId,
} from "../types.js";

// --- customType names -----------------------------------------------------

export const OBSERVATION_TYPE = "memkeeper.observation";
export const GRAPH_DELTA_TYPE = "memkeeper.graph_delta";
export const SELECTION_TYPE = "memkeeper.selection";
export const USAGE_TYPE = "memkeeper.usage";

/** Current snapshot schema version (additive fields don't bump). */
export const DETAILS_VERSION = "v1";

// --- usage ledger ---------------------------------------------------------

export interface PhaseUsage {
  input: number;
  output: number;
  cacheRead: number;
  cost: number;
  turns: number;
  runs: number;
}

export interface UsageLedger {
  observe: PhaseUsage;
  build: PhaseUsage;
  select: PhaseUsage;
}

export const EMPTY_PHASE_USAGE: PhaseUsage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cost: 0,
  turns: 0,
  runs: 0,
};

export const EMPTY_LEDGER: UsageLedger = {
  observe: { ...EMPTY_PHASE_USAGE },
  build: { ...EMPTY_PHASE_USAGE },
  select: { ...EMPTY_PHASE_USAGE },
};

/** A deep copy of a ledger — three independent phase objects. `{ ...EMPTY_LEDGER }`
 *  is a shallow copy whose phases alias `EMPTY_LEDGER`'s, so mutating one phase
 *  via the shared reference corrupts the others. Use this whenever a fresh,
 *  independently-mutable ledger is needed (store init, load fallback, tests). */
export function cloneLedger(ledger: UsageLedger): UsageLedger {
  return {
    observe: { ...ledger.observe },
    build: { ...ledger.build },
    select: { ...ledger.select },
  };
}

// --- serialized wire types -------------------------------------------------

/** Wire observation: summary + provenance + parentNode; NO summaryTokens/detailsLines/detailsTokens (recomputed on decode). */
export interface SerializedObservation {
  id: string;
  summary: string;
  /** Verbatim-source size hint, frozen at capture (additive — legacy snapshots
   *  predate this; decodeObservation falls back to a summary-derived estimate).
   *  summaryTokens is NOT stored (recomputed on decode). */
  detailsLines?: number;
  detailsTokens?: number;
  importance: Importance;
  sourceEntryIds: string[];
  timestamp: string;
  parentNode: string;
}

/** Wire node: full in-memory shape, structure-only (no observation content). */
export interface SerializedNode {
  id: string;
  summary: string;
  summaryTokens: number;
  state: NodeState;
  importance: Importance;
  parentNode: string | null;
  observationIds: string[];
  childNodeIds: string[];
  supersededBy: string | null;
  timestamps: {
    createdAt: string;
    updatedAt: string;
    rangeStart: string;
    rangeEnd: string;
  };
}

/**
 * Self-contained selected-tree snapshot: nodes are deep-copied
 * (own summaries/structure so a later Builder mutate can't dangle them);
 * observations are id refs (content is immutable, never dangles); `oInitialPrompt`
 * is carried verbatim because it is special and rendered directly.
 */
export interface SerializedSelection {
  nodes: SerializedNode[];
  oInitialPrompt: SerializedObservation | null;
  obsRefs: string[];
  /** The observer frontier (`coversUpToId`) at tree-build time — the staleness
   *  check compares it to the current frontier: equal = no new observations
   *  since build (tree is current); different = new observations (rebuild).
   *  Additive optional (legacy snapshots lack it → null → stale → rebuild). */
  coveredFrontier: string | null;
  nextObsId: number;
  nextNodeId: number;
}

// --- custom-entry payloads -------------------------------------------------

/** `memkeeper.observation` — a batch from one Observer run. */
export interface ObservationEntry {
  coversFromId: string | null;
  coversUpToId: string;
  records: SerializedObservation[];
  tokenCount: number;
}

/** `memkeeper.graph_delta` — one or more applied mutates (envelope over
 *  GraphDelta(s)). Singular `delta` is a Builder per-mutate entry; `deltas`
 *  (array) is an Observer wrapper batch (additive; tolerant-reader safe). */
export interface GraphDeltaEntry {
  kind: "graph_delta";
  /** One applied mutate (Builder per-mutate entry). */
  delta?: GraphDelta;
  /** A batch of applied mutates (Observer wrapper batch). */
  deltas?: GraphDelta[];
}

/** `memkeeper.selection` — the Selector's selected-tree snapshot. */
export interface SelectionEntry extends SerializedSelection {}

/** `memkeeper.usage` — the cumulative usage ledger. */
export interface UsageEntry {
  ledger: UsageLedger;
}

// --- compaction details (NOT a custom entry) -------------------------------

/**
 * `CompactionEntry.details` payload: a materialized node-graph
 * snapshot — structure + cached token counts + id counters + observation-id refs,
 * NOT observation content. Carries the last selected tree + usage baseline.
 */
export interface MemkeeperDetails {
  version: string;
  nodes: SerializedNode[];
  oInitialPrompt: SerializedObservation | null;
  nextObsId: number;
  nextNodeId: number;
  selectedTree: SerializedSelection | null;
  lastCompactionLedger: UsageLedger | null;
}

// --- decoders (tolerant) ---------------------------------------------------

const IMPORTANCE_SET = new Set<string>(IMPORTANCE_VALUES);
const STATE_SET = new Set<string>(NODE_STATE_VALUES);

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

function isImportance(v: unknown): v is Importance {
  return typeof v === "string" && IMPORTANCE_SET.has(v);
}

function isState(v: unknown): v is NodeState {
  return typeof v === "string" && STATE_SET.has(v);
}

/** Decode a serialized observation; recompute summaryTokens/details. Null if malformed.
 *  Tolerant-reader: accepts both `summary` (current) and `content` (legacy wire
 *  form) — old pre-rename entries persist (no-prune) and must still decode. */
export function decodeObservation(raw: unknown): Observation | null {
  if (!isObject(raw)) return null;
  const { id, summary, content, importance, sourceEntryIds, timestamp, parentNode } = raw;
  const text = typeof summary === "string" ? summary : content;
  if (
    typeof id !== "string" ||
    typeof text !== "string" ||
    !isImportance(importance) ||
    !Array.isArray(sourceEntryIds) ||
    sourceEntryIds.some((s) => typeof s !== "string") ||
    typeof timestamp !== "string" ||
    typeof parentNode !== "string"
  ) {
    return null;
  }
  // detailsLines/detailsTokens/summaryTokens are additive (tolerant reader):
  // legacy snapshots lack them; makeObservation's summary-derived fallback fills
  // the details hints and recomputes summaryTokens when they are absent.
  return makeObservation({
    id: id as ObsId,
    summary: text,
    importance,
    sourceEntryIds: sourceEntryIds as string[],
    timestamp,
    parentNode: parentNode as NodeId,
    detailsLines: typeof raw.detailsLines === "number" ? raw.detailsLines : undefined,
    detailsTokens: typeof raw.detailsTokens === "number" ? raw.detailsTokens : undefined,
  });
}

/** Decode a serialized node; recompute summaryTokens from the summary. */
export function decodeNode(raw: unknown): Node | null {
  if (!isObject(raw)) return null;
  const ts = raw.timestamps;
  if (!isObject(ts)) return null;
  const { createdAt, updatedAt, rangeStart, rangeEnd } = ts;
  const obsIds = raw.observationIds;
  const childIds = raw.childNodeIds;
  if (
    typeof raw.id !== "string" ||
    typeof raw.summary !== "string" ||
    !isState(raw.state) ||
    !isImportance(raw.importance) ||
    (raw.parentNode !== null && typeof raw.parentNode !== "string") ||
    !Array.isArray(obsIds) ||
    obsIds.some((s) => typeof s !== "string") ||
    !Array.isArray(childIds) ||
    childIds.some((s) => typeof s !== "string") ||
    (raw.supersededBy !== null && typeof raw.supersededBy !== "string") ||
    typeof createdAt !== "string" ||
    typeof updatedAt !== "string" ||
    typeof rangeStart !== "string" ||
    typeof rangeEnd !== "string"
  ) {
    return null;
  }
  const summary = raw.summary;
  return makeNode({
    id: raw.id as NodeId,
    summary,
    importance: raw.importance,
    state: raw.state,
    parentNode: raw.parentNode === null ? null : (raw.parentNode as NodeId),
    observationIds: obsIds as ObsId[],
    childNodeIds: childIds as NodeId[],
    supersededBy: raw.supersededBy === null ? null : (raw.supersededBy as NodeId),
    createdAt,
    rangeStart,
    rangeEnd,
  });
}

/**
 * Decode + revalidate a wire node into the canonical SerializedNode form.
 * Returns null if the node is malformed (bad state/importance/timestamps).
 * Shared by `decodeSelection` and `decodeDetails` so neither blind-casts.
 */
function decodeSerializedNode(raw: unknown): SerializedNode | null {
  const decoded = decodeNode(raw);
  if (decoded === null) return null;
  return {
    id: decoded.id,
    summary: decoded.summary,
    summaryTokens: decoded.summaryTokens,
    state: decoded.state,
    importance: decoded.importance,
    parentNode: decoded.parentNode,
    observationIds: decoded.observationIds,
    childNodeIds: decoded.childNodeIds,
    supersededBy: decoded.supersededBy,
    timestamps: decoded.timestamps,
  };
}

/** Decode a node array + the optional oInitialPrompt verbatim obs. */
function decodeNodesAndPrompt(
  nodes: unknown,
  oInitialPrompt: unknown,
): { nodes: SerializedNode[]; oInitialPrompt: SerializedObservation | null } | null {
  if (!Array.isArray(nodes)) return null;
  const decodedNodes: SerializedNode[] = [];
  for (const n of nodes) {
    const decoded = decodeSerializedNode(n);
    if (decoded === null) return null;
    decodedNodes.push(decoded);
  }
  let prompt: SerializedObservation | null = null;
  if (oInitialPrompt !== null && oInitialPrompt !== undefined) {
    prompt = decodeObservation(oInitialPrompt);
    if (prompt === null) return null;
  }
  return { nodes: decodedNodes, oInitialPrompt: prompt };
}

/** Decode a selected-tree snapshot; null if malformed. */
export function decodeSelection(raw: unknown): SerializedSelection | null {
  if (!isObject(raw)) return null;
  const { nodes, oInitialPrompt, obsRefs, coveredFrontier, nextObsId, nextNodeId } = raw;
  if (
    !Array.isArray(nodes) ||
    !Array.isArray(obsRefs) ||
    obsRefs.some((s) => typeof s !== "string") ||
    (coveredFrontier !== null && coveredFrontier !== undefined && typeof coveredFrontier !== "string") ||
    typeof nextObsId !== "number" ||
    typeof nextNodeId !== "number"
  ) {
    return null;
  }
  const base = decodeNodesAndPrompt(nodes, oInitialPrompt);
  if (base === null) return null;
  return {
    nodes: base.nodes,
    oInitialPrompt: base.oInitialPrompt,
    obsRefs: obsRefs as string[],
    coveredFrontier: typeof coveredFrontier === "string" ? coveredFrontier : null,
    nextObsId,
    nextNodeId,
  };
}

function isPhaseUsage(v: unknown): v is PhaseUsage {
  if (!isObject(v)) return false;
  // `runs` is the current field; `passes` is the legacy name (older persisted
  // ledgers) — accept either (tolerant reader, additive rename).
  const runs = v.runs ?? v.passes;
  const { input, output, cacheRead, cost, turns } = v;
  return (
    typeof input === "number" &&
    typeof output === "number" &&
    typeof cacheRead === "number" &&
    typeof cost === "number" &&
    typeof turns === "number" &&
    typeof runs === "number"
  );
}

/** Decode a cumulative usage ledger; null if malformed. */
export function decodeUsage(raw: unknown): UsageLedger | null {
  if (!isObject(raw)) return null;
  const { observe, build, select } = raw;
  if (!isPhaseUsage(observe) || !isPhaseUsage(build) || !isPhaseUsage(select)) return null;
  // normalize: emit `runs` from either the current field or the legacy `passes`
  // name (older persisted ledgers), constructing fresh PhaseUsage objects.
  return { observe: normalizePhase(observe), build: normalizePhase(build), select: normalizePhase(select) };
}

/** Build a fresh PhaseUsage from a decoded phase, normalizing the run counter
 *  field name (current `runs`, legacy `passes`). */
function normalizePhase(p: PhaseUsage): PhaseUsage {
  const NO_RUNS = 0;
  const runs = (p as { runs?: number; passes?: number }).runs ?? (p as { passes?: number }).passes ?? NO_RUNS;
  return { input: p.input, output: p.output, cacheRead: p.cacheRead, cost: p.cost, turns: p.turns, runs };
}

/** Known MemkeeperDetails schema versions (tolerant reader rejects others). */
const KNOWN_DETAILS_VERSIONS = new Set<string>([DETAILS_VERSION]);

/** Decode compaction details; null if malformed/non-memkeeper (native rejected).
 *  A KNOWN version is required: additive field changes do NOT bump the version
 *  (they're handled by the per-delta optional-field coalescing in `load`), so a
 *  bumped version signals a breaking schema change we cannot safely migrate at
 *  read. Returning null makes `load` fall back to deltas-only reconstruction
 *  (lossless for the graph + counters; the lastCompactionLedger baseline is
 *  lost until the next compaction re-captures it — cosmetic, /mk:status only).
 *  The drop is logged by `findLatestSnapshot` when the details carries a
 *  `version` field. */
export function decodeDetails(raw: unknown): MemkeeperDetails | null {
  if (!isObject(raw)) return null;
  const { version, nodes, oInitialPrompt, nextObsId, nextNodeId, selectedTree, lastCompactionLedger } = raw;
  if (
    typeof version !== "string" ||
    !KNOWN_DETAILS_VERSIONS.has(version) ||
    !Array.isArray(nodes) ||
    typeof nextObsId !== "number" ||
    typeof nextNodeId !== "number"
  ) {
    return null;
  }
  const base = decodeNodesAndPrompt(nodes, oInitialPrompt);
  if (base === null) return null;
  let tree: SerializedSelection | null = null;
  if (selectedTree !== null && selectedTree !== undefined) {
    tree = decodeSelection(selectedTree);
    if (tree === null) return null;
  }
  let ledger: UsageLedger | null = null;
  if (lastCompactionLedger !== null && lastCompactionLedger !== undefined) {
    ledger = decodeUsage(lastCompactionLedger);
    if (ledger === null) return null;
  }
  return {
    version,
    nodes: base.nodes,
    oInitialPrompt: base.oInitialPrompt,
    nextObsId,
    nextNodeId,
    selectedTree: tree,
    lastCompactionLedger: ledger,
  };
}

// --- encoders (in-memory -> wire) ------------------------------------------

/** Encode an observation to its wire form (drops summaryTokens/detailsLines/detailsTokens). */
export function encodeObservation(obs: Observation): SerializedObservation {
  return {
    id: obs.id,
    summary: obs.summary,
    // summaryTokens is recomputed on decode (cheap, summary-derived) — NOT stored.
    // detailsLines/detailsTokens CAN'T be recomputed on decode (they need the
    // verbatim source render over session entries the snapshot doesn't carry),
    // so they ARE stored for faithful snapshot size hints.
    detailsLines: obs.detailsLines,
    detailsTokens: obs.detailsTokens,
    importance: obs.importance,
    sourceEntryIds: [...obs.sourceEntryIds],
    timestamp: obs.timestamp,
    parentNode: obs.parentNode,
  };
}

/** Encode a node to its wire form. */
export function encodeNode(node: Node): SerializedNode {
  return {
    id: node.id,
    summary: node.summary,
    summaryTokens: node.summaryTokens,
    state: node.state,
    importance: node.importance,
    parentNode: node.parentNode,
    observationIds: [...node.observationIds],
    childNodeIds: [...node.childNodeIds],
    supersededBy: node.supersededBy,
    timestamps: { ...node.timestamps },
  };
}

/**
 * Encode the selected-tree snapshot from a working graph. Nodes are deep-copied;
 * observations become id refs (content stays in the immutable observation store);
 * `oInitialPrompt` is carried verbatim.
 */
export function encodeSelection(
  graph: MemkeeperGraph,
  oInitialPrompt: ObsId | null,
  coveredFrontier: string | null,
): SerializedSelection {
  const nodes: SerializedNode[] = [];
  const obsRefs: string[] = [];
  const seen = new Set<string>();
  for (const node of graph.nodes.values()) {
    nodes.push(encodeNode(node));
    for (const obsId of node.observationIds) {
      if (!seen.has(obsId)) {
        seen.add(obsId);
        obsRefs.push(obsId);
      }
    }
  }
  let prompt: SerializedObservation | null = null;
  if (oInitialPrompt !== null) {
    const promptObs = graph.observations.get(oInitialPrompt);
    if (promptObs !== undefined) {
      prompt = encodeObservation(promptObs);
    }
  }
  return {
    nodes,
    oInitialPrompt: prompt,
    obsRefs,
    coveredFrontier,
    nextObsId: graph.nextObsId,
    nextNodeId: graph.nextNodeId,
  };
}

/** Encode compaction details from the in-memory graph + optional baseline state. */
export function encodeDetails(
  graph: MemkeeperGraph,
  selectedTree: SerializedSelection | null,
  lastCompactionLedger: UsageLedger | null,
): MemkeeperDetails {
  const nodes: SerializedNode[] = [];
  for (const node of graph.nodes.values()) {
    nodes.push(encodeNode(node));
  }
  const promptObs = graph.observations.get(O_INITIAL_PROMPT);
  return {
    version: DETAILS_VERSION,
    nodes,
    oInitialPrompt: promptObs === undefined ? null : encodeObservation(promptObs),
    nextObsId: graph.nextObsId,
    nextNodeId: graph.nextNodeId,
    selectedTree,
    lastCompactionLedger,
  };
}
