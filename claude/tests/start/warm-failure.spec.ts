// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// A backfill that rejects mid-start must release the details-warm readiness
// latch — otherwise the owl line stays on the loading text for the whole
// process lifetime. Drives the real register wiring through the harness
// with the backfill module's start entry made to reject.
import { beforeEach, describe, expect, test, vi } from "vitest";
import { markDetailsWarmDone } from "../../host/start/readiness.js";

vi.mock("../../host/start/backfill.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../host/start/backfill.js")>();
  return {
    ...original,
    runBackfill: vi.fn(async () => {
      throw new Error("backfill exploded (test)");
    }),
  };
});

describe("start failure releases the readiness latch", () => {
  beforeEach(() => {
    markDetailsWarmDone();
    vi.clearAllMocks();
  });

  test("a rejected backfill clears the pending warm instead of sticking", async () => {
    const { createHarness } = await import("../helpers/harness.js");
    const harness = createHarness();
    await harness.load();
    harness.env.set("CLAUDE_CONFIG_DIR", "/cfg");
    await harness.dispatch("classic.SessionStart", {
      session_id: "warm-fail",
      transcript_path: "/t/warm-fail.jsonl",
      source: "startup",
      cwd: "/w",
    });
    // the latch must not stay armed: the failed start has no warm coming,
    // and nothing else would ever clear it
    const { detailsWarmPending } = await import("../../host/start/readiness.js");
    expect(detailsWarmPending()).toBe(false);
  });
});
