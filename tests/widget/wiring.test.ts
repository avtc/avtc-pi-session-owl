// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// Wiring smoke test: initWidget()'s controller publishes via ctx.ui.setWidget
// with a factory when a stage is active + TUI mode, and hides (undefined) when
// idle or non-TUI. The factory produces a renderable Text.

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { beforeEach, describe, expect, it } from "vitest";
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

  it("render() idle (stage null) → setWidget(key, undefined) to hide", () => {
    const widget = initWidget();
    const { ctx, calls } = makeCtx(null);
    widget.setCtx(ctx);
    // show first, then endStage → render hides
    widget.startStage("observe");
    widget.render();
    widget.endStage();
    widget.render();
    expect(calls).toHaveLength(2);
    expect(calls[1]?.key).toBe(WIDGET_KEY);
    expect(calls[1]?.content).toBeUndefined();
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
    // a message_update with usage → streaming tokens + a coalesced re-render
    // (onEvent schedules the render via queueMicrotask so a fast stream produces
    // one render per tick)
    widget.onEvent({ type: "message_update", message: { usage: { output: 250 } } } as unknown as Parameters<
      typeof widget.onEvent
    >[0]);
    await Promise.resolve(); // flush the scheduled microtask render
    expect(calls.length).toBeGreaterThanOrEqual(1);
    expect(calls[0]?.key).toBe(WIDGET_KEY);
  });

  it("onEvent coalesces a fast stream into one render per microtask tick", async () => {
    const widget = initWidget();
    const { ctx, calls } = makeCtx(null);
    widget.setCtx(ctx);
    widget.startStage("build", { pass: 1 });
    // many message_update events in the same tick → ONE coalesced render
    for (let i = 0; i < 50; i += 1) {
      widget.onEvent({ type: "message_update", message: { usage: { output: i * 10 } } } as unknown as Parameters<
        typeof widget.onEvent
      >[0]);
    }
    const beforeFlush = calls.length;
    await Promise.resolve();
    // the 50 events produced at most one additional render (the coalesced one)
    expect(calls.length - beforeFlush).toBeLessThanOrEqual(1);
    expect(calls.length).toBeGreaterThanOrEqual(1);
  });
});
