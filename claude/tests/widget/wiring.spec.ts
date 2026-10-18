// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// The live hook wiring for the widget band: the register's ui.render
// handler answering AbovePrompt asks through the REAL register(on) wiring
// over the in-memory harness — the survey yield, the empty-store
// passthrough, and the Box composition with the line-store's current line.
import { describe, expect, test } from "vitest";
import { _resetWidgetLine, setWidgetLine } from "../../host/widget/line-store.js";
import { createHarness } from "../helpers/harness.js";

async function bandHarness() {
  const h = createHarness();
  await h.load();
  return h;
}

describe("the AbovePrompt band branch (live wiring)", () => {
  test("no line in the store: the band passes through untouched", async () => {
    _resetWidgetLine();
    const h = await bandHarness();
    const out = await h.dispatch("ui.render", {
      component: "AbovePrompt",
      surface: "terminal",
      hasSurvey: false,
      requestId: "r1",
    });
    // passthrough: the event itself (the harness's next default)
    expect((out as { component?: string }).component).toBe("AbovePrompt");
  });

  test("a live line composes Box{[next, Text(line)]} under the band's content", async () => {
    setWidgetLine("🦉 3 obs → 1 roots · ? · 0 tok");
    const h = await bandHarness();
    const out = await h.dispatch("ui.render", {
      component: "AbovePrompt",
      surface: "terminal",
      hasSurvey: false,
      requestId: "r2",
    });
    const box = out as { type?: string; children?: Array<{ type?: string; children?: unknown[] }> };
    expect(box.type).toBe("Box");
    expect(box.children).toHaveLength(2);
    expect(box.children?.[1]?.type).toBe("Text");
    expect(box.children?.[1]?.children).toEqual(["🦉 3 obs → 1 roots · ? · 0 tok"]);
    _resetWidgetLine();
  });

  test("a survey holding the band yields — passthrough even with a live line", async () => {
    setWidgetLine("🦉 live but yielding");
    const h = await bandHarness();
    const out = await h.dispatch("ui.render", {
      component: "AbovePrompt",
      surface: "terminal",
      hasSurvey: true,
      requestId: "r3",
    });
    expect((out as { component?: string }).component).toBe("AbovePrompt");
    expect((out as { type?: string }).type).toBeUndefined();
    _resetWidgetLine();
  });

  test("other components (ToolResult) still route to the restyle branch", async () => {
    _resetWidgetLine();
    const h = await bandHarness();
    const out = await h.dispatch("ui.render", {
      component: "ToolResult",
      props: { tool: "Read", output: "x", isErrored: false },
      requestId: "r4",
    });
    expect((out as { component?: string }).component).toBe("ToolResult");
  });
});
