// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import { log } from "../log.js";
import { currentConversationKey } from "./conversation-key.js";

// The per-conversation run-locks (one lock state per conversation; one stage
// active per key; triggers await). At most one of {Observer, Builder, Selector}
// is active AT A TIME FOR ITS OWN CONVERSATION — conversations hold their locks
// independently (the in-process-subagent capability). Background triggers that
// collide SKIP (fire-and-forget) — and the skipped evaluation arms
// ONE coalesced re-entry (the gap) that the holder's own release fires on the
// next microtask (Promise-based; never inside the release call itself); pi's
// session-level agent settle events cannot observe this fire-and-forget chain,
// so the chain's own release is the settle point.
// Compaction is
// EXCLUSIVE — it aborts an in-flight background run via its OWN abort controller
// (NOT event.signal), awaits the run's actual release, then
// acquires unconditionally.
//
// Each run owns its own AbortController so compaction can cancel it at the next
// tool-call boundary (the run honors `signal`; release stays in the run's
// `finally`). A handle CAPTURES its own lock state at acquire, so a later key
// flip never redirects a release or rearm to another conversation. pi never
// activates a key ⇒ exactly one state (the default key): today's behavior.
//
// Idle waiters (compaction, /tree branch navigation) queue in a LIST per key:
// several flows may wait for the same run to unwind concurrently, and every one
// of them is resolved on release — a single waiter slot would silently drop all
// but the last, hanging its caller forever.

/** The maintenance stages serialized by the run-lock. `extract` is the
 *  goal-extraction one-shot: it takes the lock so a same-tick turn_end
 *  trigger SKIPs until the goal settles (the goal-first sequencing rule). */
export type StageName = "observe" | "build" | "select" | "extract";

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
  /** Update the stage label mid-run (a chained turn_end run observes, then
   *  builds, then selects under a single acquire). */
  setStage: (stage: StageName) => void;
}

interface ActiveRun {
  stage: StageName;
  handle: RunHandle;
  released: boolean;
}

/** One conversation's lock state: its in-flight run, its idle waiters, and
 *  its armed gap. Keyed by the conversation key at CALL time (handles keep
 *  their own state across later flips). */
interface LockState {
  active: ActiveRun | null;
  idleWaiters: Array<() => void>;
  pendingRearm: (() => void) | null;
}

const lockStates = new Map<string, LockState>();

function lockStateFor(key: string): LockState {
  let state = lockStates.get(key);
  if (state === undefined) {
    state = { active: null, idleWaiters: [], pendingRearm: null };
    lockStates.set(key, state);
  }
  return state;
}

/** The state belonging to the conversation the process currently serves. */
function activeState(): LockState {
  return lockStateFor(currentConversationKey());
}

/** Arm the gap's re-entry: fired by the holder's own successful release, on the
 * next microtask, once, after the lock has cleared. */
export function armRearmOnRelease(reenter: () => void): void {
  activeState().pendingRearm = reenter;
}

/** Test-only: reset every conversation's lock state to idle (no runs, no
 *  waiters, no arms). */
export function _resetRunLock(): void {
  lockStates.clear();
}

/** Whether a run is currently in flight (for the ACTIVE conversation). */
export function inFlight(): boolean {
  return activeState().active !== null;
}

/** The currently-active stage of the ACTIVE conversation, or null when idle. */
export function current(): StageName | null {
  const active = activeState().active;
  return active === null ? null : active.stage;
}

function makeHandle(state: LockState, stage: StageName): RunHandle {
  const run: ActiveRun = {
    stage,
    handle: {
      release: () => releaseActive(state, run),
      abortController: new AbortController(),
      setStage: (next: StageName) => {
        if (state.active === run) state.active.stage = next;
      },
    },
    released: false,
  };
  state.active = run;
  return run.handle;
}

/** Release the active run (called from the handle's `release`). Idempotent. */
function releaseActive(state: LockState, run: ActiveRun): void {
  if (run.released) return;
  run.released = true;
  if (state.active === run) {
    state.active = null;
    // wake EVERY idle waiter (any number may queue concurrently — compaction,
    // branch navigation — each resolves so no flow is dropped)
    const waiters = state.idleWaiters.splice(0, state.idleWaiters.length);
    for (const waiter of waiters) waiter();
    // the armed gap: deleted BEFORE dispatch (one attempt per release), fired
    // on a Promise microtask so it never re-enters inside this call; an ABORTED
    // holder drops it (the flow that aborted it owns the next evaluation)
    const reenter = state.pendingRearm;
    if (reenter !== null) {
      state.pendingRearm = null;
      if (run.handle.abortController.signal.aborted) {
        log.debug("settle-rearm dropped — the holder was aborted");
      } else {
        void Promise.resolve().then(() => {
          try {
            reenter();
          } catch (err) {
            log.error("settle-rearm failed", err);
          }
        });
      }
    }
  }
}

/**
 * Goal-extraction acquire (the goal-first sequencing rule). SYNCHRONOUS when
 * idle — the capture fires this from its first statements (before any await),
 * so the capture's trailing turn_end trigger, evaluated in the same tick, sees
 * the holder and SKIPs. Returns null when a run already holds the lock: the
 * extraction then runs WITHOUT contending — the holder (the reuse rebuild's
 * compaction-class hold, or a background run) already excludes every stage,
 * and waiting here would deadlock against the holder's release while a rescan
 * flow awaits the extraction's settle on the other side.
 */
export function acquireForExtract(): RunHandle | null {
  const state = activeState();
  return state.active === null ? makeHandle(state, "extract") : null;
}

/**
 * Background-trigger acquire: return a handle when idle, or null (SKIP) when a run
 * is already in flight (the handler returns immediately; the skipped
 * evaluation arms one coalesced re-entry, fired on this run's release).
 */
export function acquireOrSkip(stage: StageName): RunHandle | null {
  const state = activeState();
  return state.active === null ? makeHandle(state, stage) : null;
}

/**
 * Abort the in-flight run's OWN abort controller (session-owl's
 * per-run controller, NOT event.signal) for the ACTIVE conversation. The run
 * stops at its next tool-call boundary and releases in its `finally`; this does
 * NOT release the lock itself. No-op when idle.
 */
export function abortInFlight(): void {
  const active = activeState().active;
  if (active !== null) {
    active.handle.abortController.abort();
  }
}

/**
 * Abort any in-flight run and AWAIT its actual release (the run unwinds at its
 * next signal check and releases in its `finally`). For host-driven state
 * swaps that must not race a run's trailing persists (a `/tree` branch switch
 * re-derives the store for the new branch — an in-flight chunk persisting
 * against the swapped-out graph state would write stale ids into it). No-op
 * when idle. Safe alongside other idle waiters (a concurrently waiting
 * compaction is resolved too — see the waiter list in `releaseActive`).
 */
export async function abortAndAwaitIdle(): Promise<void> {
  const state = activeState();
  if (state.active === null) return;
  state.active.handle.abortController.abort();
  await waitForStateIdle(state);
}

/** Resolve once the given conversation's lock is idle (released by
 *  `releaseActive` via the waiters). */
function waitForStateIdle(state: LockState): Promise<void> {
  if (state.active === null) return Promise.resolve();
  return new Promise<void>((resolve) => {
    state.idleWaiters.push(resolve);
  });
}

/**
 * Compaction-exclusive acquire (never skips): abort any in-flight background run
 * at its next tool-call boundary, AWAIT its actual release, then
 * acquire unconditionally and return a fresh handle (stage "select" — compaction
 * runs observe/build/select sequentially under this single acquire). The compaction
 * hook `await`s this and releases in its `finally`.
 */
export async function acquireForCompaction(): Promise<RunHandle> {
  const state = activeState();
  if (state.active !== null) {
    state.active.handle.abortController.abort();
    await waitForStateIdle(state);
  }
  return makeHandle(state, "select");
}
