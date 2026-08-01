// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// The Builder toolset — 3 read tools here (ls/cat/find) + 5 mutate tools +
// try_finish appended in the mutate-tools task. Each is an AgentTool whose
// execute operates on the source graph (read-only here). The shared one-line
// render format (formatNodeLine/formatObservationLine) is reused across
// Builder ls/find, the Selector, mk_recall, the user commands, and the
// compaction summary.

import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import type { MemkeeperConfig } from "../config/schema.js";
import { formatNodeLine, formatObservationLine, formatTimestamp, importanceAbbr } from "../format/render.js";
import { formatTokens } from "../format/tokens.js";
import { GraphInvariantError } from "../graph/invariants.js";
import {
  applyCreateNode,
  applyMerge,
  applyMv,
  applySetMeta,
  applySupersede,
  type GraphDelta,
  MUTATE_SOURCE,
} from "../graph/mutations.js";
import { ImportanceSchema, PageSchema } from "../schema.js";
import { appendGraphDelta, type StoreContext } from "../store/graph-store.js";
import {
  estimateContentTokens,
  IMPORTANCE_RANK,
  type Importance,
  type MemkeeperGraph,
  type Node,
  type NodeId,
  type Observation,
  type ObsId,
} from "../types.js";

// --- named constants (no bare literals at call sites) ----------------------

export const LS_TOOL = "ls";
export const CAT_TOOL = "cat";
export const FIND_TOOL = "find";

/** Default page size for cursor pagination. */
const DEFAULT_TAKE = 50;
/** take === 0 means "all" (no pagination). */
const TAKE_ALL = 0;
/** Upper bound on a `find` regex pattern length — guards against accidental
 *  megabyte patterns. NOTE: this caps PATTERN LENGTH, not catastrophic
 *  backtracking (a short `(a+)+$` can still blow up on long input). True ReDoS
 *  hardening needs a worker-thread timeout; find is cooperative-LLM-only here,
 *  so that is deferred until the user-facing search path lands. */
const FIND_QUERY_MAX = 500;
const INDENT_STEP = 2;
const ROOT_DEPTH = 0;
const ROOT_PARENT: NodeId | null = null;
const NO_AFTER_ID: string | null = null;

/** Resolved cursor pagination: an ordered window into a full results list. */
export interface ResolvedPage {
  take: number;
  afterId: string | null;
}

/** Normalize a raw `page` param (all-optional; TypeBox-inferred as unknown) into
 *  a resolved window. */
export function resolvePage(page: unknown): ResolvedPage {
  if (page === null || page === undefined || typeof page !== "object") {
    return { take: DEFAULT_TAKE, afterId: NO_AFTER_ID };
  }
  const raw = page as { take?: number; afterId?: string | null };
  // clamp negative take to TAKE_ALL (the "all" sentinel) — a negative page size
  // is meaningless; treat it like 0.
  const rawTake = raw.take ?? DEFAULT_TAKE;
  const take = rawTake < 0 ? TAKE_ALL : rawTake;
  return { take, afterId: raw.afterId ?? NO_AFTER_ID };
}

/** Slice a results list by cursor pagination; return the window, whether more
 *  remain, how many remain, and whether the `afterId` cursor was STALE (not
 *  found — the graph changed between calls). `take === 0` returns the whole
 *  list. A stale cursor yields an empty window + stale:true so the tool can
 *  return an actionable re-query message instead of silently re-delivering
 *  duplicates from the start. */
export function paginate<T extends { id: string }>(
  items: T[],
  page: ResolvedPage,
): { window: T[]; more: boolean; remaining: number; stale: boolean } {
  if (page.take === TAKE_ALL) return { window: items, more: false, remaining: 0, stale: false };
  let startIdx = 0;
  if (page.afterId !== NO_AFTER_ID) {
    const i = items.findIndex((item) => item.id === page.afterId);
    if (i < 0) return { window: [], more: false, remaining: 0, stale: true };
    startIdx = i + 1;
  }
  const window = items.slice(startIdx, startIdx + page.take);
  const remaining = Math.max(0, items.length - (startIdx + page.take));
  return { window, more: remaining > 0, remaining, stale: false };
}

/** Render a pagination footer (only when more remain). */
function footer(lastId: string, remaining: number): string {
  return `… +${remaining} more · afterId=${lastId}`;
}

/** Actionable message for a stale cursor (the afterId item was removed between
 *  calls) — tells the caller to re-query from null instead of looping. */
function staleCursorMessage(afterId: string): string {
  return `Cursor afterId=${afterId} not found (the graph changed since the last page). Re-query without afterId to start fresh.`;
}

/** Indent a line by `depth` levels (2 spaces each). */
function indent(line: string, depth: number): string {
  return `${" ".repeat(depth * INDENT_STEP)}${line}`;
}

// --- ordering --------------------------------------------------------------

/** Importance desc (critical→low), then rangeEnd recency desc (newer first). */
function compareNodeOrder(a: Node, b: Node): number {
  const byImportance = IMPORTANCE_RANK[b.importance] - IMPORTANCE_RANK[a.importance];
  if (byImportance !== 0) return byImportance;
  return b.timestamps.rangeEnd.localeCompare(a.timestamps.rangeEnd);
}

/** Recency desc by timestamp (newer first). */
function compareObservationOrder(a: Observation, b: Observation): number {
  return b.timestamp.localeCompare(a.timestamp);
}

/** A node is obsolete when its state is "obsolete". */
function isObsolete(node: Node): boolean {
  return node.state === "obsolete";
}

// --- ls --------------------------------------------------------------------

/** The roots of the graph: nodes whose parentNode is null. */
function rootNodes(graph: MemkeeperGraph): Node[] {
  return [...graph.nodes.values()].filter((n) => n.parentNode === ROOT_PARENT);
}

/** Non-obsolete roots, importance desc then recency — the view `ls` renders at
 *  the root and `try_finish` measures. Obsolete roots are hidden by default
 *  (findable via find with includeSuperseded). */
function nonObsoleteRoots(graph: MemkeeperGraph): Node[] {
  return rootNodes(graph)
    .filter((n) => !isObsolete(n))
    .sort(compareNodeOrder);
}

/** Direct child nodes + direct observations of a parent node, ordered
 *  nodes-first (importance desc, then recency) then observations (recency). */
function directChildren(graph: MemkeeperGraph, parent: Node): { nodes: Node[]; observations: Observation[] } {
  const nodes = parent.childNodeIds
    .map((id) => graph.nodes.get(id))
    .filter((n): n is Node => n !== undefined)
    .sort(compareNodeOrder);
  const observations = parent.observationIds
    .map((id) => graph.observations.get(id))
    .filter((o): o is Observation => o !== undefined)
    .sort(compareObservationOrder);
  return { nodes, observations };
}

function renderLines(lines: string[]): string {
  return lines.length === 0 ? "(empty)" : lines.join("\n");
}

const LS_PARAMS = Type.Object({
  nodeId: Type.Optional(Type.String()),
  page: Type.Optional(PageSchema),
});

/** Build the `ls` tool: one level of the memory graph. */
function makeLsTool(graph: MemkeeperGraph): AgentTool<typeof LS_PARAMS> {
  return {
    name: LS_TOOL,
    description:
      "List one level of the memory graph — the root nodes with no id, or a node's direct children (subnodes and observations).",
    label: "List",
    parameters: LS_PARAMS,
    async execute(_toolCallId, params) {
      const page = resolvePage(params.page);
      const lines: string[] = [];

      if (params.nodeId === undefined || params.nodeId === null) {
        // roots: non-obsolete only (obsolete hidden by default — findable via find).
        const roots = nonObsoleteRoots(graph);
        const { window, more, remaining, stale } = paginate(roots, page);
        if (stale) {
          return {
            content: [{ type: "text", text: staleCursorMessage(page.afterId ?? "") }],
            details: { count: 0, stale: true },
          };
        }
        for (const node of window) lines.push(formatNodeLine(node, { viewer: "builder" }));
        if (more && window.length > 0) lines.push(footer(window[window.length - 1].id, remaining));
        return { content: [{ type: "text", text: renderLines(lines) }], details: { count: window.length, more } };
      }

      const parent = graph.nodes.get(params.nodeId as NodeId);
      if (parent === undefined) {
        return { content: [{ type: "text", text: `No node with id ${params.nodeId}.` }], details: { error: true } };
      }
      // header is the parent itself at depth 0; children indented at depth 1.
      lines.push(indent(formatNodeLine(parent, { viewer: "builder" }), ROOT_DEPTH));
      const { nodes, observations } = directChildren(graph, parent);
      const combined = [
        ...nodes.map((n) => ({ id: n.id, depth: 1, render: formatNodeLine(n, { viewer: "builder" }) })),
        ...observations.map((o) => ({ id: o.id, depth: 1, render: formatObservationLine(o, { viewer: "builder" }) })),
      ];
      const { window, more, remaining, stale } = paginate(combined, page);
      if (stale) {
        return {
          content: [{ type: "text", text: staleCursorMessage(page.afterId ?? "") }],
          details: { count: 0, stale: true },
        };
      }
      for (const item of window) lines.push(indent(item.render, item.depth));
      if (more && window.length > 0) lines.push(footer(window[window.length - 1].id, remaining));
      return { content: [{ type: "text", text: renderLines(lines) }], details: { count: window.length, more } };
    },
  };
}

// --- cat -------------------------------------------------------------------

const CAT_PARAMS = Type.Object({
  ids: Type.Array(Type.String(), { minItems: 1 }),
  page: Type.Optional(PageSchema),
});

/** Build the `cat` tool: read full text — observations verbatim, or a node's
 *  header plus its direct observations verbatim (child nodes NOT expanded). */
function makeCatTool(graph: MemkeeperGraph): AgentTool<typeof CAT_PARAMS> {
  return {
    name: CAT_TOOL,
    description:
      "Read full text — an observation's content, or a node's header plus the full text of its direct observations. Sub-nodes are not expanded here (use `ls` for them). `ls` shows one-line structure; `cat` shows full content.",
    label: "Read full text",
    parameters: CAT_PARAMS,
    async execute(_toolCallId, params) {
      const page = resolvePage(params.page);
      // Build the aggregated observation full-text units (a node expands to its
      // direct observations; the node header rides the first as a preamble),
      // then paginate over those units (page paginates the aggregated observation
      // full-texts, not the requested ids).
      const units = buildCatUnits(graph, params.ids);
      const { window, more, remaining, stale } = paginate(units, page);
      if (stale) {
        return {
          content: [{ type: "text", text: staleCursorMessage(page.afterId ?? "") }],
          details: { count: 0, stale: true },
        };
      }
      const lines = window.map(renderCatUnit);
      if (more && window.length > 0) lines.push(footer(window[window.length - 1].id, remaining));
      const text = lines.length === 0 ? "(empty)" : lines.join("\n\n");
      return { content: [{ type: "text", text }], details: { count: window.length, more } };
    },
  };
}

/** A content-free header for a cat observation block: id · importance · timestamp
 *  (NO content — that's the body; NO sourceEntryIds — provenance is internal). */
function catObsHeader(obs: Observation): string {
  return `📄 ${obs.id} ${importanceAbbr(obs.importance)} · ${formatTimestamp(obs.timestamp)}`;
}

/** A paginated cat unit: one observation full-text (header + content), with an
 *  optional node-header preamble shown above it (the node summary, shown once
 *  on the page where the node's first observation lands). A node with no
 *  observations, or an unknown id, becomes a header-only unit. */
interface CatUnit {
  id: string;
  preamble?: string;
  header: string;
  content?: string;
}

/** Build the cat units for a list of requested ids: each node expands to its
 *  direct observations (the node header rides the first as a preamble); each
 *  observation is one unit; unknown ids are a not-found unit. */
function buildCatUnits(graph: MemkeeperGraph, ids: string[]): CatUnit[] {
  const units: CatUnit[] = [];
  for (const id of ids) {
    const node = graph.nodes.get(id as NodeId);
    if (node !== undefined) {
      const nodeHeader = formatNodeLine(node, { viewer: "builder" });
      const obs = node.observationIds
        .map((oid) => graph.observations.get(oid))
        .filter((o): o is Observation => o !== undefined)
        .sort(compareObservationOrder);
      if (obs.length === 0) {
        // a node with no direct observations is a header-only unit.
        units.push({ id: node.id, header: nodeHeader });
        continue;
      }
      obs.forEach((o, index) => {
        units.push({
          id: o.id,
          preamble: index === 0 ? nodeHeader : undefined,
          header: catObsHeader(o),
          content: o.content,
        });
      });
      continue;
    }
    const obs = graph.observations.get(id as ObsId);
    if (obs !== undefined) {
      units.push({ id: obs.id, header: catObsHeader(obs), content: obs.content });
      continue;
    }
    units.push({ id, header: `No node or observation with id ${id}.` });
  }
  return units;
}

/** Render one cat unit (preamble + header + content). */
function renderCatUnit(unit: CatUnit): string {
  const parts: string[] = [];
  if (unit.preamble !== undefined) parts.push(unit.preamble);
  parts.push(unit.header);
  if (unit.content !== undefined) parts.push(unit.content);
  return parts.join("\n");
}

// --- find ------------------------------------------------------------------

const FIND_PARAMS = Type.Object({
  query: Type.String(),
  includeSuperseded: Type.Optional(Type.Boolean()),
  page: Type.Optional(PageSchema),
});

interface FindMatch {
  id: string;
  render: string;
}

/** A sortable wrapper carrying the entity for ordering. */
interface NodeMatch extends FindMatch {
  node: Node;
}
interface ObsMatch extends FindMatch {
  obs: Observation;
}

/** Build the `find` tool: whole-graph regex search over node summaries +
 *  observation content, flat results each carrying `in <parent>`. */
function makeFindTool(graph: MemkeeperGraph): AgentTool<typeof FIND_PARAMS> {
  return {
    name: FIND_TOOL,
    description:
      "Search the whole memory graph by regex — node summaries and observation content. Flat results, each showing its parent.",
    label: "Find",
    parameters: FIND_PARAMS,
    async execute(_toolCallId, params) {
      const includeSuperseded = params.includeSuperseded ?? false;
      if (params.query.length > FIND_QUERY_MAX) {
        return {
          content: [{ type: "text", text: `Query too long (max ${FIND_QUERY_MAX} chars). Use a shorter regex.` }],
          details: { error: true },
        };
      }
      let regex: RegExp;
      try {
        regex = new RegExp(params.query);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text", text: `Invalid regex "${params.query}": ${message}. Retry with a fixed pattern.` }],
          details: { error: true },
        };
      }

      const nodeMatches: NodeMatch[] = [];
      const obsMatches: ObsMatch[] = [];
      for (const node of graph.nodes.values()) {
        // parent-state gate: skip the node (and its evidence) when obsolete and
        // not including superseded.
        if (isObsolete(node) && !includeSuperseded) continue;
        if (regex.test(node.summary)) {
          nodeMatches.push({
            id: node.id,
            node,
            render: formatNodeLine(node, { viewer: "builder", showParent: node.parentNode ?? undefined }),
          });
        }
        for (const obsId of node.observationIds) {
          const obs = graph.observations.get(obsId);
          if (obs === undefined) continue;
          if (regex.test(obs.content)) {
            obsMatches.push({
              id: obs.id,
              obs,
              render: formatObservationLine(obs, { viewer: "builder", showParent: node.id }),
            });
          }
        }
      }
      // nodes-first (importance desc, then recency), then observations (recency) —
      // consistent with `ls`.
      nodeMatches.sort((a, b) => compareNodeOrder(a.node, b.node));
      obsMatches.sort((a, b) => compareObservationOrder(a.obs, b.obs));
      const matches: FindMatch[] = [...nodeMatches, ...obsMatches];

      const page = resolvePage(params.page);
      const { window, more, remaining, stale } = paginate(matches, page);
      if (stale) {
        return {
          content: [{ type: "text", text: staleCursorMessage(page.afterId ?? "") }],
          details: { count: 0, stale: true },
        };
      }
      const lines = window.map((m) => m.render);
      if (more && window.length > 0) lines.push(footer(window[window.length - 1].id, remaining));
      const text = lines.length === 0 ? "No matches." : lines.join("\n");
      return { content: [{ type: "text", text }], details: { count: window.length, more } };
    },
  };
}

// --- mutate tools ---------------------------------------------------------

const MKDIR_TOOL = "mkdir";
const MV_TOOL = "mv";
const MERGE_TOOL = "merge";
const SUPERSEDE_TOOL = "supersede";
const SET_META_TOOL = "set_meta";
const TRY_FINISH_TOOL = "try_finish";

/** Default importance for Builder-created container nodes. */
const DEFAULT_NODE_IMPORTANCE: Importance = "medium";

/** A success mutation result: the ack text + the applied delta recorded in
 *  `details` for inspection/tests. */
function okResult(text: string, delta: GraphDelta): AgentToolResult<unknown> {
  return { content: [{ type: "text", text }], details: { ok: true as const, delta } };
}

/** An error mutation result: the model sees the message and can retry. The
 *  graph is unchanged (the mutator threw before mutating). */
function errorResult(message: string): AgentToolResult<unknown> {
  return { content: [{ type: "text", text: message }], details: { error: true } };
}

/** Run a mutation, persist its delta, and report success — or catch a structural
 *  rejection (GraphInvariantError) and surface it as an error result the model
 *  can retry from. A rejected mutate leaves the graph AND the delta log
 *  unchanged (the mutator throws before mutating). `describe(delta)` builds the
 *  success text from the APPLIED delta so the model learns any new/resolved ids
 *  (e.g. merge with destId=null resolves a new root id). */
function applyAndPersist(
  store: StoreContext,
  what: string,
  apply: () => GraphDelta,
  describe: (delta: GraphDelta) => string,
): AgentToolResult<unknown> {
  let delta: GraphDelta;
  try {
    delta = apply();
  } catch (cause) {
    if (cause instanceof GraphInvariantError) {
      return errorResult(`${what}: ${cause.message}`);
    }
    throw cause;
  }
  appendGraphDelta(store, delta);
  return okResult(describe(delta), delta);
}

/** Build the `mkdir` tool: create a container node (zero observations OK) under
 *  an optional parent, state `active`, default importance medium. */
function makeMkdirTool(graph: MemkeeperGraph, store: StoreContext): AgentTool<typeof MKDIR_PARAMS> {
  return {
    name: MKDIR_TOOL,
    description:
      "Create a container node (optionally under a parent). Zero observations is fine. Returns the new node id.",
    label: "Create container",
    parameters: MKDIR_PARAMS,
    async execute(_toolCallId, params) {
      // generate the id from the counter BEFORE applyCreateNode (which advances it).
      const id = `n${graph.nextNodeId}` as NodeId;
      return applyAndPersist(
        store,
        `mkdir ${id}`,
        () =>
          applyCreateNode(graph, {
            id,
            summary: params.summary,
            importance: DEFAULT_NODE_IMPORTANCE,
            parentNode: (params.parentId ?? null) as NodeId | null,
            state: "active",
          }),
        () => `Created ${id} (active).`,
      );
    },
  };
}

const MKDIR_PARAMS = Type.Object({
  summary: Type.String({ minLength: 1, description: "One-line summary for the new container node." }),
  parentId: Type.Optional(Type.String({ description: "Parent node id; omit or null for a root node." })),
});

/** Build the `mv` tool: move observations and/or nodes to a new parent (or to
 *  the root when destId is null). An optional newSummary rewrites the dest
 *  node's summary as part of the same atomic mutate (ignored when destId is
 *  null — promoting to root touches no dest). */
function makeMvTool(graph: MemkeeperGraph, store: StoreContext): AgentTool<typeof MV_PARAMS> {
  return {
    name: MV_TOOL,
    description:
      "Move observations and/or nodes under a new parent (group/split/reparent). destId null promotes to root. Optional newSummary rewrites the dest summary atomically.",
    label: "Move",
    parameters: MV_PARAMS,
    async execute(_toolCallId, params) {
      const destId = (params.destId ?? null) as NodeId | null;
      // newSummary is meaningful only when there is a dest node to rewrite.
      const newSummary = destId === null ? undefined : params.newSummary;
      return applyAndPersist(
        store,
        "mv",
        () =>
          applyMv(
            graph,
            {
              sourceIds: params.sourceIds as Array<ObsId | NodeId>,
              destId,
              ...(newSummary !== undefined ? { newSummary } : {}),
            },
            MUTATE_SOURCE,
          ),
        () => {
          const where = destId === null ? "the root" : destId;
          return `Moved ${params.sourceIds.length} item(s) to ${where}.`;
        },
      );
    },
  };
}

const MV_PARAMS = Type.Object({
  sourceIds: Type.Array(Type.String(), { minItems: 1, description: "Observation and/or node ids to move." }),
  destId: Type.Optional(Type.String({ description: "Destination node id; omit or null to promote to root." })),
  newSummary: Type.Optional(
    Type.String({ minLength: 1, description: "New summary for the dest node (ignored when destId is null)." }),
  ),
});

/** Build the `merge` tool: fold absorbed nodes into a target. newSummary is
 *  required when destId is null (names the new root node); optional when merging
 *  into an existing dest (a refreshed synthesis — omit to keep the dest summary).
 *  Absorbed nodes dissolve once emptied. */
function makeMergeTool(graph: MemkeeperGraph, store: StoreContext): AgentTool<typeof MERGE_PARAMS> {
  return {
    name: MERGE_TOOL,
    description:
      "Fold one or more nodes into a target node (absorbed nodes dissolve). destId null creates a new root; in that case newSummary is required to name it.",
    label: "Merge",
    parameters: MERGE_PARAMS,
    async execute(_toolCallId, params) {
      const destId = (params.destId ?? null) as NodeId | null;
      if (destId === null && (params.newSummary === undefined || params.newSummary.length === 0)) {
        return errorResult("merge: newSummary is required when destId is null (names the new root node).");
      }
      // When destId is null, applyMerge creates a new root at n<nextNodeId>; capture
      // the id BEFORE the call so the result can surface it to the model.
      const newRootId = destId === null ? (`n${graph.nextNodeId}` as NodeId) : null;
      return applyAndPersist(
        store,
        "merge",
        () =>
          applyMerge(
            graph,
            {
              sourceIds: params.sourceIds as NodeId[],
              destId,
              ...(params.newSummary !== undefined ? { newSummary: params.newSummary } : {}),
            },
            MUTATE_SOURCE,
          ),
        () => {
          const where = newRootId ?? destId;
          return `Merged ${params.sourceIds.length} node(s) into ${where}.`;
        },
      );
    },
  };
}

const MERGE_PARAMS = Type.Object({
  sourceIds: Type.Array(Type.String(), { minItems: 1, description: "Node ids to absorb into the target." }),
  destId: Type.Optional(Type.String({ description: "Target node id; omit or null to create a new root." })),
  newSummary: Type.Optional(
    Type.String({ minLength: 1, description: "Synthesized summary for the target. Required when destId is null." }),
  ),
});

/** Build the `supersede` tool: mark nodes obsolete, each carrying supersededBy
 *  pointing at the replacement. The superseded nodes retain their evidence. */
function makeSupersedeTool(graph: MemkeeperGraph, store: StoreContext): AgentTool<typeof SUPERSEDE_PARAMS> {
  return {
    name: SUPERSEDE_TOOL,
    description:
      "Mark one or more nodes obsolete, superseded by a replacement node. Superseded nodes keep their observations (a non-empty tombstone).",
    label: "Supersede",
    parameters: SUPERSEDE_PARAMS,
    async execute(_toolCallId, params) {
      return applyAndPersist(
        store,
        "supersede",
        () =>
          applySupersede(
            graph,
            { nodeId: params.nodeId as NodeId, supersededNodeIds: params.supersededNodeIds as NodeId[] },
            MUTATE_SOURCE,
          ),
        () => `Superseded ${params.supersededNodeIds.length} node(s) with ${params.nodeId}.`,
      );
    },
  };
}

const SUPERSEDE_PARAMS = Type.Object({
  nodeId: Type.String({ description: "The replacement node id." }),
  supersededNodeIds: Type.Array(Type.String(), {
    minItems: 1,
    description: "Node ids to mark obsolete.",
  }),
});

/** Build the `set_meta` tool: re-rate importance, archive/un-archive, condense
 *  the summary, or resurrect an obsolete node. obsolete:true is rejected (use
 *  supersede). nGoal allows summary only. */
function makeSetMetaTool(graph: MemkeeperGraph, store: StoreContext): AgentTool<typeof SET_META_PARAMS> {
  return {
    name: SET_META_TOOL,
    description:
      "Update a node's importance, archived flag, summary, or resurrect it (obsolete:false). obsolete:true is not allowed — use supersede.",
    label: "Edit metadata",
    parameters: SET_META_PARAMS,
    async execute(_toolCallId, params) {
      return applyAndPersist(
        store,
        "set_meta",
        () =>
          applySetMeta(
            graph,
            {
              nodeId: params.nodeId as NodeId,
              importance: (params.importance ?? null) as Importance | null,
              archived: params.archived ?? null,
              obsolete: params.obsolete ?? null,
              summary: params.summary ?? null,
            },
            MUTATE_SOURCE,
          ),
        () => `Updated ${params.nodeId}.`,
      );
    },
  };
}

const SET_META_PARAMS = Type.Object({
  nodeId: Type.String({ description: "Node id to update." }),
  importance: Type.Optional(ImportanceSchema),
  archived: Type.Optional(Type.Boolean({ description: "true archives, false un-archives." })),
  summary: Type.Optional(Type.String({ minLength: 1, description: "New summary (re-rates summaryTokens)." })),
  obsolete: Type.Optional(
    Type.Boolean({ description: "false resurrects an obsolete node; true is rejected (use supersede)." }),
  ),
});

/** Render the non-obsolete root view (the same lines `ls` shows at the root) so
 *  try_finish can measure its token cost. */
function renderRootView(graph: MemkeeperGraph): string {
  const roots = nonObsoleteRoots(graph);
  if (roots.length === 0) return "";
  return roots.map((n) => formatNodeLine(n, { viewer: "builder" })).join("\n");
}

/** Build the `try_finish` convergence gate: measures the non-obsolete root view
 *  against builderRootViewThreshold. Within budget → success + terminate:true
 *  (stops the pass/run). Over budget → reject + terminate:false (keep
 *  organizing, call again). Deterministic/mechanical — no LLM. */
function makeTryFinishTool(graph: MemkeeperGraph, settings: MemkeeperConfig): AgentTool<typeof TRY_FINISH_PARAMS> {
  return {
    name: TRY_FINISH_TOOL,
    description:
      "Signal the Builder run is done. Reports whether the root view is within budget; within = stop, over = keep organizing.",
    label: "Finish",
    parameters: TRY_FINISH_PARAMS,
    async execute() {
      const rootsViewTokens = estimateContentTokens(renderRootView(graph));
      const threshold = settings.builderRootViewThreshold;
      if (rootsViewTokens <= threshold) {
        return {
          content: [
            { type: "text", text: `Within budget: ${formatTokens(rootsViewTokens)} / ${formatTokens(threshold)}.` },
          ],
          details: { ok: true, rootsViewTokens, threshold },
          terminate: true,
        };
      }
      return {
        content: [
          {
            type: "text",
            text: `Over budget: ${formatTokens(rootsViewTokens)} / ${formatTokens(threshold)}. Keep organizing, then call try_finish again.`,
          },
        ],
        details: { ok: false, rootsViewTokens, threshold },
        terminate: false,
      };
    },
  };
}

const TRY_FINISH_PARAMS = Type.Object({}, { description: "No parameters." });

// --- factory ---------------------------------------------------------------

/** Build the Builder READ tools over the given source graph (ls/cat/find).
 *  Read-only — no store or settings needed, so read-only tests and read-only
 *  consumers can construct these without a StoreContext. */
export function makeBuilderReadTools(graph: MemkeeperGraph): AgentTool[] {
  return [makeLsTool(graph), makeCatTool(graph), makeFindTool(graph)];
}

/** Build the full Builder toolset (9 tools): ls/cat/find (read) +
 *  mkdir/mv/merge/supersede/set_meta/try_finish (mutate). The mutate tools close
 *  over the store (to append graph deltas) and settings (try_finish threshold).
 *  Builder tools operate on the SOURCE graph with `MUTATE_SOURCE` policy (the
 *  nGoal/oInitialPrompt protection matrix is enforced). */
export function makeBuilderTools(graph: MemkeeperGraph, store: StoreContext, settings: MemkeeperConfig): AgentTool[] {
  return [
    ...makeBuilderReadTools(graph),
    makeMkdirTool(graph, store),
    makeMvTool(graph, store),
    makeMergeTool(graph, store),
    makeSupersedeTool(graph, store),
    makeSetMetaTool(graph, store),
    makeTryFinishTool(graph, settings),
  ];
}
