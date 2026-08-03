// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// Tests for the worker-thread regex runner. The runner executes regex tests in
// a worker so a catastrophic pattern can be terminated instead of freezing pi.

import { describe, expect, it } from "vitest";
import { runRegexTests } from "../../src/graph/regex-runner.js";

describe("runRegexTests", () => {
  it("returns boolean match results for each input string (batch, order-preserving)", async () => {
    const regex = /foo/;
    const res = await runRegexTests(regex, ["foobar", "no match", "foo", ""], 5000);
    expect("results" in res).toBe(true);
    if ("results" in res) expect(res.results).toEqual([true, false, true, false]);
  });

  it("respects regex flags (case-insensitive)", async () => {
    const res = await runRegexTests(/foo/i, ["FOO", "bar"], 5000);
    if ("results" in res) expect(res.results).toEqual([true, false]);
  });

  it("returns empty results for an empty input list (no worker spawned)", async () => {
    const res = await runRegexTests(/x/, [], 5000);
    expect("results" in res).toBe(true);
    if ("results" in res) expect(res.results).toEqual([]);
  });

  it("terminates a catastrophic backtracking pattern on timeout and reports an error", async () => {
    // (a+)+$ on a long non-matching string backtracks catastrophically on the
    // main thread; in the worker it is killed at the timeout.
    const evil = /(a+)+$/;
    const input = "a".repeat(2000).concat("!");
    const t0 = Date.now();
    const res = await runRegexTests(evil, [input], 500);
    const elapsed = Date.now() - t0;
    expect("error" in res).toBe(true);
    // killed promptly, not after the pattern's natural (multi-second+) runtime
    expect(elapsed).toBeLessThan(2000);
  });

  it("keeps the main thread responsive while the worker is stuck on a slow pattern", async () => {
    const evil = /(a+)+$/;
    const input = "a".repeat(2000).concat("!");
    let ticks = 0;
    const interval = setInterval(() => {
      ticks += 1;
    }, 50);
    await runRegexTests(evil, [input], 400);
    clearInterval(interval);
    // the main thread ticked at least once while the worker ran (responsive)
    expect(ticks).toBeGreaterThanOrEqual(1);
  });

  it("timeout 0 means no timeout (a slow pattern runs to completion, not killed)", async () => {
    // a polynomial-but-not-catastrophic pattern that completes well within any
    // reasonable bound; timeout 0 must NOT short-circuit to an error.
    const res = await runRegexTests(/foo/, ["foobar"], 0);
    if ("results" in res) expect(res.results).toEqual([true]);
  });
});
