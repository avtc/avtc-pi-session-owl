// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// The band composition's contract: survey yield, empty-store passthrough,
// and the Box{[next, Text(line)]} shape that keeps every other mod's band
// content alive.
import { describe, expect, test } from "vitest";
import { type BandElements, composeBand, decideBand } from "../../host/widget/band.js";
import { _resetWidgetLine, setWidgetLine, widgetLine, widgetSegments } from "../../host/widget/line-store.js";
import type { WidgetSegment } from "../../host/widget/render.js";

const ELEMENTS: BandElements = {
  Box: (props) => ({ type: "Box", ...props }),
  Text: (props) => ({ type: "Text", ...props }),
};

describe("decideBand", () => {
  test("a survey holding the band yields — passthrough whatever the line", () => {
    setWidgetLine("🦉 1 obs → 0 roots · ? · 0 tok");
    expect(decideBand(true, "inner")).toEqual({ kind: "passthrough" });
  });

  test("no line in the store: passthrough (the band composes nothing)", () => {
    _resetWidgetLine();
    expect(decideBand(false, "inner")).toEqual({ kind: "passthrough" });
  });

  test("an empty-string line is treated as hidden", () => {
    setWidgetLine("");
    expect(decideBand(false, "inner")).toEqual({ kind: "passthrough" });
  });

  test("a live line composes under the inner drawing", () => {
    setWidgetLine("🦉 12 obs → 3 roots · 22k/200k · 1.2k tok");
    expect(decideBand(false, { type: "Foreign" })).toEqual({
      kind: "compose",
      inner: { type: "Foreign" },
      line: "🦉 12 obs → 3 roots · 22k/200k · 1.2k tok",
    });
  });
});

describe("composeBand", () => {
  test("the Box wraps [inner, Text(line)] — other mods' band content survives", () => {
    setWidgetLine("🦉 line");
    const decision = decideBand(false, { type: "Inner" });
    if (decision.kind !== "compose") throw new Error("expected compose");
    const out = composeBand(ELEMENTS, decision) as { type: string; children: unknown[] };
    expect(out.type).toBe("Box");
    expect(out.children).toHaveLength(2);
    expect(out.children[0]).toEqual({ type: "Inner" });
    expect(out.children[1]).toEqual({ type: "Text", children: ["🦉 line"] });
  });
});

describe("the line store", () => {
  test("set/get round-trip; reset clears", () => {
    _resetWidgetLine();
    expect(widgetLine()).toBeNull();
    expect(widgetSegments()).toBeNull();
    setWidgetLine("x");
    expect(widgetLine()).toBe("x");
    _resetWidgetLine();
    expect(widgetLine()).toBeNull();
    expect(widgetSegments()).toBeNull();
  });

  test("segments ride with their line and drop when the caller has none", () => {
    _resetWidgetLine();
    const segs: WidgetSegment[] = [
      { text: "12", color: "accent" },
      { text: " obs", color: "dim" },
    ];
    setWidgetLine("12 obs", segs);
    expect(widgetSegments()).toEqual(segs);
    setWidgetLine("plain");
    expect(widgetSegments()).toBeNull();
  });
});

describe("composeBand — the painted line", () => {
  test("a painted line composes as a row of styled Text spans (colors reach the band)", () => {
    const segs: WidgetSegment[] = [
      { text: "12", color: "accent" },
      { text: " obs", color: "dim" },
      { text: " · 22k/200k", color: "muted" },
    ];
    setWidgetLine("12 obs · 22k/200k", segs);
    const decision = decideBand(false, { type: "Inner" });
    if (decision.kind !== "compose") throw new Error("expected compose");
    const out = composeBand(ELEMENTS, decision) as { type: string; children: unknown[] };
    expect(out.children[0]).toEqual({ type: "Inner" });
    expect(out.children[1]).toEqual({
      type: "Box",
      flexDirection: "row",
      children: [
        { type: "Text", children: ["12"], color: "claude" },
        { type: "Text", children: [" obs"], dimColor: true },
        { type: "Text", children: [" · 22k/200k"], color: "subtle" },
      ],
    });
  });

  test("a plain 'text' segment carries the theme's text color", () => {
    setWidgetLine("x", [{ text: "x", color: "text" }]);
    const decision = decideBand(false, "inner");
    if (decision.kind !== "compose") throw new Error("expected compose");
    const out = composeBand(ELEMENTS, decision) as { type: string; children: { children: unknown[] }[] };
    const row = out.children[1] as { children: unknown[] };
    expect(row.children[0]).toEqual({ type: "Text", children: ["x"], color: "text" });
  });

  test("a line with no segments still draws as one plain Text", () => {
    setWidgetLine("plain line");
    const decision = decideBand(false, { type: "Inner" });
    if (decision.kind !== "compose") throw new Error("expected compose");
    const out = composeBand(ELEMENTS, decision) as { type: string; children: unknown[] };
    expect(out.children[1]).toEqual({ type: "Text", children: ["plain line"] });
  });

  test("a foreign line (the pause override) never borrows the stage segments", () => {
    setWidgetLine("stage line", [{ text: "stage line", color: "accent" }]);
    const decision = decideBand(false, "inner", "pause line");
    if (decision.kind !== "compose") throw new Error("expected compose");
    const out = composeBand(ELEMENTS, decision) as { type: string; children: unknown[] };
    expect(out.children[1]).toEqual({ type: "Text", children: ["pause line"] });
    _resetWidgetLine();
  });
});

describe("decideBand — the conflict-pause line", () => {
  test("a pause line wins over a stale stage line, even with no line stored", () => {
    _resetWidgetLine();
    const decision = decideBand(false, "inner", "🦉 ⚠ paused — evil-mod also handles compaction (/owl-status)");
    expect(decision).toEqual({
      kind: "compose",
      inner: "inner",
      line: "🦉 ⚠ paused — evil-mod also handles compaction (/owl-status)",
    });
    setWidgetLine("🦉 stale stage line");
    const again = decideBand(false, "inner", "🦉 ⚠ paused — evil-mod also handles compaction (/owl-status)");
    expect(again.kind).toBe("compose");
    if (again.kind === "compose") expect(again.line).toContain("paused");
    _resetWidgetLine();
  });

  test("a survey still holds the band even while paused (the engine's survey wins)", () => {
    const decision = decideBand(true, "inner", "🦉 ⚠ paused — evil-mod also handles compaction (/owl-status)");
    expect(decision).toEqual({ kind: "passthrough" });
  });

  test("no pause line keeps the store-driven behavior", () => {
    _resetWidgetLine();
    expect(decideBand(false, "inner", null)).toEqual({ kind: "passthrough" });
    setWidgetLine("🦉 line");
    expect(decideBand(false, "inner", null)).toEqual({ kind: "compose", inner: "inner", line: "🦉 line" });
    _resetWidgetLine();
  });
});
