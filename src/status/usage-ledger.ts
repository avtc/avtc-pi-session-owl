// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// Pure usage-ledger math (no callbacks, no I/O). The ledger is a per-phase
// cumulative token/cost/turn tracker; the stage passes feed it via
// addPhaseUsage at each stage end and /owl:status reads it.

import type { StageUsage } from "../runtime/agent-loop.js";
import { cloneLedger, type PhaseUsage, type UsageLedger } from "../store/codecs.js";

/** The three session-owl stages whose usage the ledger tracks. */
export type Phase = "observe" | "build" | "select";

/**
 * Add a stage's accumulated usage to its phase total, in place (token/cost/turn
 * fields only). `StageUsage` carries input/output/cacheRead/cost/turns (no run
 * counter); the run counter is bumped once per stage RUN by the ledger hook
 * (makeLedgerHook), not per convergence pass. Returns the same ledger object
 * (convenience for `appendUsage(store, addPhaseUsage(...))`).
 */
export function addPhaseUsage(ledger: UsageLedger, phase: Phase, usage: StageUsage): UsageLedger {
  const p = ledger[phase];
  p.input += usage.input;
  p.output += usage.output;
  p.cacheRead += usage.cacheRead;
  p.cacheWrite += usage.cacheWrite;
  p.cost += usage.cost;
  p.turns += usage.turns;
  p.elapsedMs += usage.elapsedMs;
  return ledger;
}

/** Count one completed stage RUN for `phase` (a Builder/Selector convergence
 *  run, or one Observer run — regardless of how many passes/chunks it had). */
export function bumpRun(ledger: UsageLedger, phase: Phase): void {
  ledger[phase].runs += 1;
}

/**
 * Snapshot the ledger at a compaction point. The `ledger` is the post-compaction
 * cumulative baseline; `lastCompactionLedger` is a deep copy of it so later
 * stage activity can't mutate the captured baseline. The compaction hook keeps
 * `lastCompactionLedger` (carried into `details`) so post-compaction /owl:status
 * "since last compaction" arithmetic is correct.
 */
export function snapshotAtCompaction(ledger: UsageLedger): { ledger: UsageLedger; lastCompactionLedger: UsageLedger } {
  return { ledger, lastCompactionLedger: cloneLedger(ledger) };
}

/** since-session-start = the cumulative ledger itself. */
export function sinceSessionStart(ledger: UsageLedger): UsageLedger {
  return ledger;
}

/** Per-phase field-wise subtraction (ledger − baseline), `runs` included. Pure:
 *  returns a fresh ledger, leaves both inputs untouched. */
export function sinceLastCompaction(ledger: UsageLedger, baseline: UsageLedger): UsageLedger {
  return {
    observe: subtractPhase(ledger.observe, baseline.observe),
    build: subtractPhase(ledger.build, baseline.build),
    select: subtractPhase(ledger.select, baseline.select),
  };
}

function subtractPhase(a: PhaseUsage, b: PhaseUsage): PhaseUsage {
  return {
    input: a.input - b.input,
    output: a.output - b.output,
    cacheRead: a.cacheRead - b.cacheRead,
    cacheWrite: a.cacheWrite - b.cacheWrite,
    cost: a.cost - b.cost,
    turns: a.turns - b.turns,
    runs: a.runs - b.runs,
    elapsedMs: a.elapsedMs - b.elapsedMs,
  };
}
