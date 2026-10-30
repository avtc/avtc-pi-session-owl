// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// The recall serve's budget-free lane: the engine's per-dispatch hook
// budget is ~10s and the clock stops only while an engine-served $ call is
// in flight — so a serve that may run long parks its work under a stage
// key and rides the await_stage dispatch loop ($.tool.call to our own
// in-process sdk tool: no engine-side duration limit, 9s slices answer
// before the per-call ceiling, no linger, no worker respawn). The loop
// returns the parked work's value when a dispatch reports done; a denied
// dispatch (the tool side cold) runs the work inline — the budget risk
// returns for that one call, but the serve is never broken.

/** The lane's outcome: the work's value, or the interrupted marker (an
 *  aborted slice — the engine is skipping the hook anyway). */
export type StageLaneOutcome<T> = T | { interrupted: true };

export interface StageLaneDeps<W> {
  /** Park the work under the key (the tool side takes it on the first
   *  dispatch). */
  park: (key: string, work: () => Promise<W>) => void;
  /** The work itself — also started by the fallback path. */
  startWork: () => Promise<W>;
  /** One await_stage dispatch ($.tool.call — engine-served, budget-frozen).
   *  Resolves the slice answer, or a {deny} when the tool side refuses. */
  dispatch: () => Promise<{ result?: unknown; done?: unknown } | { deny: string }>;
  /** The dispatch-loop abort wire (the hook's signal). */
  signal?: AbortSignal | undefined;
  /** The slice answer's abort marker text. */
  sliceAbortResult: string;
  /** The stage key (unique per call). */
  key: string;
}

/** Serve through the stage lane: park, loop dispatches, return the value. */
export async function serveViaStageLane<W>(deps: StageLaneDeps<W>): Promise<StageLaneOutcome<W>> {
  let value: W | undefined;
  let settled = false;
  let resolveWork: () => void = () => {};
  const workDone = new Promise<void>((resolve) => {
    resolveWork = resolve;
  });
  const work = async (): Promise<W> => {
    const v = await deps.startWork();
    value = v;
    settled = true;
    resolveWork();
    return v;
  };
  deps.park(deps.key, work);
  for (;;) {
    if (deps.signal?.aborted === true) return { interrupted: true };
    let answer: { result?: unknown; done?: unknown } | { deny: string };
    try {
      answer = await deps.dispatch();
    } catch {
      answer = { deny: "dispatch threw" };
    }
    if ("deny" in answer) {
      // the tool side never took the work — run it inline (one call's
      // budget risk; the serve is never broken)
      await work();
      return value as W;
    }
    if (answer.result === deps.sliceAbortResult) return { interrupted: true };
    if (answer.done === true) {
      if (!settled) await workDone; // the slice race: done landed before the value
      return value as W;
    }
    // a slice boundary — loop (each dispatch re-freezes the budget clock)
  }
}
