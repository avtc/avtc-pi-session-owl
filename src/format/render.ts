// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// Shared tree-render formatting: the one-line graph-item format used by the
// Builder ls/find, the Selector, mk_recall, the user /mk:* commands, and the
// compaction summary.

import { estimateContentTokens, type Node, type Observation } from "../types.js";

export type RenderViewer = "builder" | "nonBuilder";

/** The canonical one-line legend for the shared render format (non-Builder
 *  consumers — compaction summary, commands; the Builder's own prompt carries
 *  its own legend including the Builder-only 🆕new glyph). */
export const RENDER_LEGEND =
  "n.. node · o.. observation · importance crit high med low (how much it matters if lost) · 📦archived 🪦obsolete";

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
const DATE_DAY_INDEX = 1; // local.date "<Mon> <DD>" → day is the 2nd space-part

/** Collapse internal whitespace + trim so a multi-line summary/content/path
 *  cannot break the one-line render layout. */
export function singleLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** The first line of a (possibly multi-line) text, collapsed to one line. Used
 *  to render a bare `new` node from its observation's content. */
function firstLine(text: string): string {
  const newlineAt = text.indexOf("\n");
  return singleLine(newlineAt === NOT_FOUND ? text : text.slice(START_INDEX, newlineAt));
}

/** Zero-length list sentinel (no-bare-literals). */
const EMPTY_OBS_LIST = 0;
const NOT_FOUND = -1;
const START_INDEX = 0;

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

/** Render a stored UTC ISO instant as a LOCAL "<DD> <HH:MM>" (2-digit day-number +
 *  24h time, no month) — the locale-independent day+time form used by the
 *  touched-files list. Shares the same UTC→local conversion as `formatTimestamp`
 *  (hardcoded English, never locale-dependent) so the format never drifts. */
export function formatDayTime(stored: string): string {
  const local = parseLocalParts(stored);
  if (local !== null) {
    // local.date is "<Mon> <DD>" (e.g. "Jul 28") — day is the 2nd space-part
    const day = local.date.split(" ")[DATE_DAY_INDEX] ?? "??";
    return `${day} ${local.time}`;
  }
  const { date, time } = parseTimestamp(stored);
  // legacy "YYYY-MM-DD" — day is the 3rd dash-part
  const day = date.split("-")[DAY_PART] ?? "??";
  return `${day} ${time}`;
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
 *  the record's sourceEntryIds). Always shown — lets the agent gauge the cost
 *  of expanding (fullDetails) before drilling, and pick a `lines` window.
 *  Falls back to a summary-derived estimate when the counts are null (legacy
 *  snapshots predating SD-4). */
function observationSize(summary: string, detailsLines: number | null, detailsTokens: number | null): string {
  const lines = detailsLines ?? (summary === "" ? 0 : summary.split("\n").length - (summary.endsWith("\n") ? 1 : 0));
  const tokens = detailsTokens ?? estimateContentTokens(summary);
  return `${pluralize(lines, "line", "lines")} ${pluralize(tokens, "token", "tokens")}`;
}

interface LineOptions {
  viewer: RenderViewer;
  showParent?: string;
  /** Transform (or omit) the observation content line. Default: `singleLine`.
   *  Return "" to render a content-free header. Node lines ignore this. */
  formatContent?: (content: string) => string;
  /** Resolve an observation's content by id — used to render a bare `new` node
   *  (empty summary) as its first observation's first line. Callers without
   *  observation-content access omit it (the summary segment is then omitted). */
  observationContent?: (obsId: string) => string | undefined;
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
   *  legacy snapshots (pre-SD-4) lack it; the render falls back to a
   *  summary-derived estimate. */
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
  } else if (node.observationIds.length > EMPTY_OBS_LIST && options.observationContent !== undefined) {
    // a bare `new` node (empty summary until the Builder first writes one) renders
    // its first observation's first line so the Builder sees what it is about.
    const resolved = options.observationContent(node.observationIds[0]);
    if (resolved !== undefined) {
      const first = firstLine(resolved);
      if (first !== "") parts.push(first);
    }
  }
  if (options.showParent !== undefined) parts.push(`in ${options.showParent}`);
  if (node.state === "obsolete" && node.supersededBy !== null) parts.push(`→ ${node.supersededBy}`);
  parts.push(childCounts(node));
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
  parts.push(observationSize(obs.summary, obs.detailsLines ?? null, obs.detailsTokens ?? null));
  parts.push(formatTimestamp(obs.timestamp));
  return parts.join(" · ");
}

/** Spaces per render-tree depth level (shared by every indented listing). */
export const INDENT_STEP = 2;

/** Indent a line by `depth` levels (INDENT_STEP spaces each). */
export function indent(line: string, depth: number): string {
  return `${" ".repeat(depth * INDENT_STEP)}${line}`;
}
