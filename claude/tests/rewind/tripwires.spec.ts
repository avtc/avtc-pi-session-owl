// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// Layer 3 — the tripwires: a session.measure fill DROP with no owl
// compaction answered and no compaction row observed means truncation
// outside owl's knowledge — trigger the canonical check immediately.

import { beforeEach, describe, expect, test } from "vitest";
import { TruncationTripwires } from "../../host/rewind/tripwires.js";

let wires: TruncationTripwires;

beforeEach(() => {
  wires = new TruncationTripwires();
});

describe("TruncationTripwires", () => {
  test("a fill drop fires the suspicion", () => {
    wires.observeMeasure("main", 80_000);
    wires.observeMeasure("main", 40_000);
    expect(wires.evaluate("main")).toEqual({ suspected: true });
  });

  test("a rising or steady fill never fires", () => {
    wires.observeMeasure("main", 40_000);
    wires.observeMeasure("main", 80_000);
    expect(wires.evaluate("main")).toEqual({ suspected: false });
    wires.observeMeasure("main", 80_000);
    expect(wires.evaluate("main")).toEqual({ suspected: false });
  });

  test("an owl compaction answered since the last measure suppresses", () => {
    wires.observeMeasure("main", 80_000);
    wires.noteOwlCompactionAnswered("main");
    wires.observeMeasure("main", 40_000);
    expect(wires.evaluate("main")).toEqual({ suspected: false });
  });

  test("a compaction row observed suppresses (native compaction writes a door row)", () => {
    wires.observeMeasure("main", 80_000);
    wires.noteCompactionRow("row-x");
    wires.observeMeasure("main", 40_000);
    expect(wires.evaluate("main")).toEqual({ suspected: false });
  });

  test("per-key isolation (the subagent loop's fill is its own series)", () => {
    wires.observeMeasure("main", 80_000);
    wires.observeMeasure("loop-1", 10_000);
    wires.observeMeasure("main", 40_000);
    expect(wires.evaluate("main")).toEqual({ suspected: true });
    expect(wires.evaluate("loop-1")).toEqual({ suspected: false });
  });

  test("a clean check resets the suspicion; the next drop re-fires", () => {
    wires.observeMeasure("main", 80_000);
    wires.observeMeasure("main", 40_000);
    wires.markCheckedClean("main");
    expect(wires.evaluate("main")).toEqual({ suspected: false });
    wires.observeMeasure("main", 20_000); // drop vs the 40k baseline
    expect(wires.evaluate("main")).toEqual({ suspected: true });
  });

  test("the suppression markers only cover ONE subsequent drop (they clear on use)", () => {
    wires.observeMeasure("main", 80_000);
    wires.noteCompactionRow("row-x");
    wires.observeMeasure("main", 40_000); // suppressed by the compaction row
    expect(wires.evaluate("main")).toEqual({ suspected: false });
    wires.observeMeasure("main", 20_000); // a further drop with no marker — fires
    expect(wires.evaluate("main")).toEqual({ suspected: true });
  });

  test("an unknown key evaluates clean", () => {
    expect(wires.evaluate("never-seen")).toEqual({ suspected: false });
  });
});
