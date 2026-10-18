// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// Engine-kit twin of the trigger surface: the closure-clean slice — the
// keyed run-lock (pi's semantics per conversation), the measure snapshots
// (the context-threshold arms' data source, loop scoping), the
// goal-extract $.model.complete mapping over an injected capsule, and —
// with the rewrite-table shims resolving the vendored bare edges — the
// boundary evaluator + the conversation binding themselves, loading and
// constructing under the real kit loader's import rules.
import { describe, expect, test } from "claude-code/testing";
import { getBinding, releaseBinding } from "../host/runs/bind.js";
import { makeGoalCompleter } from "../host/runs/goal-extract-complete.js";
import * as state from "../host/state.js";
import { _resetMeasureSnapshots, contextTokensFor, pruneMeasures, recordMeasure } from "../host/triggers/context.js";
import { onStepBoundary, onTurnCompleteBoundary } from "../host/triggers/eval.js";
import {
  _resetRunLocks,
  acquireForCompaction,
  acquireOrSkip,
  current,
  inFlight,
  pruneIdleLocks,
} from "../host/triggers/run-locks.js";

describe("trigger surface — engine-run twin", () => {
  test("the keyed run-lock: same-conversation collision skips, another conversation acquires", () => {
    _resetRunLocks();
    const h1 = acquireOrSkip("s1", "observe");
    expect(h1).not.toBeNull();
    expect(acquireOrSkip("s1", "build")).toBeNull();
    expect(acquireOrSkip("s2", "observe")).not.toBeNull();
    expect(inFlight("s1")).toBe(true);
    expect(current("s1")).toBe("observe");
    h1?.release();
    h1?.release(); // idempotent
    expect(inFlight("s1")).toBe(false);
  });

  test("acquireForCompaction never skips (abort, await, acquire)", async () => {
    _resetRunLocks();
    const h = acquireOrSkip("s1", "observe");
    const acquiring = acquireForCompaction("s1");
    await new Promise<void>((r) => setTimeout(r, 0));
    expect(h?.abortController.signal.aborted).toBe(true);
    h?.release();
    const compaction = await acquiring;
    expect(current("s1")).toBe("select");
    compaction.release();
  });

  test("measure snapshots: the fill serves the main conversation; loop keys read unknown", () => {
    _resetMeasureSnapshots();
    expect(contextTokensFor("sess")).toBeNull();
    recordMeasure("sess", { tokens: 42_000, window: 200_000 });
    expect(contextTokensFor("sess")).toBe(42_000);
    expect(contextTokensFor("sess|ag-1")).toBeNull();
    _resetMeasureSnapshots();
  });

  test("production teardown prunes the per-conversation maps", () => {
    _resetRunLocks();
    _resetMeasureSnapshots();
    const h1 = acquireOrSkip("s-x", "observe");
    h1?.release();
    recordMeasure("s-x", { tokens: 5000, window: 200_000 });
    expect(pruneIdleLocks()).toBe(1);
    pruneMeasures();
    expect(contextTokensFor("s-x")).toBeNull();
  });

  test("the goal-extract mapping: one shot over the injected capsule, skip-and-log when no model", async () => {
    const calls: unknown[] = [];
    const completer = makeGoalCompleter({
      complete: async (request, options) => {
        calls.push({ request, options });
        return { isAnswered: true, text: "one-line goal" };
      },
      getModel: () => "haiku",
    });
    const signal = new AbortController().signal;
    const reply = await completer({ prompt: "GOAL\n\nask", signal, maxTokens: 512, timeoutMs: 30_000 });
    expect(reply).toBe("one-line goal");
    expect(calls.length).toBe(1);
    expect(calls[0]).toEqual({
      request: { model: "haiku", prompt: "GOAL\n\nask", maxTokens: 512, timeoutMs: 30_000 },
      options: { signal },
    });
    // no model resolvable ⇒ skip-and-log, no call
    const logs: string[] = [];
    const skipping = makeGoalCompleter({
      complete: async () => ({ isAnswered: true, text: "never" }),
      getModel: () => null,
      log: (m) => logs.push(m),
    });
    await expect(skipping({ prompt: "p", signal: undefined, maxTokens: 512, timeoutMs: 1000 })).resolves.toBe("");
    expect(logs.some((l) => l.includes("goal extract skipped"))).toBe(true);
  });

  test("the wired boundary closure loads: binding construction + the evaluator entry points (kit import rules)", () => {
    // The imports at the top already prove the closure resolves under the
    // kit loader's rules (bare specifiers refused; the vendored bare VALUE
    // edges rewritten to the local shims by the sync table).
    expect(typeof onStepBoundary).toBe("function");
    expect(typeof onTurnCompleteBoundary).toBe("function");
    // constructing a binding needs only the config dir (the storage
    // assembly's precondition) — no pin, no disk: the memoized instance
    // hands back its contract and releases cleanly
    state.resolveConfigDir("/cfg", null);
    const key = "kit-bind";
    const binding = getBinding(key, key, null);
    try {
      expect(binding.key).toBe(key);
      expect(binding.isEnabled()).toBe(true);
      const deps = binding.triggerDeps();
      expect(deps.key).toBe(key);
      expect(typeof deps.runs.runObserver).toBe("function");
      expect(binding.leafId()).toBeNull(); // no capture state yet
    } finally {
      releaseBinding(key);
    }
  });
});
