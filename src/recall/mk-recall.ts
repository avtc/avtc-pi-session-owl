// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// mk_recall — the agent's single read-only drill-down tool over preserved
// memory. Registered via pi.registerTool as a ToolDefinition (the main agent's
// tool, NOT passed to any agentLoop). Targets the rendered tree per renderMode:
// the source observations graph in observations-root, the persisted selected
// tree in selected-root (falling back to the source graph when no tree exists
// yet). Read-only; never mutates.

import type { Theme, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { getMemkeeperSettings } from "../config/schema.js";
import { renderDetails } from "../format/details.js";
import {
  formatNodeLine,
  formatObservationLine,
  indent,
  NON_BUILDER,
  type RenderableNode,
  type RenderableObservation,
  type RenderViewer,
  singleDirectObs,
  singleLine,
} from "../format/render.js";
import {
  countConnectedObservations,
  DEFAULT_TAKE,
  isVisible,
  NO_AFTER_ID,
  orderActiveSetRoots,
  paginate,
  type ResolvedPage,
  resolveGrepSpec,
  resolvePage,
  staleCursorMessage,
  tryCompileFindRegex,
} from "../graph/read-tools.js";
import { runRegexTests } from "../graph/regex-runner.js";
import {
  budgetReachedFooter,
  budgetWindow,
  grepTimeoutNote,
  intersectRegexFilters,
  runGrepExcerpts,
  SOURCE_UNAVAILABLE_NOTE,
  searchableText,
} from "../graph/result-budget.js";
import { type ContentMode, contentBlock, grepBlock, resolveContentMode } from "../graph/result-render.js";
import type { SerializedNode, SerializedObservation, SerializedSelection } from "../store/codecs.js";
import { getGraphStore } from "../store/graph-store.js";
import { IMPORTANCE_RANK, type Importance, type MemkeeperGraph, type NodeId, type ObsId } from "../types.js";

// --- named constants (no bare literals at call sites) ----------------------

export const MK_RECALL_TOOL = "mk_recall";
const VIEWER: RenderViewer = NON_BUILDER;
/** Single-line content cap for terse results (full content shows in fullDetails). */
const TERSE_CONTENT_MAX = 120;
const TRUNCATION_ELLIPSIS = "…";
const CHILD_DEPTH = 1;
/** Maximum lines a collapsed (non-expanded) transcript render shows. */
const COLLAPSED_LINE_LIMIT = 12;
/** Appended under a truncated collapsed render — expanding shows the full text. */
const EXPAND_HINT = "(Ctrl+O to expand)";
/** Named undefined for an observation block's showParent (no bare literals). */
const NO_PARENT: string | undefined = undefined;
/** Named undefined for the pre-computed grep excerpts arg (no bare literals). */
const NO_EXCERPTS: readonly string[] | undefined = undefined;

// --- normalized recall target ----------------------------------------------

// A recall target unifies the two read sources — the live source graph (Node +
// Observation) and the persisted selected tree (self-contained SerializedNode
// deep copies + observation id refs resolved from the immutable source store).
// Both Node and SerializedNode structurally satisfy RenderableNode; both
// Observation and SerializedObservation satisfy RenderableObservation, so the
// ranking + render logic operates on one shape regardless of source.

interface RecallTarget {
  readonly renderMode: "observations-root" | "selected-root";
  /** All nodes, keyed by id. */
  readonly nodes: Map<string, RenderableNode>;
  /** All observations, keyed by id (tree mode resolves refs from the source store). */
  readonly observations: Map<string, RecallObservation>;
}

/** A renderable observation plus its parent-node id (needed for the parent-state
 *  search gate + the `in <parent>` render — fields the shared render contract
 *  does not carry). Satisfied by both Observation and SerializedObservation. */
interface RecallObservation extends RenderableObservation {
  readonly parentNode: string;
}

/** Map each observation id to its tree-node parent (the Selector's curated
 *  placement, which may differ from the source-graph parent). */
function buildTreeObsParent(selection: SerializedSelection): Map<string, string> {
  const treeObsParent = new Map<string, string>();
  for (const sn of selection.nodes) {
    for (const obsId of sn.observationIds) treeObsParent.set(obsId, sn.id);
  }
  return treeObsParent;
}

/** Resolve a tree observation to a recall view: oInitialPrompt is carried
 *  verbatim in its own field; any other obs id is resolved from the immutable
 *  source store and re-parented to its curated tree node. Returns undefined if
 *  the id is not present (caller skips). */
function resolveTreeObs(
  selection: SerializedSelection,
  sourceGraph: MemkeeperGraph,
  obsId: string,
  treeObsParent: Map<string, string>,
): RecallObservation | undefined {
  if (selection.oInitialPrompt !== null && obsId === selection.oInitialPrompt.id) {
    return withTreeParent(serializedObservationToView(selection.oInitialPrompt), treeObsParent);
  }
  const source = sourceGraph.observations.get(obsId as ObsId);
  if (source === undefined) return undefined;
  return withTreeParent(source, treeObsParent);
}

/** Build a recall target over the live source graph. The source graph's own
 *  node/observation maps are referenced directly (no eager copy) — the live
 *  graph is read-only during a recall call, and `Observation`/`Node` already
 *  satisfy the renderable view types. */
function targetFromSourceGraph(graph: MemkeeperGraph): RecallTarget {
  return {
    renderMode: "observations-root",
    nodes: graph.nodes as Map<string, RenderableNode>,
    observations: graph.observations as Map<string, RecallObservation>,
  };
}

/** Build a recall target over the persisted selected tree. Nodes are the tree's
 *  own self-contained deep copies; observations are id refs resolved from the
 *  immutable source observation store (observations are never removed). The
 *  observation's PARENT is taken from the tree structure (the Selector may have
 *  regrouped an obs under a different node than the source), NOT from the source
 *  obs.parentNode — so the search `in <parent>` render + parent-state gate use
 *  the curated tree parent. */
function targetFromSelection(selection: SerializedSelection, sourceGraph: MemkeeperGraph): RecallTarget {
  const nodes = new Map<string, RenderableNode>();
  for (const sn of selection.nodes) nodes.set(sn.id, serializedNodeToView(sn));

  const treeObsParent = buildTreeObsParent(selection);
  const observations = new Map<string, RecallObservation>();
  for (const ref of selection.obsRefs) {
    const view = resolveTreeObs(selection, sourceGraph, ref, treeObsParent);
    if (view !== undefined) observations.set(view.id, view);
  }
  return { renderMode: "selected-root", nodes, observations };
}

/** Materialize an `ids` drill into the accumulator maps. For each id: if it
 *  resolves to a node, add the node + its direct child nodes + its connected
 *  observations; otherwise add it as an observation. `resolveNode` serves both
 *  the requested id and child ids (same backing lookup in both call sites),
 *  and each observation is added at most once. Shared by the source-graph and
 *  selected-tree focused-id builders. */
function materializeFocusedIds(
  ids: readonly string[],
  nodes: Map<string, RenderableNode>,
  observations: Map<string, RecallObservation>,
  resolveNode: (id: string) => RenderableNode | undefined,
  resolveObs: (id: string) => RecallObservation | undefined,
): void {
  for (const id of ids) {
    const node = resolveNode(id);
    if (node !== undefined) {
      nodes.set(node.id, node);
      for (const childId of node.childNodeIds) {
        const child = resolveNode(childId);
        if (child !== undefined) nodes.set(child.id, child);
      }
      for (const obsId of node.observationIds) {
        if (!observations.has(obsId)) {
          const obs = resolveObs(obsId);
          if (obs !== undefined) observations.set(obsId, obs);
        }
      }
      continue;
    }
    if (!observations.has(id)) {
      const obs = resolveObs(id);
      if (obs !== undefined) observations.set(id, obs);
    }
  }
}

/** Build a FOCUSED recall target over the source graph for an `ids` drill:
 *  materialize only the requested nodes + their direct children + requested
 *  observations, instead of iterating the whole graph. */
function targetFromSourceGraphForIds(graph: MemkeeperGraph, ids: readonly string[]): RecallTarget {
  const nodes = new Map<string, RenderableNode>();
  const observations = new Map<string, RecallObservation>();
  materializeFocusedIds(
    ids,
    nodes,
    observations,
    (id) => graph.nodes.get(id as NodeId),
    (id) => graph.observations.get(id as ObsId),
  );
  return { renderMode: "observations-root", nodes, observations };
}

/** Build a FOCUSED recall target over the persisted selected tree for an `ids`
 *  drill: materialize only the requested nodes + their direct children +
 *  requested observations (resolved from the immutable source store). The
 *  tree-parent map is built once so observation parents use the curated
 *  placement, mirroring the full targetFromSelection path. */
function targetFromSelectionForIds(
  selection: SerializedSelection,
  sourceGraph: MemkeeperGraph,
  ids: readonly string[],
): RecallTarget {
  const byId = new Map<string, SerializedNode>();
  for (const sn of selection.nodes) byId.set(sn.id, sn);
  const treeObsParent = buildTreeObsParent(selection);
  const resolveNode = (id: string): RenderableNode | undefined => {
    const sn = byId.get(id);
    return sn === undefined ? undefined : serializedNodeToView(sn);
  };
  const resolveObs = (id: string): RecallObservation | undefined =>
    resolveTreeObs(selection, sourceGraph, id, treeObsParent);
  const nodes = new Map<string, RenderableNode>();
  const observations = new Map<string, RecallObservation>();
  materializeFocusedIds(ids, nodes, observations, resolveNode, resolveObs);
  return { renderMode: "selected-root", nodes, observations };
}

/** Override an observation's parentNode with its curated tree parent when the
 *  tree places it under a different node than the source graph. */
function withTreeParent(obs: RecallObservation, treeObsParent: Map<string, string>): RecallObservation {
  const treeParent = treeObsParent.get(obs.id);
  if (treeParent === undefined) return obs;
  return { ...obs, parentNode: treeParent };
}

/** A SerializedNode already satisfies RenderableNode; this narrows to the view
 *  shape (drops wire-only fields) so the render layer reads exactly its contract. */
function serializedNodeToView(sn: SerializedNode): RenderableNode {
  return {
    id: sn.id,
    summary: sn.summary,
    state: sn.state,
    importance: sn.importance,
    parentNode: sn.parentNode,
    supersededBy: sn.supersededBy,
    childNodeIds: sn.childNodeIds,
    observationIds: sn.observationIds,
    timestamps: { rangeStart: sn.timestamps.rangeStart, rangeEnd: sn.timestamps.rangeEnd },
  };
}

/** A SerializedObservation already satisfies the render shape; carry parentNode
 *  through so the search gate + `in <parent>` render work on tree observations too. */
function serializedObservationToView(so: SerializedObservation): RecallObservation {
  return {
    id: so.id,
    summary: so.summary,
    importance: so.importance,
    timestamp: so.timestamp,
    parentNode: so.parentNode,
    detailsLines: so.detailsLines,
    detailsTokens: so.detailsTokens,
    sourceEntryIds: so.sourceEntryIds,
  };
}

/** Resolve an observation's verbatim-source details text (full render, no
 *  entry=id) from its sourceEntryIds via the session resolver. Returns null
 *  when source is unavailable (source_unavailable — the one-line summary
 *  still renders; only the verbatim body is gone). Lazily cached per obs by
 *  renderDetails. */
export type DetailsProvider = (obsId: string) => string | null;

/** Build a DetailsProvider bound to a recall target (uses the GraphStore session
 *  resolver; returns a null-only provider when the resolver is absent — e.g.
 *  tests without a session). */
function makeDetailsProvider(target: RecallTarget): DetailsProvider {
  const resolver = getGraphStore().resolveEntries;
  if (resolver === null) return () => null;
  return (obsId: string): string | null => {
    const obs = target.observations.get(obsId);
    if (obs === undefined) return null;
    const render = renderDetails(obsId, [...obs.sourceEntryIds], resolver);
    return render === null ? null : render.text;
  };
}

/** Resolve the active recall target from the live renderMode + store state. */
function resolveTarget(): RecallTarget {
  const store = getGraphStore();
  const settings = getMemkeeperSettings();
  if (settings.renderMode === "observations-root") {
    return targetFromSourceGraph(store.graph);
  }
  // selected-root: use the persisted tree when present, else fall back to the
  // source graph (recall never has an undefined target).
  if (store.selectedTree !== null) {
    return targetFromSelection(store.selectedTree, store.graph);
  }
  return targetFromSourceGraph(store.graph);
}

/** Resolve a FOCUSED target for an `ids` drill: only the requested ids + the
 *  direct children of requested nodes are materialized (not the whole graph).
 *  The `ids` path bypasses ranking + includeSuperseded, so it never needs the
 *  full node/observation Maps — building them over the whole (unbounded)
 *  retained observation set per single-id drill is pure waste. */
function resolveTargetForIds(ids: readonly string[]): RecallTarget {
  const store = getGraphStore();
  const settings = getMemkeeperSettings();
  if (settings.renderMode === "observations-root") {
    return targetFromSourceGraphForIds(store.graph, ids);
  }
  if (store.selectedTree !== null) {
    return targetFromSelectionForIds(store.selectedTree, store.graph, ids);
  }
  return targetFromSourceGraphForIds(store.graph, ids);
}

// --- ranking ---------------------------------------------------------------

interface RankKey {
  readonly importanceRank: number;
  readonly recency: string;
}

/** A ranked search candidate: the entity + its composite rank key + a flat
 *  render line carrying `in <parent>`. */
interface SearchCandidate {
  readonly id: string;
  readonly key: RankKey;
  /** The one-line header (terse). Observation candidates also carry `obs` so the
   *  content can be expanded/extracted by the budget layer under the active
   *  content mode.*/
  readonly line: string;
  readonly obs?: RecallObservation;
}

/** Importance desc, then recency desc (lexicographic on the UTC ISO instant). */
function compareCandidates(a: SearchCandidate, b: SearchCandidate): number {
  const byImportance = b.key.importanceRank - a.key.importanceRank;
  if (byImportance !== 0) return byImportance;
  return b.key.recency.localeCompare(a.key.recency);
}

/** max(obs.importance, parent.importance) — node importance lifts evidence
 *  without mutating the immutable observation. */
function observationImportanceRank(obs: RenderableObservation, parent: RenderableNode | null): number {
  const own = IMPORTANCE_RANK[obs.importance];
  if (parent === null) return own;
  return Math.max(own, IMPORTANCE_RANK[parent.importance]);
}

function importanceRankOf(level: Importance): number {
  return IMPORTANCE_RANK[level];
}

// --- terse truncation ------------------------------------------------------

/** Collapse a string to one line and cap its length, appending an ellipsis when
 *  truncated. Terse results stay compact; fullDetails shows the raw content. */
function terseSingleLine(text: string): string {
  const oneLine = singleLine(text);
  if (oneLine.length <= TERSE_CONTENT_MAX) return oneLine;
  return `${oneLine.slice(0, TERSE_CONTENT_MAX - TRUNCATION_ELLIPSIS.length)}${TRUNCATION_ELLIPSIS}`;
}

// --- time-range normalization ----------------------------------------------

/** Parse a from/to bound the agent supplies (YYYY-MM-DD HH:mm, wall-clock)
 *  into the stored UTC ISO contract so bounds compare against timestamps
 *  consistently. A naive wall-clock string parses as the host local zone; an
 *  ISO value with explicit offset/Z parses with its zone. Returns null for an
 *  unparseable value. */
function normalizeRangeBound(raw: string): string | null {
  const parsed = new Date(raw.trim());
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

// --- ids path (exact lookup) -----------------------------------------------

function missingIdMessage(id: string): string {
  return `No node or observation with id ${id}.`;
}

/** Render a node as a drill-down payload: header at depth 0, direct children
 *  indented at depth 1 (child nodes one-lined, child observations per the
 *  active content mode). */
function renderNodePayload(
  node: RenderableNode,
  target: RecallTarget,
  mode: ContentMode,
  excerpts: ReadonlyMap<string, string[]>,
  details: DetailsProvider,
): string {
  const lines: string[] = [formatNodeLine(node, { viewer: VIEWER })];
  const childNodes = node.childNodeIds
    .map((id) => target.nodes.get(id))
    .filter((n): n is RenderableNode => n !== undefined);
  const childObs = node.observationIds
    .map((id) => target.observations.get(id))
    .filter((o): o is RecallObservation => o !== undefined);
  for (const child of childNodes) {
    lines.push(indent(formatNodeLine(child, { viewer: VIEWER }), CHILD_DEPTH));
  }
  for (const obs of childObs) {
    lines.push(indent(renderObservationBlock(obs, mode, NO_PARENT, excerpts.get(obs.id), details), CHILD_DEPTH));
  }
  return lines.join("\n");
}

/** Render a node payload under a contentPattern filter (grep-tree pruning):
 * the node header shows only if its summary matches OR a descendant
 *  matches; child nodes are kept when their summaries match; child observations
 *  are kept when they have contentPattern excerpts. Returns null when the whole
 *  node (header + every child) is filtered out. */
function renderNodePayloadGrep(
  node: RenderableNode,
  target: RecallTarget,
  mode: Extract<ContentMode, { kind: "grep" }>,
  excerpts: ReadonlyMap<string, string[]>,
  summaryMatch: ReadonlySet<string>,
  details: DetailsProvider,
): string | null {
  const keptChildNodes = node.childNodeIds.filter((id) => target.nodes.has(id) && summaryMatch.has(id));
  const keptChildObs = node.observationIds.filter((id) => {
    const o = target.observations.get(id);
    return o !== undefined && (excerpts.get(id)?.length ?? 0) > 0;
  });
  // keep the node header only if its summary matches, or it is the structural
  // parent of a kept descendant.
  if (!summaryMatch.has(node.id) && keptChildNodes.length === 0 && keptChildObs.length === 0) {
    return null;
  }
  const lines: string[] = [formatNodeLine(node, { viewer: VIEWER })];
  for (const cid of keptChildNodes) {
    const child = target.nodes.get(cid);
    if (child !== undefined) lines.push(indent(formatNodeLine(child, { viewer: VIEWER }), CHILD_DEPTH));
  }
  for (const oid of keptChildObs) {
    const o = target.observations.get(oid);
    if (o !== undefined)
      lines.push(indent(renderObservationBlock(o, mode, NO_PARENT, excerpts.get(oid), details), CHILD_DEPTH));
  }
  return lines.join("\n");
}

/** Render an observation per the active content mode: terse one-line, full
 *  content block, a line range, or grep excerpts. Terse shows the one-line
 *  SUMMARY; full/lines/grep operate on the DETAILS (verbatim source, re-rendered
 *  via the details provider). Delegates the full/lines body to the shared
 *  contentBlock and the grep body to the shared grepBlock, so the body shape
 *  stays byte-identical to the graph read tools. */
function renderObservationBlock(
  obs: RenderableObservation,
  mode: ContentMode,
  showParent: string | undefined,
  excerpts: readonly string[] | undefined,
  details: DetailsProvider,
): string {
  if (mode.kind === "terse") return terseObservationLine(obs, showParent);
  const header = observationHeader(obs, showParent);
  if (mode.kind === "grep") return grepBlock(header, excerpts);
  const body = details(obs.id);
  // source_unavailable: the one-line summary is the best fallback body (the
  // verbatim source can't render) — flag it so the agent knows the full source
  // is gone, not just absent from this render.
  if (body === null) {
    return `${header}\n${singleLine(obs.summary)}\n${SOURCE_UNAVAILABLE_NOTE}`;
  }
  return contentBlock(header, body, mode);
}

/** A terse observation line: delegates to the shared formatObservationLine with
 *  terse (truncated) content, so the prefix stays byte-identical to every other
 *  observation line. */
function terseObservationLine(obs: RenderableObservation, showParent: string | undefined): string {
  return formatObservationLine(obs, { viewer: VIEWER, showParent, formatContent: terseSingleLine });
}

/** An observation header carrying no content: the shared format with content
 *  omitted (`id · importance · size · [in parent] · timestamp`). */
function observationHeader(obs: RenderableObservation, showParent: string | undefined): string {
  return formatObservationLine(obs, { viewer: VIEWER, showParent, formatContent: () => "" });
}

// --- search/list path ------------------------------------------------------

interface ResolvedBounds {
  readonly from: string | null;
  readonly to: string | null;
  readonly error: string | null;
}

/** Resolve + validate from/to bounds. Returns an error string on an unparseable
 *  bound (surfaced to the agent rather than thrown). */
function resolveBounds(from: string | undefined, to: string | undefined): ResolvedBounds {
  const fromNorm = from === undefined ? null : normalizeRangeBound(from);
  if (from !== undefined && fromNorm === null) {
    return {
      from: null,
      to: null,
      error: `Invalid "from" datetime: ${from}. Use YYYY-MM-DD HH:mm.`,
    };
  }
  const toNorm = to === undefined ? null : normalizeRangeBound(to);
  if (to !== undefined && toNorm === null) {
    return { from: null, to: null, error: `Invalid "to" datetime: ${to}. Use YYYY-MM-DD HH:mm.` };
  }
  return { from: fromNorm, to: toNorm, error: null };
}

/** Build the ranked candidate list for the search/list path. Async because the
 *  regex tests run in a worker thread bounded by `findTimeoutMs`. Returns the
 *  candidates, or an error string the caller surfaces verbatim.
 *
 *  `filters` are intersected over node summaries + observation content (an item
 *  passes only if it matches EVERY filter) — used to intersect `query` and
 *  `contentPattern`, both of which filter the same text scope. An empty
 *  filter list is the time-range browse (every node/obs passes the text gate). */
async function buildSearchCandidates(
  target: RecallTarget,
  filters: readonly RegExp[],
  bounds: ResolvedBounds,
  includeSuperseded: boolean,
  details: DetailsProvider,
): Promise<{ candidates: SearchCandidate[]; note?: string } | { error: string }> {
  // gather node + observation jobs, then batch-test every text against every
  // filter (intersection — an item passes only if it matches all filters).
  // Nodes only surface when a text filter can match their summary; a pure
  // time-range browse (no text filter) returns observations only.
  const includeNodes = filters.length > 0;
  const nodeJobs: { node: RenderableNode }[] = [];
  const obsJobs: { obs: RecallObservation; parent: RenderableNode | null }[] = [];
  for (const node of target.nodes.values()) {
    if (!includeNodes || !isVisible(node.state, includeSuperseded)) continue;
    nodeJobs.push({ node });
  }
  for (const obs of target.observations.values()) {
    const parent = obs.parentNode === null ? null : (target.nodes.get(obs.parentNode) ?? null);
    // parent-state gate: an obs under an obsolete node is hidden unless includeSuperseded
    if (parent !== null && !isVisible(parent.state, includeSuperseded)) continue;
    obsJobs.push({ obs, parent });
  }

  const nodeCount = nodeJobs.length;
  // every job passes the text gate until a filter marks it false (intersection —
  // worker-bounded). An empty filter list is the time-range browse (all pass).
  let passes = new Array<boolean>(nodeCount + obsJobs.length).fill(true);
  let note: string | undefined;
  if (filters.length > 0) {
    // nodes match over summary only; observations match over summary + details
    // (the verbatim source) so a query/contentPattern finds obs whose details hit.
    const texts = [
      ...nodeJobs.map((j) => j.node.summary),
      ...obsJobs.map((j) => {
        const d = details(j.obs.id);
        return d === null ? j.obs.summary : searchableText(j.obs.summary, d);
      }),
    ];
    const filtered = await intersectRegexFilters(texts, filters);
    if ("error" in filtered) return { error: filtered.error };
    passes = filtered.passes;
    note = filtered.note;
  }

  const candidates: SearchCandidate[] = [];
  for (let i = 0; i < nodeJobs.length; i += 1) {
    if (passes[i]) {
      const { node } = nodeJobs[i];
      candidates.push({
        id: node.id,
        key: { importanceRank: importanceRankOf(node.importance), recency: node.timestamps.rangeEnd },
        line: formatNodeLine(node, {
          viewer: VIEWER,
          showParent: node.parentNode ?? undefined,
          singleObs: singleDirectObs(node, target.observations),
        }),
      });
    }
  }
  for (let i = 0; i < obsJobs.length; i += 1) {
    if (!passes[nodeCount + i]) continue;
    const { obs, parent } = obsJobs[i];
    // time range applies to observations only (nodes are never time-filtered)
    if (bounds.from !== null && obs.timestamp < bounds.from) continue;
    if (bounds.to !== null && obs.timestamp >= bounds.to) continue;
    candidates.push({
      id: obs.id,
      key: { importanceRank: observationImportanceRank(obs, parent), recency: obs.timestamp },
      line: terseObservationLine(obs, obs.parentNode ?? undefined),
      obs,
    });
  }

  candidates.sort(compareCandidates);
  return { candidates, note };
}

/** Non-obsolete root nodes for the default browse (no filters) path. When
 *  `includeSuperseded` is true, obsolete roots are included too (shown with 🪦
 *  + → supersededBy) so the modifier is never silently dropped. */
function rootBrowseCandidates(target: RecallTarget, includeSuperseded: boolean): SearchCandidate[] {
  const roots: RenderableNode[] = [];
  for (const node of target.nodes.values()) {
    if (node.parentNode !== null) continue;
    if (!isVisible(node.state, includeSuperseded)) continue;
    roots.push(node);
  }
  // nGoal first, nIrrelevant last, the rest by importance/recency — the same
  // canonical ordering as the compaction summary and /mk:ls, so the agent's
  // browse view matches its injected memory.
  const ordered = orderActiveSetRoots(roots);
  return ordered.map((node) => ({
    id: node.id,
    key: { importanceRank: importanceRankOf(node.importance), recency: node.timestamps.rangeEnd },
    line: formatNodeLine(node, { viewer: VIEWER, singleObs: singleDirectObs(node, target.observations) }),
  }));
}

// --- footer ----------------------------------------------------------------

/** Search footer: total match count (constant across pages) + the continuation
 *  cursor when more remain. */
function searchFooter(total: number, lastId: string, more: boolean): string {
  const parts = [`· ${total} results`];
  if (more) parts.push(`afterId=${lastId}`);
  return parts.join(" · ");
}

// --- pagination (top-level take/afterId → ResolvedPage) --------------------

/** Normalize top-level take/afterId into the shared ResolvedPage (negative
 *  take clamps to TAKE_ALL = "all"). */
function pageOf(take: number | undefined, afterId: string | undefined): ResolvedPage {
  return resolvePage({ take: take ?? DEFAULT_TAKE, afterId: afterId ?? NO_AFTER_ID });
}

// --- tool parameters + description -----------------------------------------

const MK_RECALL_PARAMS = Type.Object({
  ids: Type.Optional(
    Type.Array(Type.String(), {
      description:
        "Specific ids to fetch (e.g. ['n23','o5']). Drill into an id from the memory summary or a result's children. The prefix gives the kind: n = node, o = observation. Id lookups return each item exactly as-is and ignore the filters below — a superseded node still returns, with its replacement id.",
    }),
  ),
  query: Type.Optional(
    Type.String({
      description:
        "Find items by regex (JS) over node summaries and observation content. A pattern that runs too long is stopped; partial matches come back with a note to narrow the query.",
    }),
  ),
  from: Type.Optional(
    Type.String({
      description: "Start of the time range, inclusive — YYYY-MM-DD HH:mm.",
    }),
  ),
  to: Type.Optional(
    Type.String({
      description: "End of the time range, exclusive — YYYY-MM-DD HH:mm.",
    }),
  ),
  includeSuperseded: Type.Optional(
    Type.Boolean({
      description:
        "false (default) returns only current memory — superseded and obsolete items are hidden. true includes them as well (shown with 🪦, and where replaced, the replacement id). Ignored when ids is set.",
    }),
  ),
  fullDetails: Type.Optional(
    Type.Boolean({
      description:
        "false (default): terse one-line results; long observation text is truncated. true: full untruncated observation content — use it to read one item in full rather than surveying many.",
    }),
  ),
  contentPattern: Type.Optional(
    Type.String({
      description:
        "Extract matching lines from observations as grep-style excerpts (with `contextLines` and line numbers) instead of the whole text — greps every observation, or just those an `ids` drill or `query` search returns.",
    }),
  ),
  contextLines: Type.Optional(
    Type.Integer({
      minimum: 0,
      description: "Lines of context shown before and after each `contentPattern` match (default 2).",
    }),
  ),
  lines: Type.Optional(
    Type.String({
      description:
        "Read a line range (e.g. '40-60') of a single observation — pass an observation id, or a node id with one observation.",
    }),
  ),
  take: Type.Optional(Type.Integer({ minimum: 0, description: "Page size (default 50; 0 returns all)." })),
  afterId: Type.Optional(
    Type.String({ description: "Pagination cursor — the last id from the previous page. Omit on the first page." }),
  ),
});

const MK_RECALL_DESCRIPTION =
  "Browse the full memory tree preserved across compactions — the memory summary shows only the top level. Fetch the detail behind any id (a node, its observations, their verbatim source lines), search all captured memory by regex, or filter by time. Use it proactively: before redoing work or assuming a decision, check how it was done earlier.";

// --- execute ---------------------------------------------------------------

interface MkRecallParams {
  ids?: string[];
  query?: string;
  from?: string;
  to?: string;
  includeSuperseded?: boolean;
  fullDetails?: boolean;
  contentPattern?: string;
  contextLines?: number;
  lines?: string;
  take?: number;
  afterId?: string;
}

/** Build the mk_recall ToolDefinition. Reads the graph store + renderMode live
 *  (closures; needs no ExtensionContext). Read-only — never mutates. */
export function makeMkRecallTool(): ToolDefinition<typeof MK_RECALL_PARAMS> {
  return {
    name: MK_RECALL_TOOL,
    label: "Browse memory",
    description: MK_RECALL_DESCRIPTION,
    parameters: MK_RECALL_PARAMS,
    async execute(_toolCallId, params) {
      const result = await executeRecall(params as MkRecallParams);
      return {
        content: [{ type: "text", text: result.text }],
        details: result.error ? { error: true } : { ok: true },
      };
    },
    renderResult(result, options, theme) {
      return renderRecallResult(result, options, theme);
    },
  };
}

/** The subset of a tool result the transcript renderer reads (satisfied by
 *  pi's AgentToolResult — content blocks + the error flag). */
interface RenderableToolResult {
  readonly content?: readonly { readonly type: string; readonly text?: string }[];
  readonly details?: unknown;
}

/** Transcript render for mk_recall results. The default fallback prints the
 *  whole text — a browse or fullDetails read would flood the visible transcript.
 *  Collapsed shows the first COLLAPSED_LINE_LIMIT lines + the expand hint;
 *  expanded (Ctrl+O) and error results render in full. */
function renderRecallResult(result: RenderableToolResult, options: { expanded?: boolean }, theme: Theme): Text {
  const textBlocks = result.content?.filter((block) => block.type === "text") ?? [];
  const last = textBlocks.length > 0 ? (textBlocks[textBlocks.length - 1]?.text ?? "") : "";
  const isError =
    typeof result.details === "object" &&
    result.details !== null &&
    (result.details as { error?: unknown }).error === true;
  if (options.expanded === true || isError) {
    return new Text(theme.fg("toolOutput", last), 0, 0);
  }
  const lines = last.split("\n");
  if (lines.length <= COLLAPSED_LINE_LIMIT) {
    return new Text(theme.fg("toolOutput", last), 0, 0);
  }
  const truncated = lines.slice(0, COLLAPSED_LINE_LIMIT).join("\n");
  return new Text(theme.fg("toolOutput", `${truncated}\n${EXPAND_HINT}`), 0, 0);
}

/** A recall result: the rendered text + whether it is a hard error (invalid
 *  regex / datetime, over-long query, stale cursor) — surfaced in
 *  `details.error` for UI, matching the sibling read-tools' convention. A
 *  missing id in an `ids` lookup is NOT a hard error (conveyed by its not-found
 *  text, like `cat`), so it does not set `error`. */
interface RecallResult {
  readonly text: string;
  readonly error: boolean;
}

function ok(text: string): RecallResult {
  return { text, error: false };
}
function err(text: string): RecallResult {
  return { text, error: true };
}

/** Compile `contentPattern` (if present) and resolve the content mode.
 *  Precedence: lines > contentPattern > fullDetails > terse. */
function resolveRecallMode(fullDetails: boolean, params: MkRecallParams): { mode: ContentMode } | { error: string } {
  const grepRes = resolveGrepSpec(params.contentPattern, params.contextLines);
  if ("error" in grepRes) return grepRes;
  const mode = resolveContentMode(fullDetails, grepRes.grep, params.lines);
  if ("error" in mode) return mode;
  return { mode };
}

/** Compute grep excerpts for a set of observations: batch-test contentPattern
 *  over their DETAILS (verbatim source) lines in one worker round-trip (shared
 *  runGrepExcerpts), then return the per-observation excerpt map. When an
 *  observation's verbatim source is unavailable, grep falls back to its one-line
 *  summary so the pattern still has something to match. Returns an error string
 *  for a compile/worker failure. */
async function computeGrepExcerpts(
  observations: RenderableObservation[],
  pattern: RegExp,
  context: number,
  details: DetailsProvider,
): Promise<{ excerpts: ReadonlyMap<string, string[]>; note: string | null } | { error: string }> {
  const items = observations.map((o) => ({ id: o.id, content: details(o.id) ?? o.summary }));
  const result = await runGrepExcerpts(items, pattern, context, getMemkeeperSettings().findTimeoutMs);
  if ("error" in result) return result;
  if (result.timedOutMs !== null) {
    return { excerpts: result.excerpts, note: grepTimeoutNote(result.timedOutMs) };
  }
  return { excerpts: result.excerpts, note: null };
}

/** Pure recall logic (extracted for testability + so the tool shell stays thin). */
async function executeRecall(params: MkRecallParams): Promise<RecallResult> {
  const fullDetails = params.fullDetails ?? false;
  const includeSuperseded = params.includeSuperseded ?? false;
  const modeRes = resolveRecallMode(fullDetails, params);
  if ("error" in modeRes) return err(modeRes.error);
  const mode = modeRes.mode;

  // --- ids path: exact lookup, bypasses ranking + includeSuperseded ---
  // builds a FOCUSED target (only the requested ids + their children), not the
  // whole graph — single-id drills must not allocate Maps over every retained
  // observation.
  if (params.ids !== undefined && params.ids.length > 0) {
    const target = resolveTargetForIds(params.ids);
    const details = makeDetailsProvider(target);
    return executeIds(target, params.ids, params.take, params.afterId, mode, details);
  }

  // `lines` reads a range of ONE observation — it needs an `ids` target. With
  // no ids it has nothing to slice (this also forbids `lines` + `query`, since
  // query yields many). contentPattern-alone is fine — it greps every obs below.
  if (mode.kind === "lines") {
    return err(
      "`lines` reads a range of a single observation — pass one observation id, or a node id with one observation.",
    );
  }

  const target = resolveTarget();
  const details = makeDetailsProvider(target);

  // --- search/list path ---
  // compile query regex (if any) — shared compiler (length cap + error wording)
  let regex: RegExp | null = null;
  if (params.query !== undefined && params.query !== "") {
    const compiled = tryCompileFindRegex(params.query);
    if ("error" in compiled) return err(compiled.error);
    regex = compiled.regex;
  }

  const bounds = resolveBounds(params.from, params.to);
  if (bounds.error !== null) return err(bounds.error);

  // contentPattern-alone greps every observation: keep it out of the root-browse
  // path (which returns root nodes only, leaving grep with nothing to operate on).
  const noFilters = regex === null && bounds.from === null && bounds.to === null && mode.kind !== "grep";
  let list: SearchCandidate[];
  let note: string | undefined;
  if (noFilters) {
    list = rootBrowseCandidates(target, includeSuperseded);
  } else {
    // intersect query + contentPattern over summaries + content (both are
    // filters, never obs-only). contentPattern-alone is the degenerate single-filter
    // case (filters = [contentPattern] → nodes + obs matching it).
    const filters: RegExp[] = [];
    if (regex !== null) filters.push(regex);
    if (mode.kind === "grep") filters.push(mode.pattern);
    const result = await buildSearchCandidates(target, filters, bounds, includeSuperseded, details);
    if ("error" in result) return err(result.error);
    list = result.candidates;
    note = result.note;
  }

  const page = pageOf(params.take, params.afterId);
  const { window, more, stale } = paginate(list, page);
  if (stale) return err(staleCursorMessage(page.afterId));

  if (window.length === 0) {
    return ok(note ?? (noFilters ? "No memory yet." : "No matches."));
  }

  // grep mode: pre-compute excerpts for the observation candidates in the window.
  let excerpts: ReadonlyMap<string, string[]> = EMPTY_EXCERPTS;
  if (mode.kind === "grep") {
    const obsWindow = window.map((c) => c.obs).filter((o): o is RecallObservation => o !== undefined);
    const result = await computeGrepExcerpts(obsWindow, mode.pattern, mode.context, details);
    if ("error" in result) return err(result.error);
    excerpts = result.excerpts;
    if (result.note !== null) note = result.note;
  }

  // render each candidate per the mode, then bound by the result token budget
  // (per-item atomic — a single-observation target is unbudgeted in any mode:
  // the cap lifts, but the mode still applies).
  const singleObs = window.length === 1 && window[0].obs !== undefined;
  const budget = singleObs ? null : getMemkeeperSettings().toolResultTokenBudget;
  const units = window.map((c) => ({
    id: c.id,
    text:
      c.obs !== undefined
        ? renderObservationBlock(c.obs, mode, c.obs.parentNode ?? undefined, excerpts.get(c.obs.id), details)
        : c.line,
  }));
  const { text, footer } = budgetUnits(units, budget, more, list.length, window[window.length - 1].id);
  const parts = [text];
  if (footer !== null) parts.push(footer);
  if (note !== undefined) parts.push(note);
  return ok(parts.join("\n"));
}

const EMPTY_EXCERPTS: ReadonlyMap<string, string[]> = new Map();
const EMPTY_MATCH: ReadonlySet<string> = new Set();

/** Apply the result token budget to rendered units (per-item atomic): emit whole
 *  units while the budget holds, then a footer. A null budget is uncapped (only
 *  the paginate `more` footer applies). The search footer (total count) is always
 *  shown unless the budget truncated (the budget footer replaces it). */
function budgetUnits(
  units: { id: string; text: string }[],
  budget: number | null,
  paginateMore: boolean,
  total: number,
  lastWindowId: string,
): { text: string; footer: string | null } {
  if (budget === null) {
    return { text: units.map((u) => u.text).join("\n"), footer: searchFooter(total, lastWindowId, paginateMore) };
  }
  const budgeted = budgetWindow(units, budget);
  const lines = budgeted.kept.map((u) => u.text);
  if (budgeted.remaining > 0) {
    lines.push(budgetReachedFooter(budgeted.remaining, budgeted.lastKeptId, "item"));
    return { text: lines.join("\n"), footer: null };
  }
  return { text: lines.join("\n"), footer: searchFooter(total, lastWindowId, paginateMore) };
}

/** ids path: render each requested id (node payload or observation); paginate
 *  over the requested ids. Async because grep mode batches contentPattern over
 *  the observation content lines via the worker. */
async function executeIds(
  target: RecallTarget,
  ids: string[],
  take: number | undefined,
  afterId: string | undefined,
  mode: ContentMode,
  details: DetailsProvider,
): Promise<RecallResult> {
  // `lines` reads a range of ONE observation — error unless the ids resolve to
  // exactly one connected observation (an obs id, or a node with one). With more,
  // the range is ambiguous across several observations.
  if (
    mode.kind === "lines" &&
    !(ids.length === 1 && countConnectedObservations(target.nodes, target.observations, ids[0]) === 1)
  ) {
    return err(
      "`lines` reads a range of a single observation — pass one observation id, or a node id with one observation.",
    );
  }
  // Resolve each requested id to a node or observation up front so the grep
  // path can prune (and the non-grep path renders in one pass).
  const resolved = ids.map((id) => ({ id, node: target.nodes.get(id), obs: target.observations.get(id) }));
  // track the observations referenced (for grep excerpt pre-computation).
  const obsById = new Map<string, RenderableObservation>();
  for (const r of resolved) {
    if (r.node !== undefined) {
      for (const oid of r.node.observationIds) {
        const o = target.observations.get(oid);
        if (o !== undefined) obsById.set(oid, o);
      }
    } else if (r.obs !== undefined) {
      obsById.set(r.id, r.obs);
    }
  }

  // grep mode: contentPattern filters the ids target (grep-tree pruning.
  // A node is kept if its summary matches OR a descendant obs matches (header
  // kept as the structural parent); a non-matching standalone obs is dropped;
  // non-matching child obs are dropped. Non-grep modes keep every requested id.
  let excerpts: ReadonlyMap<string, string[]> = EMPTY_EXCERPTS;
  let summaryMatch: ReadonlySet<string> = EMPTY_MATCH;
  let grepNote: string | null = null;
  if (mode.kind === "grep") {
    const result = await computeGrepExcerpts([...obsById.values()], mode.pattern, mode.context, details);
    if ("error" in result) return err(result.error);
    excerpts = result.excerpts;
    grepNote = result.note;
    // summaries: requested nodes + their child nodes. A node header is kept when
    // its summary matches contentPattern (run through the worker for ReDoS safety).
    const summaryNodes: RenderableNode[] = [];
    for (const r of resolved) {
      if (r.node !== undefined) {
        summaryNodes.push(r.node);
        for (const cid of r.node.childNodeIds) {
          const child = target.nodes.get(cid);
          if (child !== undefined) summaryNodes.push(child);
        }
      }
    }
    const summaryTexts = summaryNodes.map((n) => n.summary);
    const outcome = await runRegexTests(mode.pattern, summaryTexts, getMemkeeperSettings().findTimeoutMs);
    if ("error" in outcome) return err(outcome.error);
    const matchSet = new Set<string>();
    for (let i = 0; i < summaryNodes.length; i += 1) {
      if (outcome.results[i]) matchSet.add(summaryNodes[i].id);
    }
    summaryMatch = matchSet;
  }

  // Build the unit list: a requested obs is dropped when grep has no excerpt;
  // a requested node is pruned to matching children (or dropped entirely).
  const units: { id: string; text: string }[] = [];
  for (const r of resolved) {
    if (r.node !== undefined) {
      if (mode.kind === "grep") {
        const payload = renderNodePayloadGrep(r.node, target, mode, excerpts, summaryMatch, details);
        if (payload !== null) units.push({ id: r.id, text: payload });
      } else {
        units.push({ id: r.id, text: renderNodePayload(r.node, target, mode, EMPTY_EXCERPTS, details) });
      }
      continue;
    }
    if (r.obs !== undefined) {
      if (mode.kind === "grep") {
        // a standalone obs is kept only when its content matches contentPattern.
        if ((excerpts.get(r.id)?.length ?? 0) > 0) {
          units.push({ id: r.id, text: renderObservationBlock(r.obs, mode, NO_PARENT, excerpts.get(r.id), details) });
        }
      } else {
        units.push({ id: r.id, text: renderObservationBlock(r.obs, mode, NO_PARENT, NO_EXCERPTS, details) });
      }
      continue;
    }
    if (mode.kind !== "grep") {
      // missing id: convey via its not-found text (grep mode drops it silently —
      // nothing matched). ids lookups never flag a whole-result error.
      units.push({ id: r.id, text: missingIdMessage(r.id) });
    }
  }

  if (units.length === 0) {
    return ok(grepNote ?? "No matches.");
  }

  const page = pageOf(take, afterId);
  const { window, more, stale } = paginate(units, page);
  if (stale) return err(staleCursorMessage(page.afterId));

  // A single-observation target is unbudgeted in any mode (full / lines / grep):
  // the cap lifts, but the mode still applies. This covers both a direct
  // observation id and a node whose connected observations total exactly one.
  const budget =
    ids.length === 1 && countConnectedObservations(target.nodes, target.observations, ids[0]) === 1
      ? null
      : getMemkeeperSettings().toolResultTokenBudget;
  const { text, footer } = budgetUnits(window, budget, more, units.length, window[window.length - 1].id);
  const parts = [text];
  if (footer !== null) parts.push(footer);
  if (grepNote !== null) parts.push(grepNote);
  // ids lookups never flag error: a missing id is conveyed by its not-found text
  // (matching the sibling `cat` tool), not a whole-result error flag.
  return ok(parts.join("\n"));
}
