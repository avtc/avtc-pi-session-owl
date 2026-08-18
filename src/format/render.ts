// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// Shared tree-render formatting: the one-line graph-item format used by the
// Builder ls/find, the Selector, mk_recall, the user /mk:* commands, and the
// compaction summary.

import type { Node, Observation } from "../types.js";
import { formatTokens } from "./tokens.js";

export type RenderViewer = "builder" | "nonBuilder";

/** Shared named values for the RenderViewer union, so call sites pass a named
 *  constant instead of a bare string (consistency + one definition point). */
export const BUILDER: RenderViewer = "builder";
export const NON_BUILDER: RenderViewer = "nonBuilder";

/** The counts+size legend segment — the tail shared verbatim by every legend
 *  (RENDER_LEGEND, the Builder and Selector prompts, README): the child-count
 *  segment and the size segment (the direct observations' full-details size)
 *  explained once, in one place. */
export const COUNTS_SIZE_LEGEND =
  "2nodes 3obs (direct children) · 34lines 412tokens (direct children observations full details size)";

/** The canonical one-line legend for the shared render format (non-Builder
 *  consumers — compaction summary, commands; the Builder's own prompt carries
 *  its own legend including the Builder-only 🆕new glyph). */
export const RENDER_LEGEND =
  "n.. node · o.. observation (obs) · importance crit high med low (how much it matters if lost) · 📦archived 🪦obsolete · " +
  COUNTS_SIZE_LEGEND;

const MONTH_ABBREVIATIONS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const;

const MONTH_PART = 1;
const DAY_PART = 2;
const MONTH_INDEX_OFFSET = 1;

/** Collapse internal whitespace + trim so a multi-line summary/content/path
 *  cannot break the one-line render layout. */
export function singleLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

interface ParsedTimestamp {
  date: string;
  time: string;
}

/** Parse a stored UTC ISO instant into LOCAL date + time strings for render
 *  (locale-independent: hardcoded English month abbreviations, never
 *  `toLocaleString` — a Russian/Ukrainian/Japanese host locale would emit
 *  non-English month names that English-trained LLMs can't parse). Returns null
 *  for a non-ISO stored value (caller falls back to the legacy split path). */
function parseLocalParts(stored: string): ParsedTimestamp | null {
  const d = new Date(stored);
  if (Number.isNaN(d.getTime()) || !stored.includes("T")) return null;
  const monthIndex = d.getMonth();
  const day = d.getDate().toString().padStart(2, "0");
  const hh = d.getHours().toString().padStart(2, "0");
  const mm = d.getMinutes().toString().padStart(2, "0");
  return { date: `${MONTH_ABBREVIATIONS[monthIndex] ?? "???"} ${day}`, time: `${hh}:${mm}` };
}

/** Split a legacy "YYYY-MM-DD HH:MM" stored value (tolerant fallback path). */
function parseTimestamp(stored: string): ParsedTimestamp {
  const [date, time] = stored.split(" ");
  return { date: date ?? stored, time: time ?? "" };
}

function monthDay(date: string): string {
  const parts = date.split("-");
  const monthIndex = Number(parts[MONTH_PART]) - MONTH_INDEX_OFFSET;
  const day = parts[DAY_PART];
  return `${MONTH_ABBREVIATIONS[monthIndex] ?? "???"} ${day}`;
}

/** Render a stored UTC ISO timestamp as a LOCAL "Jul 28 14:30" (English month
 *  abbreviation, hardcoded — never locale-dependent). */
export function formatTimestamp(stored: string): string {
  const local = parseLocalParts(stored);
  if (local !== null) return `${local.date} ${local.time}`;
  const { date, time } = parseTimestamp(stored);
  return `${monthDay(date)} ${time}`;
}

/** Render a stored UTC ISO instant as a LOCAL "<Mon> <DD> <HH:MM>" (3-letter
 *  English month + 2-digit day-number + 24h time) — the locale-independent
 *  day+time form used by the touched-files list. Shares the same UTC→local
 *  conversion as `formatTimestamp` (hardcoded English, never locale-dependent)
 *  so the format never drifts. */
export function formatDayTime(stored: string): string {
  const local = parseLocalParts(stored);
  if (local !== null) {
    // local.date is "<Mon> <DD>" (e.g. "Jul 28") — month + day, no year, so the
    // date is unambiguous without a legend (matching the node-tree format).
    return `${local.date} ${local.time}`;
  }
  const { date, time } = parseTimestamp(stored);
  // legacy "YYYY-MM-DD" — emit as-is (no month abbreviation available)
  return `${date} ${time}`;
}

/** Convert a raw session-entry timestamp (pi stores ISO 8601, e.g.
 *  "2026-07-29T09:22:50.283Z") into the stored UTC ISO contract the in-memory
 *  model + render layer use. Absolute (TZ-agnostic); rendered to LOCAL at
 *  display time. A value already in ISO form is normalized; a non-ISO value
 *  passes through unchanged (tolerant/idempotent). */
export function toStoredTimestamp(raw: string): string {
  if (!raw.includes("T")) return raw;
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) return raw;
  return parsed.toISOString();
}

/** Render a [start, end] range, compressing identical or same-day endpoints. */
export function formatTimestampRange(startStored: string, endStored: string): string {
  const startLocal = parseLocalParts(startStored);
  const endLocal = parseLocalParts(endStored);
  if (startLocal !== null && endLocal !== null) {
    if (startStored === endStored) return `${startLocal.date} ${startLocal.time}`;
    const startText = `${startLocal.date} ${startLocal.time}`;
    if (startLocal.date === endLocal.date) return `${startText} — ${endLocal.time}`;
    return `${startText} — ${endLocal.date} ${endLocal.time}`;
  }
  if (startStored === endStored) return formatTimestamp(startStored);
  const start = parseTimestamp(startStored);
  const end = parseTimestamp(endStored);
  const startText = `${monthDay(start.date)} ${start.time}`;
  if (start.date === end.date) return `${startText} — ${end.time}`;
  return `${startText} — ${monthDay(end.date)} ${end.time}`;
}

/** The notable-state glyph for a node, or empty for active. */
function stateGlyph(node: RenderableNode, viewer: RenderViewer): string {
  if (node.state === "archived") return "📦";
  if (node.state === "obsolete") return "🪦";
  if (node.state === "new") return viewer === "builder" ? "🆕" : "";
  return "";
}

/** `count` + `singular`/`plural` noun, grammar-correct and SPACE-LESS
 *  (1node, 2nodes) — the compact counts-slot render format. Prose that needs a
 *  space between the count and noun (e.g. "5 compactions" in the status report)
 *  keeps its inline suffix, since this helper's space-less output is for the
 *  tree counts only. Handles invariant nouns like "obs" via equal singular+plural. */
export function pluralize(count: number, singular: string, plural: string): string {
  return `${count}${count === 1 ? singular : plural}`;
}

/** The direct-child counts fragment for a node. The node count is shown only
 *  when non-zero (a `0nodes` prefix is noise); the obs count always shows. */
function childCounts(node: RenderableNode): string {
  const nodes = node.childNodeIds.length;
  const obs = pluralize(node.observationIds.length, "obs", "obs");
  return nodes > 0 ? `${pluralize(nodes, "node", "nodes")} ${obs}` : obs;
}

/** The size fragment for an observation: the verbatim-source line count +
 *  estimated token count (detailsLines/detailsTokens, computed at capture from
 *  the record's sourceEntryIds). Shown when both counts exist — lets the agent
 *  gauge the cost of expanding (fullDetails) before drilling, and pick a
 *  `lines` window. Returns null when the counts are absent (legacy snapshots /
 *  source-unavailable captures) — no size segment, never a summary-derived
 *  guess. */
function observationSize(detailsLines: number | undefined, detailsTokens: number | undefined): string | null {
  if (detailsLines === undefined || detailsTokens === undefined) return null;
  return formatSize(detailsLines, detailsTokens);
}

/** Render a line/token count pair as the size segment (`2lines 15tokens`). */
function formatSize(lines: number, tokens: number): string {
  return `${pluralize(lines, "line", "lines")} ${pluralize(tokens, "token", "tokens")}`;
}

/** The minimal observation shape the node-line size hint reads. */
export type SizeHintObservation = Pick<RenderableObservation, "detailsLines" | "detailsTokens">;

/** The summed verbatim-source size of a node's direct observations — the cost
 *  of the node's fullDetails drill, which renders every direct observation's
 *  full text. */
export interface SizeHint {
  readonly lines: number;
  readonly tokens: number;
}

/** Sum a node's direct observations' verbatim-source sizes for the node-line
 *  size hint (qualifying the Nobs count — the same observations a node drill
 *  expands; child nodes' observations are not included). An observation without
 *  captured counts (legacy) contributes 0; a node with no direct observations
 *  has no size to show. */
export function directObsSizeHint<T extends SizeHintObservation>(
  node: RenderableNode,
  observations: ReadonlyMap<string, T>,
): SizeHint | undefined {
  if (node.observationIds.length === 0) return undefined;
  let lines = 0;
  let tokens = 0;
  for (const id of node.observationIds) {
    const obs = observations.get(id);
    if (obs === undefined) continue;
    lines += obs.detailsLines ?? 0;
    tokens += obs.detailsTokens ?? 0;
  }
  return { lines, tokens };
}

/** The graph shape renderTreeTotal reads: the full node + observation maps. */
export interface TreeTotalGraph {
  nodes: ReadonlyMap<string, RenderableNode>;
  observations: ReadonlyMap<string, SizeHintObservation>;
}

/** Max tree depth in levels (roots = 1), via BFS over child links. Nodes not
 *  reachable from a root count as their own level-1 tree (tolerant — structure
 *  invariants normally make them impossible). */
function treeLevels(nodes: ReadonlyMap<string, RenderableNode>): number {
  const depth = new Map<string, number>();
  const queue: RenderableNode[] = [];
  for (const node of nodes.values()) {
    if (node.parentNode !== null && nodes.has(node.parentNode)) continue;
    depth.set(node.id, 1);
    queue.push(node);
  }
  let max = queue.length > 0 ? 1 : 0;
  while (queue.length > 0) {
    const node = queue.shift() as RenderableNode;
    for (const cid of node.childNodeIds) {
      const child = nodes.get(cid);
      if (child === undefined || depth.has(cid)) continue;
      const level = (depth.get(node.id) ?? 1) + 1;
      depth.set(cid, level);
      if (level > max) max = level;
      queue.push(child);
    }
  }
  return max;
}

/** Render the source-tree totals block — a `---` divider plus the one-line
 *  tree scale shown under every root view (the compaction summary's active
 *  set, the Builder's per-pass root snapshot, the Selector's working tree):
 *  node count + depth, observation count, the summed verbatim details size
 *  (the same lines/tokens units as the per-node size hints; observations
 *  without captured counts contribute 0), and the session's compaction count
 *  (how much of the session lives only in memory). */
export function renderTreeTotal(graph: TreeTotalGraph, compactionCount: number): string {
  let lines = 0;
  let tokens = 0;
  for (const obs of graph.observations.values()) {
    lines += obs.detailsLines ?? 0;
    tokens += obs.detailsTokens ?? 0;
  }
  const levels = treeLevels(graph.nodes);
  return (
    `---\nSource tree total: ${graph.nodes.size} nodes (${levels} level${levels === 1 ? "" : "s"}) · ` +
    `${graph.observations.size} observations · ` +
    `${formatTokens(lines)} lines ${formatTokens(tokens)} tokens of details · ` +
    `${compactionCount} compaction${compactionCount === 1 ? "" : "s"}`
  );
}

interface LineOptions {
  viewer: RenderViewer;
  showParent?: string;
  /** The summed size of the node's direct observations (caller-resolved via
   *  directObsSizeHint) — renders as the size segment after the child counts.
   *  Node lines only; observation lines ignore this. */
  obsSize?: SizeHint;
  /** Transform (or omit) the observation content line. Default: `singleLine`.
   *  Return "" to render a content-free header. Node lines ignore this. */
  formatContent?: (content: string) => string;
}

/** Structural node shape the line helpers read (satisfied by both the in-memory
 *  `Node` and the serialized `SerializedNode` — the compaction summary renders
 *  a self-contained snapshot, so the helpers must not pin to `NodeId`). */
export interface RenderableNode {
  id: string;
  summary: string;
  state: Node["state"];
  importance: Node["importance"];
  parentNode: string | null;
  supersededBy: string | null;
  childNodeIds: readonly string[];
  observationIds: readonly string[];
  timestamps: { rangeStart: string; rangeEnd: string };
}

/** Structural observation shape the line helpers read. */
export interface RenderableObservation {
  id: string;
  summary: string;
  importance: Observation["importance"];
  timestamp: string;
  /** Verbatim-source size hint (frozen at capture) — the drill cost. Optional:
   *  legacy snapshots / source-unavailable captures lack it; the render then
   *  omits the size segment. */
  detailsLines?: number;
  detailsTokens?: number;
  /** Source entry ids — the verbatim-source provenance, used to re-render the
   *  details (full/lines/grep body) on demand. */
  sourceEntryIds: readonly string[];
}

/** Render one node as a line (no indent — callers apply depth indentation). */
export function formatNodeLine(node: RenderableNode, options: LineOptions): string {
  const parts: string[] = [`${node.id} · ${stateGlyph(node, options.viewer)}${node.importance}`];
  const summary = singleLine(node.summary);
  if (summary !== "") {
    parts.push(summary);
  }
  if (options.showParent !== undefined) parts.push(`in ${options.showParent}`);
  if (node.state === "obsolete" && node.supersededBy !== null) parts.push(`→ ${node.supersededBy}`);
  parts.push(childCounts(node));
  if (options.obsSize !== undefined) {
    parts.push(formatSize(options.obsSize.lines, options.obsSize.tokens));
  }
  parts.push(formatTimestampRange(node.timestamps.rangeStart, node.timestamps.rangeEnd));
  return parts.join(" · ");
}

/** Render one observation as a line (no indent — callers apply depth indentation). */
export function formatObservationLine(obs: RenderableObservation, options: LineOptions): string {
  const parts: string[] = [`${obs.id} · ${obs.importance}`];
  const formatContent = options.formatContent ?? singleLine;
  const content = formatContent(obs.summary);
  if (content !== "") parts.push(content);
  if (options.showParent !== undefined) parts.push(`in ${options.showParent}`);
  const size = observationSize(obs.detailsLines, obs.detailsTokens);
  if (size !== null) parts.push(size);
  parts.push(formatTimestamp(obs.timestamp));
  return parts.join(" · ");
}

/** Spaces per render-tree depth level (shared by every indented listing). */
export const INDENT_STEP = 2;

/** Indent a line by `depth` levels (INDENT_STEP spaces each). */
export function indent(line: string, depth: number): string {
  return `${" ".repeat(depth * INDENT_STEP)}${line}`;
}
