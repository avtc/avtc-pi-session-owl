// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// A backfill that rejects mid-start must release the details-warm readiness
// latch — otherwise the owl line stays on the loading text for the whole
// process lifetime. Drives the real register wiring through the harness
// with the backfill module's start entry made to reject.
//
// The specs share one module registry (isolate: false): a hoisted vi.mock
// would hand EVERY later file in this worker the rejecting backfill. The
// mock is therefore registered on a fresh registry (resetModules + doMock,
// every import below dynamic), and the registry is dropped again when the
// file ends — the next file loads the real graph.
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";

const BACKFILL = "../../host/start/backfill.js";

beforeAll(() => {
  vi.resetModules();
  vi.doMock(BACKFILL, async (importOriginal) => ({
    ...(await importOriginal<typeof import("../../host/start/backfill.js")>()),
    runBackfill: vi.fn(async () => {
      throw new Error("backfill exploded (test)");
    }),
  }));
});

afterAll(() => {
  vi.doUnmock(BACKFILL);
  vi.resetModules();
});

describe("start failure releases the readiness latch", () => {
  beforeEach(async () => {
    const { markDetailsWarmDone } = await import("../../host/start/readiness.js");
    markDetailsWarmDone();
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
    // the start really failed in the backfill (not elsewhere, not quietly)
    expect(harness.uiLog.some((line) => line.includes("backfill exploded (test)"))).toBe(true);
    // the latch must not stay armed: the failed start has no warm coming,
    // and nothing else would ever clear it
    const { detailsWarmPending } = await import("../../host/start/readiness.js");
    expect(detailsWarmPending()).toBe(false);
  });
});
