// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// In-memory domain model for the memory graph: plain types + a graph container.
// No I/O, no singletons, no mutations here (the mutation layer owns those).

/** Chars-per-token estimate (chars/4), memkeeper's own heuristic. */
export const CHARS_PER_TOKEN_ESTIMATE = 4;

/** Root-parent sentinel: a node whose `parentNode` is null lives at the tree root. */
export const ROOT_PARENT = null;

// --- Fixed special ids -----------------------------------------------------

/** The predefined goal node (source-graph special; immovable, never empty). */
export const N_GOAL = "nGoal" as const;
/** The verbatim initial user message (source-graph special; permanently under nGoal). */
export const O_INITIAL_PROMPT = "oInitialPrompt" as const;
/**
 * The Selector's working-copy demote bin. NOT a source-graph special — created
 * only in the Selector working copy. Defined here so the `dissolvable` exemption
 * is uniform (a no-op in the source graph, which never contains it).
 */
export const N_IRRELEVANT = "nIrrelevant" as const;

// --- Ids -------------------------------------------------------------------

/** A generated observation id: `o<seq>`. */
export type GeneratedObsId = `o${number}`;
/** A generated node id: `n<seq>`. */
export type GeneratedNodeId = `n${number}`;

/**
 * Any observation id: a generated `o<seq>` OR the fixed special `oInitialPrompt`
 * (the verbatim initial-user-message observation permanently under nGoal).
 */
export type ObsId = GeneratedObsId | typeof O_INITIAL_PROMPT;
/**
 * Any node id: a generated `n<seq>` OR a fixed special — the predefined goal
 * node `nGoal` (source-graph) or the working-copy demote bin `nIrrelevant`.
 */
export type NodeId = GeneratedNodeId | typeof N_GOAL | typeof N_IRRELEVANT;

// --- Importance ------------------------------------------------------------

export type Importance = "crit" | "high" | "med" | "low";

/** Ranking value for each importance (higher = more consequential if lost). */
export const IMPORTANCE_RANK: Record<Importance, number> = {
  crit: 4,
  high: 3,
  med: 2,
  low: 1,
};

/** The canonical importance value list, derived from IMPORTANCE_RANK so the
 *  union, the settings schema enum, and the codecs decoder set cannot drift.
 *  Order is crit→low (matches the union + IMPORTANCE_RANK key order). */
export const IMPORTANCE_VALUES = Object.keys(IMPORTANCE_RANK) as readonly Importance[];

// --- Node state ------------------------------------------------------------

export type NodeState = "new" | "active" | "archived" | "obsolete";

/** The canonical node-state value list, the single source of truth for the
 *  settings schema enum and the codecs decoder set so they cannot drift from
 *  the union. Order is new→obsolete (matches the union declaration order). */
export const NODE_STATE_VALUES = ["new", "active", "archived", "obsolete"] as const satisfies readonly NodeState[];

// --- Timestamps ------------------------------------------------------------

/** Node lifecycle + the time range of its contained observations. */
export interface NodeTimestamps {
  /** When the node was created. */
  createdAt: string;
  /** When the node was last mutated. */
  updatedAt: string;
  /** Earliest timestamp among contained observations (incl. descendants). */
  rangeStart: string;
  /** Latest timestamp among contained observations (incl. descendants). */
  rangeEnd: string;
}

// --- Observation (immutable leaf) ------------------------------------------

export interface Observation {
  id: ObsId;
  /** Condensed essential summary (the full detail stays in the source). */
  readonly content: string;
  /** Cached chars/4 estimate, frozen at capture. */
  readonly contentTokens: number;
  readonly importance: Importance;
  /** Provenance — real session-entry ids. */
  readonly sourceEntryIds: string[];
  /** UTC ISO instant ("...Z"), attached mechanically from the source entries
   *  (rendered to local at display time). */
  readonly timestamp: string;
  /** ALWAYS a real node id (the capture wrapper at first; regrouped later). */
  parentNode: NodeId;
}

/** Estimate the cached token count for a content/summary string. */
export function estimateContentTokens(content: string): number {
  return Math.ceil(content.length / CHARS_PER_TOKEN_ESTIMATE);
}

/** The current instant as a stored UTC ISO 8601 timestamp (e.g.
 *  "2026-07-29T10:00:00.000Z"). Absolute/TZ-agnostic (a session resumed in a
 *  different timezone stays consistent); rendered to LOCAL at display time. The
 *  canonical source for any code generating a fresh model timestamp (the graph
 *  clock + the Observer's no-source fallback), so the format never drifts.
 *  Lexicographic order = chronological, so recency ranking is unaffected. */
export function nowStoredTimestamp(): string {
  return new Date().toISOString();
}

/** Construct an observation, freezing `contentTokens` from `content`. */
export function makeObservation(args: {
  id: ObsId;
  content: string;
  importance: Importance;
  sourceEntryIds: string[];
  timestamp: string;
  parentNode: NodeId;
}): Observation {
  return {
    id: args.id,
    content: args.content,
    contentTokens: estimateContentTokens(args.content),
    importance: args.importance,
    sourceEntryIds: args.sourceEntryIds,
    timestamp: args.timestamp,
    parentNode: args.parentNode,
  };
}

// --- Node (mutable container) ----------------------------------------------

export interface Node {
  id: NodeId;
  /** LLM distillation; the content-type lives here, inferred by readers. */
  summary: string;
  /** Cached chars/4 estimate, recomputed on every summary write. */
  summaryTokens: number;
  state: NodeState;
  importance: Importance;
  /** null = root. */
  parentNode: NodeId | null;
  observationIds: ObsId[];
  childNodeIds: NodeId[];
  /** The single replacement id when state === "obsolete"; null otherwise. */
  supersededBy: NodeId | null;
  timestamps: NodeTimestamps;
}

/** Construct a node, computing `summaryTokens` from `summary` and seeding
 *  `timestamps` (rangeStart/rangeEnd default to the createdAt instant). */
export function makeNode(args: {
  id: NodeId;
  summary: string;
  importance: Importance;
  state: NodeState;
  parentNode: NodeId | null;
  observationIds?: ObsId[];
  childNodeIds?: NodeId[];
  supersededBy?: NodeId | null;
  createdAt: string;
  rangeStart?: string;
  rangeEnd?: string;
}): Node {
  const rangeStart = args.rangeStart ?? args.createdAt;
  return {
    id: args.id,
    summary: args.summary,
    summaryTokens: estimateContentTokens(args.summary),
    importance: args.importance,
    state: args.state,
    parentNode: args.parentNode,
    observationIds: args.observationIds ?? [],
    childNodeIds: args.childNodeIds ?? [],
    supersededBy: args.supersededBy ?? null,
    timestamps: {
      createdAt: args.createdAt,
      updatedAt: args.createdAt,
      rangeStart,
      rangeEnd: args.rangeEnd ?? rangeStart,
    },
  };
}

// --- Graph container -------------------------------------------------------

/**
 * Plain in-memory data container: the containment-tree nodes, the immutable
 * observation leaves, and the per-session id counters. Mutations are applied
 * elsewhere; this struct only holds state + the computed
 * `hasInitialPrompt` getter (never stored — always consistent with the map,
 * survives /reload·/new·fork).
 */
export class MemkeeperGraph {
  nodes: Map<NodeId, Node>;
  observations: Map<ObsId, Observation>;
  nextObsId: number;
  nextNodeId: number;

  constructor(args: {
    nodes: Map<NodeId, Node>;
    observations: Map<ObsId, Observation>;
    nextObsId: number;
    nextNodeId: number;
  }) {
    this.nodes = args.nodes;
    this.observations = args.observations;
    this.nextObsId = args.nextObsId;
    this.nextNodeId = args.nextNodeId;
  }

  /** True iff the special initial-prompt observation is present. Never stored. */
  get hasInitialPrompt(): boolean {
    return this.observations.has(O_INITIAL_PROMPT as ObsId);
  }
}
