// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// The readiness latch: pending hides the owl line, done releases it.
import { beforeEach, describe, expect, test, vi } from "vitest";
import { detailsWarmPending, markDetailsWarmDone, markDetailsWarmPending } from "../../host/start/readiness.js";

describe("the details-warm readiness latch", () => {
  beforeEach(() => {
    markDetailsWarmDone();
  });
  test("starts armed — the band draws the loading line from the engine's first paint", async () => {
    // the engine fires the start hook only after its own resume work; the
    // latch is pending from module load so the band never shows a pre-owl
    // gap (or a stale store line) during that span
    vi.resetModules();
    const fresh = await import("../../host/start/readiness.js");
    expect(fresh.detailsWarmPending()).toBe(true);
  });

  test("pending while the warm is in flight, released on completion", () => {
    expect(detailsWarmPending()).toBe(false);
    markDetailsWarmPending();
    expect(detailsWarmPending()).toBe(true);
    markDetailsWarmDone();
    expect(detailsWarmPending()).toBe(false);
  });
});

describe("the band's loading line while the warm is pending", () => {
  test("decideBand draws the loading line instead of the store line; pause still wins", async () => {
    const { decideBand } = await import("../../host/widget/band.js");
    const { setWidgetLine } = await import("../../host/widget/line-store.js");
    setWidgetLine("the store line", null);
    // warm pending: the loading line replaces the store line
    const loading = decideBand(false, "inner", null, "🦉 loading memory — please wait before you proceed");
    expect(loading).toMatchObject({ kind: "compose", line: "🦉 loading memory — please wait before you proceed" });
    // the pause line outranks the loading line
    const paused = decideBand(
      false,
      "inner",
      "🦉 ⚠ paused — conflicts",
      "🦉 loading memory — please wait before you proceed",
    );
    expect(paused).toMatchObject({ kind: "compose", line: "🦉 ⚠ paused — conflicts" });
    // warm done: the store line is back
    const ready = decideBand(false, "inner", null, null);
    expect(ready).toMatchObject({ kind: "compose", line: "the store line" });
    setWidgetLine(null, null);
  });
});
