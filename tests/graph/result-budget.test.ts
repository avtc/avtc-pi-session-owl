// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import { describe, expect, it } from "vitest";
import {
  budgetWindow,
  buildGrepExcerpt,
  grepTimeoutNote,
  parseLineRange,
  searchableText,
  searchTimeoutNote,
  sliceLineRange,
} from "../../src/graph/result-budget.js";

describe("budgetWindow", () => {
  it("keeps all items when under budget", () => {
    const items = [
      { id: "a", text: "1234" },
      { id: "b", text: "1234" },
    ];
    const out = budgetWindow(items, 100);
    expect(out.kept).toEqual(items);
    expect(out.remaining).toBe(0);
    expect(out.lastKeptId).toBe("b");
  });

  it("truncates when the next item would overflow (1 token = 4 chars)", () => {
    // each item ~1 token; budget 3 tokens keeps 3 items, drops 2.
    const items = ["a", "b", "c", "d", "e"].map((id) => ({ id, text: "xxxx" }));
    const out = budgetWindow(items, 3);
    expect(out.kept.map((i) => i.id)).toEqual(["a", "b", "c"]);
    expect(out.remaining).toBe(2);
    expect(out.lastKeptId).toBe("c");
  });

  it("keeps the first item even if it alone exceeds the budget (never empty)", () => {
    const items = [{ id: "a", text: "x".repeat(100) }];
    const out = budgetWindow(items, 1);
    expect(out.kept).toHaveLength(1);
    expect(out.remaining).toBe(0);
    expect(out.lastKeptId).toBe("a");
  });

  it("returns empty for an empty list", () => {
    const out = budgetWindow([], 100);
    expect(out.kept).toEqual([]);
    expect(out.remaining).toBe(0);
    expect(out.lastKeptId).toBeNull();
  });
});

describe("buildGrepExcerpt", () => {
  const lines = ["alpha", "beta", "gamma", "delta", "beta", "epsilon", "zeta"];

  it("emits each match line plus context, with 1-indexed line numbers", () => {
    // matches at index 1 (beta) and 4 (beta); context 1 → [0-2] and [3-5]
    const out = buildGrepExcerpt(lines, [1, 4], 1);
    // range 0-2 then 3-5 → contiguous 0-5, one block
    expect(out).toEqual(["  1: alpha", "  2: beta", "  3: gamma", "  4: delta", "  5: beta", "  6: epsilon"]);
  });

  it("merges overlapping/adjacent ranges", () => {
    // matches at 2 and 3, context 1 → [1-3] and [2-4] merge to [1-4]
    const out = buildGrepExcerpt(lines, [2, 3], 1);
    expect(out).toEqual(["  2: beta", "  3: gamma", "  4: delta", "  5: beta"]);
  });

  it("clamps context to the start/end of the content", () => {
    // match at 0, context 2 → clamped to [0-2]
    const out = buildGrepExcerpt(lines, [0], 2);
    expect(out).toEqual(["  1: alpha", "  2: beta", "  3: gamma"]);
  });

  it("context 0 emits only the match line", () => {
    const out = buildGrepExcerpt(lines, [4], 0);
    expect(out).toEqual(["  5: beta"]);
  });

  it("returns nothing for no matches", () => {
    expect(buildGrepExcerpt(lines, [], 2)).toEqual([]);
  });
});

describe("parseLineRange", () => {
  it("parses a N-M range (1-indexed)", () => {
    expect(parseLineRange("40-60")).toEqual({ start: 40, end: 60 });
  });
  it("parses a single line N as N-N", () => {
    expect(parseLineRange("47")).toEqual({ start: 47, end: 47 });
  });
  it("swaps reversed bounds", () => {
    expect(parseLineRange("60-40")).toEqual({ start: 40, end: 60 });
  });
  it("rejects non-numeric / malformed input", () => {
    expect("error" in parseLineRange("foo")).toBe(true);
    expect("error" in parseLineRange("40-")).toBe(true);
    expect("error" in parseLineRange("-60")).toBe(true);
    expect("error" in parseLineRange("0-5")).toBe(true); // 1-indexed; 0 invalid
  });
});

describe("sliceLineRange", () => {
  const content = "line1\nline2\nline3\nline4\nline5";
  it("returns the 1-indexed range, clamped to the content length", () => {
    expect(sliceLineRange(content, "2-4")).toEqual({
      lines: ["line2", "line3", "line4"],
      start: 2,
    });
  });
  it("clamps end past the content length", () => {
    expect(sliceLineRange(content, "4-99")).toEqual({
      lines: ["line4", "line5"],
      start: 4,
    });
  });
  it("clamps start below 1 to 1", () => {
    expect(sliceLineRange(content, "1-2")).toEqual({ lines: ["line1", "line2"], start: 1 });
  });
  it("surfaces a parse error", () => {
    const out = sliceLineRange(content, "bad");
    expect("error" in out).toBe(true);
  });
});

describe("searchTimeoutNote", () => {
  it("formats seconds, tested of total, with the partial-results hint", () => {
    const note = searchTimeoutNote(30_000, 4, 10);
    expect(note).toBe(
      "Search timed out after 30s — tested 4 of 10 items before the kill. These are partial results; refine or narrow the query.",
    );
  });

  it("floors fractional seconds to a whole number", () => {
    // a 300ms timeout renders as 0s (Math.floor), not 0.3s — timeout notes
    // read better as whole seconds.
    const note = searchTimeoutNote(300, 0, 5);
    expect(note).toContain("after 0s —");
    expect(note).toContain("tested 0 of 5 items");
  });
});

describe("grepTimeoutNote", () => {
  it("formats floored seconds with the partial-excerpts hint", () => {
    expect(grepTimeoutNote(30_000)).toBe(
      "Grep timed out after 30s — partial excerpts only; refine or narrow the pattern.",
    );
  });

  it("floors fractional seconds to a whole number", () => {
    expect(grepTimeoutNote(300)).toContain("after 0s —");
  });
});

describe("searchableText", () => {
  it("concatenates summary + details with a newline when they differ", () => {
    expect(searchableText("the goal", "<USER>do the thing</USER>")).toBe("the goal\n<USER>do the thing</USER>");
  });

  it("emits the summary ONCE when details equal the summary (source-unavailable fallback)", () => {
    // the source-unavailable fallback renders the summary as the details; the
    // dedup contract is that the summary is NOT doubled.
    expect(searchableText("same line", "same line")).toBe("same line");
  });
});
