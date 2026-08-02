// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// mk_recall — the agent's single read-only drill-down tool over preserved
// memory. Registered via pi.registerTool as a ToolDefinition (the main agent's
// tool, NOT passed to any agentLoop). Targets the rendered tree per renderMode:
// the source observations graph in observations-root, the persisted selected
// tree in selected-root (falling back to the source graph when no tree exists
// yet). Read-only; never mutates.

import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { getMemkeeperSettings } from "../config/schema.js";
import {
  formatNodeLine,
  formatObservationLine,
  indent,
  type RenderableNode,
  type RenderableObservation,
  type RenderViewer,
  singleLine,
} from "../format/render.js";
import {
  DEFAULT_TAKE,
  isVisible,
  paginate,
  type ResolvedPage,
  resolvePage,
  staleCursorMessage,
  tryCompileFindRegex,
} from "../graph/read-tools.js";
import type { SerializedNode, SerializedObservation, SerializedSelection } from "../store/codecs.js";
import { getGraphStore } from "../store/graph-store.js";
import { IMPORTANCE_RANK, type Importance, type MemkeeperGraph, type ObsId } from "../types.js";

// --- named constants (no bare literals at call sites) ----------------------

export const MK_RECALL_TOOL = "mk_recall";
const VIEWER: RenderViewer = "nonBuilder";
/** Single-line content cap for terse results (full content shows in fullDetails). */
const TERSE_CONTENT_MAX = 120;
const TRUNCATION_ELLIPSIS = "…";
const CHILD_DEPTH = 1;
const NO_AFTER_ID: string | null = null;

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

/** Build a recall target over the live source graph. */
function targetFromSourceGraph(graph: MemkeeperGraph): RecallTarget {
  const nodes = new Map<string, RenderableNode>();
  for (const n of graph.nodes.values()) nodes.set(n.id, n);
  const observations = new Map<string, RecallObservation>();
  for (const o of graph.observations.values()) observations.set(o.id, o);
  return { renderMode: "observations-root", nodes, observations };
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

  // Map each observation id to its tree-node parent (the curated placement).
  const treeObsParent = new Map<string, string>();
  for (const sn of selection.nodes) {
    for (const obsId of sn.observationIds) treeObsParent.set(obsId, sn.id);
  }

  const observations = new Map<string, RecallObservation>();
  for (const ref of selection.obsRefs) {
    // oInitialPrompt is carried verbatim in its own field (resolved below) — skip
    // the redundant source-resolution here so it is not added twice.
    if (selection.oInitialPrompt !== null && ref === selection.oInitialPrompt.id) continue;
    const source = sourceGraph.observations.get(ref as ObsId);
    if (source === undefined) continue;
    observations.set(source.id, withTreeParent(source, treeObsParent));
  }
  if (selection.oInitialPrompt !== null) {
    const view = serializedObservationToView(selection.oInitialPrompt);
    observations.set(view.id, withTreeParent(view, treeObsParent));
  }
  return { renderMode: "selected-root", nodes, observations };
}

/** Override an observation's parentNode with its curated tree parent when the
 *  tree places it under a different node than the source graph. */
function withTreeParent<T extends RecallObservation>(obs: T, treeObsParent: Map<string, string>): RecallObservation {
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
    content: so.content,
    importance: so.importance,
    timestamp: so.timestamp,
    parentNode: so.parentNode,
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
  readonly line: string;
}

/** Importance desc, then recency desc (lexicographic on "YYYY-MM-DD HH:MM"). */
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
 *  indented at depth 1 (child nodes one-lined, child observations terse or full). */
function renderNodePayload(node: RenderableNode, target: RecallTarget, fullDetails: boolean): string {
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
    lines.push(indent(renderObservationBlock(obs, { showParent: undefined, fullDetails }), CHILD_DEPTH));
  }
  return lines.join("\n");
}

/** Render an observation as either a terse one-line (single-lined, length-capped)
 *  or a full content block (header + raw multi-line content). */
function renderObservationBlock(
  obs: RenderableObservation,
  options: { showParent: string | undefined; fullDetails: boolean },
): string {
  if (options.fullDetails) {
    // header (no content) + raw multi-line content below
    const header = observationHeader(obs, options.showParent);
    return `${header}\n${obs.content}`;
  }
  return terseObservationLine(obs, options.showParent);
}

/** A terse observation line: delegates to the shared formatObservationLine with
 *  terse (truncated) content, so the prefix stays byte-identical to every other
 *  observation line. */
function terseObservationLine(obs: RenderableObservation, showParent: string | undefined): string {
  return formatObservationLine(obs, { viewer: VIEWER, showParent, formatContent: terseSingleLine });
}

/** An observation header carrying no content: the shared format with content
 *  omitted (`📄 id · importance · [in parent] · timestamp`). */
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

/** Build the ranked candidate list for the search/list path. */
function buildSearchCandidates(
  target: RecallTarget,
  regex: RegExp | null,
  bounds: ResolvedBounds,
  includeSuperseded: boolean,
  fullDetails: boolean,
): SearchCandidate[] {
  const candidates: SearchCandidate[] = [];

  // node candidates: regex on summary only (nodes are never time-filtered)
  for (const node of target.nodes.values()) {
    if (!isVisible(node.state, includeSuperseded)) continue;
    if (regex === null) continue; // nodes are query-only
    if (regex.test(node.summary)) {
      candidates.push({
        id: node.id,
        key: { importanceRank: importanceRankOf(node.importance), recency: node.timestamps.rangeEnd },
        line: formatNodeLine(node, { viewer: VIEWER, showParent: node.parentNode ?? undefined }),
      });
    }
  }

  // observation candidates: text match (when query set) AND time range
  for (const obs of target.observations.values()) {
    const parent = obs.parentNode === null ? null : (target.nodes.get(obs.parentNode) ?? null);
    // parent-state gate: an obs under an obsolete node is hidden unless includeSuperseded
    if (parent !== null && !isVisible(parent.state, includeSuperseded)) continue;
    const textMatch = regex === null || regex.test(obs.content);
    if (!textMatch) continue;
    if (bounds.from !== null && obs.timestamp < bounds.from) continue;
    if (bounds.to !== null && obs.timestamp >= bounds.to) continue;
    candidates.push({
      id: obs.id,
      key: { importanceRank: observationImportanceRank(obs, parent), recency: obs.timestamp },
      line: renderObservationBlock(obs, { showParent: obs.parentNode ?? undefined, fullDetails }),
    });
  }

  candidates.sort(compareCandidates);
  return candidates;
}

/** Non-obsolete root nodes for the default browse (no filters) path. When
 *  `includeSuperseded` is true, obsolete roots are included too (shown with 🪦
 *  + → supersededBy) so the modifier is never silently dropped. */
function rootBrowseCandidates(target: RecallTarget, includeSuperseded: boolean): SearchCandidate[] {
  const candidates: SearchCandidate[] = [];
  for (const node of target.nodes.values()) {
    if (node.parentNode !== null) continue;
    if (!isVisible(node.state, includeSuperseded)) continue;
    candidates.push({
      id: node.id,
      key: { importanceRank: importanceRankOf(node.importance), recency: node.timestamps.rangeEnd },
      line: formatNodeLine(node, { viewer: VIEWER }),
    });
  }
  candidates.sort(compareCandidates);
  return candidates;
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

/** Normalize top-level take/afterId into the shared ResolvedPage (negative take
 *  clamps to TAKE_ALL = "all"). */
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
        "Regex (JS) over node summaries and observation content. Match several terms in one call with alternation, e.g. auth|jwt|login. An invalid pattern returns an error string; fix it and retry.",
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
  take: Type.Optional(Type.Integer({ minimum: 0, description: "Page size (default 50; 0 returns all)." })),
  afterId: Type.Optional(
    Type.String({ description: "Pagination cursor — the last id from the previous page. Omit on the first page." }),
  ),
});

const MK_RECALL_DESCRIPTION =
  "Recall your preserved session memory — the durable context kept across compactions. Fetch the detail behind any id in the memory summary (n.. = node, o.. = observation), search all captured memory by regex, or filter by time. Each node in the result lists its children by id; call again with a child id to descend. Results are a compact indented tree (📁 node, 📄 observation) with importance (crit/high/med/low) and timestamps. Read-only.";

// --- execute ---------------------------------------------------------------

interface MkRecallParams {
  ids?: string[];
  query?: string;
  from?: string;
  to?: string;
  includeSuperseded?: boolean;
  fullDetails?: boolean;
  take?: number;
  afterId?: string;
}

/** Build the mk_recall ToolDefinition. Reads the graph store + renderMode live
 *  (closures; needs no ExtensionContext). Read-only — never mutates. */
export function createMkRecallTool(): ToolDefinition<typeof MK_RECALL_PARAMS> {
  return {
    name: MK_RECALL_TOOL,
    label: "Browse memory",
    description: MK_RECALL_DESCRIPTION,
    parameters: MK_RECALL_PARAMS,
    async execute(_toolCallId, params) {
      const result = executeRecall(params as MkRecallParams);
      return {
        content: [{ type: "text", text: result.text }],
        details: result.error ? { error: true } : { ok: true },
      };
    },
  };
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

/** Pure recall logic (extracted for testability + so the tool shell stays thin). */
function executeRecall(params: MkRecallParams): RecallResult {
  const target = resolveTarget();
  const fullDetails = params.fullDetails ?? false;
  const includeSuperseded = params.includeSuperseded ?? false;

  // --- ids path: exact lookup, bypasses ranking + includeSuperseded ---
  if (params.ids !== undefined && params.ids.length > 0) {
    return executeIds(target, params.ids, params.take, params.afterId, fullDetails);
  }

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

  const noFilters = regex === null && bounds.from === null && bounds.to === null;
  const candidates = noFilters
    ? rootBrowseCandidates(target, includeSuperseded)
    : buildSearchCandidates(target, regex, bounds, includeSuperseded, fullDetails);

  const page = pageOf(params.take, params.afterId);
  const { window, more, stale } = paginate(candidates, page);
  if (stale) return err(staleCursorMessage(page.afterId));

  if (window.length === 0) {
    return ok(noFilters ? "No memory yet." : "No matches.");
  }

  const lines = window.map((c) => c.line);
  lines.push(searchFooter(candidates.length, window[window.length - 1].id, more));
  return ok(lines.join("\n"));
}

/** ids path: render each requested id (node payload or observation); paginate
 *  the aggregated children across all requested nodes/observations. */
function executeIds(
  target: RecallTarget,
  ids: string[],
  take: number | undefined,
  afterId: string | undefined,
  fullDetails: boolean,
): RecallResult {
  // Build a flat list of payload blocks (one per requested id), then paginate
  // over the requested ids (each id is one paginatable unit).
  const units: { id: string; text: string }[] = [];
  for (const id of ids) {
    const node = target.nodes.get(id);
    if (node !== undefined) {
      units.push({ id, text: renderNodePayload(node, target, fullDetails) });
      continue;
    }
    const obs = target.observations.get(id);
    if (obs !== undefined) {
      units.push({ id, text: renderObservationBlock(obs, { showParent: undefined, fullDetails }) });
      continue;
    }
    units.push({ id, text: missingIdMessage(id) });
  }

  const page = pageOf(take, afterId);
  const { window, more, stale } = paginate(units, page);
  if (stale) return err(staleCursorMessage(page.afterId));

  const lines = window.map((u) => u.text);
  if (more && window.length > 0) lines.push(`· afterId=${window[window.length - 1].id}`);
  // ids lookups never flag error: a missing id is conveyed by its not-found text
  // (matching the sibling `cat` tool), not a whole-result error flag.
  return ok(lines.join("\n"));
}
