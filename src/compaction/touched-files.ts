// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// Touched-files extraction: scans the active branch (getBranch — NOT getEntries,
// which mixes all branches) for read/write/edit toolCall entries since a cut
// entry, excludes bash-mediated ops, dedups by path (write dominates, latest
// timestamp kept), and renders <Mon> <DD> <HH:MM> ✎|👁 <path> oldest-first. Surfaces
// to the Selector input AND the rendered compaction summary.

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

/** One touched file: its path, the last-touch timestamp (stored contract), and op. */
export interface TouchedFile {
  path: string;
  timestamp: string;
  op: "write" | "read";
}

/** Tool names that count as a file WRITE (the agent changed the file). */
const WRITE_TOOLS = new Set(["write", "edit"]);
/** Tool names that count as a file READ. */
const READ_TOOLS = new Set(["read"]);
/** All file-touching tool names (bash is deliberately excluded — unbounded). */
const FILE_TOOLS = new Set<string>([...WRITE_TOOLS, ...READ_TOOLS]);

const NO_CUT: string | null = null;
const NO_PATH_LENGTH = 0;
const PATH_NOT_FOUND = -1;
const FIRST_ENTRY = 0;

/** Extract deduped touched files from the active branch's compacted block:
 *  the entries strictly BEFORE `cutEntryId` (the current compaction's first
 *  retained entry), bounded below by the previous compaction on the path (so a
 *  mid-session list reflects activity since the last compaction, not the whole
 *  history). `cutEntryId === null` (background, no compaction cut) scans from
 *  the previous compaction to the current leaf. Bash ops are excluded; paths
 *  are deduped (write dominates, the latest timestamp is kept). Oldest-first. */
export function extractTouchedFiles(ctx: TouchedFilesContext, cutEntryId: string | null): TouchedFile[] {
  const entries = ctx.getBranch(ctx.getLeafId() ?? undefined);
  const [start, end] = compactedRange(entries, cutEntryId);

  const latest = new Map<string, TouchedFile>();
  for (let i = start; i < end; i += 1) {
    const entry = entries[i];
    if (entry === undefined) continue;
    const touches = fileTouches(entry);
    for (const touch of touches) {
      const existing = latest.get(touch.path);
      // write dominates; the latest timestamp wins for both op and ordering.
      if (existing === undefined || touch.timestamp >= existing.timestamp) {
        const op = existing?.op === "write" || touch.op === "write" ? "write" : "read";
        latest.set(touch.path, { path: touch.path, timestamp: touch.timestamp, op });
      }
    }
  }

  return [...latest.values()].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
}

/** The [start, end) range of the compacted block: entries strictly before the
 *  cut (`cutEntryId` exclusive), bounded below by the previous compaction entry
 *  on the path (its position + 1 — the summary entry itself carries no file
 *  touches). `cutEntryId === null` → end = branch length (background, scan to
 *  the current leaf). Falls back to the whole branch when no previous
 *  compaction is found. */
function compactedRange(entries: SessionEntry[], cutEntryId: string | null): [number, number] {
  const cutIndex = cutEntryId === NO_CUT ? entries.length : entries.findIndex((e) => e.id === cutEntryId);
  const end = cutIndex === PATH_NOT_FOUND ? entries.length : cutIndex; // exclusive of the cut entry
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

/** Extract the file touches (path + op + timestamp) from one entry's toolCalls. */
function fileTouches(entry: SessionEntry): TouchedFile[] {
  if (!isMessageEntry(entry)) return [];
  const message = entry.message;
  if (!isPartedMessage(message)) return [];
  const timestamp = toStoredTimestamp(entry.timestamp);
  const touches: TouchedFile[] = [];
  for (const part of message.content) {
    if (typeof part !== "object" || part === null) continue;
    const typed = part as { type?: string; name?: string; arguments?: Record<string, unknown> };
    if (typed.type !== "toolCall") continue;
    const name = typed.name;
    if (name === undefined || !FILE_TOOLS.has(name)) continue;
    const path = typed.arguments?.path;
    if (typeof path !== "string" || path.length === NO_PATH_LENGTH) continue;
    touches.push({ path, timestamp, op: WRITE_TOOLS.has(name) ? "write" : "read" });
  }
  return touches;
}

/** Render touched files as `<Mon> <DD> <HH:MM> ✎|👁 <path>` lines (one per file). */
export function renderTouchedFiles(files: readonly TouchedFile[]): string[] {
  return files.map(renderTouchedFile);
}

const WRITE_GLYPH = "✎";
const READ_GLYPH = "👁";

/** Render a touched-file line as "<Mon> <DD> <HH:MM> <glyph> <path>". */
function renderTouchedFile(f: TouchedFile): string {
  return `${formatDayTime(f.timestamp)} ${f.op === "write" ? WRITE_GLYPH : READ_GLYPH} ${singleLine(f.path)}`;
}
