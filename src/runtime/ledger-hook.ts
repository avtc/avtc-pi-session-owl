// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// The stage-end → usage-ledger seam. Each stage run (Observer per chunk,
// Builder/Selector per pass) wires `onStageEnd` (the agentLoop's end-of-run
// hook) to a hook built here: fold the stage's accumulated usage into the
// store's cumulative ledger + persist a `memkeeper.usage` delta. One stage
// invocation = one ledger increment + one durable persist.

import { addPhaseUsage, type Phase } from "../status/usage-ledger.js";
import { appendUsage, getGraphStore, type StoreContext } from "../store/graph-store.js";
import type { StageUsage } from "./agent-loop.js";

/**
 * Build the `onStageEnd` hook for one phase of one run. The hook reads the
 * store's live cumulative ledger, folds the stage usage into the named phase
 * (input/output/cacheRead/cost/turns + a run count), then persists the updated
 * ledger as a `memkeeper.usage` delta. Closing over `phase` keeps each run's hook
 * scoped to its own stage (an Observer run never credits the build phase).
 */
export function makeLedgerHook(store: StoreContext, phase: Phase): (usage: StageUsage) => void {
  return (usage: StageUsage): void => {
    const ledger = getGraphStore().usageLedger;
    addPhaseUsage(ledger, phase, usage);
    appendUsage(store, ledger);
  };
}
