// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// Tests for the ledger-feed hook factory: each stage run wires `onStageEnd`
// (the agentLoop's end-of-run seam) to the fold hook built here, which folds the
// stage's accumulated usage into the store's cumulative ledger IN-MEMORY. The
// RUN persists the ledger as a single `memkeeper.usage` delta once at run end
// (fold-per-pass, persist-once — mirroring the Observer).

import { beforeEach, describe, expect, it } from "vitest";
import type { StageUsage } from "../../src/runtime/agent-loop.js";
import { makeLedgerHook, persistLedger } from "../../src/runtime/ledger-hook.js";
import { cloneLedger, EMPTY_LEDGER } from "../../src/store/codecs.js";
import { getGraphStore, type StoreContext, type StoreEntry } from "../../src/store/graph-store.js";

const USAGE_A: StageUsage = { input: 1000, output: 500, cacheRead: 300, cost: 0.05, turns: 3, elapsedMs: 0 };

function freshStore(): StoreContext {
  const entries: StoreEntry[] = [];
  const ctx: StoreContext = {
    appendEntry: (customType, data) => {
      entries.push({ type: "custom", id: `e${entries.length}`, customType, data } as StoreEntry);
    },
    getLeafId: () => null,
    getBranch: () => entries,
  };
  return ctx;
}

/** A StoreContext whose `getBranch` also reflects memkeeper.usage deltas written
 *  via appendUsage (so the test can confirm persistence). */
function recordingStore(): { ctx: StoreContext; usageDeltaCount: () => number } {
  let usageDeltas = 0;
  const base = freshStore();
  const wrapped: StoreContext = {
    appendEntry: (customType, data) => {
      if (customType === "memkeeper.usage") usageDeltas += 1;
      base.appendEntry(customType, data);
    },
    getLeafId: base.getLeafId,
    getBranch: base.getBranch,
  };
  return { ctx: wrapped, usageDeltaCount: () => usageDeltas };
}

describe("makeLedgerHook", () => {
  beforeEach(() => {
    // reset the singleton ledger to a fresh empty one (independent phases).
    getGraphStore().usageLedger = cloneLedger(EMPTY_LEDGER);
  });

  it("folds a stage's usage into the store ledger's named phase WITHOUT persisting", () => {
    const { usageDeltaCount } = recordingStore();
    const { onStageEnd } = makeLedgerHook("build");
    expect(usageDeltaCount()).toBe(0);
    onStageEnd(USAGE_A);
    expect(getGraphStore().usageLedger.build).toEqual({ ...USAGE_A, runs: 1 });
    expect(usageDeltaCount()).toBe(0); // fold only — no persist yet
  });

  it("accumulates usage across multiple folds but counts the run once (one hook = one run)", () => {
    const { onStageEnd } = makeLedgerHook("observe");
    onStageEnd(USAGE_A);
    onStageEnd(USAGE_A);
    expect(getGraphStore().usageLedger.observe).toEqual({
      input: 2000,
      output: 1000,
      cacheRead: 600,
      cost: 0.1,
      turns: 6,
      elapsedMs: 0,
      runs: 1,
    });
  });

  it("each phase's hook is independent (observe hook doesn't touch build)", () => {
    makeLedgerHook("observe").onStageEnd(USAGE_A);
    makeLedgerHook("select").onStageEnd(USAGE_A);
    expect(getGraphStore().usageLedger.observe.runs).toBe(1);
    expect(getGraphStore().usageLedger.select.runs).toBe(1);
    expect(getGraphStore().usageLedger.build.runs).toBe(0);
  });

  it("hasUsage() reports false before any fold, true after", () => {
    const ledger = makeLedgerHook("build");
    expect(ledger.hasUsage()).toBe(false);
    ledger.onStageEnd(USAGE_A);
    expect(ledger.hasUsage()).toBe(true);
  });

  it("persistLedger writes ONE memkeeper.usage delta for the folded ledger (run-end persist)", () => {
    const { ctx, usageDeltaCount } = recordingStore();
    const ledger = makeLedgerHook("build");
    // two passes fold into the same phase — only ONE persist at run end
    ledger.onStageEnd(USAGE_A);
    ledger.onStageEnd(USAGE_A);
    expect(usageDeltaCount()).toBe(0);
    persistLedger(ctx);
    expect(usageDeltaCount()).toBe(1); // single persist regardless of pass count
  });

  it("persistLedger writes nothing across a full multi-pass run until called once", () => {
    // simulates a 3-pass Builder run: 3 folds, 1 persist (the design's per-run batch)
    const { ctx, usageDeltaCount } = recordingStore();
    const ledger = makeLedgerHook("build");
    for (let i = 0; i < 3; i += 1) ledger.onStageEnd(USAGE_A);
    expect(usageDeltaCount()).toBe(0);
    if (ledger.hasUsage()) persistLedger(ctx);
    expect(usageDeltaCount()).toBe(1);
    expect(getGraphStore().usageLedger.build.runs).toBe(1);
  });
});
