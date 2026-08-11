// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import { describe, expect, it } from "vitest";
import type { StageUsage } from "../../src/runtime/agent-loop.js";
import {
  addPhaseUsage,
  bumpRun,
  sinceLastCompaction,
  sinceSessionStart,
  snapshotAtCompaction,
} from "../../src/status/usage-ledger.js";
import { cloneLedger, EMPTY_LEDGER, type PhaseUsage, type UsageLedger } from "../../src/store/codecs.js";

const STAGE_USAGE_A: StageUsage = {
  input: 1000,
  output: 500,
  cacheRead: 300,
  cacheWrite: 40,
  cost: 0.05,
  turns: 3,
  elapsedMs: 0,
};
const STAGE_USAGE_B: StageUsage = {
  input: 2000,
  output: 1500,
  cacheRead: 700,
  cacheWrite: 90,
  cost: 0.11,
  turns: 5,
  elapsedMs: 0,
};

function phase(
  input: number,
  output: number,
  cacheRead: number,
  cacheWrite: number,
  cost: number,
  turns: number,
  runs: number,
): PhaseUsage {
  return { input, output, cacheRead, cacheWrite, cost, turns, runs, elapsedMs: 0 };
}

describe("usage-ledger", () => {
  describe("addPhaseUsage", () => {
    it("accumulates a stage's usage into the named phase (counter untouched)", () => {
      const ledger: UsageLedger = cloneLedger(EMPTY_LEDGER);
      addPhaseUsage(ledger, "observe", STAGE_USAGE_A);
      expect(ledger.observe).toEqual(phase(1000, 500, 300, 40, 0.05, 3, 0));
      expect(ledger.build).toEqual(phase(0, 0, 0, 0, 0, 0, 0));
      expect(ledger.select).toEqual(phase(0, 0, 0, 0, 0, 0, 0));
    });

    it("accumulates across multiple stages of the same phase", () => {
      const ledger: UsageLedger = cloneLedger(EMPTY_LEDGER);
      addPhaseUsage(ledger, "build", STAGE_USAGE_A);
      addPhaseUsage(ledger, "build", STAGE_USAGE_B);
      expect(ledger.build).toEqual(phase(3000, 2000, 1000, 130, 0.16, 8, 0));
    });

    it("accumulates into independent phases", () => {
      const ledger: UsageLedger = cloneLedger(EMPTY_LEDGER);
      addPhaseUsage(ledger, "observe", STAGE_USAGE_A);
      addPhaseUsage(ledger, "build", STAGE_USAGE_B);
      addPhaseUsage(ledger, "select", STAGE_USAGE_A);
      expect(ledger.observe.runs).toBe(0);
      expect(ledger.build.runs).toBe(0);
      expect(ledger.select.runs).toBe(0);
      expect(ledger.build.input).toBe(2000);
      expect(ledger.observe.input).toBe(1000);
      expect(ledger.select.input).toBe(1000);
    });

    it("bumpRun counts one run per phase (independent of usage folds)", () => {
      const ledger: UsageLedger = cloneLedger(EMPTY_LEDGER);
      addPhaseUsage(ledger, "observe", STAGE_USAGE_A);
      addPhaseUsage(ledger, "observe", STAGE_USAGE_B);
      bumpRun(ledger, "observe");
      expect(ledger.observe.runs).toBe(1);
      // two folds folded, but only one run counted
      expect(ledger.observe.input).toBe(3000);
    });

    it("mutates + returns the same ledger object (in-place accumulation)", () => {
      const ledger: UsageLedger = cloneLedger(EMPTY_LEDGER);
      const returned = addPhaseUsage(ledger, "select", STAGE_USAGE_A);
      expect(returned).toBe(ledger);
    });
  });

  describe("sinceSessionStart", () => {
    it("returns the ledger itself (cumulative since session start)", () => {
      const ledger: UsageLedger = {
        observe: phase(100, 50, 20, 5, 0.01, 2, 1),
        build: phase(200, 100, 40, 10, 0.02, 4, 1),
        select: phase(150, 30, 10, 3, 0.005, 1, 1),
      };
      expect(sinceSessionStart(ledger)).toBe(ledger);
    });
  });

  describe("sinceLastCompaction", () => {
    it("subtracts the snapshot phase-by-phase, field by field (runs included)", () => {
      const ledger: UsageLedger = {
        observe: phase(3000, 2000, 1000, 150, 0.16, 8, 3),
        build: phase(2000, 1500, 700, 90, 0.11, 5, 1),
        select: phase(150, 30, 10, 8, 0.005, 1, 1),
      };
      const baseline: UsageLedger = {
        observe: phase(1000, 500, 300, 50, 0.05, 3, 1),
        build: phase(0, 0, 0, 0, 0, 0, 0),
        select: phase(0, 0, 0, 0, 0, 0, 0),
      };
      const diff = sinceLastCompaction(ledger, baseline);
      expect(diff.observe).toEqual(phase(2000, 1500, 700, 100, 0.11, 5, 2));
      expect(diff.build).toEqual(phase(2000, 1500, 700, 90, 0.11, 5, 1));
      expect(diff.select).toEqual(phase(150, 30, 10, 8, 0.005, 1, 1));
    });

    it("returns zeros when the baseline equals the ledger", () => {
      const ledger: UsageLedger = {
        observe: phase(1000, 500, 300, 40, 0.05, 3, 1),
        build: phase(0, 0, 0, 0, 0, 0, 0),
        select: phase(0, 0, 0, 0, 0, 0, 0),
      };
      const diff = sinceLastCompaction(ledger, ledger);
      expect(diff.observe).toEqual(phase(0, 0, 0, 0, 0, 0, 0));
      expect(diff.build).toEqual(phase(0, 0, 0, 0, 0, 0, 0));
      expect(diff.select).toEqual(phase(0, 0, 0, 0, 0, 0, 0));
    });
  });

  describe("snapshotAtCompaction", () => {
    it("returns the ledger + a deep-copy baseline (independent of later mutation)", () => {
      const ledger: UsageLedger = {
        observe: phase(1000, 500, 300, 40, 0.05, 3, 1),
        build: phase(0, 0, 0, 0, 0, 0, 0),
        select: phase(0, 0, 0, 0, 0, 0, 0),
      };
      const snap = snapshotAtCompaction(ledger);
      expect(snap.ledger).toBe(ledger);
      // baseline equals the ledger values now…
      expect(snap.lastCompactionLedger).toEqual(ledger);
      // …but is a separate object: mutating the ledger afterwards doesn't touch it.
      addPhaseUsage(ledger, "observe", STAGE_USAGE_B);
      expect(snap.lastCompactionLedger.observe).toEqual(phase(1000, 500, 300, 40, 0.05, 3, 1));
      expect(snap.lastCompactionLedger).not.toBe(ledger);
    });
  });

  describe("reconstruct from delta + snapshot (the load path)", () => {
    it("a delta ledger + a baseline snapshot round-trip into since-last-compaction", () => {
      // session-start cumulative (what the latest memkeeper.usage delta carries)
      const ledger: UsageLedger = {
        observe: phase(5000, 3000, 1500, 200, 0.2, 12, 4),
        build: phase(2000, 1500, 700, 90, 0.11, 5, 1),
        select: phase(150, 30, 10, 8, 0.005, 1, 1),
      };
      // baseline captured at the last compaction (from details.lastCompactionLedger)
      const baseline = snapshotAtCompaction(ledger).lastCompactionLedger;
      // simulate post-snapshot activity: one observe run folds usage + bumps runs.
      addPhaseUsage(ledger, "observe", STAGE_USAGE_A);
      bumpRun(ledger, "observe");
      // since-last-compaction reflects only the post-snapshot stage (cost uses
      // FP-tolerant comparison — floating-point addition drifts in the cents).
      const diff = sinceLastCompaction(ledger, baseline);
      expect(diff.observe.input).toBe(1000);
      expect(diff.observe.output).toBe(500);
      expect(diff.observe.cacheRead).toBe(300);
      expect(diff.observe.cacheWrite).toBe(40);
      expect(diff.observe.cost).toBeCloseTo(0.05, 10);
      expect(diff.observe.turns).toBe(3);
      expect(diff.observe.runs).toBe(1);
      expect(diff.build).toEqual(phase(0, 0, 0, 0, 0, 0, 0));
    });
  });
});
