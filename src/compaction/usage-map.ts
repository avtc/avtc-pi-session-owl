// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// Map session-owl's per-phase usage (PhaseUsage) into pi's `Usage` shape so the
// session_before_compact hook can return `compaction.usage` (UD32 — makes the
// bench's metric measurable for the session-owl arms). pi's `addUsageToTotals`
// has NO nullish guards, so every field MUST be a finite number (0, never
// undefined/omitted) and `cost` MUST be an object with `total: number`.
//
// Shape notes (session-owl → pi-ai Usage):
//  - input/output/cacheRead/cacheWrite carry straight through.
//  - `totalTokens` (pi-ai) is the per-agent context-window consumption; session-owl's
//    PhaseUsage doesn't accumulate it, so we derive input+output+cacheRead+cacheWrite
//    (the honest token total — never 0 for a non-empty phase, never undefined).
//  - `cost` is flat per-phase in session-owl (PhaseUsage.cost = cost.total); the
//    per-bucket cost.{input,output,cacheRead,cacheWrite} are NOT tracked, so they
//    emit 0 (honest) while cost.total carries the real number addUsageToTotals reads.

import type { Usage } from "@earendil-works/pi-ai";
import type { PhaseUsage, UsageLedger } from "../store/codecs.js";

/** Map one phase's cumulative usage into pi's `Usage` shape. All fields finite. */
export function phaseUsageToUsage(p: PhaseUsage): Usage {
  return {
    input: p.input,
    output: p.output,
    cacheRead: p.cacheRead,
    cacheWrite: p.cacheWrite,
    // session-owl doesn't track per-phase totalTokens → derive the token sum.
    totalTokens: p.input + p.output + p.cacheRead + p.cacheWrite,
    // per-bucket costs aren't tracked; total is the real number pi reads.
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: p.cost },
  };
}

/** Sum observe + build + select into the aggregate `Usage` for `compaction.usage`. */
export function aggregateLedgerUsage(delta: UsageLedger): Usage {
  const sum = (sel: (p: PhaseUsage) => number): number => sel(delta.observe) + sel(delta.build) + sel(delta.select);
  const input = sum((p) => p.input);
  const output = sum((p) => p.output);
  const cacheRead = sum((p) => p.cacheRead);
  const cacheWrite = sum((p) => p.cacheWrite);
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    totalTokens: input + output + cacheRead + cacheWrite,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: sum((p) => p.cost) },
  };
}

/** Per-stage breakdown (observe/build/select each → Usage) for the freeform `details`
 *  field — feeds the bench's per-stage table. Additive over the existing
 *  `lastCompactionLedger` (which is cumulative, not this-compaction's delta).  */
export function ledgerToStageUsages(delta: UsageLedger): { observe: Usage; build: Usage; select: Usage } {
  return {
    observe: phaseUsageToUsage(delta.observe),
    build: phaseUsageToUsage(delta.build),
    select: phaseUsageToUsage(delta.select),
  };
}
