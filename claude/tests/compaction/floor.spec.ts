// SPDX-License-Identifier: MIT
// SPDXFileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// The observation floor: owl's own answered summaries bound the catch-up
// scope. Own-summary identity is the recorded exact text — a user message
// that merely opens like a summary never matches.

import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { describe, expect, test } from "vitest";
import { ownSummaryFloorIndex } from "../../host/compaction/floor.js";
import { normalizeSummaryText } from "../../host/storage/summary-identity.js";

function userEntry(id: string, text: string): SessionEntry {
  return {
    id,
    timestamp: `${id}-ts`,
    type: "message",
    message: { role: "user", content: text },
  } as unknown as SessionEntry;
}

function compactionEntry(id: string, summary: string): SessionEntry {
  return { id, timestamp: `${id}-ts`, type: "compaction", summary } as unknown as SessionEntry;
}

describe("ownSummaryFloorIndex", () => {
  test("no recorded texts -> no floor (-1)", () => {
    expect(ownSummaryFloorIndex([userEntry("a", "hello")], new Set())).toBe(-1);
  });

  test("a row whose exact text is recorded is the floor; whitespace variance tolerates", () => {
    const entries = [userEntry("a", "first"), userEntry("b", "# Memory\nthe summary"), userEntry("c", "after")];
    const texts = new Set([normalizeSummaryText("# Memory\nthe summary  ")]); // sets hold normalized texts
    expect(ownSummaryFloorIndex(entries, texts)).toBe(1);
  });

  test("a summary-shaped user row that is NOT a recorded text never matches", () => {
    const entries = [userEntry("a", "first"), userEntry("b", "# Memory\na look-alike"), userEntry("c", "after")];
    expect(ownSummaryFloorIndex(entries, new Set(["# Memory\nthe real one"].map(normalizeSummaryText)))).toBe(-1);
  });

  test("the NEWEST matching row wins; a compaction-type entry matches by its summary", () => {
    const entries = [
      userEntry("a", "first"),
      compactionEntry("b", "# Memory\nolder"),
      userEntry("c", "mid"),
      compactionEntry("d", "# Memory\nnewer"),
      userEntry("e", "after"),
    ];
    const texts = new Set(["# Memory\nolder", "# Memory\nnewer"].map(normalizeSummaryText));
    expect(ownSummaryFloorIndex(entries, texts)).toBe(3);
  });
});
