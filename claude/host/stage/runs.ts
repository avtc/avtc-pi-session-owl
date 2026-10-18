// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// The stage runs' state home: one record per spawned stage agent, keyed by
// the agentId the engine resolved at spawn. The turn.step relay, the stage
// tools' caller gate (liveness), and the shim's completion gate consult this
// map; the delivery drop and the capture skip read the broader spawn
// registry's membership (which outlives the run). Everything here is plain
// data + flags — no engine access, so Node tests drive it without capsules.

/** A stage name, as the agent types are registered (the bare short form). */
export type StageName = "observer" | "builder" | "selector";

/** Run-control configuration, carried per run (pi's runStage knobs the relay
 *  enforces: per-call output cap, per-call stall timeout, the Observer's
 *  no-progress turn count). */
export interface StageRunConfig {
  /** Per-LLM-call output cap in ESTIMATED tokens (chars/4). At the cap the
   *  relay yields a synthetic 'max_tokens' stop for that step. */
  maxTokens: number;
  /** Per-LLM-call stall timeout (ms), re-armed per step; null = no limit. */
  timeoutMs: number | null;
  /** Consecutive zero-accepted steps before the abort flag trips. */
  noProgressTurns: number;
}

/** The per-run state machine the relay owns. */
export interface StageRunState {
  /** The agentId the engine resolved at spawn (the map key). */
  agentId: string;
  /** Which stage type this run was spawned as. */
  stage: StageName;
  /** Run-control knobs (from pi's runStage input). */
  config: StageRunConfig;
  /** Set once the run must fabricate every further step (signal abort,
   *  no-progress trip, or a watchdog flag). */
  abortFlag: boolean;
  /** Why the abort flag was set (the dump marker + gate reason). */
  abortReason: string | null;
  /** The run's widget event sink (the shim's onEvent): per-step model
   *  lifecycle + streaming deltas feed the tracker bridge (pi's stream). */
  onEvent: ((event: unknown) => void) | null;
  /** True when the per-call timeout fired (distinct from a signal abort). */
  timedOut: boolean;
  /** Steps this run has completed (the StageUsage.turns source). */
  stepCount: number;
  /** Accepted-record counter (the tools layer increments; the relay samples
   *  per-step deltas for the no-progress rule). */
  acceptedRecords: number;
  /** Consecutive steps with zero accepted records. */
  zeroAcceptedSteps: number;
  /** The accepted-records checkpoint of the last completed step — a step's
   *  tool calls land between its completion and the next step's start, so
   *  progress is measured step-completion to step-completion. */
  lastAcceptedMark: number;
  /** Spawn epoch ms (elapsedMs source). */
  startedAt: number;
  /** The dump call-site buffer (dumps.ts fills it; the run modules append
   *  their own pre-call <input> blocks — the buffer carries no prompt). */
  dump: {
    outputRows: unknown[];
    handback: { tool: string; result: unknown } | null;
    fabricatedStop: string | null;
    /** Run-module forensics appended at spawn time (the per-chunk allowed-id
     *  block, the per-pass markers — pi's dump wrappers). The pending closer
     *  keeps the wrappers balanced at teardown. */
    sections: string[];
    /** The closer owed by the last opener section (flushed at completion). */
    pendingCloser: string | null;
  };
}

const runs = new Map<string, StageRunState>();

/** A fatal model-side error seen in a stage run's stream (an engine
 *  `api_error` system row: the gateway/model was unavailable and the
 *  engine's own retries are exhausted — the run's output is NOT a verdict).
 *  First note sticks; the stage runner takes it after the run. */
const fatalModelErrors = new Map<StageName, string>();

/** Record a fatal model error observed in a stage's captured rows. */
export function noteStageFatalModelError(stage: StageName, detail: string): void {
  if (!fatalModelErrors.has(stage)) fatalModelErrors.set(stage, detail);
}

/** Take (and clear) a stage's pending fatal model error, if any. */
export function takeStageFatalModelError(stage: StageName): string | null {
  const detail = fatalModelErrors.get(stage);
  if (detail === undefined) return null;
  fatalModelErrors.delete(stage);
  return detail;
}

/** Create the per-run state (the shim, right after spawn resolves). */
export function createStageRun(
  agentId: string,
  stage: StageName,
  config: StageRunConfig,
  onEvent: ((event: unknown) => void) | null = null,
): StageRunState {
  const state: StageRunState = {
    agentId,
    stage,
    config,
    onEvent,
    abortFlag: false,
    abortReason: null,
    timedOut: false,
    stepCount: 0,
    acceptedRecords: 0,
    zeroAcceptedSteps: 0,
    lastAcceptedMark: 0,
    startedAt: Date.now(),
    dump: { outputRows: [], handback: null, fabricatedStop: null, sections: [], pendingCloser: null },
  };
  runs.set(agentId, state);
  return state;
}

/** The run for an agentId, or undefined (the caller gate's deny side). */
export function getStageRun(agentId: string | undefined | null): StageRunState | undefined {
  if (typeof agentId !== "string") return undefined;
  return runs.get(agentId);
}

/** Set the abort flag (idempotent; the first reason sticks for the dump). */
export function abortRun(agentId: string, reason: string): void {
  const run = runs.get(agentId);
  if (run === undefined) return;
  if (run.abortFlag) return;
  run.abortFlag = true;
  run.abortReason = reason;
}

/** Mark the run as timed out (also aborts it — a timeout is an error stop). */
export function timeoutRun(agentId: string): void {
  const run = runs.get(agentId);
  if (run === undefined) return;
  run.timedOut = true;
  abortRun(agentId, "timeout");
}

/** Record accepted records (the tools layer, per accepted batch). */
export function noteAccepted(agentId: string, count: number): void {
  const run = runs.get(agentId);
  if (run === undefined) return;
  run.acceptedRecords += count;
}

/** End-of-step bookkeeping: step count + the no-progress counter over the
 *  accepted delta since the last step COMPLETED (a step's tool calls land
 *  between its completion and the next step's start). Returns true when the
 *  no-progress rule just tripped the abort flag. */
export function completeStep(agentId: string): boolean {
  const run = runs.get(agentId);
  if (run === undefined) return false;
  run.stepCount += 1;
  const acceptedThisStep = run.acceptedRecords - run.lastAcceptedMark;
  run.lastAcceptedMark = run.acceptedRecords;
  if (acceptedThisStep > 0) {
    run.zeroAcceptedSteps = 0;
  } else {
    run.zeroAcceptedSteps += 1;
    if (!run.abortFlag && run.config.noProgressTurns > 0 && run.zeroAcceptedSteps >= run.config.noProgressTurns) {
      abortRun(agentId, "no-progress");
      return true;
    }
  }
  return false;
}

/** Remove the run (the shim's completion gate). The finished agent's dump
 *  buffer merges into the stage's ARCHIVE entry first — one stage RUN spans
 *  many agents (a pass per spawn), and the run module materializes the
 *  archive as its single dump file at run end (takeStageDump). */
export function completeStageRun(agentId: string): StageRunState | undefined {
  const run = runs.get(agentId);
  runs.delete(agentId);
  // flush the owed section closer (this module stays import-free — the
  // two-line flush is inlined rather than imported from the dump module)
  if (run !== undefined && run.dump.pendingCloser !== null) {
    run.dump.sections.push(run.dump.pendingCloser);
    run.dump.pendingCloser = null;
  }
  if (run !== undefined) mergeIntoArchive(run);
  return run;
}

/** The per-stage dump archive: completed agents' buffers merged in completion
 *  order — the content of the stage run's ONE dump file. */
const dumpArchive = new Map<StageName, StageDumpArchive>();

/** The accumulated view: sections/rows/handback/marker as completed agents
 *  observe them. The <input> blocks are NOT archived — the run module
 *  appends each pass's input PRE-CALL from its own messages (pi's
 *  durability property: a call that dies still leaves its input record). */
export interface StageDumpArchive {
  outputRows: unknown[];
  handback: { tool: string; result: unknown } | null;
  fabricatedStop: string | null;
  sections: string[];
}

/** The stages whose dump handles are open (dumps enabled) — mergeIntoArchive
 *  consults this; the run modules arm it at open. */
const dumpArchiveStages = new Set<StageName>();

/** Arm (or disarm) a stage's dump archive — the run module calls this each
 *  run: armed when its dump handle opens (dumps enabled), disarmed when it
 *  does not (a mid-session disable stops the accumulation for good, not
 *  just for the handle-less run). */
export function enableStageDumpArchive(stage: StageName, enabled = true): void {
  if (enabled) dumpArchiveStages.add(stage);
  else dumpArchiveStages.delete(stage);
}

function mergeIntoArchive(run: StageRunState): void {
  if (!dumpArchiveStages.has(run.stage)) return; // dumps disabled — never accumulate
  const d = run.dump;
  let acc = dumpArchive.get(run.stage);
  if (acc === undefined) {
    acc = { outputRows: [], handback: null, fabricatedStop: null, sections: [] };
    dumpArchive.set(run.stage, acc);
  }
  acc.sections.push(...d.sections);
  acc.outputRows.push(...d.outputRows);
  if (d.handback !== null) acc.handback = d.handback; // the last pair
  if (acc.fabricatedStop === null) acc.fabricatedStop = d.fabricatedStop; // first sticks
}

/** Take (and clear) a stage's archived dump delta — the run module drains
 *  after each pass/chunk (per-record durability) and once more at run end.
 * Null when no agent has completed (or dumps are disabled for the stage). */
export function takeStageDump(stage: StageName): StageDumpArchive | null {
  const acc = dumpArchive.get(stage);
  if (acc === undefined) return null;
  dumpArchive.delete(stage);
  return acc;
}

/** How many runs are live (the ticker arms/disarms on this). */
export function stageRunCount(): number {
  return runs.size;
}

/** session.end teardown: drop every run state (the engine's agents are gone
 *  with the session; the bridge's clearAllForSessionEnd resolves any gate
 *  still awaiting one of them). */
export function clearAllStageRuns(): void {
  runs.clear();
  dumpArchive.clear(); // session-scoped state — the reset clears it too
  dumpArchiveStages.clear();
}
