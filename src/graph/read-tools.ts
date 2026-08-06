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
import { getMemkeeperSettings } from "../config/schema.js";
import { renderDetails } from "../format/details.js";
import {
  formatNodeLine,
  formatObservationLine,
  indent,
  NON_BUILDER,
  type RenderableNode,
  type RenderViewer,
} from "../format/render.js";
import { formatTokens } from "../format/tokens.js";
import { PageSchema } from "../schema.js";
import { getGraphStore } from "../store/graph-store.js";
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
import {
  budgetReachedFooter,
  budgetWindow,
  intersectRegexFilters,
  SOURCE_UNAVAILABLE_NOTE,
  searchableText,
} from "./result-budget.js";
import {
  type ContentMode,
  type GrepSpec,
  type RenderItem,
  renderBudgeted,
  resolveContentMode,
} from "./result-render.js";
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
 *  hardening is two-layer: a static `isSafeRegex` fast-reject (known-evil
 *  shapes) plus a worker-thread runtime cap (`findTimeoutMs`, regex-runner.ts)
 *  that kills any residual catastrophic pattern at the configured duration and
 *  returns partial matches. `find` accepts USER input (/mk:find); observations
 *  are condensed (short) and the graph is session-bounded, so the realistic
 *  blast radius is small, and the worker timeout bounds the worst case. */
const FIND_QUERY_MAX = 500;

const ROOT_DEPTH = 0;
export const NO_AFTER_ID: string | null = null;
/** Default value for an `includeSuperseded` flag (hide obsolete unless asked). */
const INCLUDE_DEFAULT = false;

/** Default context lines around a grep (contentPattern) match. */
const DEFAULT_CONTEXT_LINES = 2;
/** Named booleans for `resolveToolMode`'s default-full flag (no bare literals). */
const MODE_DEFAULT_FULL = true;
const MODE_DEFAULT_TERSE = false;
/** find has no `lines` param (incompatible with its required `query`); pass
 *  this so `resolveToolMode` never enters lines mode for a find call. */
const NO_LINES: string | undefined = undefined;

// --- extraction param schemas (contentPattern / contextLines / lines) -------
// Shared by `cat`, `find` (and mirrored in mk_recall). `ls` is structure-only,
// so it does NOT take these params.

const ContentPatternSchema = Type.Optional(
  Type.String({
    description:
      "Extract matching lines from observations as grep-style excerpts (with `contextLines` and line numbers) instead of the whole text — greps every observation, or just those an `ids` drill or `query` search returns.",
  }),
);
const ContextLinesSchema = Type.Optional(
  Type.Integer({
    minimum: 0,
    description: "Lines of context shown before and after each `contentPattern` match (default 2).",
  }),
);
const LinesSchema = Type.Optional(
  Type.String({
    description:
      "Read a line range (e.g. '40-60') of a single observation — pass an observation id, or a node id with one observation.",
  }),
);

/** Resolve a contentPattern (compile via the shared guard) into a GrepSpec, or
 *  null when contentPattern is absent. Returns an error string on a bad regex.
 *  Shared by cat/find (read-tools) and mk_recall (recall). */
export function resolveGrepSpec(
  contentPattern: string | undefined,
  contextLines: number | undefined,
): { grep: GrepSpec | null } | { error: string } {
  if (contentPattern === undefined || contentPattern === "") return { grep: null };
  const compiled = tryCompileFindRegex(contentPattern);
  if ("error" in compiled) return compiled;
  return { grep: { pattern: compiled.regex, context: contextLines ?? DEFAULT_CONTEXT_LINES } };
}

/** The result of resolving a tool's extraction params to a content mode — either
 *  the mode, or an error string to surface verbatim. Shared by cat + find. */
type ResolvedToolMode = ContentMode | { error: string };

/** Resolve the extraction params (contentPattern / contextLines / lines) plus
 *  the tool's default full flag to a content mode (cat defaults to full; find
 *  defaults to terse). */
function resolveToolMode(
  defaultFull: boolean,
  contentPattern: string | undefined,
  contextLines: number | undefined,
  lines: string | undefined,
): ResolvedToolMode {
  const grepRes = resolveGrepSpec(contentPattern, contextLines);
  if ("error" in grepRes) return grepRes;
  return resolveContentMode(defaultFull, grepRes.grep, lines);
}

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
  let startIdx = 0;
  if (page.afterId !== NO_AFTER_ID) {
    const i = items.findIndex((item) => item.id === page.afterId);
    if (i < 0) return { window: [], more: false, remaining: 0, stale: true };
    startIdx = i + 1;
  }
  // take === 0 means "all" — return the whole (cursor-shifted) list at once.
  if (page.take === TAKE_ALL) return { window: items.slice(startIdx), more: false, remaining: 0, stale: false };
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

/** The full tool result for a stale cursor: the message + zero-count/stale
 *  details. Shared by ls/cat/find so the 4 stale paths stay identical. */
function staleResult(page: ResolvedPage): AgentToolResult<unknown> {
  return {
    content: [{ type: "text", text: staleCursorMessage(page.afterId ?? "") }],
    details: { count: 0, stale: true },
  };
}

// --- ordering --------------------------------------------------------------

/** The node fields `compareNodeOrder` reads — structural, so it orders both the
 *  live `Node` and the render-only `RenderableNode` (snapshot/working-copy). */
export interface OrderableNode {
  importance: Node["importance"];
  timestamps: { rangeEnd: string };
}

/** Importance desc (crit→low), then rangeEnd recency desc (newer first). */
function compareNodeOrder<T extends OrderableNode>(a: T, b: T): number {
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
function compareObservationOrder(a: Observation, b: Observation): number {
  return b.timestamp.localeCompare(a.timestamp);
}

/** A node is obsolete when its state is "obsolete". */
function isObsolete(node: Node): boolean {
  return isObsoleteState(node.state);
}

/** A raw state is obsolete when it is "obsolete" (the visible-by-default gate;
 *  the operand form of `isObsolete` for sites that hold a `NodeState`, not a node). */
function isObsoleteState(state: Node["state"]): boolean {
  return state === "obsolete";
}

/** The single obsolete-visibility rule every read path shares: a node (by state)
 *  is visible in default listings unless obsolete, and obsolete nodes appear only
 *  when the caller opted into superseded items. */
export function isVisible(state: Node["state"], includeSuperseded: boolean): boolean {
  return !isObsoleteState(state) || includeSuperseded;
}

// --- root view + children --------------------------------------------------

/** The roots of the graph: nodes whose parentNode is null. */
function rootNodes(graph: MemkeeperGraph): Node[] {
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

/** Non-obsolete roots drawn from an arbitrary node collection (the persisted
 *  selected tree's nodes, a working copy, or `graph.nodes.values()`) — the
 *  shared filter behind `nonObsoleteRoots(graph)`, the compaction summary, the
 *  Selector working-tree render, and the status command. Filters roots
 *  (`parentNode === ROOT_PARENT`) and drops obsolete. UNSORTED: callers apply
 *  their own ordering (`compareNodeOrder` for the Builder view,
 *  `orderActiveSetRoots` for the active-set/summary render). */
export function nonObsoleteRootsOf<T extends RenderableNode>(nodes: Iterable<T>): T[] {
  const out: T[] = [];
  for (const n of nodes) {
    if (n.parentNode === ROOT_PARENT && !isObsoleteState(n.state)) out.push(n);
  }
  return out;
}

/** Non-obsolete root nodes, ordered (nGoal first, then the rest by importance
 *  + recency, nIrrelevant last) — the canonical "active-set roots" query used
 *  by the compaction summary, the Selector working roots, and render sites. */
export function orderedNonObsoleteRoots<T extends RenderableNode>(nodes: Iterable<T>): T[] {
  return orderActiveSetRoots(nonObsoleteRootsOf(nodes));
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

/** The per-call result token budget (chars/4) from config. */
function resultTokenBudget(): number {
  return getMemkeeperSettings().toolResultTokenBudget;
}

/** Apply the token budget to a paginated window of already-rendered one-line
 *  items, returning the kept lines + a footer that reflects whichever axis
 *  bound first (budget or item-count). When the budget truncates, the paginate
 *  cursor is advanced to the last *kept* item (the budget is the tighter axis). */
function renderTerseWindow(
  window: { id: string; render: string }[],
  budget: number,
  paginateMore: boolean,
  paginateRemaining: number,
): { text: string; count: number; more: boolean } {
  const budgeted = budgetWindow(
    window.map((i) => ({ id: i.id, text: i.render })),
    budget,
  );
  const lines = budgeted.kept.map((k) => k.text);
  const budgetDropped = budgeted.remaining;
  if (budgetDropped > 0) {
    lines.push(budgetReachedFooter(budgetDropped, budgeted.lastKeptId, "item"));
    return { text: renderLines(lines), count: budgeted.kept.length, more: true };
  }
  if (paginateMore && window.length > 0) {
    lines.push(footer(window[window.length - 1].id, paginateRemaining));
  }
  return { text: renderLines(lines), count: window.length, more: paginateMore };
}

/** Build the node-line render options for a graph-backed viewer, wiring the
 *  observation-content resolver so a bare `new` node renders its first obs's
 *  first line. */
export function nodeLineOptions(
  graph: MemkeeperGraph,
  viewer: RenderViewer,
): {
  viewer: RenderViewer;
  observationContent: (obsId: string) => string | undefined;
} {
  return {
    viewer,
    observationContent: (obsId: string): string | undefined => graph.observations.get(obsId as ObsId)?.summary,
  };
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
function makeLsTool(graph: MemkeeperGraph, viewer: RenderViewer): AgentTool<typeof LS_PARAMS> {
  return {
    name: LS_TOOL,
    description:
      "List one level of the memory graph — the root nodes, or a node's children (subnodes and observations).",
    label: "List",
    parameters: LS_PARAMS,
    async execute(_toolCallId, params) {
      const page = resolvePage(params.page);
      const budget = resultTokenBudget();

      if (params.nodeId === undefined || params.nodeId === null) {
        // roots: non-obsolete only (obsolete hidden by default — findable via find).
        const roots = nonObsoleteRoots(graph);
        const { window, more, remaining, stale } = paginate(roots, page);
        if (stale) {
          return staleResult(page);
        }
        const rendered = window.map((node) => ({
          id: node.id,
          render: formatNodeLine(node, nodeLineOptions(graph, viewer)),
        }));
        const out = renderTerseWindow(rendered, budget, more, remaining);
        return { content: [{ type: "text", text: out.text }], details: { count: out.count, more: out.more } };
      }

      const parent = graph.nodes.get(params.nodeId as NodeId);
      if (parent === undefined) {
        return { content: [{ type: "text", text: `No node with id ${params.nodeId}.` }], details: { error: true } };
      }
      // header is the parent itself at depth 0; children indented at depth 1.
      const headerLine = indent(formatNodeLine(parent, nodeLineOptions(graph, viewer)), ROOT_DEPTH);
      const { nodes, observations } = directChildren(graph, parent);
      const combined = [
        ...nodes.map((n) => ({ id: n.id, depth: 1, render: formatNodeLine(n, nodeLineOptions(graph, viewer)) })),
        ...observations.map((o) => ({ id: o.id, depth: 1, render: formatObservationLine(o, { viewer }) })),
      ];
      const { window, more, remaining, stale } = paginate(combined, page);
      if (stale) {
        return staleResult(page);
      }
      // the parent header rides outside the budgeted window (always shown); the
      // children window is budgeted by token count independently of `take`.
      const rendered = window.map((item) => ({ id: item.id, render: indent(item.render, item.depth) }));
      const out = renderTerseWindow(rendered, budget, more, remaining);
      return {
        content: [{ type: "text", text: renderLines([headerLine, out.text]) }],
        details: { count: out.count, more: out.more },
      };
    },
  };
}

// --- cat -------------------------------------------------------------------

const CAT_PARAMS = Type.Object({
  ids: Type.Array(Type.String(), {
    minItems: 1,
    description: "Ids to read in full — observations and/or nodes. At least one.",
  }),
  contentPattern: ContentPatternSchema,
  contextLines: ContextLinesSchema,
  lines: LinesSchema,
  page: Type.Optional(PageSchema),
});

/** Build the `cat` tool: read full text — observations verbatim, or a node's
 *  header plus its direct observations verbatim (child nodes NOT expanded).
 *  `viewer` controls the node-header glyph rendering (Builder-only `new`). */
function makeCatTool(graph: MemkeeperGraph, viewer: RenderViewer): AgentTool<typeof CAT_PARAMS> {
  return {
    name: CAT_TOOL,
    description:
      "Read full text — an observation's content, or a node's header plus the full text of its direct observations. Sub-nodes are not expanded here (use `ls` for them). `ls` shows one-line structure; `cat` shows full content. Use `contentPattern` for grep-style excerpts or `lines` for a line range instead of the whole content.",
    label: "Read full text",
    parameters: CAT_PARAMS,
    async execute(_toolCallId, params) {
      const page = resolvePage(params.page);
      // resolve content mode + budget. cat is a full read, so the default mode
      // is `full`; grep/lines override it. `lines` and `contentPattern` are
      // mutually exclusive (resolveContentMode errors if both are set). A
      // single-observation target is unbudgeted in any mode.
      const modeRes = resolveToolMode(MODE_DEFAULT_FULL, params.contentPattern, params.contextLines, params.lines);
      if ("error" in modeRes) {
        return { content: [{ type: "text", text: modeRes.error }], details: { error: true } };
      }
      // `lines` reads a range of ONE observation — error unless the ids resolve
      // to exactly one connected observation (an obs id, or a node with one).
      if (modeRes.kind === "lines" && singleObsTargetCount(graph, params.ids) !== 1) {
        return {
          content: [
            {
              type: "text",
              text: "`lines` reads a range of a single observation — pass one observation id, or a node id with one observation.",
            },
          ],
          details: { error: true },
        };
      }

      // A single-observation target is unbudgeted in ANY mode (full / lines /
      // grep): the cap lifts, but the mode still applies. Counts the TARGET's
      // connected observations (not the paginated window), so a small `take`
      // on a multi-observation node is not wrongly uncapped.
      const singleObs = singleObsTargetCount(graph, params.ids) === 1;
      const budget = singleObs ? null : resultTokenBudget();

      // grep mode: contentPattern filters the ids target (grep-tree pruning,
      // a node is kept when its summary matches OR a child observation
      // matches; a non-matching standalone observation is dropped. The surviving
      // items then go through the shared budgeted grep renderer (every survivor
      // carries excerpts). Non-grep modes render every requested id.
      let items: RenderItem[];
      let grepNote: string | undefined;
      if (modeRes.kind === "grep") {
        const pruned = await buildCatGrepItemsWithMatches(graph, params.ids, viewer, modeRes);
        if ("error" in pruned) {
          return { content: [{ type: "text", text: pruned.error }], details: { error: true } };
        }
        items = pruned.items;
        grepNote = pruned.note;
      } else {
        const units = buildCatUnits(graph, params.ids, viewer);
        items = units.map(catUnitToItem);
      }

      const { window, more, remaining, stale } = paginate(items, page);
      if (stale) {
        return staleResult(page);
      }
      if (window.length === 0) {
        const empty = modeRes.kind === "grep" ? "No matches." : "No observations.";
        return { content: [{ type: "text", text: grepNote ?? empty }], details: { count: 0, more: false } };
      }
      const rendered = await renderBudgeted(window, {
        budget,
        mode: modeRes,
        findTimeoutMs: getMemkeeperSettings().findTimeoutMs,
      });
      const lines: string[] = [rendered.text];
      if (rendered.note !== null) {
        lines.push(rendered.note);
      } else if (grepNote !== undefined) {
        lines.push(grepNote);
      } else if (more && window.length > 0) {
        lines.push(footer(window[window.length - 1].id, remaining));
      }
      const text = lines.filter((l) => l !== "").join("\n");
      return {
        content: [{ type: "text", text }],
        details: { count: window.length, more: more || rendered.note !== null },
      };
    },
  };
}

/** A content-free header for a cat observation block: `id · importance · size · timestamp`
 *  (NO content — that's the body; NO sourceEntryIds — provenance is internal).
 *  Delegates to the shared formatObservationLine with content omitted, so the
 *  header stays byte-identical to every other observation line prefix. */
function catObsHeader(obs: Observation): string {
  return formatObservationLine(obs, { viewer: NON_BUILDER, formatContent: () => "" });
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

/** Resolve an observation's verbatim-source details text (full render, no
 *  entry=id) for the cat/find body. Uses the GraphStore session resolver; returns
 *  the one-line summary when the verbatim source is unavailable (source_unavailable)
 *  so the body still has something to show. Returns undefined for an unknown id. */
function detailsTextFor(obs: Observation): string {
  const resolver = getGraphStore().resolveEntries;
  if (resolver === null) return obs.summary;
  const render = renderDetails(obs.id, [...obs.sourceEntryIds], resolver);
  return render === null ? obs.summary : render.text;
}

/** The source-unavailable marker appended to a cat/full body when the verbatim
 *  source can't render, so the consumer knows the full source is gone (the
 *  one-line summary is the fallback body). Mirrors mk_recall's degradation. */
/** Cat display body for an observation: the verbatim source when available,
 *  else the one-line summary + a source-unavailable note. (The match/grep-text
 *  path uses `detailsTextFor` directly — no note, so the marker isn't
 *  searchable.) */
function catBody(obs: Observation): string {
  const resolver = getGraphStore().resolveEntries;
  const available = resolver !== null && renderDetails(obs.id, [...obs.sourceEntryIds], resolver) !== null;
  return available ? detailsTextFor(obs) : `${detailsTextFor(obs)}\n${SOURCE_UNAVAILABLE_NOTE}`;
}

/** Count the observations a single id resolves to: 1 if the id is an
 *  observation, the node's connected-observation count if the id is a node, 0
 *  otherwise. Shared by the agent find/cat path and mk_recall to detect a
 *  single-observation uncapped target (one connected observation → returned
 *  whole in any mode). */
export function countConnectedObservations(
  nodes: Map<string, { observationIds: readonly string[] }>,
  observations: Map<string, unknown>,
  id: string,
): number {
  const node = nodes.get(id);
  if (node !== undefined) return node.observationIds.length;
  return observations.has(id) ? 1 : 0;
}

/** Sum `countConnectedObservations` over a list of ids against a graph — the
 *  total a target resolves to. A single-observation target (total === 1) is
 *  unbudgeted in any mode. */
function singleObsTargetCount(graph: MemkeeperGraph, ids: string[]): number {
  let total = 0;
  for (const id of ids) {
    total += countConnectedObservations(graph.nodes, graph.observations, id);
  }
  return total;
}

/** Build the cat units for a list of requested ids: each node expands to its
 *  direct observations (the node header rides the first as a preamble); each
 *  observation is one unit; unknown ids are a not-found unit. */
export function buildCatUnits(graph: MemkeeperGraph, ids: string[], viewer: RenderViewer): CatUnit[] {
  const units: CatUnit[] = [];
  for (const id of ids) {
    const node = graph.nodes.get(id as NodeId);
    if (node !== undefined) {
      const nodeHeader = formatNodeLine(node, nodeLineOptions(graph, viewer));
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
          content: catBody(o),
        });
      });
      continue;
    }
    const obs = graph.observations.get(id as ObsId);
    if (obs !== undefined) {
      units.push({ id: obs.id, header: catObsHeader(obs), content: catBody(obs) });
      continue;
    }
    units.push({ id, header: `No node or observation with id ${id}.` });
  }
  return units;
}

/** Map a cat unit to a budgeted render item: the preamble (node header, shown
 *  once on the first observation of a node) is folded into the item header so
 *  the budget treats it as part of that observation's block. */
function catUnitToItem(unit: CatUnit): RenderItem {
  const header = unit.preamble !== undefined ? `${unit.preamble}\n${unit.header}` : unit.header;
  return { id: unit.id, header, content: unit.content };
}

/** Build the cat render items for a contentPattern (grep) read with grep-tree
 *  pruning: a requested node is kept when its summary matches OR a child
 *  observation matches (its header rides the first surviving observation, or is
 *  a header-only item on a summary-only match); a non-matching standalone
 *  observation is dropped. Pre-filtered items then go through the shared
 *  budgeted grep renderer (every surviving observation carries excerpts). */
function buildCatGrepItems(
  graph: MemkeeperGraph,
  ids: readonly string[],
  viewer: RenderViewer,
  summaryMatch: ReadonlySet<string>,
  obsMatch: ReadonlySet<string>,
): RenderItem[] {
  const items: RenderItem[] = [];
  for (const id of ids) {
    const node = graph.nodes.get(id as NodeId);
    if (node !== undefined) {
      const nodeHeader = formatNodeLine(node, nodeLineOptions(graph, viewer));
      const matchingObs = node.observationIds
        .map((oid) => graph.observations.get(oid))
        .filter((o): o is Observation => o !== undefined && obsMatch.has(o.id))
        .sort(compareObservationOrder);
      // drop the node entirely when neither its summary nor any child matches.
      if (!summaryMatch.has(node.id) && matchingObs.length === 0) continue;
      if (matchingObs.length === 0) {
        // summary-only match → header-only item (no content to grep).
        items.push({ id: node.id, header: nodeHeader });
        continue;
      }
      matchingObs.forEach((o, index) => {
        const header = index === 0 ? `${nodeHeader}\n${catObsHeader(o)}` : catObsHeader(o);
        items.push({ id: o.id, header, content: catBody(o) });
      });
      continue;
    }
    const obs = graph.observations.get(id as ObsId);
    if (obs !== undefined) {
      if (obsMatch.has(obs.id)) {
        items.push({ id: obs.id, header: catObsHeader(obs), content: catBody(obs) });
      }
    }
    // missing id: silently dropped in grep mode (nothing matched).
  }
  return items;
}

/** Compute contentPattern matches (node summaries + observation content) in
 *  ONE worker round-trip, then build the pruned cat grep items. */
async function buildCatGrepItemsWithMatches(
  graph: MemkeeperGraph,
  ids: readonly string[],
  viewer: RenderViewer,
  grep: Extract<ContentMode, { kind: "grep" }>,
): Promise<{ items: RenderItem[]; note?: string } | { error: string }> {
  // gather summary nodes (requested nodes + their direct child nodes) + all
  // referenced observations in one batch so a single worker run covers both.
  const summaryNodes: Node[] = [];
  const obsList: Observation[] = [];
  const seenObs = new Set<string>();
  for (const id of ids) {
    const node = graph.nodes.get(id as NodeId);
    if (node !== undefined) {
      summaryNodes.push(node);
      for (const cid of node.childNodeIds) {
        const child = graph.nodes.get(cid);
        if (child !== undefined) summaryNodes.push(child);
      }
      for (const oid of node.observationIds) {
        const o = graph.observations.get(oid);
        if (o !== undefined && !seenObs.has(o.id)) {
          seenObs.add(o.id);
          obsList.push(o);
        }
      }
    } else {
      const o = graph.observations.get(id as ObsId);
      if (o !== undefined && !seenObs.has(o.id)) {
        seenObs.add(o.id);
        obsList.push(o);
      }
    }
  }
  const texts = [
    ...summaryNodes.map((n) => n.summary),
    ...obsList.map((o) => searchableText(o.summary, detailsTextFor(o))),
  ];
  // Reuse the shared regex-batch helper (worker-bounded, findTimeoutMs) so the
  // timeout note matches find/mk_recall exactly instead of a hand-rolled variant.
  const result = await intersectRegexFilters(texts, [grep.pattern]);
  if ("error" in result) return { error: result.error };
  const summaryMatch = new Set<string>();
  for (let i = 0; i < summaryNodes.length; i += 1) {
    if (result.passes[i]) summaryMatch.add(summaryNodes[i].id);
  }
  const obsMatch = new Set<string>();
  for (let i = 0; i < obsList.length; i += 1) {
    if (result.passes[summaryNodes.length + i]) obsMatch.add(obsList[i].id);
  }
  const items = buildCatGrepItems(graph, ids, viewer, summaryMatch, obsMatch);
  return { items, note: result.note };
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
  query: Type.Optional(
    Type.String({
      description:
        "Find items by regex (JS) over node summaries and observation content. A pattern that runs too long is stopped; partial matches come back with a note to narrow the query.",
    }),
  ),
  includeSuperseded: Type.Optional(
    Type.Boolean({ description: "Include superseded and obsolete items (default false — current memory only)." }),
  ),
  contentPattern: ContentPatternSchema,
  contextLines: ContextLinesSchema,
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
 *  `/mk:find` commands.
 *
 *  Async because the regex tests run in a worker thread bounded by
 *  `findTimeoutMs` (a catastrophic pattern is killed instead of freezing pi).
 *  Returns the matches, or an error string the caller surfaces verbatim. */
export async function collectFindMatches(
  graph: MemkeeperGraph,
  regexes: readonly RegExp[],
  includeSuperseded: IncludeSuperseded,
  viewer: RenderViewer,
): Promise<{ matches: FindMatch[]; note?: string } | { error: string }> {
  // gather candidates first (preserving node-then-obs grouping), then batch-test
  // every text against EVERY regex (intersection: an item passes only if it
  // matches all regexes — used by find to intersect query + contentPattern).
  const nodeJobs: { node: Node; text: string }[] = [];
  const obsJobs: { obs: Observation; parent: NodeId }[] = [];
  for (const node of graph.nodes.values()) {
    // obsolete-visibility gate: skip the node (and its evidence) unless the
    // caller opted into superseded items.
    if (!isVisible(node.state, includeSuperseded)) continue;
    nodeJobs.push({ node, text: node.summary });
    for (const obsId of node.observationIds) {
      const obs = graph.observations.get(obsId);
      if (obs === undefined) continue;
      obsJobs.push({ obs, parent: node.id });
    }
  }
  // observations match over summary + DETAILS (verbatim source) so a
  // query/contentPattern finds obs whose verbatim source hits; nodes match over
  // summary only.
  const texts: string[] = [
    ...nodeJobs.map((j) => j.text),
    ...obsJobs.map((j) => searchableText(j.obs.summary, detailsTextFor(j.obs))),
  ];
  const nodeCount = nodeJobs.length;
  // an item passes the intersection only if it matches EVERY regex (worker-bounded).
  const filtered = await intersectRegexFilters(texts, regexes);
  if ("error" in filtered) return { error: filtered.error };
  const passes = filtered.passes;

  const nodeMatches: NodeMatch[] = [];
  const obsMatches: ObsMatch[] = [];
  for (let i = 0; i < nodeJobs.length; i += 1) {
    if (passes[i]) {
      const { node } = nodeJobs[i];
      nodeMatches.push({
        id: node.id,
        node,
        render: formatNodeLine(node, { ...nodeLineOptions(graph, viewer), showParent: node.parentNode ?? undefined }),
      });
    }
  }
  for (let i = 0; i < obsJobs.length; i += 1) {
    if (passes[nodeCount + i]) {
      const { obs, parent } = obsJobs[i];
      obsMatches.push({
        id: obs.id,
        obs,
        render: formatObservationLine(obs, { viewer, showParent: parent }),
      });
    }
  }
  // nodes-first (importance desc, then recency), then observations (recency) —
  // consistent with `ls`.
  nodeMatches.sort((a, b) => compareNodeOrder(a.node, b.node));
  obsMatches.sort((a, b) => compareObservationOrder(a.obs, b.obs));
  return { matches: [...nodeMatches, ...obsMatches], note: filtered.note };
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
function makeFindTool(graph: MemkeeperGraph, viewer: RenderViewer): AgentTool<typeof FIND_PARAMS> {
  return {
    name: FIND_TOOL,
    description: "Search the whole memory graph by regex through node summaries and observation content.",
    label: "Find",
    parameters: FIND_PARAMS,
    async execute(_toolCallId, params) {
      const includeSuperseded = params.includeSuperseded ?? INCLUDE_DEFAULT;
      const hasContentPattern = params.contentPattern !== undefined && params.contentPattern !== "";
      const hasQuery = params.query !== undefined && params.query !== "";
      if (!hasQuery && !hasContentPattern) {
        return {
          content: [{ type: "text", text: "Pass `query` or `contentPattern` to search the graph." }],
          details: { error: true },
        };
      }
      // resolve content mode first (compiles contentPattern; find has no `lines`).
      const modeRes = resolveToolMode(MODE_DEFAULT_TERSE, params.contentPattern, params.contextLines, NO_LINES);
      if ("error" in modeRes) {
        return { content: [{ type: "text", text: modeRes.error }], details: { error: true } };
      }

      // contentPattern is a FILTER over node summaries + observation content
      // (same scope as `query`) — not obs-only. When both are given they
      // intersect (an item must match both). contentPattern also switches the
      // render to grep excerpts for matching observations.
      const filterRegexes: RegExp[] = [];
      if (params.query !== undefined && params.query !== "") {
        const compiled = tryCompileFindRegex(params.query);
        if ("error" in compiled) {
          return { content: [{ type: "text", text: compiled.error }], details: { error: true } };
        }
        filterRegexes.push(compiled.regex);
      }
      if (modeRes.kind === "grep") {
        filterRegexes.push(modeRes.pattern);
      }
      const collected = await collectFindMatches(graph, filterRegexes, includeSuperseded, viewer);
      if ("error" in collected) {
        return { content: [{ type: "text", text: collected.error }], details: { error: true } };
      }
      const matches = collected.matches;
      const page = resolvePage(params.page);
      const { window, more, remaining, stale } = paginate(matches, page);
      if (stale) {
        return staleResult(page);
      }
      if (window.length === 0) {
        const empty = collected.note ?? "No matches.";
        return { content: [{ type: "text", text: empty }], details: { count: 0, more: false } };
      }

      const budget = resultTokenBudget();
      if (modeRes.kind === "terse") {
        // terse: one-line matches, budgeted independently of `take`.
        const rendered = window.map((m) => ({ id: m.id, render: m.render }));
        const out = renderTerseWindow(rendered, budget, more, remaining);
        const text = collected.note !== undefined ? `${out.text}\n${collected.note}` : out.text;
        return { content: [{ type: "text", text }], details: { count: out.count, more: out.more } };
      }

      // grep: matching observations render contentPattern excerpts; matching
      // nodes render headers (candidates are pre-filtered by contentPattern).
      const items: RenderItem[] = window.map((m) => {
        const match = m as FindMatch & { obs?: Observation };
        return { id: m.id, header: m.render, content: match.obs !== undefined ? detailsTextFor(match.obs) : undefined };
      });
      const rendered = await renderBudgeted(items, {
        budget,
        mode: modeRes,
        findTimeoutMs: getMemkeeperSettings().findTimeoutMs,
      });
      const lines = [rendered.text];
      if (rendered.note !== null) lines.push(rendered.note);
      else if (more) lines.push(footer(window[window.length - 1].id, remaining));
      if (collected.note !== undefined) lines.push(collected.note);
      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: { count: window.length, more: more || rendered.note !== null },
      };
    },
  };
}

// --- root view render + measure (shared by try_finish + fast-path) ---------

/** Render the non-obsolete root view (the same lines `ls` shows at the root) for
 *  `viewer`. Shared by try_finish (budget gate), the run's fast-path, and the
 *  per-pass user-message state snapshot. */
export function renderRootView(graph: MemkeeperGraph, viewer: RenderViewer): string {
  return renderRootViewFromRoots(nonObsoleteRoots(graph), viewer, nodeLineOptions(graph, viewer).observationContent);
}

/** Resolver that yields no observation content (for callers without
 *  observation-content access — e.g. measuring a detached selected tree). */
export const NO_OBSERVATION_CONTENT = (_obsId: string): undefined => undefined;

/** Render an already-collected set of non-obsolete roots for `viewer`. Lets a
 *  caller that already needs the roots list (e.g. the widget, which reads both
 *  the count and the view tokens) avoid recomputing `nonObsoleteRoots`. The
 *  observation-content resolver wires the bare-`new`-node first-obs-line
 *  fallback so token measurement matches the displayed render; pass
 *  NO_OBSERVATION_CONTENT when the caller has no observation access. */
export function renderRootViewFromRoots(
  roots: Node[],
  viewer: RenderViewer,
  observationContent: (obsId: string) => string | undefined,
): string {
  if (roots.length === 0) return "";
  return roots.map((n) => formatNodeLine(n, { viewer, observationContent })).join("\n");
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
      "Call when you've finished organizing. Ends the run if the root view fits the budget; otherwise reports the overrun so you can consolidate more.",
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
