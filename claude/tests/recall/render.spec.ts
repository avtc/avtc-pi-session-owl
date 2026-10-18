// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import { describe, expect, test } from "vitest";
// The owl_recall render-site restyle — the human-facing polish ported from
// pi's CollapsedOutput: the result text caps at the row limit with the
// expand hint; error rows never collapse; other tools and non-text outputs
// pass through untouched; the model's own payload is never affected (the
// restyle touches only the render prop).
import { makeOwlRecallTool } from "../../core/src/recall/owl-recall.js";
import {
  collapseRecallOutput,
  RECALL_COLLAPSED_LINE_LIMIT,
  RECALL_EXPAND_HINT,
  recallCallLine,
  restyleToolResultProps,
} from "../../host/recall/render.js";

function longText(rows: number): string {
  return Array.from({ length: rows }, (_, i) => `line ${i + 1}`).join("\n");
}

describe("collapseRecallOutput — the row cap + hint", () => {
  test("a text at or under the cap passes through unchanged (no hint)", () => {
    const text = longText(RECALL_COLLAPSED_LINE_LIMIT);
    expect(collapseRecallOutput(text)).toBe(text);
  });

  test("a longer text caps at the limit with the expand hint below", () => {
    const out = collapseRecallOutput(longText(40));
    const lines = out.split("\n");
    expect(lines).toHaveLength(RECALL_COLLAPSED_LINE_LIMIT + 1);
    expect(lines[lines.length - 1]).toBe(RECALL_EXPAND_HINT);
    expect(lines[0]).toBe("line 1");
    expect(lines[RECALL_COLLAPSED_LINE_LIMIT - 1]).toBe(`line ${RECALL_COLLAPSED_LINE_LIMIT}`);
  });

  test("the constants are pi's", () => {
    expect(RECALL_COLLAPSED_LINE_LIMIT).toBe(12);
    expect(RECALL_EXPAND_HINT).toBe("(Ctrl+O to expand)");
  });
});

describe("restyleToolResultProps — the site rule", () => {
  test("our tool's result text collapses", () => {
    const props = restyleToolResultProps({
      tool: "mcp__session-owl__owl_recall",
      output: { result: longText(40) },
      isErrored: false,
    });
    const out = (props.output as { result: string }).result;
    expect(out.split("\n")).toHaveLength(13);
    expect(out.endsWith(RECALL_EXPAND_HINT)).toBe(true);
  });

  test("error rows NEVER collapse (the platform draws the thrown text in full)", () => {
    const props = restyleToolResultProps({
      tool: "mcp__session-owl__owl_recall",
      output: { result: longText(40) },
      isErrored: true,
    });
    expect((props.output as { result: string }).result).toBe(longText(40));
  });

  test("other tools pass through untouched", () => {
    const props = { tool: "Bash", output: { stdout: longText(40) }, isErrored: false };
    expect(restyleToolResultProps(props)).toBe(props);
  });

  test("a non-text output passes through untouched", () => {
    const props = { tool: "mcp__session-owl__owl_recall", output: { rows: 3 }, isErrored: false };
    expect(restyleToolResultProps(props)).toBe(props);
  });
});

describe("recallCallLine — the compact call line (pi's action/qualifier logic)", () => {
  test("ids drill with a line range", () => {
    expect(recallCallLine({ ids: ["n23", "o5"], lines: "40-60" })).toBe("owl_recall ids: n23, o5 · lines 40-60");
  });

  test("search with grep + time range + pagination", () => {
    expect(
      recallCallLine({ query: "rewind", contentPattern: "marker", from: "2026-01-01 00:00", take: 20, afterId: "o9" }),
    ).toBe("owl_recall search: rewind · grep: marker · from 2026-01-01 00:00 · take 20 · after o9");
  });

  test("bare browse + defaults carry nothing", () => {
    expect(recallCallLine({})).toBe("owl_recall browse");
  });
});

describe("restyleToolResultProps — envelope preservation", () => {
  test("onScreen, output siblings, and envelope keys carry through untouched", () => {
    const props = restyleToolResultProps({
      tool: "mcp__session-owl__owl_recall",
      output: { result: Array.from({ length: 40 }, (_, i) => `r${i}`).join("\n"), meta: "keep-me" },
      isErrored: false,
      onScreen: { firstRow: 3, lastRow: 9 },
    });
    expect((props as { onScreen?: unknown }).onScreen).toEqual({ firstRow: 3, lastRow: 9 });
    expect((props as { isErrored: boolean }).isErrored).toBe(false);
    expect((props.output as { meta?: string }).meta).toBe("keep-me"); // output siblings survive
    const collapsed = (props.output as { result: string }).result;
    expect(collapsed.endsWith(RECALL_EXPAND_HINT)).toBe(true); // only the text changed
  });
});

describe("recallCallLine — reference drift-gate against the vendored renderCall", () => {
  const theme = {
    fg: (_cls: string, s: string) => s,
    bold: (s: string) => s,
  } as never;

  function vendoredCallLine(input: Record<string, unknown>): string {
    const tool = makeOwlRecallTool();
    if (tool.renderCall === undefined) throw new Error("vendored tool has no renderCall");
    const out = tool.renderCall(input as never, theme, undefined as never);
    return (out as unknown as { text: string }).text;
  }

  test("the port's call line equals the vendored renderer's text on every branch shape", () => {
    const shapes: Record<string, unknown>[] = [
      {},
      { ids: ["n23", "o5"], lines: "40-60" },
      { query: "rewind" },
      { query: "rewind", contentPattern: "marker", from: "2026-01-01 00:00", take: 20, afterId: "o9" },
      { contentPattern: "marker" },
      { includeSuperseded: true, fullDetails: true, contextLines: 5, to: "2026-02-01 00:00" },
      { query: "x", contextLines: 2, from: "" }, // the exclusion sentinels' boundary: ctx===2 omits, empty from omits
      { ids: ["n1"], take: 0 },
    ];
    for (const shape of shapes) {
      expect(recallCallLine(shape)).toBe(vendoredCallLine(shape));
    }
  });
});
