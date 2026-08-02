// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// The stage-end → usage-ledger seam. Each stage run wires `onStageEnd` (the
// agentLoop's end-of-run hook) to a hook built here. The hook FOLDS the stage's
// accumulated usage into the store's cumulative ledger in-memory; the RUN
// persists the ledger as a single `memkeeper.usage` delta once at run end
// (mirroring the Observer's fold-per-unit, persist-once pattern). `hasUsage`
// tells the run whether anything was folded so it can skip a redundant persist.

import { addPhaseUsage, type Phase } from "../status/usage-ledger.js";
import { appendUsage, getGraphStore, type StoreContext } from "../store/graph-store.js";
import type { StageUsage } from "./agent-loop.js";

/**
 * Build the `onStageEnd` fold hook for one phase of one run. The hook folds the
 * stage usage into the named phase (input/output/cacheRead/cost/turns + a run
 * count) of the store's live cumulative ledger, in-memory only — the RUN calls
 * `persistLedger` once at run end. `hasUsage()` reports whether any fold fired.
 * Closing over `phase` keeps each run's hook scoped to its own stage.
 */
export function makeLedgerHook(
  store: StoreContext,
  phase: Phase,
): {
  onStageEnd: (usage: StageUsage) => void;
  hasUsage: () => boolean;
} {
  let accumulated = false;
  return {
    onStageEnd: (usage: StageUsage): void => {
      addPhaseUsage(getGraphStore().usageLedger, phase, usage);
      accumulated = true;
    },
    hasUsage: () => accumulated,
  };
}

/** Persist the store's live cumulative ledger as a `memkeeper.usage` delta. The
 *  run calls this once at run end (after all passes have folded). */
export function persistLedger(store: StoreContext): void {
  appendUsage(store, getGraphStore().usageLedger);
}
