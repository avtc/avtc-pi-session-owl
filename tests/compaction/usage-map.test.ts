// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import type { Usage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { aggregateLedgerUsage, ledgerToStageUsages, phaseUsageToUsage } from "../../src/compaction/usage-map.js";
import { EMPTY_LEDGER, type PhaseUsage, type UsageLedger } from "../../src/store/codecs.js";

function phase(input: number, output: number, cacheRead: number, cacheWrite: number, cost: number): PhaseUsage {
  return { input, output, cacheRead, cacheWrite, cost, turns: 0, runs: 0, elapsedMs: 0 };
}

describe("phaseUsageToUsage", () => {
  it("maps a PhaseUsage to pi's Usage shape (all fields finite numbers, cost object)", () => {
    const u = phaseUsageToUsage(phase(1000, 500, 300, 40, 0.05));
    // the EXACT + COMPLETE set pi's addUsageToTotals reads (no nullish guards → NaN-safe).
    expect(u).toEqual({
      input: 1000,
      output: 500,
      cacheRead: 300,
      cacheWrite: 40,
      totalTokens: 1840, // derived (memkeeper doesn't track per-phase totalTokens)
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.05 }, // per-bucket 0 (not tracked); total real
    });
  });

  it("emits zeros (NEVER undefined) for a zero-usage phase", () => {
    const u = phaseUsageToUsage(EMPTY_LEDGER.observe);
    expect(u).toEqual({
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    });
  });

  it("cost.total is always a finite number (the NaN-propagation guard)", () => {
    const u = phaseUsageToUsage(phase(0, 0, 0, 0, 0));
    expect(Number.isFinite(u.cost.total)).toBe(true);
    expect(Number.isFinite(u.input)).toBe(true);
    expect(Number.isFinite(u.cacheWrite)).toBe(true);
  });
});

describe("aggregateLedgerUsage", () => {
  it("sums observe + build + select into one Usage (this-compaction aggregate)", () => {
    const delta: UsageLedger = {
      observe: phase(1000, 500, 300, 40, 0.05),
      build: phase(2000, 1000, 600, 80, 0.1),
      select: phase(500, 200, 100, 20, 0.02),
    };
    const u = aggregateLedgerUsage(delta);
    expect(u.input).toBe(3500);
    expect(u.output).toBe(1700);
    expect(u.cacheRead).toBe(1000);
    expect(u.cacheWrite).toBe(140);
    expect(u.totalTokens).toBe(6340);
    expect(u.cost.total).toBeCloseTo(0.17, 10);
  });

  it("returns a fully-zero Usage for an empty delta (no stages ran)", () => {
    const u = aggregateLedgerUsage(EMPTY_LEDGER);
    expect(u).toEqual({
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    });
  });

  it("tolerates a phase with zero usage (observations-root skips Selector)", () => {
    const delta: UsageLedger = {
      observe: phase(1000, 500, 300, 40, 0.05),
      build: phase(2000, 1000, 600, 80, 0.1),
      select: EMPTY_LEDGER.select, // Selector skipped (observations-root)
    };
    const u = aggregateLedgerUsage(delta);
    expect(u.input).toBe(3000);
    expect(u.cacheWrite).toBe(120);
    expect(u.cost.total).toBeCloseTo(0.15, 10);
  });
});

describe("ledgerToStageUsages", () => {
  it("maps each phase to its own Usage (the per-stage breakdown for details)", () => {
    const delta: UsageLedger = {
      observe: phase(1000, 500, 300, 40, 0.05),
      build: phase(2000, 1000, 600, 80, 0.1),
      select: phase(500, 200, 100, 20, 0.02),
    };
    const stages = ledgerToStageUsages(delta);
    expect(stages.observe.input).toBe(1000);
    expect(stages.build.input).toBe(2000);
    expect(stages.select.input).toBe(500);
    // each stage is a valid Usage
    for (const u of [stages.observe, stages.build, stages.select] as Usage[]) {
      expect(Number.isFinite(u.cost.total)).toBe(true);
      expect(Number.isFinite(u.cacheWrite)).toBe(true);
    }
  });
});
