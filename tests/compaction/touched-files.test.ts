// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// extractTouchedFiles + renderTouchedFiles: scans the active branch for
// read/write/edit toolCall entries since a cut entry, excludes bash, dedups by
// path (write dominates), and renders <DD> <HH:MM> ✎|👁 <path> oldest-first.

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
    expect(files).toEqual([
      { path: "/a.ts", timestamp: "2026-07-28T10:05:00.000Z", op: "write" },
      { path: "/b.ts", timestamp: "2026-07-28T10:06:00.000Z", op: "write" },
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

  it("dedups by path (write dominates, latest timestamp kept)", () => {
    const entries: SessionEntry[] = [
      toolCallEntry("e1", "2026-07-28T10:00:00Z", "read", { path: "/a.ts" }),
      toolCallEntry("e2", "2026-07-28T10:05:00Z", "write", { path: "/a.ts" }),
      toolCallEntry("e3", "2026-07-28T10:06:00Z", "read", { path: "/a.ts" }),
    ];
    const files = extractTouchedFiles(ctxWith(entries), NO_CUT);
    expect(files).toEqual([{ path: "/a.ts", timestamp: "2026-07-28T10:06:00.000Z", op: "write" }]);
  });

  it("starts strictly after sinceEntryId (the cut entry excluded)", () => {
    const entries: SessionEntry[] = [
      toolCallEntry("e1", "2026-07-28T10:00:00Z", "write", { path: "/old.ts" }),
      toolCallEntry("e2", "2026-07-28T11:00:00Z", "write", { path: "/cut.ts" }),
      toolCallEntry("e3", "2026-07-28T12:00:00Z", "write", { path: "/new.ts" }),
    ];
    const files = extractTouchedFiles(ctxWith(entries), "e2");
    expect(files.map((f) => f.path)).toEqual(["/new.ts"]);
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
  it("renders <DD> <HH:MM> ✎|👁 <path> lines", () => {
    const files: TouchedFile[] = [
      { path: "/a.ts", timestamp: "2026-07-28T14:30:00.000Z", op: "write" },
      { path: "/b.ts", timestamp: "2026-07-28T14:28:00.000Z", op: "read" },
    ];
    expect(renderTouchedFiles(files)).toEqual(["28 14:30 ✎ /a.ts", "28 14:28 👁 /b.ts"]);
  });

  it("renders nothing for empty input", () => {
    expect(renderTouchedFiles([])).toEqual([]);
  });

  it("collapses internal whitespace in a path so it cannot break the one-line render", () => {
    const files: TouchedFile[] = [
      { path: "path/with\nnewline\tand tabs.ts", timestamp: "2026-07-28T14:30:00.000Z", op: "write" },
    ];
    expect(renderTouchedFiles(files)).toEqual(["28 14:30 ✎ path/with newline and tabs.ts"]);
  });

  it("renders the stored UTC instant as LOCAL time (not UTC)", () => {
    // The suite pins TZ=UTC; override to a known offset here, then restore, so
    // the day/time render is verified to go through new Date() local getters
    // (a UTC-positional slice would render 14:30 regardless of zone).
    const prevTz = process.env.TZ;
    try {
      process.env.TZ = "America/New_York"; // UTC-4 (EDT) in July
      const files: TouchedFile[] = [{ path: "/a.ts", timestamp: "2026-07-28T14:30:00.000Z", op: "write" }];
      expect(renderTouchedFiles(files)).toEqual(["28 10:30 ✎ /a.ts"]);
    } finally {
      process.env.TZ = prevTz;
    }
  });
});
