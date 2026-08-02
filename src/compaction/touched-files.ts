// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// Touched-files extraction: scans the active branch (getBranch — NOT getEntries,
// which mixes all branches) for read/write/edit toolCall entries since a cut
// entry, excludes bash-mediated ops, dedups by path (write dominates, latest
// timestamp kept), and renders <DD> <HH:MM> ✎|👁 <path> oldest-first. Surfaces
// to the Selector input AND the rendered compaction summary.

import type { SessionEntry, SessionMessageEntry } from "@earendil-works/pi-coding-agent";
import { singleLine, toStoredTimestamp } from "../format/render.js";

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
const PATH_NOT_FOUND = -1;
const START_AFTER_CUT_OFFSET = 1;
const FIRST_ENTRY = 0;

/**
 * Extract deduped touched files from the active branch since `sinceEntryId`
 * (exclusive). Bash ops are excluded; paths are deduped (write dominates, the
 * latest timestamp is kept). Returns oldest-first chronological order.
 */
export function extractTouchedFiles(ctx: TouchedFilesContext, sinceEntryId: string | null): TouchedFile[] {
  const entries = ctx.getBranch(ctx.getLeafId() ?? undefined);
  const start = startIndex(entries, sinceEntryId);

  const latest = new Map<string, TouchedFile>();
  for (let i = start; i < entries.length; i += 1) {
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

/** The first index to scan: strictly after the cut entry (exclusive). */
function startIndex(entries: SessionEntry[], sinceEntryId: string | null): number {
  if (sinceEntryId === NO_CUT) return FIRST_ENTRY;
  const idx = entries.findIndex((e) => e.id === sinceEntryId);
  return idx === PATH_NOT_FOUND ? FIRST_ENTRY : idx + START_AFTER_CUT_OFFSET;
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

const NO_PATH_LENGTH = 0;

/** Render touched files as `<DD> <HH:MM> ✎|👁 <path>` lines (one per file). */
export function renderTouchedFiles(files: readonly TouchedFile[]): string[] {
  return files.map(
    (f) => `${formatDayTime(f.timestamp)} ${f.op === "write" ? WRITE_GLYPH : READ_GLYPH} ${singleLine(f.path)}`,
  );
}

const WRITE_GLYPH = "✎";
const READ_GLYPH = "👁";

/** Render a stored "YYYY-MM-DD HH:MM" timestamp as "<DD> <HH:MM>" (day + time). */
function formatDayTime(stored: string): string {
  // stored contract: "YYYY-MM-DD HH:MM" — slice the day and time directly.
  const day = stored.slice(DAY_START, DAY_END);
  const time = stored.slice(TIME_START, TIME_END);
  return `${day} ${time}`;
}

const DAY_START = 8;
const DAY_END = 10;
const TIME_START = 11;
const TIME_END = 16;
