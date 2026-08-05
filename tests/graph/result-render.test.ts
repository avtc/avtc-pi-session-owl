// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import { describe, expect, it } from "vitest";
import {
  type ContentMode,
  type GrepSpec,
  type RenderItem,
  renderBudgeted,
  resolveContentMode,
} from "../../src/graph/result-render.js";

// helper: an item whose header is ~1 token (4 chars) and content is N tokens.
function item(id: string, contentChars: number): RenderItem {
  const header = `h-${id}`; // 4 chars ≈ 1 token
  const content = contentChars > 0 ? "x".repeat(contentChars) : undefined;
  return { id, header, content };
}

// 1 token = 4 chars (estimateContentTokens = Math.ceil(len/4)).
const TOKEN = 4;

describe("resolveContentMode", () => {
  const grep = (pattern: string): GrepSpec => ({ pattern: new RegExp(pattern), context: 2 });
  it("terse when nothing set", () => {
    expect(resolveContentMode(false, null, undefined)).toEqual({ kind: "terse" });
  });
  it("full when fullDetails", () => {
    expect(resolveContentMode(true, null, undefined)).toEqual({ kind: "full" });
  });
  it("grep when contentPattern compiled", () => {
    expect(resolveContentMode(false, grep("foo"), undefined)).toEqual({
      kind: "grep",
      pattern: expect.any(RegExp),
      context: 2,
    });
  });
  it("lines when lines set", () => {
    expect(resolveContentMode(false, null, "40-60")).toEqual({ kind: "lines", start: 40, end: 60 });
  });
  it("lines and contentPattern are mutually exclusive", () => {
    // both set -> error (no silent override)
    const both = resolveContentMode(true, grep("foo"), "1-3");
    expect("error" in both).toBe(true);
    // grep alone still wins over fullDetails
    const m = resolveContentMode(true, grep("foo"), undefined);
    expect("error" in m ? null : m.kind).toBe("grep");
  });
  it("rejects a malformed line range", () => {
    expect("error" in resolveContentMode(false, null, "bad")).toBe(true);
  });
});

describe("renderBudgeted — terse", () => {
  const mode: ContentMode = { kind: "terse" };
  it("keeps all when under budget", async () => {
    const items = [item("a", 0), item("b", 0), item("c", 0)];
    const out = await renderBudgeted(items, { budget: 100, mode, findTimeoutMs: 5000 });
    expect(out.text).toBe("h-a\nh-b\nh-c");
    expect(out.note).toBeNull();
    expect(out.lastId).toBe("c");
  });
  it("truncates the list when budget exceeded, with a footer", async () => {
    const items = [item("a", 0), item("b", 0), item("c", 0), item("d", 0)];
    // budget 2 tokens keeps 2 items (each header ~1 token), drops 2.
    const out = await renderBudgeted(items, { budget: 2, mode, findTimeoutMs: 5000 });
    expect(out.text).toBe("h-a\nh-b");
    expect(out.note).toContain("2 more");
    expect(out.lastId).toBe("b");
  });
});

describe("renderBudgeted — full (two-stage)", () => {
  const mode: ContentMode = { kind: "full" };
  it("expands all when budget allows", async () => {
    const items = [item("a", 2 * TOKEN), item("b", 2 * TOKEN)];
    const out = await renderBudgeted(items, { budget: 100, mode, findTimeoutMs: 5000 });
    expect(out.text).toContain("x".repeat(2 * TOKEN));
    expect(out.note).toBeNull();
    expect(out.lastId).toBe("b");
  });
  it("shows all headers, expands only a prefix when content overflows", async () => {
    const items = [item("a", 10 * TOKEN), item("b", TOKEN)]; // a's content is big
    // budget ~3 tokens: 2 headers (~2) + 1 left → a's content (10 tokens) won't fit.
    const out = await renderBudgeted(items, { budget: 3, mode, findTimeoutMs: 5000 });
    expect(out.text).toContain("h-a");
    expect(out.text).toContain("h-b");
    expect(out.text).not.toContain("x".repeat(10 * TOKEN)); // a's content NOT expanded
    expect(out.note).toContain("not expanded");
  });
  it("returns a partial header list when even headers overflow", async () => {
    const items = [item("a", 0), item("b", 0), item("c", 0), item("d", 0)];
    const out = await renderBudgeted(items, { budget: 2, mode, findTimeoutMs: 5000 });
    expect(out.text).toBe("h-a\nh-b");
    expect(out.note).toContain("2 more");
    expect(out.lastId).toBe("b");
  });
});

describe("renderBudgeted — full uncapped (single-observation)", () => {
  const mode: ContentMode = { kind: "full" };
  it("returns the whole content with no budget cap", async () => {
    const items = [item("a", 100 * TOKEN)];
    const out = await renderBudgeted(items, { budget: null, mode, findTimeoutMs: 5000 });
    expect(out.text).toContain("x".repeat(100 * TOKEN));
    expect(out.note).toBeNull();
    expect(out.lastId).toBe("a");
  });
});

describe("renderBudgeted — lines", () => {
  const mode: ContentMode = { kind: "lines", start: 2, end: 3 };
  it("returns the clamped line range with 1-indexed numbers", async () => {
    const items: RenderItem[] = [{ id: "a", header: "h-a", content: "L1\nL2\nL3\nL4\nL5" }];
    const out = await renderBudgeted(items, { budget: 100, mode, findTimeoutMs: 5000 });
    expect(out.text).toContain("  2: L2");
    expect(out.text).toContain("  3: L3");
  });
  it("clamps end past the content length", async () => {
    const items: RenderItem[] = [{ id: "a", header: "h-a", content: "L1\nL2" }];
    const out = await renderBudgeted(items, {
      budget: 100,
      mode: { kind: "lines", start: 1, end: 99 },
      findTimeoutMs: 5000,
    });
    expect(out.text).toContain("  1: L1");
    expect(out.text).toContain("  2: L2");
  });
});

describe("renderBudgeted — grep", () => {
  const makeGrep = (pattern: string, context: number): ContentMode => ({
    kind: "grep",
    pattern: new RegExp(pattern),
    context,
  });
  it("emits matching lines with context + line numbers", async () => {
    const items: RenderItem[] = [{ id: "a", header: "h-a", content: "alpha\nbeta\ngamma\ndelta" }];
    const out = await renderBudgeted(items, { budget: 100, mode: makeGrep("beta", 1), findTimeoutMs: 5000 });
    expect(out.text).toContain("h-a");
    expect(out.text).toContain("1: alpha");
    expect(out.text).toContain("2: beta");
    expect(out.text).toContain("3: gamma");
    expect(out.note).toBeNull();
  });
  it("accumulates across observations, budget-checked per excerpt", async () => {
    const items: RenderItem[] = [
      { id: "a", header: "h-a", content: "hit\nx\nx" },
      { id: "b", header: "h-b", content: "hit\ny\ny" },
    ];
    // tight budget: header(a) + excerpt(a) fits, then header(b) overflows.
    const out = await renderBudgeted(items, { budget: 3, mode: makeGrep("hit", 0), findTimeoutMs: 5000 });
    expect(out.note).toContain("budget reached");
    expect(out.note).toMatch(/more observation/);
  });
  it("stops mid-observation noting more matches in this observation", async () => {
    // one observation with many matches; budget fits a few excerpts then overflows.
    const content = Array.from({ length: 20 }, (_, i) => (i % 2 === 0 ? "hit" : "miss")).join("\n");
    const items: RenderItem[] = [{ id: "a", header: "h-a", content }];
    const out = await renderBudgeted(items, { budget: 3, mode: makeGrep("hit", 0), findTimeoutMs: 5000 });
    expect(out.note).toContain("more matches in this observation");
  });
  it("emits the first excerpt even when it alone exceeds the remaining budget", async () => {
    // the `&& emittedExcerpt` guard ensures the FIRST excerpt of an observation
    // is always pushed once its header was emitted, even if that excerpt alone
    // overflows the remaining budget. A regression that flips && to || (or drops
    // the guard) would drop the first excerpt and must be caught here.
    // header ~1 tok; one long matching line (~10 tok); budget ~2 → after the
    // header ~1 tok remains, so the first excerpt (~2 tok) exceeds it but is
    // still pushed; a second excerpt is dropped (→ more-matches note).
    const longMatch = "hit".repeat(10);
    const items: RenderItem[] = [{ id: "a", header: "h-a", content: `${longMatch}\nmiss\n${longMatch}` }];
    const out = await renderBudgeted(items, { budget: 2, mode: makeGrep(longMatch, 0), findTimeoutMs: 5000 });
    // the first excerpt IS present despite exceeding the budget.
    expect(out.text).toContain("1: ");
    expect(out.note).toContain("more matches in this observation");
  });
  it("skips observations with no matches", async () => {
    const items: RenderItem[] = [
      { id: "a", header: "h-a", content: "nomatch" },
      { id: "b", header: "h-b", content: "hitme" },
    ];
    const out = await renderBudgeted(items, { budget: 100, mode: makeGrep("hit", 0), findTimeoutMs: 5000 });
    expect(out.text).not.toContain("h-a");
    expect(out.text).toContain("h-b");
  });
});

describe("renderBudgeted — empty", () => {
  it("returns empty text for no items", async () => {
    const out = await renderBudgeted([], { budget: 100, mode: { kind: "terse" }, findTimeoutMs: 5000 });
    expect(out.text).toBe("");
    expect(out.lastId).toBeNull();
  });
});
