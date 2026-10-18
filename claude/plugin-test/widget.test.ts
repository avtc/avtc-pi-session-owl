// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// Engine-kit twin of the widget surface: the closure-clean slice — the
// line store + the band composition (what the live AbovePrompt branch in
// the hooks module reads) and the width pair. The tracker bridge rides the
// Node suite (it reuses the vendored read-tools, whose bare-package edge
// the kit loader refuses — a kit-loader platform gap); this twin pins the
// loadable contracts under the real kit loader.
import { describe, expect, test } from "claude-code/testing";
import { composeBand, decideBand } from "../host/widget/band.js";
import { _resetWidgetLine, setWidgetLine, widgetLine, widgetSegments } from "../host/widget/line-store.js";
import { truncateToWidth, visibleWidth } from "../host/widget/width.js";

const ELEMENTS = {
  Box: (props: { children?: unknown[] }) => ({ type: "Box", ...props }),
  Text: (props: { children?: unknown[] }) => ({ type: "Text", ...props }),
};

describe("the band's line store — engine-run twin", () => {
  test("set/get round-trip; reset clears", () => {
    _resetWidgetLine();
    expect(widgetLine()).toBeNull();
    setWidgetLine("🦉 1 obs");
    expect(widgetLine()).toBe("🦉 1 obs");
    _resetWidgetLine();
  });
});

describe("the band composition — engine-run twin", () => {
  test("a survey yields; a live line composes under the inner drawing", () => {
    setWidgetLine("🦉 5 obs → 2 roots");
    expect(decideBand(true, "inner").kind).toBe("passthrough");
    const decision = decideBand(false, "inner");
    if (decision.kind !== "compose") throw new Error("expected compose");
    const out = composeBand(ELEMENTS, decision) as { type: string; children: unknown[] };
    expect(out.type).toBe("Box");
    expect(out.children).toEqual(["inner", { type: "Text", children: ["🦉 5 obs → 2 roots"] }]);
    _resetWidgetLine();
  });
});

describe("the painted band line — engine-run twin", () => {
  test("segments ride the line and compose as styled Text spans", () => {
    _resetWidgetLine();
    setWidgetLine("12 obs", [
      { text: "12", color: "accent" },
      { text: " obs", color: "dim" },
    ]);
    expect(widgetSegments()).toHaveLength(2);
    const decision = decideBand(false, "inner");
    if (decision.kind !== "compose") throw new Error("expected compose");
    const out = composeBand(ELEMENTS, decision) as { type: string; children: unknown[] };
    expect(out.children[1]).toEqual({
      type: "Box",
      flexDirection: "row",
      children: [
        { type: "Text", children: ["12"], color: "claude" },
        { type: "Text", children: [" obs"], dimColor: true },
      ],
    });
    _resetWidgetLine();
  });

  test("a plain publish keeps the single-Text shape", () => {
    _resetWidgetLine();
    setWidgetLine("plain");
    expect(widgetSegments()).toBeNull();
    const decision = decideBand(false, "inner");
    if (decision.kind !== "compose") throw new Error("expected compose");
    const out = composeBand(ELEMENTS, decision) as { type: string; children: unknown[] };
    expect(out.children[1]).toEqual({ type: "Text", children: ["plain"] });
  });
});

describe("the width pair — engine-run twin", () => {
  test("the owl measures two cells; truncation keeps graphemes whole", () => {
    expect(visibleWidth("🦉")).toBe(2);
    expect(truncateToWidth("🦉🦉🦉", 5, "…")).toBe("🦉🦉…");
  });
});
