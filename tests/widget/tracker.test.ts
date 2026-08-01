// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// Stub-guard: verifies the no-op WidgetController contract. The widget task replaces the
// stub with the real ProgressTracker and replaces this test with the real suite.

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { initWidget } from "../../src/widget/tracker.js";

describe("initWidget stub", () => {
  it("returns a controller with all surface methods as functions", () => {
    const widget = initWidget();
    expect(typeof widget.setCtx).toBe("function");
    expect(typeof widget.clearCtx).toBe("function");
    expect(typeof widget.render).toBe("function");
    expect(typeof widget.startStage).toBe("function");
    expect(typeof widget.setPass).toBe("function");
    expect(typeof widget.setBatch).toBe("function");
    expect(typeof widget.endStage).toBe("function");
    expect(typeof widget.onEvent).toBe("function");
  });

  it("every method is a no-op (does not throw)", () => {
    const widget = initWidget();
    expect(() => widget.setCtx({} as unknown as ExtensionContext)).not.toThrow();
    expect(() => widget.clearCtx()).not.toThrow();
    expect(() => widget.render()).not.toThrow();
    expect(() => widget.startStage("observe")).not.toThrow();
    expect(() => widget.setPass(1)).not.toThrow();
    expect(() => widget.setBatch(0, 0)).not.toThrow();
    expect(() => widget.endStage()).not.toThrow();
    expect(() => widget.onEvent({})).not.toThrow();
  });
});
