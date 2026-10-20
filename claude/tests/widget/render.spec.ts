// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// The widget line render port: formatWidgetLine + formatConflictLine over a
// local WidgetSnapshot type. PARITY: every fixture output is pinned against
// pi's own src/widget/render.ts (imported directly — its chain is pure),
// through a passthrough theme so the compared strings are the raw texts.
import { describe, expect, test } from "vitest";
import { formatConflictLine as piConflictRaw, formatWidgetLine as piWidget } from "../../../src/widget/render.js";

// The approved kebab substitution (/owl: -> /owl-) is the ONE deliberate
// divergence from pi's byte output; apply it before comparing.
const piConflict = (names: string[], width: number, theme2: unknown): string =>
  piConflictRaw(names, width, theme2 as never).replace(/owl:/g, "owl-");

import type { WidgetSnapshot as PiSnapshot } from "../../../src/widget/tracker.js";
import {
  formatConflictLine,
  formatIdleSegments,
  formatWidgetLine,
  type WidgetSegment,
  type WidgetSnapshot,
} from "../../host/widget/render.js";

/** Passthrough theme (colorless — the port and pi agree on the raw text). */
const theme = { fg: (_c: string, t: string) => t };

/** A minimal idle-ish snapshot exercising every section. */
function baseSnapshot(): WidgetSnapshot {
  return {
    stage: "observe",
    pass: 2,
    batch: { done: 1, total: 3 },
    usage: { input: 10, output: 20, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1, elapsedMs: 0 },
    streamingOutputTokens: 1234,
    obs: { count: 12, delta: 3 },
    roots: { count: 4, countDelta: 1, viewTokens: 8100, tokenDelta: 400, threshold: 16000 },
    selected: null,
    contextTokens: 22000,
    contextWindow: 200000,
    inFlightObs: 2,
  };
}

describe("formatWidgetLine — parity with pi's render", () => {
  test("the full observe line matches pi's byte-for-byte", () => {
    const snap = baseSnapshot();
    expect(formatWidgetLine(snap, theme)).toBe(piWidget(snap as unknown as PiSnapshot, theme));
  });

  test("the build line (pass marker, no batch) matches", () => {
    const snap = { ...baseSnapshot(), stage: "build" as const, batch: null, inFlightObs: 0 };
    expect(formatWidgetLine(snap, theme)).toBe(piWidget(snap as unknown as PiSnapshot, theme));
  });

  test("the select line (selected section, deltas) matches", () => {
    const snap: WidgetSnapshot = {
      ...baseSnapshot(),
      stage: "select",
      pass: 4,
      batch: null,
      inFlightObs: 0,
      selected: { count: 7, countDelta: -2, viewTokens: 5300, tokenDelta: -100, threshold: 8000 },
    };
    expect(formatWidgetLine(snap, theme)).toBe(piWidget(snap as unknown as PiSnapshot, theme));
  });

  test("null context collapses to ? and null deltas drop", () => {
    const snap: WidgetSnapshot = {
      ...baseSnapshot(),
      contextTokens: null,
      contextWindow: null,
      obs: { count: 5, delta: 0 },
      roots: { count: 2, countDelta: 0, viewTokens: 4000, tokenDelta: 0, threshold: 16000 },
      inFlightObs: 0,
      batch: null,
    };
    expect(formatWidgetLine(snap, theme)).toBe(piWidget(snap as unknown as PiSnapshot, theme));
    expect(formatWidgetLine(snap, theme)).toContain("?");
  });

  test("negative deltas render in parens, token deltas in k-units", () => {
    const snap: WidgetSnapshot = {
      ...baseSnapshot(),
      obs: { count: 9, delta: -2 },
      roots: { count: 3, countDelta: -1, viewTokens: 7700, tokenDelta: -300, threshold: 16000 },
    };
    const line = formatWidgetLine(snap, theme);
    expect(line).toContain("(-2)");
    expect(line).toContain("(-300)");
    expect(line).toBe(piWidget(snap as unknown as PiSnapshot, theme));
  });

  test("a single-chunk batch shows no N/M marker; multi does", () => {
    const one = { ...baseSnapshot(), batch: { done: 0, total: 1 } };
    expect(formatWidgetLine(one, theme)).not.toContain("0/1");
    const multi = { ...baseSnapshot(), batch: { done: 2, total: 5 } };
    expect(formatWidgetLine(multi, theme)).toContain("2/5");
  });

  test("the colored line routes fragments through the theme seam like pi's", () => {
    const marker = { fg: (c: string, t: string) => `<${c}>${t}</${c}>` };
    const snap = baseSnapshot();
    expect(formatWidgetLine(snap, marker)).toBe(piWidget(snap as unknown as PiSnapshot, marker));
  });
});

describe("formatIdleSegments — the usual line without a highlighted stage", () => {
  const join = (segs: WidgetSegment[]): string => segs.map((s) => s.text).join("");

  test("no accent anywhere; batch and pass markers drop", () => {
    const segs = formatIdleSegments(baseSnapshot());
    expect(segs.some((s) => s.color === "accent")).toBe(false);
    expect(join(segs)).not.toContain("1/3"); // the observe batch belongs to the run
    expect(join(segs)).not.toContain("#"); // the build pass marker belongs to the run
  });

  test("the run's deltas clear: the idle line shows plain counts", () => {
    const text = join(formatIdleSegments(baseSnapshot()));
    expect(text).not.toContain("("); // (+N)/(-N) deltas and the +N in-flight marker
    expect(text).toContain("12 obs");
    expect(text).toContain("4 roots");
  });

  test("counts stay; the stage agent's context/token cluster drops", () => {
    const segs = formatIdleSegments(baseSnapshot());
    const text = join(segs);
    expect(text).toContain("12 obs");
    expect(text).toContain("4 roots");
    expect(text).not.toContain("22k/200k");
    expect(text).not.toContain("tok");
  });

  test("a selected root renders without accent", () => {
    const snap = {
      ...baseSnapshot(),
      selected: { count: 2, countDelta: 1, viewTokens: 500, tokenDelta: 0, threshold: 4000 },
    };
    const segs = formatIdleSegments(snap);
    expect(join(segs)).toContain("2 selected");
    expect(segs.some((s) => s.color === "accent")).toBe(false);
  });
});

describe("formatConflictLine — parity + the degradation ladder", () => {
  test("single name, wide terminal: matches pi", () => {
    expect(formatConflictLine(["other-memory"], 100, theme)).toBe(piConflict(["other-memory"], 100, theme));
  });

  test("multiple names: plural verb, matches pi", () => {
    const names = ["alpha-memory", "beta-memory"];
    expect(formatConflictLine(names, 100, theme)).toBe(piConflict(names, 100, theme));
  });

  test("narrow: +N more collapse, then verb drop, then ellipsis — each rung matches pi", () => {
    const names = ["alpha-memory", "beta-memory", "gamma-memory"];
    for (const width of [64, 48, 34, 30, 26]) {
      expect(formatConflictLine(names, width, theme)).toBe(stripAnsi(piConflict(names, width, theme)));
    }
  });

  test("extremely narrow: the resolution hint is the last thing to go", () => {
    const line = formatConflictLine(["averyveryverylongname"], 22, theme);
    expect(visible(line)).toBeLessThanOrEqual(22);
  });
});

/** Strip ANSI SGR sequences (pi's truncateToWidth wraps its ellipsis in
 *  resets; the port is pre-theme/ANSI-free by design — the VISIBLE text is
 *  the parity contract). */
function stripAnsi(text: string): string {
  return text.replace(new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g"), "");
}

/** ANSI-blind width for assertion purposes. */
function visible(text: string): number {
  return stripAnsi(text).length;
}
