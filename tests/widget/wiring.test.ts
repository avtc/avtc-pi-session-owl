// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// Wiring smoke test: initWidget()'s controller publishes via ctx.ui.setWidget
// with a factory when a stage is active + TUI mode, and hides (undefined) when
// idle or non-TUI. The factory produces a renderable Text.

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { _resetGetSessionOwlSettings, _setGetSessionOwlSettings, DEFAULT_CONFIG } from "../../src/config/schema.js";
import { resetForNewSession } from "../../src/store/graph-store.js";
import { initWidget, WIDGET_KEY } from "../../src/widget/tracker.js";

interface SetWidgetCall {
  key: string;
  content: unknown;
  options: unknown;
}

function makeCtx(over: Partial<ExtensionContext> | null): { ctx: ExtensionContext; calls: SetWidgetCall[] } {
  const calls: SetWidgetCall[] = [];
  const ctx = {
    mode: "tui",
    hasUI: true,
    ui: {
      setWidget(key: string, content: unknown, options: unknown) {
        calls.push({ key, content, options });
      },
      notify: () => {},
    },
    getContextUsage: () => ({ tokens: 12_000, contextWindow: 262_000, percent: 5 }),
  } as unknown as ExtensionContext;
  return { ctx: { ...ctx, ...(over ?? {}) } as ExtensionContext, calls };
}

describe("initWidget wiring", () => {
  beforeEach(() => {
    resetForNewSession();
  });

  it("render() before setCtx is a no-op (no ctx ref yet)", () => {
    const widget = initWidget();
    expect(() => widget.render()).not.toThrow();
  });

  it("render() with an active stage + TUI → setWidget(key, factory, aboveEditor)", () => {
    const widget = initWidget();
    const { ctx, calls } = makeCtx(null);
    widget.setCtx(ctx);
    widget.startStage("build", { pass: 1 });
    widget.render();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.key).toBe(WIDGET_KEY);
    expect(calls[0]?.options).toEqual({ placement: "aboveEditor" });
    expect(typeof calls[0]?.content).toBe("function");
  });

  it("the factory produces a renderable component (renders non-empty lines)", () => {
    const widget = initWidget();
    const { ctx, calls } = makeCtx(null);
    widget.setCtx(ctx);
    widget.startStage("observe");
    widget.render();
    const factory = calls[0]?.content as (tui: unknown, theme: unknown) => { render: (w: number) => string[] };
    const fakeTheme = { fg: (_c: string, t: string) => t };
    const comp = factory({}, fakeTheme);
    const lines = comp.render(120);
    expect(lines.length).toBeGreaterThan(0);
    expect(lines[0]).toContain("🦉");
  });

  function renderFactory(calls: SetWidgetCall[], at: number): (w: number) => string[] {
    const factory = calls[at]?.content as unknown as (
      tui: unknown,
      theme: unknown,
    ) => { render: (w: number) => string[] };
    const fakeTheme = { fg: (_c: string, t: string) => t };
    return (w: number) => factory({}, fakeTheme).render(w);
  }

  it("render() idle (stage null) → the store line stays visible (counts, no runtime cluster)", () => {
    const widget = initWidget();
    const { ctx, calls } = makeCtx(null);
    widget.setCtx(ctx);
    widget.startStage("observe");
    widget.render();
    widget.endStage();
    widget.render();
    const last = calls[calls.length - 1];
    expect(last?.key).toBe(WIDGET_KEY);
    expect(last?.content).toBeDefined(); // NOT hidden — the idle store line
    const line = renderFactory(calls, calls.length - 1)(120)[0] ?? "";
    expect(line).toContain("🦉");
    expect(line).toContain(" obs");
    expect(line).toContain(" roots");
    expect(line).not.toContain("tok"); // no runtime cluster when idle
  });

  it("a disabled owl owns no widget — idle hides", () => {
    _setGetSessionOwlSettings(() => ({ ...DEFAULT_CONFIG, enabled: false }));
    try {
      const widget = initWidget();
      const { ctx, calls } = makeCtx(null);
      widget.setCtx(ctx);
      widget.render();
      const last = calls[calls.length - 1];
      expect(last?.content).toBeUndefined();
    } finally {
      _resetGetSessionOwlSettings();
    }
  });

  it("setLoading(true) → the loading line; cleared → the store line", () => {
    const widget = initWidget();
    const { ctx, calls } = makeCtx(null);
    widget.setCtx(ctx);
    widget.setLoading(true);
    widget.render();
    const atLoad = calls.length - 1;
    expect(calls[atLoad]?.key).toBe(WIDGET_KEY);
    const loadingLine = renderFactory(calls, atLoad)(120)[0] ?? "";
    expect(loadingLine).toContain("🦉 loading memory — please wait before you proceed");
    widget.setLoading(false);
    widget.render();
    const idleLine = renderFactory(calls, calls.length - 1)(120)[0] ?? "";
    expect(idleLine).toContain(" obs");
    expect(idleLine).toContain(" roots");
  });

  it("endStage() republishes the store line when the stage drops to null (no follow-up render needed)", () => {
    // A run ends with no further events; without endStage republishing, the
    // last stage's line (e.g. the Selector's final `N selected`) persists.
    const widget = initWidget();
    const { ctx, calls } = makeCtx(null);
    widget.setCtx(ctx);
    widget.startStage("select");
    widget.render(); // shown (stage active)
    const shownCount = calls.length;
    widget.endStage(); // must itself republish the idle store line
    expect(calls.length).toBeGreaterThan(shownCount);
    const last = calls[calls.length - 1];
    expect(last?.key).toBe(WIDGET_KEY);
    expect(last?.content).toBeDefined();
  });

  it("render() is a no-op in non-TUI modes (rpc/json/print)", () => {
    const widget = initWidget();
    const { ctx, calls } = makeCtx({ mode: "rpc" });
    widget.setCtx(ctx);
    widget.startStage("observe");
    widget.render();
    expect(calls).toHaveLength(0);
  });

  it("clearCtx drops the ref (render becomes a no-op even with an active stage)", () => {
    const widget = initWidget();
    const { ctx, calls } = makeCtx(null);
    widget.setCtx(ctx);
    widget.startStage("observe");
    widget.clearCtx(); // hides once (1 setWidget call)
    const afterClear = calls.length;
    widget.render(); // ref is null now → no-op (no additional call)
    expect(calls.length).toBe(afterClear);
  });

  it("clearCtx hides the widget before dropping the ref (no stale line)", () => {
    const widget = initWidget();
    const { ctx, calls } = makeCtx(null);
    widget.setCtx(ctx);
    widget.startStage("observe");
    widget.render(); // shown
    const shownCount = calls.length;
    widget.clearCtx(); // teardown must hide
    expect(calls.length).toBeGreaterThan(shownCount); // a hide setWidget happened
    const hideCall = calls[calls.length - 1];
    expect(hideCall?.key).toBe(WIDGET_KEY);
    expect(hideCall?.content).toBeUndefined();
  });

  it("onEvent forwards to the tracker then renders (live streaming)", async () => {
    const widget = initWidget();
    const { ctx, calls } = makeCtx(null);
    widget.setCtx(ctx);
    widget.startStage("build", { pass: 1 });
    // a message_update with usage → streaming tokens + a re-render. The first
    // event after startStage renders immediately (the throttle's leading edge).
    widget.onEvent({ type: "message_update", message: { usage: { output: 250 } } } as unknown as Parameters<
      typeof widget.onEvent
    >[0]);
    expect(calls.length).toBeGreaterThanOrEqual(1);
    expect(calls[0]?.key).toBe(WIDGET_KEY);
  });

  it("onEvent throttles a fast stream to one render per 200ms (leading + trailing)", async () => {
    vi.useFakeTimers();
    try {
      const widget = initWidget();
      const { ctx, calls } = makeCtx(null);
      widget.setCtx(ctx);
      widget.startStage("build", { pass: 1 });
      // The first event renders immediately (leading edge); a burst of 50 events
      // in the same tick coalesces into ONE trailing render at the 200ms boundary.
      for (let i = 0; i < 50; i += 1) {
        widget.onEvent({ type: "message_update", message: { usage: { output: i * 10 } } } as unknown as Parameters<
          typeof widget.onEvent
        >[0]);
      }
      const afterBurst = calls.length; // leading render (+ startStage's own)
      // no timer fired yet → no more renders mid-interval
      await vi.advanceTimersByTimeAsync(199);
      expect(calls.length).toBe(afterBurst);
      // crossing the 200ms boundary fires the single coalesced trailing render
      await vi.advanceTimersByTimeAsync(2);
      expect(calls.length).toBe(afterBurst + 1);
    } finally {
      vi.useRealTimers();
    }
  });
});
