// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// Tests for the worker-thread regex runner. The runner executes regex tests in
// a worker so a catastrophic pattern can be terminated instead of freezing pi.

import { afterEach, describe, expect, it, vi } from "vitest";
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

  it("terminates a catastrophic backtracking pattern on timeout, returning partial results", async () => {
    // (a+)+$ on a long non-matching string backtracks catastrophically on the
    // main thread; in the worker it is killed at the timeout. The outcome now
    // carries the PARTIAL results found so far + a timed-out marker (not a bare
    // error) so callers can surface what was matched.
    const evil = /(a+)+$/;
    const fast = "plain text";
    const input = "a".repeat(2000).concat("!");
    const t0 = Date.now();
    // the fast string completes before the catastrophic one hangs; both are in
    // the batch so partial results = [true] (fast matched... actually false) and
    // the catastrophic slot is untested (false).
    const res = await runRegexTests(evil, [fast, input], 500);
    const elapsed = Date.now() - t0;
    expect("testedCount" in res).toBe(true);
    expect("results" in res).toBe(true);
    if ("testedCount" in res) {
      // killed promptly, not after the pattern's natural (multi-second+) runtime
      expect(elapsed).toBeLessThan(2000);
      // the fast string was tested (testedCount >= 1); the catastrophic one hung
      expect(res.testedCount).toBeGreaterThanOrEqual(1);
      expect(res.timedOutMs).toBeGreaterThanOrEqual(500);
    }
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

  it("timeout 0 is clamped to the minimum floor (a fast pattern still completes)", async () => {
    // a configured/legacy 0 (the removed "Off" preset) is floored to the
    // minimum so a catastrophic pattern cannot freeze the reused worker; a
    // fast pattern completes well within the floor and returns normally.
    const res = await runRegexTests(/foo/, ["foobar"], 0);
    if ("results" in res) expect(res.results).toEqual([true]);
  });

  it("a NaN/undefined timeout is floored to the minimum (no immediate-kill)", async () => {
    // a partial settings object missing findTimeoutMs must not produce a NaN
    // timeout that fires immediately (killing the worker at 0 tested) — it is
    // floored to the minimum so a fast pattern still completes.
    const nan = Number.NaN;
    const res = await runRegexTests(/foo/, ["foobar"], nan);
    if ("results" in res) expect(res.results).toEqual([true]);
  });
});

describe("runRegexTests synchronous fallback", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.doUnmock("node:worker_threads");
    vi.resetModules();
  });

  it("refuses the batch (returns an error) when the worker cannot spawn", async () => {
    // restricted runtimes where worker_threads is unavailable hit the catch in
    // runRegexTests. Running an interruptible pattern unprotected on the main
    // thread (the static guard has known gaps) would risk freezing the host, so
    // the batch is refused instead. Mock the Worker constructor to throw.
    vi.doMock("node:worker_threads", () => ({
      Worker: class {
        constructor() {
          throw new Error("worker_threads unavailable in this runtime");
        }
      },
    }));
    vi.resetModules();
    const { runRegexTests: fallbackRun } = await import("../../src/graph/regex-runner.js");

    const res = await fallbackRun(/foo/, ["foobar", "no match", "foo"], 5000);
    // the fallback refuses rather than running unprotected on the main thread
    expect("error" in res).toBe(true);
    if ("error" in res) expect(res.error).toMatch(/unavailable/i);
  });
});
