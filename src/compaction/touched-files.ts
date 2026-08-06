// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// Touched-files extraction: scans the active branch (getBranch — NOT getEntries,
// which mixes all branches) for read/write/edit toolCall entries since a cut
// entry, excludes bash-mediated ops, dedups by path (write > edit > read
// dominance, latest timestamp kept), and renders <Mon> <DD> <HH:MM>
// read|write|edit <path>[:line-range] oldest-first. Surfaces to the Selector
// input AND the rendered compaction summary.

import type { SessionEntry, SessionMessageEntry } from "@earendil-works/pi-coding-agent";
import { formatDayTime, singleLine, toStoredTimestamp } from "../format/render.js";

/** Narrow port over the session manager for touched-files (the active branch +
 *  the current leaf). Injected so tests pass a fake; production passes the
 *  ExtensionContext's sessionManager. */
export interface TouchedFilesContext {
  /** The current leaf entry id (null at session start before any entry). */
  getLeafId: () => string | null;
  /** The active branch path entries (NOT all-branches getEntries). Accepts the
   *  leaf id or undefined for the current leaf. */
  getBranch: (leafId?: string) => SessionEntry[];
}

/** One touched file: its path, the last-touch timestamp (stored contract), op,
 *  and (for read-only files) the merged line ranges read. */
export interface TouchedFile {
  path: string;
  timestamp: string;
  op: "write" | "edit" | "read";
  /** The merged read ranges (overlapping/adjacent unioned), present only when
   *  the file was only ever read (no write/edit dominated). `end: null` = open. */
  lineRanges?: readonly LineRange[];
}

/** A line range read from a `read` tool's offset/limit args (1-indexed). */
export interface LineRange {
  start: number;
  end: number | null;
}

/** All file-touching tool names (bash is deliberately excluded — unbounded).
 *  The tool name IS the op (read/write/edit map 1:1). */
const FILE_TOOLS = new Set(["read", "write", "edit"]);

const NO_CUT: string | null = null;
const NO_PATH_LENGTH = 0;
const INDEX_NOT_FOUND = -1;
const FIRST_ENTRY = 0;

/** Extract deduped touched files from the active branch's compacted block:
 *  the entries strictly BEFORE `cutEntryId` (the current compaction's first
 *  retained entry), bounded below by the previous compaction on the path (so a
 *  mid-session list reflects activity since the last compaction, not the whole
 *  history). `cutEntryId === null` (background, no compaction cut) scans from
 *  the previous compaction to the current leaf. Bash ops are excluded; paths
 *  are deduped (write > edit > read dominance; the latest timestamp wins for
 *  ordering). A file read at several ranges keeps every range — overlapping /
 *  adjacent ones merged — so the list shows all inspected sections. Oldest-first. */
export function extractTouchedFiles(ctx: TouchedFilesContext, cutEntryId: string | null): TouchedFile[] {
  const entries = ctx.getBranch(ctx.getLeafId() ?? undefined);
  const [start, end] = compactedRange(entries, cutEntryId);

  // Accumulate per path: the dominant op, the latest timestamp (for ordering),
  // and every read range (so a file read at several sections keeps them all).
  const accums = new Map<string, PathAccum>();
  for (let i = start; i < end; i += 1) {
    const entry = entries[i];
    if (entry === undefined) continue;
    for (const touch of fileTouches(entry)) {
      const existing = accums.get(touch.path);
      if (existing === undefined) {
        accums.set(touch.path, {
          path: touch.path,
          latestTimestamp: touch.timestamp,
          op: touch.op,
          readRanges: touch.lineRange !== undefined ? [touch.lineRange] : [],
        });
      } else {
        existing.op = dominantOp(existing.op, touch.op);
        if (touch.timestamp >= existing.latestTimestamp) existing.latestTimestamp = touch.timestamp;
        if (touch.lineRange !== undefined) existing.readRanges.push(touch.lineRange);
      }
    }
  }

  // Resolve each path: write/edit dominate (no range); read-only files merge
  // their accumulated ranges into the final entry (undefined when none).
  const files: TouchedFile[] = [];
  for (const a of accums.values()) {
    files.push({
      path: a.path,
      timestamp: a.latestTimestamp,
      op: a.op,
      lineRanges: a.op === "read" && a.readRanges.length > 0 ? mergeRanges(a.readRanges) : undefined,
    });
  }
  return files.sort((x, y) => x.timestamp.localeCompare(y.timestamp));
}

/** Per-path accumulator: the dominant op, latest timestamp, and every read range. */
interface PathAccum {
  path: string;
  latestTimestamp: string;
  op: TouchedFile["op"];
  readRanges: LineRange[];
}

/** The stronger action wins (write > edit > read): a file created/overwritten
 *  is more significant than one merely edited, which is more significant than
 *  one merely read. */
function dominantOp(a: TouchedFile["op"], b: TouchedFile["op"]): TouchedFile["op"] {
  if (a === "write" || b === "write") return "write";
  if (a === "edit" || b === "edit") return "edit";
  return "read";
}

/** Union overlapping or adjacent ranges (start ≤ prev.end + 1) into a compact
 *  set. An open end (null) absorbs everything after it and stays open. The
 *  result is sorted by start with no overlaps. */
function mergeRanges(ranges: readonly LineRange[]): LineRange[] {
  if (ranges.length <= 1) return [...ranges];
  const sorted = [...ranges].sort((a, b) => a.start - b.start);
  const merged: LineRange[] = [];
  for (const r of sorted) {
    const last = merged[merged.length - 1];
    if (last !== undefined && last.end !== null && r.start <= last.end + 1) {
      // adjacent or overlapping, finite last end — extend it
      last.end = r.end === null ? null : Math.max(last.end, r.end);
    } else if (last !== undefined && last.end === null) {
    } else {
      merged.push({ start: r.start, end: r.end });
    }
  }
  return merged;
}

/** The [start, end) range of the compacted block: entries strictly before the
 *  cut (`cutEntryId` exclusive), bounded below by the previous compaction entry
 *  on the path (its position + 1 — the summary entry itself carries no file
 *  touches). `cutEntryId === null` → end = branch length (background, scan to
 *  the current leaf). Falls back to the whole branch when no previous
 *  compaction is found. */
function compactedRange(entries: SessionEntry[], cutEntryId: string | null): [number, number] {
  const cutIndex = cutEntryId === NO_CUT ? entries.length : entries.findIndex((e) => e.id === cutEntryId);
  const end = cutIndex === INDEX_NOT_FOUND ? entries.length : cutIndex; // exclusive of the cut entry
  // the previous compaction on the path bounds the block below (its summary
  // entry carries no file touches; start strictly after it).
  let start = FIRST_ENTRY;
  for (let i = end - 1; i >= FIRST_ENTRY; i -= 1) {
    const entry = entries[i];
    if (entry === undefined) continue;
    if (entry.type === "compaction") {
      start = i + 1;
      break;
    }
  }
  return [start, end];
}

/** A message entry is a candidate if it carries toolCall parts. */
export function isMessageEntry(entry: SessionEntry): entry is SessionMessageEntry {
  return entry.type === "message";
}

/** A message whose content is an array of parts (assistant/toolResult; not custom/string). */
interface PartedMessage {
  content: readonly unknown[];
}

/** Whether an AgentMessage carries parted content (assistant/toolResult). */
function isPartedMessage(message: unknown): message is PartedMessage {
  return (
    typeof message === "object" &&
    message !== null &&
    "content" in message &&
    Array.isArray((message as { content: unknown }).content)
  );
}

/** A raw touch from one tool call: path + op + timestamp + (for reads) the
 *  single range that call covered. Accumulated + resolved into a TouchedFile. */
interface FileTouch {
  path: string;
  timestamp: string;
  op: TouchedFile["op"];
  lineRange?: LineRange;
}

/** Extract the file touches (path + op + timestamp + optional read range) from
 *  one entry's toolCalls. The tool name IS the op (read/write/edit). */
function fileTouches(entry: SessionEntry): FileTouch[] {
  if (!isMessageEntry(entry)) return [];
  const message = entry.message;
  if (!isPartedMessage(message)) return [];
  const timestamp = toStoredTimestamp(entry.timestamp);
  const touches: FileTouch[] = [];
  for (const part of message.content) {
    if (typeof part !== "object" || part === null) continue;
    const typed = part as { type?: string; name?: string; arguments?: Record<string, unknown> };
    if (typed.type !== "toolCall") continue;
    const name = typed.name;
    if (name === undefined || !FILE_TOOLS.has(name)) continue;
    const args = typed.arguments ?? {};
    const path = args.path;
    if (typeof path !== "string" || path.length === NO_PATH_LENGTH) continue;
    const op = name as TouchedFile["op"];
    touches.push({ path, timestamp, op, lineRange: op === "read" ? readLineRange(args) : undefined });
  }
  return touches;
}

/** The line range a `read` covered, from its offset/limit args (1-indexed).
 *  Returns undefined when the read had no offset (a from-the-top read, full or
 *  limit-bounded — no meaningful section to cite). offset+limit → start-end;
 *  offset only → start- (open). */
function readLineRange(args: Record<string, unknown>): LineRange | undefined {
  const offset = args.offset;
  if (typeof offset !== "number" || !Number.isFinite(offset) || offset < 1) return undefined;
  const start = Math.floor(offset);
  const limit = args.limit;
  if (typeof limit !== "number" || !Number.isFinite(limit) || limit < 1) {
    return { start, end: null };
  }
  return { start, end: start + Math.floor(limit) - 1 };
}

/** Render touched files as `<Mon> <DD> <HH:MM> read|write|edit <path>[:ranges]`
 *  lines (one per file). */
export function renderTouchedFiles(files: readonly TouchedFile[]): string[] {
  return files.map(renderTouchedFile);
}

/** Render a touched-file line as "<Mon> <DD> <HH:MM> <op> <path>[:ranges]". The op
 *  is the word (read/write/edit); a read-only file appends its merged ranges
 *  (e.g. ":1-50,100-200") to the path. */
function renderTouchedFile(f: TouchedFile): string {
  const rangeSuffix = f.op === "read" ? formatRangesSuffix(f.lineRanges) : "";
  return `${formatDayTime(f.timestamp)} ${f.op} ${singleLine(f.path)}${rangeSuffix}`;
}

/** ":1-50,100-200" for merged ranges (comma-joined), "" when there are none.
 *  A single-line range renders as ":N"; an open end as ":N-". */
function formatRangesSuffix(ranges: readonly LineRange[] | undefined): string {
  if (ranges === undefined || ranges.length === 0) return "";
  return `:${ranges.map(formatRange).join(",")}`;
}

/** "start-end", "start" (single line), or "start-" (open end). */
function formatRange(range: LineRange): string {
  if (range.end === null) return `${range.start}-`;
  if (range.end === range.start) return `${range.start}`;
  return `${range.start}-${range.end}`;
}
