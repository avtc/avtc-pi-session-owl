// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// Shared tree-render formatting: the one-line graph-item format used by the
// Builder ls/find, the Selector, mk_recall, the user /mk:* commands, and the
// compaction summary.

import { IMPORTANCE_ABBR, type Node, type Observation } from "../types.js";

export type RenderViewer = "builder" | "nonBuilder";

/** The canonical one-line legend for the shared render format (non-Builder
 *  consumers — compaction summary, commands; the Builder's own prompt carries
 *  its own legend including the Builder-only 🆕new glyph). */
export const RENDER_LEGEND = "📁 node · 📄 observation · crit high med low · 📦archived 🪦obsolete";

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

/** The render abbreviation for an importance (crit/high/med/low). */
export function importanceAbbr(imp: Node["importance"]): string {
  return IMPORTANCE_ABBR[imp];
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

/** The direct-child counts fragment for a node (empty when none at all). */
function childCounts(node: RenderableNode): string {
  const folders = node.childNodeIds.length;
  const files = node.observationIds.length;
  if (folders > 0) return `${folders}📁 ${files}📄`;
  return `${files}📄`;
}

interface LineOptions {
  viewer: RenderViewer;
  showParent?: string;
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
  content: string;
  importance: Observation["importance"];
  timestamp: string;
}

/** Render one node as a line (no indent — callers apply depth indentation). */
export function formatNodeLine(node: RenderableNode, options: LineOptions): string {
  const parts: string[] = [`📁 ${node.id} · ${stateGlyph(node, options.viewer)}${importanceAbbr(node.importance)}`];
  const summary = singleLine(node.summary);
  if (summary !== "") parts.push(summary);
  if (options.showParent !== undefined) parts.push(`in ${options.showParent}`);
  if (node.state === "obsolete" && node.supersededBy !== null) parts.push(`→ ${node.supersededBy}`);
  parts.push(childCounts(node));
  parts.push(formatTimestampRange(node.timestamps.rangeStart, node.timestamps.rangeEnd));
  return parts.join(" · ");
}

/** Render one observation as a line (no indent — callers apply depth indentation). */
export function formatObservationLine(obs: RenderableObservation, options: LineOptions): string {
  const parts: string[] = [`📄 ${obs.id} · ${importanceAbbr(obs.importance)}`];
  const formatContent = options.formatContent ?? singleLine;
  const content = formatContent(obs.content);
  if (content !== "") parts.push(content);
  if (options.showParent !== undefined) parts.push(`in ${options.showParent}`);
  parts.push(formatTimestamp(obs.timestamp));
  return parts.join(" · ");
}

/** Spaces per render-tree depth level (shared by every indented listing). */
export const INDENT_STEP = 2;

/** Indent a line by `depth` levels (INDENT_STEP spaces each). */
export function indent(line: string, depth: number): string {
  return `${" ".repeat(depth * INDENT_STEP)}${line}`;
}
