// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// extractTouchedFiles + renderTouchedFiles: scans the active branch for
// read/write/edit toolCall entries since a cut entry, excludes bash, dedups by
// path (write > edit > read dominance; a read-only file keeps every merged
// range), and renders <Mon> <DD> <HH:MM> read|write|edit <path>[:ranges]
// oldest-first.

import type { AssistantMessage, Message, Usage } from "@earendil-works/pi-ai";
import type { SessionEntry, SessionMessageEntry } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { extractTouchedFiles, renderTouchedFiles, type TouchedFile } from "../../src/compaction/touched-files.js";

// --- fixtures ---------------------------------------------------------------

const USAGE: Usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function msg(id: string, ts: string, message: Message): SessionMessageEntry {
  return { type: "message", id, parentId: null, timestamp: ts, message };
}

function toolCallEntry(id: string, ts: string, name: string, args: Record<string, unknown>): SessionMessageEntry {
  const message: AssistantMessage = {
    role: "assistant",
    content: [{ type: "toolCall", id: `${name}-${id}`, name, arguments: args }],
    api: "anthropic",
    provider: "anthropic",
    model: "m",
    usage: USAGE,
    stopReason: "stop",
    timestamp: 0,
  };
  return msg(id, ts, message);
}

function userEntry(id: string, ts: string): SessionMessageEntry {
  return msg(id, ts, { role: "user", content: "hi", timestamp: 0 });
}

function compactionEntry(id: string, ts: string): SessionEntry {
  return {
    type: "compaction",
    id,
    parentId: null,
    timestamp: ts,
    summary: "prior compaction",
    firstKeptEntryId: "prior-cut",
    tokensBefore: 0,
    details: null,
  };
}

function ctxWith(entries: SessionEntry[]) {
  return {
    getLeafId: () => entries[entries.length - 1]?.id ?? null,
    getBranch: () => entries,
    appendEntry: () => {},
  };
}

const NO_CUT = null;

describe("extractTouchedFiles", () => {
  it("collects read/write/edit toolCall paths with timestamps and ops", () => {
    const entries: SessionEntry[] = [
      userEntry("e1", "2026-07-28T10:00:00Z"),
      toolCallEntry("e2", "2026-07-28T10:05:00Z", "write", { path: "/a.ts" }),
      toolCallEntry("e3", "2026-07-28T10:06:00Z", "edit", { path: "/b.ts" }),
      toolCallEntry("e4", "2026-07-28T10:07:00Z", "read", { path: "/c.ts" }),
    ];
    const files = extractTouchedFiles(ctxWith(entries), NO_CUT);
    // the tool name IS the op — edit is distinct from write (today both were "write").
    expect(files).toEqual([
      { path: "/a.ts", timestamp: "2026-07-28T10:05:00.000Z", op: "write" },
      { path: "/b.ts", timestamp: "2026-07-28T10:06:00.000Z", op: "edit" },
      { path: "/c.ts", timestamp: "2026-07-28T10:07:00.000Z", op: "read" },
    ]);
  });

  it("excludes bash-mediated file ops", () => {
    const entries: SessionEntry[] = [
      toolCallEntry("e1", "2026-07-28T10:00:00Z", "bash", { command: "echo hi > /x.ts" }),
      toolCallEntry("e2", "2026-07-28T10:01:00Z", "write", { path: "/y.ts" }),
    ];
    const files = extractTouchedFiles(ctxWith(entries), NO_CUT);
    expect(files.map((f) => f.path)).toEqual(["/y.ts"]);
  });

  it("excludes non-file toolCalls (no path arg)", () => {
    const entries: SessionEntry[] = [
      toolCallEntry("e1", "2026-07-28T10:00:00Z", "read", {}),
      toolCallEntry("e2", "2026-07-28T10:01:00Z", "write", { path: "/a.ts" }),
    ];
    const files = extractTouchedFiles(ctxWith(entries), NO_CUT);
    expect(files.map((f) => f.path)).toEqual(["/a.ts"]);
  });

  it("dedups by path (write > edit > read dominance, latest timestamp kept)", () => {
    const entries: SessionEntry[] = [
      toolCallEntry("e1", "2026-07-28T10:00:00Z", "read", { path: "/a.ts" }),
      toolCallEntry("e2", "2026-07-28T10:05:00Z", "write", { path: "/a.ts" }),
      toolCallEntry("e3", "2026-07-28T10:06:00Z", "read", { path: "/a.ts" }),
    ];
    const files = extractTouchedFiles(ctxWith(entries), NO_CUT);
    // write dominates read → op stays write; no range (write supersedes the reads).
    expect(files).toEqual([{ path: "/a.ts", timestamp: "2026-07-28T10:06:00.000Z", op: "write" }]);
  });

  it("edit dominates read (but not write)", () => {
    const entries: SessionEntry[] = [
      toolCallEntry("e1", "2026-07-28T10:00:00Z", "read", { path: "/a.ts", offset: 10, limit: 20 }),
      toolCallEntry("e2", "2026-07-28T10:05:00Z", "edit", { path: "/a.ts" }),
    ];
    // edit dominates the read → op=edit, no range (the edit supersedes the read).
    expect(extractTouchedFiles(ctxWith(entries), NO_CUT)).toEqual([
      { path: "/a.ts", timestamp: "2026-07-28T10:05:00.000Z", op: "edit" },
    ]);
  });

  it("keeps a ranged read's line range (offset+limit → start-end)", () => {
    const entries: SessionEntry[] = [
      toolCallEntry("e1", "2026-07-28T10:00:00Z", "read", { path: "/a.ts", offset: 100, limit: 50 }),
    ];
    expect(extractTouchedFiles(ctxWith(entries), NO_CUT)).toEqual([
      { path: "/a.ts", timestamp: "2026-07-28T10:00:00.000Z", op: "read", lineRanges: [{ start: 100, end: 149 }] },
    ]);
  });

  it("merges overlapping and adjacent read ranges of the same file", () => {
    const entries: SessionEntry[] = [
      toolCallEntry("e1", "2026-07-28T10:00:00Z", "read", { path: "/a.ts", offset: 40, limit: 41 }), // 40-80
      toolCallEntry("e2", "2026-07-28T10:05:00Z", "read", { path: "/a.ts", offset: 81, limit: 20 }), // 81-100 (adjacent)
      toolCallEntry("e3", "2026-07-28T10:06:00Z", "read", { path: "/a.ts", offset: 90, limit: 30 }), // 90-119 (overlaps)
      toolCallEntry("e4", "2026-07-28T10:07:00Z", "read", { path: "/a.ts", offset: 200, limit: 10 }), // 200-209 (disjoint)
    ];
    // 40-80 + 81-100 → 40-100 (adjacent); +90-119 → 40-119 (overlap); 200-209 stays.
    expect(extractTouchedFiles(ctxWith(entries), NO_CUT)).toEqual([
      {
        path: "/a.ts",
        timestamp: "2026-07-28T10:07:00.000Z",
        op: "read",
        lineRanges: [
          { start: 40, end: 119 },
          { start: 200, end: 209 },
        ],
      },
    ]);
  });

  it("renders an open end for an offset-only read (no limit)", () => {
    const entries: SessionEntry[] = [
      toolCallEntry("e1", "2026-07-28T10:00:00Z", "read", { path: "/a.ts", offset: 50 }),
    ];
    expect(extractTouchedFiles(ctxWith(entries), NO_CUT)).toEqual([
      { path: "/a.ts", timestamp: "2026-07-28T10:00:00.000Z", op: "read", lineRanges: [{ start: 50, end: null }] },
    ]);
  });

  it("scans the compacted block BEFORE the cut (entries strictly before cutEntryId)", () => {
    const entries: SessionEntry[] = [
      toolCallEntry("e1", "2026-07-28T10:00:00Z", "write", { path: "/old.ts" }),
      toolCallEntry("e2", "2026-07-28T11:00:00Z", "write", { path: "/cut.ts" }),
      toolCallEntry("e3", "2026-07-28T12:00:00Z", "write", { path: "/new.ts" }),
    ];
    // cutEntryId = e2 → the compacted block is entries before e2 = [e1] → /old.ts.
    // The retained tail (e2 onward) is NOT scanned.
    const files = extractTouchedFiles(ctxWith(entries), "e2");
    expect(files.map((f) => f.path)).toEqual(["/old.ts"]);
  });

  it("bounds the block below at the previous compaction on the path", () => {
    const entries: SessionEntry[] = [
      toolCallEntry("e1", "2026-07-28T10:00:00Z", "write", { path: "/pre-compaction.ts" }),
      compactionEntry("c1", "2026-07-28T10:30:00Z"),
      toolCallEntry("e2", "2026-07-28T11:00:00Z", "write", { path: "/after-compaction.ts" }),
      toolCallEntry("e3", "2026-07-28T12:00:00Z", "write", { path: "/cut.ts" }),
    ];
    // cutEntryId = e3 → block before e3, bounded below by compaction c1 → [e2].
    // e1 (before the compaction) is excluded; the compaction entry itself is skipped.
    const files = extractTouchedFiles(ctxWith(entries), "e3");
    expect(files.map((f) => f.path)).toEqual(["/after-compaction.ts"]);
  });

  it("scans the whole block (to the current leaf) when cutEntryId is null (background)", () => {
    const entries: SessionEntry[] = [
      toolCallEntry("e1", "2026-07-28T10:00:00Z", "write", { path: "/old.ts" }),
      toolCallEntry("e2", "2026-07-28T11:00:00Z", "write", { path: "/cut.ts" }),
      toolCallEntry("e3", "2026-07-28T12:00:00Z", "write", { path: "/new.ts" }),
    ];
    // null cut → end = branch length; no previous compaction → start = 0 → all.
    const files = extractTouchedFiles(ctxWith(entries), NO_CUT);
    expect(files.map((f) => f.path)).toEqual(["/old.ts", "/cut.ts", "/new.ts"]);
  });

  it("returns oldest-first chronological order", () => {
    const entries: SessionEntry[] = [
      toolCallEntry("e1", "2026-07-28T15:00:00Z", "write", { path: "/late.ts" }),
      toolCallEntry("e2", "2026-07-28T09:00:00Z", "write", { path: "/early.ts" }),
      toolCallEntry("e3", "2026-07-28T12:00:00Z", "write", { path: "/mid.ts" }),
    ];
    const files = extractTouchedFiles(ctxWith(entries), NO_CUT);
    expect(files.map((f) => f.path)).toEqual(["/early.ts", "/mid.ts", "/late.ts"]);
  });

  it("returns empty when no file toolCalls", () => {
    const entries: SessionEntry[] = [userEntry("e1", "2026-07-28T10:00:00Z")];
    const files = extractTouchedFiles(ctxWith(entries), NO_CUT);
    expect(files).toEqual([]);
  });
});

describe("renderTouchedFiles", () => {
  it("renders <Mon> <DD> <HH:MM> read|write|edit <path> lines", () => {
    const files: TouchedFile[] = [
      { path: "/a.ts", timestamp: "2026-07-28T14:30:00.000Z", op: "write" },
      { path: "/b.ts", timestamp: "2026-07-28T14:28:00.000Z", op: "edit" },
      { path: "/c.ts", timestamp: "2026-07-28T14:25:00.000Z", op: "read" },
    ];
    expect(renderTouchedFiles(files)).toEqual([
      "Jul 28 14:30 write /a.ts",
      "Jul 28 14:28 edit /b.ts",
      "Jul 28 14:25 read /c.ts",
    ]);
  });

  it("appends merged read ranges as a :start-end,... suffix on the path", () => {
    const files: TouchedFile[] = [
      {
        path: "/a.ts",
        timestamp: "2026-07-28T14:30:00.000Z",
        op: "read",
        lineRanges: [
          { start: 1, end: 50 },
          { start: 100, end: 200 },
        ],
      },
      { path: "/b.ts", timestamp: "2026-07-28T14:28:00.000Z", op: "read", lineRanges: [{ start: 40, end: 40 }] },
      { path: "/c.ts", timestamp: "2026-07-28T14:25:00.000Z", op: "read", lineRanges: [{ start: 60, end: null }] },
    ];
    expect(renderTouchedFiles(files)).toEqual([
      "Jul 28 14:30 read /a.ts:1-50,100-200",
      "Jul 28 14:28 read /b.ts:40",
      "Jul 28 14:25 read /c.ts:60-",
    ]);
  });

  it("renders no range suffix for a full read (no ranges) or a write/edit", () => {
    const files: TouchedFile[] = [
      { path: "/a.ts", timestamp: "2026-07-28T14:30:00.000Z", op: "read" },
      { path: "/b.ts", timestamp: "2026-07-28T14:28:00.000Z", op: "write" },
      { path: "/c.ts", timestamp: "2026-07-28T14:25:00.000Z", op: "edit" },
    ];
    expect(renderTouchedFiles(files)).toEqual([
      "Jul 28 14:30 read /a.ts",
      "Jul 28 14:28 write /b.ts",
      "Jul 28 14:25 edit /c.ts",
    ]);
  });

  it("renders nothing for empty input", () => {
    expect(renderTouchedFiles([])).toEqual([]);
  });

  it("collapses internal whitespace in a path so it cannot break the one-line render", () => {
    const files: TouchedFile[] = [
      { path: "path/with\nnewline\tand tabs.ts", timestamp: "2026-07-28T14:30:00.000Z", op: "write" },
    ];
    expect(renderTouchedFiles(files)).toEqual(["Jul 28 14:30 write path/with newline and tabs.ts"]);
  });

  it("renders the stored UTC instant as LOCAL time (not UTC)", () => {
    // The suite pins TZ=UTC; override to a known offset here, then restore, so
    // the day/time render is verified to go through new Date() local getters
    // (a UTC-positional slice would render 14:30 regardless of zone).
    const prevTz = process.env.TZ;
    try {
      process.env.TZ = "America/New_York"; // UTC-4 (EDT) in July
      const files: TouchedFile[] = [{ path: "/a.ts", timestamp: "2026-07-28T14:30:00.000Z", op: "write" }];
      expect(renderTouchedFiles(files)).toEqual(["Jul 28 10:30 write /a.ts"]);
    } finally {
      process.env.TZ = prevTz;
    }
  });
});
