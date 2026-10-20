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
  test("no line in the store and no provider: the band carries no owl line (nothing servable yet)", async () => {
    _resetWidgetLine();
    const h = await bandHarness();
    const out = await h.dispatch("ui.render", {
      component: "AbovePrompt",
      surface: "terminal",
      hasSurvey: false,
      requestId: "r1",
    });
    // the inner drawing alone — no placeholder line before the fold lands
    expect(JSON.stringify(out)).not.toContain("🦉");
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

  test("a disabled owl passes the band through — the widget is hidden", async () => {
    const owlState = await import("../../host/state.js");
    const h = await bandHarness();
    try {
      owlState.setOwlEnabled(false);
      setWidgetLine("🦉 stale line while disabled");
      const out = await h.dispatch("ui.render", {
        component: "AbovePrompt",
        surface: "terminal",
        hasSurvey: false,
        requestId: "r3d",
      });
      // the inner drawing, untouched: no owl line anywhere in the band
      expect((out as { component?: string }).component).toBe("AbovePrompt");
      expect(JSON.stringify(out)).not.toContain("🦉");
    } finally {
      owlState._resetForTest();
      _resetWidgetLine();
    }
  });

  test("session.start primes the main binding - the idle provider serves after the fold", async () => {
    const { _resetWidgetLine, idleSegments } = await import("../../host/widget/line-store.js");
    const { hasBinding } = await import("../../host/runs/bind.js");
    _resetWidgetLine();
    const h = await bandHarness();
    h.env.set("CLAUDE_CONFIG_DIR", "/cfg");
    await h.dispatch("classic.SessionStart", {
      session_id: "prime-1",
      cwd: "/w",
      source: "startup",
      transcript_path: "/t/prime-1.jsonl",
    });
    expect(hasBinding("prime-1")).toBe(true); // created at start, not at first turn
    // the fold+pin runs on microtasks; give it a beat
    await new Promise((r) => setTimeout(r, 50));
    expect(idleSegments()).not.toBeNull(); // the provider is registered and serving
  });

  test("a pending idle refresh consumes the NEXT render dispatch - invalidated in frame, once", async () => {
    const { requestIdleRefresh } = await import("../../host/widget/line-store.js");
    _resetWidgetLine();
    const h = await bandHarness();
    const before = h.uiInvalidateCalls.length;
    requestIdleRefresh();
    await h.dispatch("ui.render", {
      component: "AbovePrompt",
      surface: "terminal",
      hasSurvey: false,
      requestId: "r-idle",
    });
    expect(h.uiInvalidateCalls.length).toBe(before + 1); // consumed, in frame
    expect(h.uiInvalidateCalls[h.uiInvalidateCalls.length - 1]).toBe("ui.render");
    const before2 = h.uiInvalidateCalls.length;
    await h.dispatch("ui.render", {
      component: "AbovePrompt",
      surface: "terminal",
      hasSurvey: false,
      requestId: "r-idle2",
    });
    expect(h.uiInvalidateCalls.length).toBe(before2); // one-shot
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
