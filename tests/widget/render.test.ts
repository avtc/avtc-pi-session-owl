// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// Unit tests for formatWidgetLine — pure over a WidgetSnapshot.
// A fake Theme marks each fg(color, text) as «color|text» so structure + color
// assignment are both assertable without a real terminal. Structural assertions
// strip the markers (visible text); color assertions check the marked fragments.

import { describe, expect, it } from "vitest";
import { formatWidgetLine } from "../../src/widget/render.js";
import type { WidgetSnapshot } from "../../src/widget/tracker.js";

interface FakeTheme {
  fg(color: string, text: string): string;
}

function fakeTheme(): FakeTheme {
  return {
    fg(color, text) {
      return `«${color}|${text}»`;
    },
  };
}

/** Strip the «color|...» markers to recover the visible text. */
function visible(line: string): string {
  return line.replace(/«[^|]*\|/g, "").replace(/»/g, "");
}

const ZERO_USAGE = { input: 0, output: 0, cacheRead: 0, cost: 0, turns: 0, elapsedMs: 0 };

function snap(over: Partial<WidgetSnapshot>): WidgetSnapshot {
  return {
    stage: "observe",
    pass: 1,
    batch: null,
    usage: ZERO_USAGE,
    streamingOutputTokens: 0,
    obs: { count: 0, delta: 0 },
    roots: { count: 0, countDelta: 0, viewTokens: 0, tokenDelta: 0, threshold: 40_000 },
    selected: null,
    contextTokens: 0,
    contextWindow: 262_000,
    inFlightObs: 0,
    ...over,
  } as WidgetSnapshot;
}

function render(s: WidgetSnapshot): { line: string; text: string } {
  const line = formatWidgetLine(s, fakeTheme() as unknown as Parameters<typeof formatWidgetLine>[1]);
  return { line, text: visible(line) };
}

describe("formatWidgetLine", () => {
  it("OBSERVE: obs+delta → roots+delta/threshold · ctx/window · tok", () => {
    const { text } = render(
      snap({
        stage: "observe",
        obs: { count: 1000, delta: 5 },
        roots: { count: 100, countDelta: 5, viewTokens: 45_000, tokenDelta: 5000, threshold: 40_000 },
        contextTokens: 12_000,
        contextWindow: 262_000,
        streamingOutputTokens: 1100,
      }),
    );
    // owl is a LEADING PREFIX (🦉 {obs}), not a ' → ' section (🦉 → {obs})
    expect(text.startsWith("🦉 ")).toBe(true);
    expect(text).not.toContain("🦉 →");
    expect(text).toContain("1000(+5) obs");
    expect(text).toContain("100(+5) roots");
    expect(text).toContain("45k(+5.0k)/40k");
    expect(text).toContain("12k/262k");
    expect(text).toContain("1.1k tok");
  });

  it("trailing cluster gains · +N obs while the current chunk has accepted records in flight", () => {
    const { text } = render(
      snap({
        stage: "observe",
        batch: { done: 150, total: 371 },
        obs: { count: 5488, delta: 11 },
        contextTokens: 37_000,
        contextWindow: 262_000,
        streamingOutputTokens: 223,
        inFlightObs: 3,
      }),
    );
    expect(text).toContain("37k/262k · 223 tok · +3 obs");
  });

  it("+N obs is absent while nothing is in flight (0)", () => {
    const { text } = render(
      snap({
        stage: "observe",
        contextTokens: 12_000,
        contextWindow: 262_000,
        streamingOutputTokens: 1100,
        inFlightObs: 0,
      }),
    );
    expect(text).toContain("12k/262k · 1.1k tok");
    expect(text).not.toContain("obs ·");
    expect(text).not.toContain("+0 obs");
  });

  it("separators: → between structural sections, · into + within the trailing runtime cluster", () => {
    const { text } = render(
      snap({
        stage: "observe",
        obs: { count: 33, delta: 0 },
        roots: { count: 33, countDelta: 0, viewTokens: 2500, tokenDelta: 0, threshold: 40_000 },
        contextTokens: 87_000,
        contextWindow: 262_000,
        streamingOutputTokens: 0,
      }),
    );
    // structural break obs→roots uses → ; the trailing runtime cluster (roots
    // view-budget · ctx/window · tok) uses ·
    expect(text).toContain("33 obs → 33 roots");
    expect(text).toContain("2.5k/40k · 87k/262k · 0 tok");
    // the trailing cluster must NOT use → between its parts
    expect(text).not.toContain("/40k → ");
    expect(text).not.toContain("/262k → ");
  });

  it("OBSERVE shows inline N/M batch only when total > 1", () => {
    const multi = render(snap({ stage: "observe", batch: { done: 3, total: 7 } })).text;
    expect(multi).toContain("3/7");
    const single = render(snap({ stage: "observe", batch: { done: 1, total: 1 } })).text;
    expect(single).not.toContain("1/1");
  });

  it("BUILD with an in-flight observe batch shows N/M in the obs section (mid-catch-up Builder)", () => {
    const { text } = render(snap({ stage: "build", pass: 1, batch: { done: 3, total: 12 } }));
    expect(text).toContain("obs 3/12 →");
    expect(text).toContain("#1");
  });

  it("BUILD with no in-flight batch shows no N/M (post-Observer Builder at compaction)", () => {
    const { text } = render(snap({ stage: "build", pass: 1, batch: null }));
    expect(text).not.toMatch(/obs \d+\/\d+/);
  });

  it("BUILD appends #pass to the roots section", () => {
    const { text } = render(
      snap({
        stage: "build",
        pass: 2,
        roots: { count: 95, countDelta: -10, viewTokens: 35_000, tokenDelta: -10_000, threshold: 40_000 },
      }),
    );
    expect(text).toContain("#2");
    expect(text).toContain("95(-10) roots");
    expect(text).toContain("35k(-10k)/40k");
  });

  it("deltas are omitted when zero (no (+0))", () => {
    const { text } = render(
      snap({
        stage: "observe",
        obs: { count: 1000, delta: 0 },
        roots: { count: 100, countDelta: 0, viewTokens: 45_000, tokenDelta: 0, threshold: 40_000 },
      }),
    );
    expect(text).not.toContain("(+0)");
    expect(text).toContain("1000 obs");
    expect(text).toContain("100 roots");
    expect(text).toContain("45k/40k");
  });

  it("SELECT renders the selected section with #pass (selected-root only)", () => {
    const { text } = render(
      snap({
        stage: "select",
        pass: 2,
        selected: {
          count: 20,
          countDelta: -75,
          viewTokens: 15_000,
          tokenDelta: -20_000,
          threshold: 20_000,
        },
      }),
    );
    expect(text).toContain("selected");
    expect(text).toContain("20(-75) selected");
    expect(text).toContain("15k(-20k)/20k");
    expect(text).toContain("#2");
  });

  it("selected section is absent outside a Select stage", () => {
    const { text } = render(snap({ stage: "build", selected: null }));
    expect(text).not.toContain("selected");
  });

  it("null contextTokens renders ?/{contextWindow}", () => {
    const { text } = render(snap({ contextTokens: null, contextWindow: 262_000 }));
    expect(text).toContain("?/262k");
  });

  it("null contextWindow (getContextUsage undefined) renders ? alone (never ?/0)", () => {
    const { text } = render(snap({ contextTokens: null, contextWindow: null }));
    expect(text).toContain("?");
    expect(text).not.toContain("?/0");
    expect(text).not.toContain("?/0k");
  });

  it("applies theme colors: counts accent on the active section, dim on separators/labels", () => {
    const { line } = render(
      snap({
        stage: "build",
        pass: 1,
        obs: { count: 1000, delta: 0 },
        roots: { count: 100, countDelta: 0, viewTokens: 45_000, tokenDelta: 0, threshold: 40_000 },
      }),
    );
    // build stage → roots count is accent-colored; obs count is plain text.
    expect(line).toContain("«accent|100»");
    expect(line).toContain("«text|1000»");
    // a section separator is dim
    expect(line).toContain("«dim| → »");
    // trailing tok is muted (the whole "N tok" fragment)
    expect(line).toContain("«muted|0 tok»");
  });
});
