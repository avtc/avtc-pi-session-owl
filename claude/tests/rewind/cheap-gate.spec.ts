// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// The mid-turn cheap gate binding: a truncation tripwire that fired since
// the last clean check defers a mid-turn launch to the turn boundary (the
// api-form check never runs mid-turn — one api call per step would be
// prohibitive). The wiring is live in the boundary evaluator; this
// fixture pins the BINDING SEMANTICS: cheapGateClean backed by the
// rewind tripwires defers exactly when the key's suspicion is live.

import { describe, expect, test } from "vitest";
import { TruncationTripwires } from "../../host/rewind/tripwires.js";
import { onStepBoundary } from "../../host/triggers/eval.js";

function makeDeps(cheapGateClean: () => boolean) {
  let launched = 0;
  const deps = {
    thinkingLevel: null,
    isEnabled: () => true,
    cheapGateClean,
    getObserverFrontier: () => null,
    // the remaining host deps stay inert: the gate decides before any of
    // them is consulted
    onLaunch: () => {
      launched += 1;
    },
  } as unknown as Parameters<typeof onStepBoundary>[0];
  return { deps, launched: () => launched };
}

describe("the mid-turn cheap gate — tripwire-backed binding", () => {
  test("clean suspicion ⇒ the launch may proceed past the gate", () => {
    const wires = new TruncationTripwires();
    const { deps, launched } = makeDeps(() => !wires.evaluate("main").suspected);
    onStepBoundary(deps, {});
    // the gate passed; the downstream matrix found no pending rows (inert
    // deps) — the assertion is that the gate did NOT defer the call itself
    expect(launched()).toBe(0);
  });

  test("a fired tripwire ⇒ the launch defers to the turn boundary", () => {
    const wires = new TruncationTripwires();
    wires.observeMeasure("main", 1000);
    wires.observeMeasure("main", 400); // drop, no compaction ⇒ suspected
    let deferred = false;
    const deps = {
      thinkingLevel: null,
      isEnabled: () => true,
      cheapGateClean: () => {
        if (!wires.evaluate("main").suspected) return true;
        deferred = true;
        return false;
      },
      getObserverFrontier: () => null,
    } as unknown as Parameters<typeof onStepBoundary>[0];
    onStepBoundary(deps, {});
    expect(deferred).toBe(true);
    // and the tripwire clears only at a clean check
    wires.markCheckedClean("main");
    expect(wires.evaluate("main")).toEqual({ suspected: false });
  });

  test("per-loop isolation: another key's suspicion never gates this loop", () => {
    const wires = new TruncationTripwires();
    wires.observeMeasure("loop-other", 1000);
    wires.observeMeasure("loop-other", 400);
    expect(wires.evaluate("loop-mine")).toEqual({ suspected: false });
  });
});
