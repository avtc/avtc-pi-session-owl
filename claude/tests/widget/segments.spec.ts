// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// The band's painted spans — the widget line as structured segments so the
// AbovePrompt band can color each fragment with the engine's Text elements
// (pi paints through its Theme; the port's band paints through per-span
// Text props). Contracts:
//   parity  — joining the segments' text reproduces pi's byte line exactly;
//   accent  — the ACTIVE stage's count carries the accent color (pi's rule:
//             count-color = accent while its stage is running);
//   labels/separators/params ride dim; the trailing runtime cluster muted.
import { describe, expect, test } from "vitest";
import { formatWidgetLine as piWidget } from "../../../src/widget/render.js";
import type { WidgetSnapshot as PiSnapshot } from "../../../src/widget/tracker.js";
import type { WidgetSnapshot } from "../../host/widget/render.js";
import { formatWidgetLine, formatWidgetSegments, type WidgetSegment } from "../../host/widget/render.js";

const theme = { fg: (_c: string, t: string) => t };

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

const texts = (segs: WidgetSegment[]): string => segs.map((s) => s.text).join("");
const accent = (segs: WidgetSegment[]): string[] => segs.filter((s) => s.color === "accent").map((s) => s.text);
const dim = (segs: WidgetSegment[]): string[] => segs.filter((s) => s.color === "dim").map((s) => s.text);

describe("formatWidgetSegments", () => {
  test("joining the segments reproduces pi's byte-exact line", () => {
    const snap = baseSnapshot();
    expect(texts(formatWidgetSegments(snap))).toBe(formatWidgetLine(snap, theme));
    expect(texts(formatWidgetSegments(snap))).toBe(piWidget(snap as unknown as PiSnapshot, theme));
  });

  test("observe stage: the obs count + delta are the only accent segments", () => {
    const snap = baseSnapshot();
    expect(accent(formatWidgetSegments(snap))).toEqual(["12", "(+3)"]);
  });

  test("build stage: the roots count + delta move to accent, obs goes plain", () => {
    const snap = { ...baseSnapshot(), stage: "build" as const };
    expect(accent(formatWidgetSegments(snap))).toEqual(["4", "(+1)"]);
  });

  test("select stage: the selected section is accent, the structural counts are not", () => {
    const snap: WidgetSnapshot = {
      ...baseSnapshot(),
      stage: "select",
      batch: null,
      inFlightObs: 0,
      selected: { count: 7, countDelta: -1, viewTokens: 5300, tokenDelta: -100, threshold: 8000 },
    };
    expect(accent(formatWidgetSegments(snap))).toEqual(["7", "(-1)"]);
  });

  test("dim carries the labels and separators; muted the trailing cluster", () => {
    const snap = baseSnapshot();
    const segs = formatWidgetSegments(snap);
    expect(dim(segs)).toContain(" obs");
    expect(dim(segs)).toContain(" → ");
    expect(dim(segs)).toContain(" roots ");
    expect(dim(segs)).toContain(" · ");
    const muted = segs.filter((s) => s.color === "muted").map((s) => s.text);
    expect(muted.join("|")).toContain("22k/200k");
    expect(muted.join("|")).toContain("1.2k tok");
  });

  test("adjacent same-color fragments are kept apart in the order pi paints them", () => {
    const snap = baseSnapshot();
    const segs = formatWidgetSegments(snap);
    // the owl prefix is its own 'text' segment up front
    expect(segs[0]).toEqual({ text: "🦉 ", color: "text" });
    // …and the segment stream has no empty text fragments
    expect(segs.every((s) => s.text.length > 0)).toBe(true);
  });

  test("the ±batch/in-flight markers ride their color out of the same order", () => {
    const snap = baseSnapshot();
    const segs = formatWidgetSegments(snap);
    expect(texts(segs)).toContain(" 1/3");
    expect(texts(segs)).toContain("+2 obs");
  });
});
