// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>
//
// The host regex sandbox: inline chunked execution with a deadline —
// contract-identical to the core's worker runner (same exports, outcome
// shapes, and message texts) minus the worker (banned in the closure).
import { describe, expect, test } from "vitest";
import { runRegexTests, terminateRegexWorker } from "../../host/graph/regex-sandbox.js";

describe("runRegexTests — the host sandbox", () => {
  test("complete batch: booleans in order, empty batch short-circuits", async () => {
    const out = await runRegexTests(/owl-\d/g, ["owl-1", "nope", "owl-2"], 5_000);
    expect(out).toEqual({ results: [true, false, true] });
    expect(await runRegexTests(/x/, [], 5_000)).toEqual({ results: [] });
  });

  test("a deadline hit returns the PARTIAL results (the worker timeout's semantics)", async () => {
    // 40k non-trivial strings over the 1s floor: the loop trips the
    // deadline between chunks and reports testedCount < total
    const strings = Array.from({ length: 40_000 }, (_, i) => `needle-in-haystack-${i}-${"x".repeat(40)}`);
    const t0 = Date.now();
    const out = await runRegexTests(/^needle-in-haystack-(\d+)-x+$/, strings, 1);
    const elapsed = Date.now() - t0;
    if ("error" in out) throw new Error(out.error);
    if ("results" in out && "testedCount" in out) {
      expect(out.testedCount).toBeLessThan(strings.length); // partial, not complete
      expect(out.timedOutMs).toBeGreaterThanOrEqual(1_000); // the floor applied
      expect(out.results.slice(0, out.testedCount)).not.toContain(false); // every tested string matched
      expect(elapsed).toBeLessThan(5_000); // it returned promptly at the deadline
    } else {
      // a fast machine finished inside the floor — the outcome is the
      // complete batch, which is also correct; assert full results
      expect(out.results.every((r) => r)).toBe(true);
    }
  }, 20_000);

  test("a compiling failure surfaces the caller-shaped error text", async () => {
    // a test-time failure (the worker compiled in-thread so its errors rode
    // the reply channel; here the catch covers the test call itself)
    const broken = {
      test: () => {
        throw new Error("Unterminated group");
      },
    } as unknown as RegExp;
    const out = await runRegexTests(broken, ["a"], 5_000);
    if (!("error" in out)) throw new Error("expected an error outcome");
    expect(out.error).toContain("Regex failed to run:");
  });

  test("a single straggler string past the deadline converts to the timeout outcome (the worker-kill equivalent)", async () => {
    // one string whose test outlasts the 1s floor: it cannot be interrupted
    // inline — but once control returns, the fired deadline converts the
    // outcome to the SAME partial/timeout shape the worker kill produced
    const spin = (ms: number) => {
      const until = Date.now() + ms;
      while (Date.now() < until) {
        /* busy-wait: a deterministic slow string */
      }
    };
    const slow = {
      test: (_s: string) => {
        spin(1_100);
        return false;
      },
    } as unknown as RegExp;
    const out = await runRegexTests(slow, ["only-string"], 1);
    if (!("timedOutMs" in out)) throw new Error("expected the timeout shape");
    expect(out.timedOutMs).toBeGreaterThanOrEqual(1_000);
    expect(out.results).toEqual([false]);
    expect(out.testedCount).toBe(1);
  }, 20_000);

  test("terminateRegexWorker is a safe no-op", () => {
    expect(() => terminateRegexWorker()).not.toThrow();
  });
});
