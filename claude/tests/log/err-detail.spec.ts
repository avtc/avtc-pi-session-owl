// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import { describe, expect, test, vi } from "vitest";
import { log } from "../../core/src/log.js";
import * as bridge from "../../host/engine-bridge.js";
import { errDetail, guarded, sayError } from "../../host/log/err-detail.js";

describe("errDetail — message + stack, never duplicated, never lost", () => {
  test("an Error whose stack contains the message: the stack alone (it carries both)", () => {
    const err = new Error("boom");
    expect(err.stack).toContain("boom"); // the V8 shape this rules assumes
    expect(errDetail(err)).toBe(err.stack);
  });

  test("an Error whose stack LOST the message line: message + stack, both", () => {
    const err = new Error("boom");
    err.stack = "    at fn (file.ts:1:1)"; // a header-less stack (real in some rewrites)
    expect(errDetail(err)).toBe("boom\n    at fn (file.ts:1:1)");
  });

  test("an Error without a stack: the message", () => {
    const err = new Error("boom");
    err.stack = "";
    expect(errDetail(err)).toBe("boom");
    err.stack = undefined as unknown as string;
    expect(errDetail(err)).toBe("boom");
  });

  test("a non-Error throw: String(value) — all there is", () => {
    expect(errDetail("plain string")).toBe("plain string");
    expect(errDetail({ odd: "object" })).toBe(String({ odd: "object" }));
    expect(errDetail(null)).toBe("null");
  });
});

describe("sayError — the one error transport (file log + user-visible ui.log, console strictly last)", () => {
  test("with the bridge armed the ui transport carries it and the console stays quiet", () => {
    const said: string[] = [];
    const consoled: string[] = [];
    bridge.arm({ uiLog: (t: string) => said.push(t) } as unknown as Record<string, (...args: unknown[]) => unknown>);
    const orig = console.error;
    console.error = (...a: unknown[]) => consoled.push(String(a[0]));
    try {
      sayError("boom-line");
    } finally {
      console.error = orig;
    }
    expect(said).toEqual(["boom-line"]); // the user-visible channel fired
    expect(consoled).toEqual([]); // …and the console was NOT needed
  });

  test("an explicit uiText reaches the ui channel UNPREFIXED while the file copy keeps the full text (no double prefix)", () => {
    const said: string[] = [];
    const warned: string[] = [];
    bridge.arm({
      uiLog: (t: string) => said.push(t),
    } as unknown as Record<string, (...args: unknown[]) => unknown>);
    const warnSpy = vi.spyOn(log, "warn").mockImplementation((t: string) => warned.push(t));
    try {
      sayError("session-owl: pane keybindings: Error: boom", { uiText: "pane keybindings: Error: boom" });
    } finally {
      warnSpy.mockRestore();
    }
    expect(said).toEqual(["pane keybindings: Error: boom"]); // the engine already attributes the row to the plugin
    expect(warned).toEqual(["session-owl: pane keybindings: Error: boom"]); // the file log keeps its own prefix
  });

  test("with NO bridge armed the console is the last resort", () => {
    bridge.clearRouting();
    bridge._disarmForTest(); // services = null: the module-load/pre-arm window
    const consoled: string[] = [];
    const orig = console.error;
    console.error = (...a: unknown[]) => consoled.push(String(a[0]));
    try {
      sayError("early-boot boom");
    } finally {
      console.error = orig;
    }
    expect(consoled).toEqual(["early-boot boom"]);
  });
});

describe("guarded (the floating-promise rejection logger)", () => {
  test("a rejection is logged with its label and stack, and still rejects the awaited caller", async () => {
    const warned: string[] = [];
    const warnSpy = vi.spyOn(log, "warn").mockImplementation((t: string) => warned.push(t));
    const boom = new Error("net boom");
    const p = guarded(Promise.reject(boom), "timeline append");
    await expect(p).rejects.toThrow("net boom");
    // the logger fired once, labeled, with the stack preserved
    await new Promise((r) => setTimeout(r, 0));
    expect(warned.length).toBe(1);
    expect(warned[0].startsWith("unhandled rejection (timeline append): ")).toBe(true);
    expect(warned[0]).toContain("net boom");
    warnSpy.mockRestore();
  });

  test("a resolving promise logs nothing", async () => {
    const warned: string[] = [];
    const warnSpy = vi.spyOn(log, "warn").mockImplementation((t: string) => warned.push(t));
    await guarded(Promise.resolve(7), "quiet path");
    expect(warned).toEqual([]);
    warnSpy.mockRestore();
  });
});
