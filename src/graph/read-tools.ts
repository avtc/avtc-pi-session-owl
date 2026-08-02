// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// Shared graph read tools (ls/cat/find) + the `try_finish` convergence gate +
// the root-view render/measure helpers. These operate on any MemkeeperGraph
// (the Builder's source graph OR the Selector's working copy) and are
// parameterized by a `viewer` so the shared one-line render honors the
// viewer-dependent `new`-state glyph rule (Builder sees 🆕; every other consumer
// renders `new` as `active`). The Builder (source graph, viewer "builder") and
// the Selector (working copy, viewer "nonBuilder") both build their toolsets
// from these factories — no duplication.

import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import {
  formatNodeLine,
  formatObservationLine,
  indent,
  type RenderableNode,
  type RenderViewer,
} from "../format/render.js";
import { formatTokens } from "../format/tokens.js";
import { PageSchema } from "../schema.js";
import {
  estimateContentTokens,
  IMPORTANCE_RANK,
  type MemkeeperGraph,
  N_GOAL,
  N_IRRELEVANT,
  type Node,
  type NodeId,
  type Observation,
  type ObsId,
  ROOT_PARENT,
} from "../types.js";
import { isSafeRegex } from "./safe-regex.js";

// --- named constants (no bare literals at call sites) ----------------------

export const LS_TOOL = "ls";
export const CAT_TOOL = "cat";
export const FIND_TOOL = "find";
export const TRY_FINISH_TOOL = "try_finish";

/** Default page size for cursor pagination. */
export const DEFAULT_TAKE = 50;
/** take === 0 means "all" (no pagination). */
export const TAKE_ALL = 0;
/** Upper bound on a `find` regex pattern length — guards against accidental
 *  megabyte patterns. NOTE: this caps PATTERN LENGTH, not catastrophic
 *  backtracking (a short `(a+)+$` can still blow up on long input). True ReDoS
 *  hardening needs a worker-thread timeout — that remains a known limitation.
 *  find now accepts USER input (/mk:find), but observations are condensed
 *  (short) and the graph is session-bounded, so the realistic blast radius is
 *  a brief synchronous hang, not a crash. */
export const FIND_QUERY_MAX = 500;

const ROOT_DEPTH = 0;
const NO_AFTER_ID: string | null = null;
/** Default value for an `includeSuperseded` flag (hide obsolete unless asked). */
const INCLUDE_DEFAULT = false;

/** The boolean that gates obsolete-item visibility in find/ls-style reads. */
export type IncludeSuperseded = boolean;

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

// --- shared render helpers -------------------------------------------------

function footer(lastId: string, remaining: number): string {
  return `… +${remaining} more · afterId=${lastId}`;
}

/** Actionable message for a stale cursor (the afterId item was removed between
 *  calls) — tells the caller to re-query from null instead of looping. Shared by
 *  the graph read tools and mk_recall (which reads the rendered tree). */
export function staleCursorMessage(afterId: string | null): string {
  return `Cursor afterId=${afterId ?? ""} not found (changed since the last page). Re-query without afterId to start fresh.`;
}

// --- ordering --------------------------------------------------------------

/** The node fields `compareNodeOrder` reads — structural, so it orders both the
 *  live `Node` and the render-only `RenderableNode` (snapshot/working-copy). */
export interface OrderableNode {
  importance: Node["importance"];
  timestamps: { rangeEnd: string };
}

/** Importance desc (critical→low), then rangeEnd recency desc (newer first). */
export function compareNodeOrder<T extends OrderableNode>(a: T, b: T): number {
  const byImportance = IMPORTANCE_RANK[b.importance] - IMPORTANCE_RANK[a.importance];
  if (byImportance !== 0) return byImportance;
  return b.timestamps.rangeEnd.localeCompare(a.timestamps.rangeEnd);
}

/** The canonical active-set root ordering shared by the compaction summary and
 *  the Selector working-tree render: nGoal first, nIrrelevant last, the rest by
 *  importance desc / recency desc. Callers pass already-filtered non-obsolete
 *  roots (structural `Node` or render-only `RenderableNode`); obsolete nodes
 *  are never roots of the rendered view. */
export function orderActiveSetRoots<T extends RenderableNode>(roots: readonly T[]): T[] {
  const goal = roots.filter((n) => n.id === N_GOAL);
  const irrelevant = roots.filter((n) => n.id === N_IRRELEVANT);
  const rest = roots.filter((n) => n.id !== N_GOAL && n.id !== N_IRRELEVANT);
  return [...goal, ...rest.sort(compareNodeOrder), ...irrelevant];
}

/** Recency desc by timestamp (newer first). */
export function compareObservationOrder(a: Observation, b: Observation): number {
  return b.timestamp.localeCompare(a.timestamp);
}

/** A node is obsolete when its state is "obsolete". */
export function isObsolete(node: Node): boolean {
  return node.state === "obsolete";
}

// --- root view + children --------------------------------------------------

/** The roots of the graph: nodes whose parentNode is null. */
export function rootNodes(graph: MemkeeperGraph): Node[] {
  return [...graph.nodes.values()].filter((n) => n.parentNode === ROOT_PARENT);
}

/** Non-obsolete roots, importance desc then recency — the view `ls` renders at
 *  the root and `try_finish` measures. Obsolete roots are hidden by default
 *  (findable via find with includeSuperseded). */
export function nonObsoleteRoots(graph: MemkeeperGraph): Node[] {
  return rootNodes(graph)
    .filter((n) => !isObsolete(n))
    .sort(compareNodeOrder);
}

/** Direct child nodes + direct observations of a parent node, ordered
 *  nodes-first (importance desc, then recency) then observations (recency). */
export function directChildren(graph: MemkeeperGraph, parent: Node): { nodes: Node[]; observations: Observation[] } {
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
  return lines.join("\n");
}

// --- ls --------------------------------------------------------------------

const LS_PARAMS = Type.Object({
  nodeId: Type.Optional(
    Type.String({ description: "The node whose direct children to list. Omit or pass null for the root nodes." }),
  ),
  page: Type.Optional(PageSchema),
});

/** Build the `ls` tool bound to `graph`, rendered for `viewer` (the `new`-state
 *  glyph is Builder-only; non-Builder viewers render `new` as `active`). */
export function makeLsTool(graph: MemkeeperGraph, viewer: RenderViewer): AgentTool<typeof LS_PARAMS> {
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
        for (const node of window) lines.push(formatNodeLine(node, { viewer }));
        if (more && window.length > 0) lines.push(footer(window[window.length - 1].id, remaining));
        return { content: [{ type: "text", text: renderLines(lines) }], details: { count: window.length, more } };
      }

      const parent = graph.nodes.get(params.nodeId as NodeId);
      if (parent === undefined) {
        return { content: [{ type: "text", text: `No node with id ${params.nodeId}.` }], details: { error: true } };
      }
      // header is the parent itself at depth 0; children indented at depth 1.
      lines.push(indent(formatNodeLine(parent, { viewer }), ROOT_DEPTH));
      const { nodes, observations } = directChildren(graph, parent);
      const combined = [
        ...nodes.map((n) => ({ id: n.id, depth: 1, render: formatNodeLine(n, { viewer }) })),
        ...observations.map((o) => ({ id: o.id, depth: 1, render: formatObservationLine(o, { viewer }) })),
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
  ids: Type.Array(Type.String(), {
    minItems: 1,
    description: "Ids to read in full — observations and/or nodes. At least one.",
  }),
  page: Type.Optional(PageSchema),
});

/** Build the `cat` tool: read full text — observations verbatim, or a node's
 *  header plus its direct observations verbatim (child nodes NOT expanded).
 *  `viewer` controls the node-header glyph rendering (Builder-only `new`). */
export function makeCatTool(graph: MemkeeperGraph, viewer: RenderViewer): AgentTool<typeof CAT_PARAMS> {
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
      const units = buildCatUnits(graph, params.ids, viewer);
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

/** A content-free header for a cat observation block: `📄 id · importance · timestamp`
 *  (NO content — that's the body; NO sourceEntryIds — provenance is internal).
 *  Delegates to the shared formatObservationLine with content omitted, so the
 *  header stays byte-identical to every other observation line prefix. */
export function catObsHeader(obs: Observation): string {
  return formatObservationLine(obs, { viewer: "nonBuilder", formatContent: () => "" });
}

/** A paginated cat unit: one observation full-text (header + content), with an
 *  optional node-header preamble shown above it (the node summary, shown once
 *  on the page where the node's first observation lands). A node with no
 *  observations, or an unknown id, becomes a header-only unit. */
export interface CatUnit {
  id: string;
  preamble?: string;
  header: string;
  content?: string;
}

/** Build the cat units for a list of requested ids: each node expands to its
 *  direct observations (the node header rides the first as a preamble); each
 *  observation is one unit; unknown ids are a not-found unit. */
export function buildCatUnits(graph: MemkeeperGraph, ids: string[], viewer: RenderViewer): CatUnit[] {
  const units: CatUnit[] = [];
  for (const id of ids) {
    const node = graph.nodes.get(id as NodeId);
    if (node !== undefined) {
      const nodeHeader = formatNodeLine(node, { viewer });
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
export function renderCatUnit(unit: CatUnit): string {
  const parts: string[] = [];
  if (unit.preamble !== undefined) parts.push(unit.preamble);
  parts.push(unit.header);
  if (unit.content !== undefined) parts.push(unit.content);
  return parts.join("\n");
}

// --- find ------------------------------------------------------------------

const FIND_PARAMS = Type.Object({
  query: Type.String({ description: "Regex (JS) to match against node summaries and observation content." }),
  includeSuperseded: Type.Optional(
    Type.Boolean({ description: "Include superseded and obsolete items (default false — current memory only)." }),
  ),
  page: Type.Optional(PageSchema),
});

interface FindMatch {
  id: string;
  render: string;
}

/** Compile a `find` regex with the shared length cap + ReDoS guard + error
 *  handling. Returns the compiled regex, or an error string the caller surfaces
 *  verbatim. */
export function tryCompileFindRegex(query: string): { regex: RegExp } | { error: string } {
  if (query.length > FIND_QUERY_MAX) {
    return { error: `Query too long (max ${FIND_QUERY_MAX} chars). Use a shorter regex.` };
  }
  if (!isSafeRegex(query)) {
    return {
      error: `Regex "${query}" may backtrack catastrophically (nested/overlapping quantifiers). Rewrite it without overlapping repetition.`,
    };
  }
  try {
    return { regex: new RegExp(query) };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { error: `Invalid regex "${query}": ${message}. Retry with a fixed pattern.` };
  }
}

/** Collect ordered find matches across node summaries + observation content.
 *  `includeSuperseded=false` (default) applies the parent-state gate: obsolete
 *  nodes and their evidence are skipped. Nodes-first (importance desc, then
 *  recency), then observations (recency) — consistent with `ls`. Each match
 *  carries `in <parent>`. Shared by the agent `find` tool and the user
 *  `/mk:find` commands. */
export function collectFindMatches(
  graph: MemkeeperGraph,
  regex: RegExp,
  includeSuperseded: IncludeSuperseded,
  viewer: RenderViewer,
): FindMatch[] {
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
        render: formatNodeLine(node, { viewer, showParent: node.parentNode ?? undefined }),
      });
    }
    for (const obsId of node.observationIds) {
      const obs = graph.observations.get(obsId);
      if (obs === undefined) continue;
      if (regex.test(obs.content)) {
        obsMatches.push({
          id: obs.id,
          obs,
          render: formatObservationLine(obs, { viewer, showParent: node.id }),
        });
      }
    }
  }
  // nodes-first (importance desc, then recency), then observations (recency) —
  // consistent with `ls`.
  nodeMatches.sort((a, b) => compareNodeOrder(a.node, b.node));
  obsMatches.sort((a, b) => compareObservationOrder(a.obs, b.obs));
  return [...nodeMatches, ...obsMatches];
}

/** A sortable wrapper carrying the entity for ordering. */
interface NodeMatch extends FindMatch {
  node: Node;
}
interface ObsMatch extends FindMatch {
  obs: Observation;
}

/** Build the `find` tool: whole-graph regex search over node summaries +
 *  observation content, flat results each carrying `in <parent>`. `viewer`
 *  controls the match glyph rendering (Builder-only `new`). */
export function makeFindTool(graph: MemkeeperGraph, viewer: RenderViewer): AgentTool<typeof FIND_PARAMS> {
  return {
    name: FIND_TOOL,
    description:
      "Search the whole memory graph by regex — node summaries and observation content. Flat results, each showing its parent.",
    label: "Find",
    parameters: FIND_PARAMS,
    async execute(_toolCallId, params) {
      const includeSuperseded = params.includeSuperseded ?? INCLUDE_DEFAULT;
      const compiled = tryCompileFindRegex(params.query);
      if ("error" in compiled) {
        return { content: [{ type: "text", text: compiled.error }], details: { error: true } };
      }

      const matches = collectFindMatches(graph, compiled.regex, includeSuperseded, viewer);
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

// --- root view render + measure (shared by try_finish + fast-path) ---------

/** Render the non-obsolete root view (the same lines `ls` shows at the root) for
 *  `viewer`. Shared by try_finish (budget gate), the run's fast-path, and the
 *  per-pass user-message state snapshot. */
export function renderRootView(graph: MemkeeperGraph, viewer: RenderViewer): string {
  return renderRootViewFromRoots(nonObsoleteRoots(graph), viewer);
}

/** Render an already-collected set of non-obsolete roots for `viewer`. Lets a
 *  caller that already needs the roots list (e.g. the widget, which reads both
 *  the count and the view tokens) avoid recomputing `nonObsoleteRoots`. */
export function renderRootViewFromRoots(roots: Node[], viewer: RenderViewer): string {
  if (roots.length === 0) return "";
  return roots.map((n) => formatNodeLine(n, { viewer })).join("\n");
}

/** Token-estimate of the non-obsolete root view (chars/4), rendered for
 *  `viewer`. Shared by the fast-path (skip-when-under) and try_finish
 *  (within-budget gate). */
export function measureRootViewTokens(graph: MemkeeperGraph, viewer: RenderViewer): number {
  return estimateContentTokens(renderRootView(graph, viewer));
}

// --- try_finish (convergence gate) -----------------------------------------

/** Settings the try_finish gate needs: the budget threshold it checks against.
 *  Decoupled from the full MemkeeperConfig so the same factory serves the
 *  Builder (builderRootViewThreshold) and the Selector
 *  (selectorRootViewThreshold). */
export interface TryFinishThreshold {
  rootViewThreshold: number;
}

const TRY_FINISH_PARAMS = Type.Object({}, { description: "No parameters." });

/** Build the `try_finish` convergence gate: measures the non-obsolete root view
 *  (rendered for `viewer`) against `threshold.rootViewThreshold`. Within budget
 *  → success + terminate:true (stops the pass/run). Over budget → reject +
 *  terminate:false (keep organizing, call again). Deterministic/mechanical —
 *  no LLM. */
export function makeTryFinishTool(
  graph: MemkeeperGraph,
  threshold: TryFinishThreshold,
  viewer: RenderViewer,
): AgentTool<typeof TRY_FINISH_PARAMS> {
  return {
    name: TRY_FINISH_TOOL,
    description:
      "Signal the graph is organized and check the root view fits the budget. Accepts when it fits; otherwise reports the overrun and asks for more consolidation.",
    label: "Finish",
    parameters: TRY_FINISH_PARAMS,
    async execute(): Promise<AgentToolResult<unknown>> {
      const rootsViewTokens = measureRootViewTokens(graph, viewer);
      const thresholdTokens = threshold.rootViewThreshold;
      if (rootsViewTokens <= thresholdTokens) {
        return {
          content: [
            {
              type: "text",
              text: `Within budget: ${formatTokens(rootsViewTokens)} / ${formatTokens(thresholdTokens)}.`,
            },
          ],
          details: { ok: true, rootsViewTokens, threshold: thresholdTokens },
          terminate: true,
        };
      }
      return {
        content: [
          {
            type: "text",
            text: `Over budget: ${formatTokens(rootsViewTokens)} / ${formatTokens(thresholdTokens)}. Keep organizing, then call try_finish again.`,
          },
        ],
        details: { ok: false, rootsViewTokens, threshold: thresholdTokens },
        terminate: false,
      };
    },
  };
}

/** Read-only graph tools (ls/cat/find) bound to `graph` for `viewer`. */
export function makeReadTools(graph: MemkeeperGraph, viewer: RenderViewer): AgentTool[] {
  return [makeLsTool(graph, viewer), makeCatTool(graph, viewer), makeFindTool(graph, viewer)];
}
