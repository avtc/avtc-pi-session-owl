// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// The agent-initiated compaction core: the setting parse, the pending-notes
// stash lifecycle, and the origin resolution a compaction renders (the
// agent's pending request over the user's typed instructions; both drop
// after one read).

import { describe, expect, it } from "vitest";
import {
  clearPendingCompact,
  clearPendingCompactForSession,
  compactNotesFor,
  consumePendingCompact,
  OWL_COMPACT_AGENT_LABEL,
  OWL_COMPACT_DISABLED_TEXT,
  OWL_COMPACT_SCHEDULED_TEXT,
  OWL_COMPACT_USER_LABEL,
  parseAgentCompactValue,
  peekPendingCompact,
  setPendingCompact,
} from "../../src/compaction/agent-compact-core.js";

describe("parseAgentCompactValue", () => {
  it("on = enabled without a floor", () => {
    expect(parseAgentCompactValue("on")).toEqual({ mode: "on", thresholdK: null });
  });

  it("on>Nk = enabled with a floor (case-insensitive k)", () => {
    expect(parseAgentCompactValue("on>40k")).toEqual({ mode: "on", thresholdK: 40 });
    expect(parseAgentCompactValue("ON>75K")).toEqual({ mode: "on", thresholdK: 75 });
  });

  it("an absent value is the shipped default (on); a present-but-garbage one is off", () => {
    expect(parseAgentCompactValue(undefined)).toEqual({ mode: "on", thresholdK: null });
    expect(parseAgentCompactValue(null)).toEqual({ mode: "on", thresholdK: null });
  });

  it("off, malformed, and padded values are off", () => {
    expect(parseAgentCompactValue("off").mode).toBe("off");
    expect(parseAgentCompactValue("on> ").mode).toBe("off");
    expect(parseAgentCompactValue("compact").mode).toBe("off");
    // padded values trim to a clean read
    expect(parseAgentCompactValue(" on ")).toEqual({ mode: "on", thresholdK: null });
  });
});

describe("pending compact stash", () => {
  it("set then consume returns the request once", () => {
    setPendingCompact("k1", "finish the report");
    expect(peekPendingCompact("k1")?.notes).toBe("finish the report");
    expect(consumePendingCompact("k1")?.notes).toBe("finish the report");
    expect(consumePendingCompact("k1")).toBeNull();
    expect(peekPendingCompact("k1")).toBeNull();
  });

  it("the latest call replaces an earlier pending request", () => {
    setPendingCompact("k2", "first");
    setPendingCompact("k2", "second");
    expect(consumePendingCompact("k2")?.notes).toBe("second");
  });

  it("clear drops the request", () => {
    setPendingCompact("k3", "x");
    clearPendingCompact("k3");
    expect(peekPendingCompact("k3")).toBeNull();
  });

  it("a session-end clear drops the main key and every loop key, other sessions untouched", () => {
    setPendingCompact("sess-a", "main a");
    setPendingCompact("sess-a|ag-1", "loop 1");
    setPendingCompact("sess-a|ag-2", "loop 2");
    setPendingCompact("sess-b", "main b");
    clearPendingCompactForSession("sess-a");
    expect(peekPendingCompact("sess-a")).toBeNull();
    expect(peekPendingCompact("sess-a|ag-1")).toBeNull();
    expect(peekPendingCompact("sess-a|ag-2")).toBeNull();
    expect(peekPendingCompact("sess-b")?.notes).toBe("main b");
    clearPendingCompact("sess-b");
  });

  it("keys are independent", () => {
    setPendingCompact("ka", "a");
    setPendingCompact("kb", "b");
    expect(consumePendingCompact("ka")?.notes).toBe("a");
    expect(consumePendingCompact("kb")?.notes).toBe("b");
  });
});

describe("compactNotesFor origin resolution", () => {
  it("a pending agent request wins over typed user instructions", () => {
    setPendingCompact("n1", "agent notes");
    const notes = compactNotesFor("n1", "user focus");
    expect(notes).toEqual({ text: "agent notes", origin: "agent" });
    expect(peekPendingCompact("n1")).toBeNull();
  });

  it("typed instructions render as user origin when no request waits", () => {
    expect(compactNotesFor("n2", "keep the API decisions")).toEqual({
      text: "keep the API decisions",
      origin: "user",
    });
  });

  it("no request and no instructions render nothing", () => {
    expect(compactNotesFor("n3", undefined)).toBeNull();
    expect(compactNotesFor("n3", "")).toBeNull();
    expect(compactNotesFor("n3", "   ")).toBeNull(); // whitespace-only instructions
  });

  it("a stale pending request renders nothing (an entry that outlived its turn boundary)", () => {
    setPendingCompact("n4", "old plan");
    const aged = peekPendingCompact("n4");
    expect(aged).not.toBeNull();
    if (aged !== null) aged.ts = Date.now() - 11 * 60 * 1000; // peek hands the stored record
    expect(compactNotesFor("n4", undefined)).toBeNull();
  });
});

describe("the user-facing strings stay stable", () => {
  it("the exact approved texts", () => {
    expect(OWL_COMPACT_SCHEDULED_TEXT).toBe(
      "compaction scheduled at the end of this turn — end your turn; the session compacts and continues automatically with your notes",
    );
    expect(OWL_COMPACT_DISABLED_TEXT).toBe("compaction not scheduled: user temporary disabled agent-initiated compact");
    expect(OWL_COMPACT_AGENT_LABEL).toBe("## Continue instructions you have sent before executing compaction");
    expect(OWL_COMPACT_USER_LABEL).toBe("## Continue instructions from user");
  });
});
