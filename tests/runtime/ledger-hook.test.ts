// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// Tests for the ledger-feed hook factory: each stage run wires `onStageEnd`
// (the agentLoop's end-of-run seam) to this hook, which folds the stage's
// accumulated usage into the store's cumulative ledger and persists a
// `memkeeper.usage` delta. One stage = one ledger increment + one persist.

import { beforeEach, describe, expect, it } from "vitest";
import type { StageUsage } from "../../src/runtime/agent-loop.js";
import { makeLedgerHook } from "../../src/runtime/ledger-hook.js";
import { cloneLedger, EMPTY_LEDGER } from "../../src/store/codecs.js";
import { getGraphStore, type StoreContext, type StoreEntry } from "../../src/store/graph-store.js";

const USAGE_A: StageUsage = { input: 1000, output: 500, cacheRead: 300, cost: 0.05, turns: 3 };

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

  it("folds a stage's usage into the store ledger's named phase + persists one delta", () => {
    const { ctx, usageDeltaCount } = recordingStore();
    const hook = makeLedgerHook(ctx, "build");
    expect(usageDeltaCount()).toBe(0);
    hook(USAGE_A);
    expect(getGraphStore().usageLedger.build).toEqual({ ...USAGE_A, runs: 1 });
    expect(usageDeltaCount()).toBe(1);
  });

  it("accumulates across multiple invocations (one hook = the same phase each call)", () => {
    const { ctx } = recordingStore();
    const hook = makeLedgerHook(ctx, "observe");
    hook(USAGE_A);
    hook(USAGE_A);
    expect(getGraphStore().usageLedger.observe).toEqual({
      input: 2000,
      output: 1000,
      cacheRead: 600,
      cost: 0.1,
      turns: 6,
      runs: 2,
    });
  });

  it("each phase's hook is independent (observe hook doesn't touch build)", () => {
    const { ctx } = recordingStore();
    makeLedgerHook(ctx, "observe")(USAGE_A);
    makeLedgerHook(ctx, "select")(USAGE_A);
    expect(getGraphStore().usageLedger.observe.runs).toBe(1);
    expect(getGraphStore().usageLedger.select.runs).toBe(1);
    expect(getGraphStore().usageLedger.build.runs).toBe(0);
  });
});
