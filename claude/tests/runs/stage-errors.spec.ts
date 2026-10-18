// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// The stage-run error classes (host port): pi's names + message formats
// verbatim — the compaction hook and the launch wrapper instanceof-check
// these, and the user reads the same text.
import { describe, expect, test } from "vitest";
import { StageModelError, StageRunError, StageTimeoutError } from "../../host/runs/stage-errors.js";

describe("stage error classes (pi-verbatim messages)", () => {
  test("StageTimeoutError formats the seconds limit and the null form", () => {
    expect(new StageTimeoutError("Observer", 30_000).message).toBe(
      "Observer stopped: an LLM call exceeded the 30s time limit",
    );
    // the null arm renders the doubled article — pi's own formatting, kept verbatim
    expect(new StageTimeoutError("Builder", null).message).toBe(
      "Builder stopped: an LLM call exceeded the the time limit",
    );
    expect(new StageTimeoutError("Selector", 500).name).toBe("StageTimeoutError");
  });

  test("StageRunError wraps the cause message and carries it", () => {
    const cause = new Error("upstream down");
    const err = new StageRunError(cause);
    expect(err.message).toBe("stage run failed: upstream down");
    expect(err.cause).toBe(cause);
  });

  test("StageModelError carries the model's own error text (or the bare form)", () => {
    expect(new StageModelError("  boom ").message).toBe('agent model call failed (stopReason "error"): boom');
    expect(new StageModelError(null).message).toBe('agent model call failed (stopReason "error")');
    expect(new StageModelError(null).modelErrorMessage).toBeNull();
  });
});
