// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// The boundary gate: a stage launch happens only at a turn completion that
// concluded a REAL round — one whose assistant rows are new since the last
// launch. A resumed session's dangling boundary (the engine completes the
// replayed turn's bookkeeping the moment the continuation prompt arrives)
// carries no new assistant content and must not launch stages.

import { describe, expect, test } from "vitest";
import { newestAssistantUuid, shouldFireBoundary } from "../../host/triggers/boundary-gate.js";

function rows(...spec: [string, string | undefined][]): Array<{ uuid: string; kind: string | undefined }> {
  return spec.map(([uuid, kind]) => ({ uuid, kind }));
}

describe("boundary gate — pi's per-round turn end", () => {
  test("the newest assistant row wins; none is null", () => {
    expect(newestAssistantUuid(rows(["u1", "user"], ["a1", "assistant"], ["u2", "user"]))).toBe("a1");
    expect(newestAssistantUuid(rows(["u1", "user"]))).toBeNull();
    expect(newestAssistantUuid([])).toBeNull();
  });

  test("a boundary with a NEW assistant row fires", () => {
    const last = rows(["u1", "user"], ["a1", "assistant"]);
    expect(shouldFireBoundary(last, null)).toBe(true);
    expect(
      shouldFireBoundary(rows(["u1", "user"], ["a1", "assistant"], ["u2", "user"], ["a2", "assistant"]), "a1"),
    ).toBe(true);
  });

  test("a boundary with no new assistant row does not fire (the resume dangling shape)", () => {
    // the continuation prompt arrived; the round's answer has not — the
    // newest assistant row is still the previous round's
    expect(shouldFireBoundary(rows(["u1", "user"], ["a1", "assistant"], ["u2", "user"]), "a1")).toBe(false);
    // and with no assistant content at all
    expect(shouldFireBoundary(rows(["u1", "user"]), null)).toBe(false);
  });

  test("a re-run over unchanged content never re-fires", () => {
    const r = rows(["u1", "user"], ["a1", "assistant"]);
    expect(shouldFireBoundary(r, "a1")).toBe(false);
  });
});
