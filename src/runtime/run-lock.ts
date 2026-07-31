// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// The single run-lock (one run-lock; one stage active at a time; triggers await).
// At most one of {Observer, Builder, Selector} is active at a time. Background
// triggers that collide SKIP (fire-and-forget, decision #20); compaction is
// EXCLUSIVE — it aborts an in-flight background run via its OWN abort controller
// (decision #39 — NOT event.signal), awaits the run's actual release, then
// acquires unconditionally.
//
// Each run owns its own AbortController so compaction can cancel it at the next
// tool-call boundary (the run honors `signal`; release stays in the run's
// `finally`). Module singleton — accessed via a small interface for testability.

/** The maintenance stages serialized by the run-lock. */
export type StageName = "observe" | "build" | "select";

/**
 * A held run-lock handle. The caller releases it in its `finally` (background) or
 * its hook `finally` (compaction). `abortController` is the run's OWN controller
 * (compaction aborts it; the run honors `abortController.signal`).
 */
export interface RunHandle {
  /** Release the run-lock (idempotent — safe to call from a `finally`). */
  release: () => void;
  /** The run's own abort controller (compaction aborts `.abort()` on it). */
  abortController: AbortController;
}

interface ActiveRun {
  stage: StageName;
  handle: RunHandle;
  released: boolean;
}

let active: ActiveRun | null = null;

/** A compaction waiter: resolved by `release()` so `acquireForCompaction` unblocks. */
let compactionWaiter: (() => void) | null = null;

/** Test-only: reset the singleton to idle (no run, no waiter). */
export function _resetRunLock(): void {
  active = null;
  compactionWaiter = null;
}

/** Whether a run is currently in flight. */
export function inFlight(): boolean {
  return active !== null;
}

/** The currently-active stage, or null when idle. */
export function current(): StageName | null {
  return active === null ? null : active.stage;
}

function makeHandle(stage: StageName): RunHandle {
  const run: ActiveRun = {
    stage,
    handle: { release: () => releaseActive(run), abortController: new AbortController() },
    released: false,
  };
  active = run;
  return run.handle;
}

/** Release the active run (called from the handle's `release`). Idempotent. */
function releaseActive(run: ActiveRun): void {
  if (run.released) return;
  run.released = true;
  if (active === run) {
    active = null;
    // wake a compaction waiter (if any) now that the lock is free.
    const waiter = compactionWaiter;
    compactionWaiter = null;
    if (waiter !== null) waiter();
  }
}

/**
 * Background-trigger acquire: return a handle when idle, or null (SKIP) when a run
 * is already in flight (decision #20 — the handler returns immediately; the gap
 * is batched on the next trigger).
 */
export function acquireOrSkip(stage: StageName): RunHandle | null {
  return active === null ? makeHandle(stage) : null;
}

/**
 * Abort the in-flight run's OWN abort controller (decision #39 — memkeeper's
 * per-run controller, NOT event.signal). The run stops at its next tool-call
 * boundary and releases in its `finally`; this does NOT release the lock itself.
 * No-op when idle.
 */
export function abortInFlight(): void {
  if (active !== null) {
    active.handle.abortController.abort();
  }
}

/** Resolve once the lock is idle (released by `releaseActive` via the waiter). */
function waitForIdle(): Promise<void> {
  if (active === null) return Promise.resolve();
  return new Promise<void>((resolve) => {
    compactionWaiter = resolve;
  });
}

/**
 * Compaction-exclusive acquire (never skips): abort any in-flight background run
 * at its next tool-call boundary (decision #39), AWAIT its actual release, then
 * acquire unconditionally and return a fresh handle (stage "select" — compaction
 * runs observe/build/select sequentially under this single acquire). The compaction
 * hook `await`s this and releases in its `finally`.
 */
export async function acquireForCompaction(): Promise<RunHandle> {
  if (active !== null) {
    abortInFlight();
    await waitForIdle();
  }
  return makeHandle("select");
}
