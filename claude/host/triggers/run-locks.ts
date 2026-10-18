// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// The KEYED run-lock — the host port of the vendored runtime/run-lock.ts.
// One process serves many conversations, so the lock is a MAP keyed by the
// conversation key (sessionId, agentId-scope) instead of pi's module
// singleton. Per-key semantics are pi's verbatim — at most one of
// {Observer, Builder, Selector} active per conversation, compaction
// EXCLUSIVE (it aborts the in-flight run via the run's OWN abort
// controller, awaits the actual release, then acquires unconditionally) —
// except ONE deliberate divergence: colliding background triggers still
// SKIP the launch, but the collision arms the settle-rearm below, so the gap
// re-enters ONCE at the holder's release. Idle waiters queue in a list —
// several flows may wait on the same run concurrently and every one resolves
// on release.

import { runsLog } from "../runs/seams.js";

/** The maintenance stages serialized by the run-lock. */
/** The maintenance stages serialized by the run-lock. `extract` is the
 *  goal-extraction one-shot: it takes the lock so a same-queue boundary
 *  evaluation SKIPs until the goal settles (the goal-first sequencing rule). */
export type StageName = "observe" | "build" | "select" | "extract";

/** A held run-lock handle. The caller releases it in its `finally`
 *  (background) or its hook `finally` (compaction). */
export interface RunHandle {
  /** Release the run-lock (idempotent — safe to call from a `finally`). */
  release: () => void;
  /** The run's own abort controller (compaction aborts `.abort()` on it). */
  abortController: AbortController;
  /** Update the stage label mid-run (a chained turn run observes, then
   *  builds, then selects under a single acquire). */
  setStage: (stage: StageName) => void;
}

interface ActiveRun {
  stage: StageName;
  handle: RunHandle;
  released: boolean;
}

interface LockState {
  key: string;
  active: ActiveRun | null;
  /** Idle waiters: resolved by `release()` so each blocked flow unblocks. */
  idleWaiters: Array<() => void>;
}

const locks = new Map<string, LockState>();

/** The pending settle-rearm re-entry per conversation key: armed when a
 *  boundary evaluation collides with an in-flight run, fired ONCE by the
 *  holder's successful release (coalesced — N collisions keep one), dropped
 *  when that release follows an abort (the takeover flow owns the next
 *  evaluation). A pure seam: the evaluator supplies the guarded re-entry. */
const rearmOnRelease = new Map<string, () => void>();

/** Arm the key's settle-rearm with the guarded re-entry (coalesced). */
export function armRearmOnRelease(key: string, reenter: () => void): void {
  rearmOnRelease.set(key, reenter);
}

function lockFor(key: string): LockState {
  let lock = locks.get(key);
  if (lock === undefined) {
    lock = { key, active: null, idleWaiters: [] };
    locks.set(key, lock);
  }
  return lock;
}

/** Test-only: reset every lock to idle (no runs, no waiters, no armed
 *  settle-rearms). */
export function _resetRunLocks(): void {
  locks.clear();
  rearmOnRelease.clear();
}

/** Whether a run is currently in flight on the conversation. */
export function inFlight(key: string): boolean {
  return (locks.get(key)?.active ?? null) !== null;
}

/** The currently-active stage on the conversation, or null when idle. */
export function current(key: string): StageName | null {
  const lock = locks.get(key);
  return lock?.active === undefined || lock.active === null ? null : lock.active.stage;
}

function makeHandle(lock: LockState, stage: StageName): RunHandle {
  const run: ActiveRun = {
    stage,
    handle: {
      release: () => releaseActive(lock, run),
      abortController: new AbortController(),
      setStage: (next: StageName) => {
        if (lock.active === run) run.stage = next;
      },
    },
    released: false,
  };
  lock.active = run;
  return run.handle;
}

function releaseActive(lock: LockState, run: ActiveRun): void {
  if (run.released) return;
  run.released = true;
  if (lock.active === run) {
    lock.active = null;
    // wake EVERY idle waiter (any number may queue concurrently — compaction,
    // branch navigation — each resolves so no flow is dropped)
    const waiters = lock.idleWaiters.splice(0, lock.idleWaiters.length);
    for (const waiter of waiters) waiter();
    // settle-rearm: the holder's SUCCESSFUL release re-enters the evaluation
    // that skipped during the flight (microtask ⇒ never re-enters inside
    // this release call); an aborted holder drops it — the flow that aborted
    // it owns the next evaluation
    const reenter = rearmOnRelease.get(lock.key);
    if (reenter !== undefined) {
      rearmOnRelease.delete(lock.key);
      if (run.handle.abortController.signal.aborted) {
        runsLog("trigger: settle-rearm dropped — the holder was aborted");
      } else {
        // Promise microtask, never `queueMicrotask(...)`: the engine's worker
        // scope where this module loads exposes no such identifier (every
        // attempt threw "queueMicrotask is not defined"). Promise is the
        // portable microtask primitive — same scheduling, next tick after
        // this call, still never re-entering inside the release.
        void Promise.resolve()
          .then(() => reenter())
          .catch((cause: unknown) => {
            // reenter may itself be async — its rejection is caught HERE
            // (the sync-throw path below stays for same-tick throws)
            runsLog("trigger: settle-rearm failed", cause);
          });
      }
    }
  }
}

/** Background-trigger acquire: return a handle when the conversation is
 *  idle, or null (SKIP) when one of its runs is already in flight (the
 *  handler returns immediately; the gap is batched onto the next run). */
export function acquireOrSkip(key: string, stage: StageName): RunHandle | null {
  const lock = lockFor(key);
  return lock.active === null ? makeHandle(lock, stage) : null;
}

/** Goal-extraction acquire (the goal-first sequencing rule): SYNCHRONOUS
 *  when the conversation is idle — the capture's fire calls this before its
 *  first await, so the same-queue boundary evaluation sees the holder and
 *  SKIPs. Null when a run already holds the lock: the extraction then runs
 *  WITHOUT contending (the holder — the reuse rebuild's compaction-class
 *  hold — already excludes every stage; waiting would deadlock against its
 *  release while a rescan awaits the extraction's settle on the other side). */
export function acquireForExtract(key: string): RunHandle | null {
  const lock = lockFor(key);
  return lock.active === null ? makeHandle(lock, "extract") : null;
}

/** Abort the conversation's in-flight run's OWN abort controller (the
 *  per-run controller, NOT an event signal). The run stops at its next
 *  signal check and releases in its `finally`; this does NOT release the
 *  lock itself. No-op when idle. */
export function abortInFlight(key: string): void {
  const active = locks.get(key)?.active;
  if (active !== undefined && active !== null) {
    active.handle.abortController.abort();
  }
}

/** Resolve once the conversation's lock is idle. */
function waitForIdle(lock: LockState): Promise<void> {
  if (lock.active === null) return Promise.resolve();
  return new Promise<void>((resolve) => {
    lock.idleWaiters.push(resolve);
  });
}

/** Abort the conversation's in-flight run and AWAIT its actual release
 *  (the run unwinds at its next signal check and releases in its
 *  `finally`). No-op when idle. Safe alongside other idle waiters. */
export async function abortAndAwaitIdle(key: string): Promise<void> {
  const lock = lockFor(key);
  if (lock.active === null) return;
  abortInFlight(key);
  await waitForIdle(lock);
}

/** Resolve once the conversation's lock is idle — immediately for an idle or
 *  never-seen key (no map entry is created by the check). Teardown flows (the
 *  subagent-handoff eviction) use it so a resident state drops only after a
 *  still-draining stage run releases its hold. */
export function awaitIdle(key: string): Promise<void> {
  const lock = locks.get(key);
  if (lock === undefined || lock.active === null) return Promise.resolve();
  return waitForIdle(lock);
}

/** Compaction-exclusive acquire for the conversation (never skips): abort
 *  any in-flight background run at its next tool-call boundary, AWAIT its
 *  actual release, then acquire unconditionally and return a fresh handle
 *  (stage "select" — compaction runs observe/build/select sequentially
 *  under this single acquire). The compaction hook `await`s this and
 *  releases in its `finally`.
 *
 *  Precondition (inherited from pi's original structure): at most ONE
 *  compaction-class waiter per key at a time — the wake-all release
 *  resolves every queued waiter, so two concurrent compaction acquires on
 *  one key would both proceed and the second would clobber the first's
 *  hold. Pi's process never had two (one session, one compaction flow);
 *  the host preserves the same single-compaction-flow guarantee by
 *  construction — compaction is one flow per conversation, and the
 *  conversation's keyed run-lock serializes every other launcher. */
export async function acquireForCompaction(key: string): Promise<RunHandle> {
  const lock = lockFor(key);
  if (lock.active !== null) {
    abortInFlight(key);
    await waitForIdle(lock);
  }
  return makeHandle(lock, "select");
}

/** Production teardown (session.end): abort EVERY live run's own
 *  controller — the user's /exit cancels any in-flight compaction wait
 *  (the looped await_stage gate unwinds at its next signal check and
 *  settles; the takeover then degrades to a skip, never a stale answer).
 *  No-op when all idle; safe alongside the prune below. */
/** Abort ONE conversation's active run (the user-cancel wire: the engine's
 *  compaction dispatch aborts — the user pressed Esc — and the gate's
 *  controller must unwind that conversation's stages, exactly as session.end
 *  unwinds every conversation's). A key with no active run is a no-op. */
export function abortActiveFor(key: string): void {
  const lock = locks.get(key);
  if (lock === undefined) return;
  const active = lock.active;
  if (active !== null) active.handle.abortController.abort();
}

export function abortAllForSessionEnd(): void {
  for (const lock of locks.values()) {
    const active = lock.active;
    if (active !== null) active.handle.abortController.abort();
  }
}

/** Production teardown (session.end): drop every IDLE lock entry. A
 *  still-running chain's entry is KEPT — its later release clears that
 *  kept entry through the normal identity guard, exactly as without the
 *  prune. Returns the number of entries pruned. */
export function pruneIdleLocks(): number {
  let pruned = 0;
  for (const [key, lock] of locks) {
    if (lock.active === null && lock.idleWaiters.length === 0) {
      locks.delete(key);
      pruned += 1;
    }
  }
  return pruned;
}
