// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// The compaction gate's budget-free wait:
// the engine's per-dispatch hook budget is 10s and the clock stops only
// while a $ call of the hook is in flight (HookBudget's documented rule —
// "a minute-long $.model.complete costs it nothing"). Our ensure-ready
// phases wait for SPAWNED stage agents, and that wait is our own promise
// time: a long catch-up exceeds the 10s budget and the engine discards
// our answer (the native summary runs instead). Wrapping the phases in a $.tool.call to our own in-process
// tool keeps the clock paused for the entire stage wait.
//
// The tool (mcp__session-owl__await_stage): plugin-hosted tools are served
// as in-process "sdk" MCP servers — NO engine-side duration limit applies
// (MCP_TOOL_TIMEOUT defaults to ~28 hours; the idle timeout is disabled
// for sdk-type servers; the plugin $.tool.call schema carries no timeout
// parameter at all). A failed dispatch falls back to running the work
// inline — the budget risk returns, but the takeover is never broken.
import type { CompactionHookDeps } from "./hook.js";

/** The engine-facing tool name (the server prefix the dispatcher adds). */
export const AWAIT_STAGE_TOOL = "mcp__session-owl__await_stage";

/** The tool's registration spec — deferred (off the main prompt; only our
 *  own compact hook ever calls it, by full name). */
export function awaitStageToolSpec(): Record<string, unknown> {
  return {
    name: "await_stage",
    isDeferred: true,
    description:
      "Internal compaction gate: runs this conversation's prepared ensure-ready phases (observer catch-up + builder) to completion. Not for the model.",
    inputSchema: {
      type: "object",
      required: ["key"],
      properties: {
        key: {
          type: "string",
          description: "The conversation key the prepared work belongs to.",
        },
      },
    },
  };
}

/** The prepared ensure-ready work by conversation key (one-shot: the tool
 *  side takes it; a fallback dispatch re-takes nothing). */
const pendingWork = new Map<string, () => Promise<unknown>>();

/** Park the ensure-ready phases for the tool side to run. */
export function stageWorkCall<T>(key: string, work: () => Promise<T>): void {
  pendingWork.set(key, work as () => Promise<unknown>);
}

/** Take (and remove) the parked work; undefined when none is prepared. */
export function takeStageWork(key: string): (() => Promise<unknown>) | undefined {
  const work = pendingWork.get(key);
  pendingWork.delete(key);
  return work;
}

/** The STARTED run by conversation key: the first serving dispatch starts
 *  the parked work; later dispatches — the engine cut an earlier one at its
 *  ~10s per-call ceiling — JOIN the same in-flight run, so the work executes
 *  exactly once however many slices the wait takes. The record drops once
 *  the run settles. */
const liveRuns = new Map<string, { promise: Promise<void> }>();

/** The serving side of await_stage: start the parked work or join the run
 *  already in flight; resolves when the run settles (never rejects — the
 *  wrapper's own closure carries the verdict and the failure). Undefined
 *  when nothing is parked NOR running (a cold dispatch). */
export function joinStageRun(key: string): Promise<void> | undefined {
  const existing = liveRuns.get(key);
  if (existing !== undefined) return existing.promise;
  const work = takeStageWork(key);
  if (work === undefined) return undefined;
  const record: { promise: Promise<void> } = { promise: null as unknown as Promise<void> };
  record.promise = work().then(
    () => undefined,
    () => undefined, // the failure rides the wrapper's closure, never this channel
  );
  liveRuns.set(key, record);
  void record.promise.then(() => {
    if (liveRuns.get(key) === record) liveRuns.delete(key);
  });
  return record.promise;
}

/** The serving-side slice ceiling: the engine
 *  cuts a dispatch at its ~10s per-call ceiling, and a hook that keeps
 *  running after the cut's abort signal is reported as lingering after 5s
 *  — two consecutive reports name the plugin a runaway and the worker is
 *  respawned (session-owl unloaded in the hard severity: every armed
 *  structure dies mid-session). Serving a slice that RETURNS at 9s, before
 *  any signal fires, removes the trigger outright: the signal channel stays
 *  reserved for genuine termination (session end, an interrupt), which the
 *  gate's own abort plumbing handles. The run itself continues in-process
 *  (joinStageRun — single execution); the gate's loop re-dispatches exactly
 *  as it does for engine cuts. */
export const STAGE_SLICE_MS = 9000;

/** The serving side of await_stage, sliced: answers {done:false} at the
 *  slice boundary while the run continues detached, or {done:true} when the
 *  run settles inside the slice. An ABORT SIGNAL (the turn was interrupted
 *  — the engine grants 5s) answers {done:false, result:"aborted"} at once:
 *  the in-flight slice never holds the grace. Undefined for a cold key
 *  (the deny case). */
export function joinStageRunSliced(
  key: string,
  sliceMs: number = STAGE_SLICE_MS,
  signal?: AbortSignal,
): Promise<{ result: string; done: boolean }> | undefined {
  const run = joinStageRun(key);
  if (run === undefined) return undefined;
  return new Promise((resolve) => {
    let settledSlice = false;
    const finish = (answer: { result: string; done: boolean }) => {
      if (settledSlice) return;
      settledSlice = true;
      clearTimeout(timer);
      if (signal !== undefined && typeof signal.removeEventListener === "function") {
        signal.removeEventListener("abort", onAbort);
      }
      resolve(answer);
    };
    const timer = setTimeout(() => finish({ result: "slice", done: false }), sliceMs);
    const onAbort = () => finish({ result: "aborted", done: false });
    if (signal !== undefined && !signal.aborted && typeof signal.addEventListener === "function") {
      signal.addEventListener("abort", onAbort, { once: true });
    } else if (signal?.aborted === true) {
      onAbort();
      return;
    }
    void run.then(() => finish({ result: "done", done: true }));
  });
}

/** The compact hook's turn-interrupt grace: the
 *  engine aborts the turn on Esc and grants the hook 5 seconds to stop
 *  ("did not stop within 5s of the turn being interrupted" — then the hook
 *  is skipped and what is below runs). A gate whose granularity is one
 *  whole stage call can never unwind that fast, so the HOOK races the
 *  signal: on abort it fires the cancel wire (the gate's controller — the
 *  stages unwind detached, at their own signal checks) and returns pass
 *  immediately (the engine is skipping the hook anyway; its answer would
 *  be discarded). A takeover that settles or rejects before any abort
 *  passes through untouched (a rejection becomes pass — never surface a
 *  broken hook to a dispatch that already moved on). */
export async function raceTakeoverWithSignal<T extends { kind: string }>(
  takeover: Promise<T>,
  signal: AbortSignal | undefined,
  onCancel: (key: string) => void,
  key: string,
): Promise<T | { kind: "pass" }> {
  if (signal === undefined || signal.aborted) {
    if (signal?.aborted === true) onCancel(key);
    return takeover.then(
      (outcome) => outcome,
      () => ({ kind: "pass" }) as { kind: "pass" },
    );
  }
  return new Promise<T | { kind: "pass" }>((resolve) => {
    let settled = false;
    const onAbort = () => {
      if (settled) return;
      settled = true;
      try {
        onCancel(key);
      } catch {
        // the cancel wire is best-effort — the hook MUST return regardless
      }
      resolve({ kind: "pass" });
    };
    signal.addEventListener("abort", onAbort, { once: true });
    takeover.then(
      (outcome) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        resolve(outcome);
      },
      () => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        resolve({ kind: "pass" });
      },
    );
  });
}

/** The wrapper's named inputs (the register wiring binds them). */
export interface BudgetFreeDeps {
  /** The $.tool.call capsule (already validated at its literal call site —
   *  this helper never spells a $ call itself). */
  call: (tool: string, args: Record<string, unknown>) => Promise<unknown>;
  /** Says a failure (the no-silent-catch rule) before the inline fallback. */
  onError: (message: string, err: unknown) => void;
  /** The compaction dispatch's abort signal (next.signal): the user
   *  cancelled the compaction (Esc) — stop re-dispatching and settle the
   *  run in-process; the gate's own controller (wired to the same signal
   *  by the register) unwinds the stages on their next signal check. */
  signal?: AbortSignal;
  /** The queued-interrupt detector: a dispatch stalled past stallMs means
   *  the engine paused dispatching behind a queued user gesture (Esc
   *  serializes behind an in-flight hook on this engine build — the signal
   *  never aborts). Called with the conversation key so the wiring can
   *  abort the gate's controller and unwind the stages. */
  onStall?: (key: string) => void;
  /** The stall bail window (default 15s — 1.5 slices; a dispatch that
   *  cannot be serviced in that window is treated as a queued interrupt). */
  stallMs?: number;
}

/** Extend compaction deps with the budget-free wait: `viaToolCall` parks
 *  the work under the conversation key and rides the await_stage tool
 *  call — the hook-budget clock stays paused for the whole duration — and
 *  LOOPS the dispatch: the engine cuts a $.tool.call at its ~10s per-call
 *  ceiling (kind=timeout — the call resolves, the served run keeps going
 *  in-process), so one dispatch can never cover a long catch-up. Each cut
 *  slice re-dispatches (the run executes exactly once — joinStageRun);
 *  there is NO total cap (pi's gate waits however long the stages take;
 *  the user's exit cancels: session.end aborts the gate's controller and
 *  the stages unwind at their next signal check). A REFUSED dispatch (a
 *  rejection, not a cut) falls back to running the work inline — never
 *  broken. */
export function withBudgetFreeWait(
  deps: CompactionHookDeps,
  wiring: BudgetFreeDeps,
): CompactionHookDeps & { viaToolCall: <T>(work: () => Promise<T>) => Promise<T> } {
  return {
    ...deps,
    viaToolCall: async <T>(work: () => Promise<T>): Promise<T> => {
      // The work's verdict and failure are CAPTURED here (the tool result
      // channel is generic tool content — the closure assigns these,
      // whichever side ends up running it)
      let verdict: T | undefined;
      let failure: unknown;
      let settled = false;
      stageWorkCall(deps.key, async () => {
        try {
          verdict = await work();
        } catch (err) {
          failure = err;
        } finally {
          settled = true;
        }
      });
      const stallMs = wiring.stallMs ?? 15_000;
      for (;;) {
        if (wiring.signal?.aborted) {
          // the user cancelled the compaction: NO further dispatches — the
          // run settles in-process (started, or started now — the refusal
          // path's semantics; the gate's controller unwinds its stages)
          await joinStageRun(deps.key);
          break;
        }
        // the queued-interrupt race: a dispatch the engine will not service
        // (a user gesture queued behind the in-flight hook) must not hold
        // the gate hostage — bail, unwind, and let the hook return so the
        // engine processes the gesture. A REJECTION (sync throw or async
        // refusal) keeps its original semantics: the inline fallback.
        let refused: { refusal: unknown } | undefined;
        let dispatch: Promise<unknown>;
        try {
          dispatch = wiring.call(AWAIT_STAGE_TOOL, { key: deps.key });
        } catch (err) {
          refused = { refusal: err };
          dispatch = Promise.resolve();
        }
        let bailTimer: ReturnType<typeof setTimeout> | undefined;
        const raced = await Promise.race([
          dispatch.then(
            () => "answered" as const,
            (err: unknown) => ({ refusal: err }),
          ),
          new Promise<"stalled">((resolveStall) => {
            bailTimer = setTimeout(() => resolveStall("stalled"), stallMs);
          }),
        ]);
        if (bailTimer !== undefined) clearTimeout(bailTimer);
        const refusal =
          refused !== undefined
            ? refused.refusal
            : typeof raced === "object" && raced !== null
              ? (raced as { refusal: unknown }).refusal
              : undefined;
        if (raced === "stalled") {
          dispatch.catch((err: unknown) => {
            // the abandoned dispatch may reject after the bail — say it (the
            // stall already unwound the gate; this only explains the corpse)
            wiring.onError(
              "await_stage dispatch rejected after the stall bail (abandoned slice — the gate already unwound)",
              err,
            );
          });
          wiring.onError(
            `await_stage dispatch stalled past ${stallMs}ms — treating it as a queued user interrupt (Esc serializes behind the in-flight hook); unwinding the gate`,
            new Error("stalled dispatch"),
          );
          wiring.onStall?.(deps.key);
          await joinStageRun(deps.key); // start-or-join; the aborted controller unwinds the stages
          break;
        }
        if (refusal !== undefined && (typeof raced === "object" || refused !== undefined)) {
          wiring.onError(
            `await_stage tool call failed — running the compaction's prepare inline (the 10s hook-budget risk returns for this dispatch)`,
            refusal,
          );
          await joinStageRun(deps.key); // start it here (the refusal path) or join the live run
          break;
        }
        if (settled) break;
        // the engine cut this slice at its ~10s ceiling — the run continues
        // in-process; dispatch the next slice to keep the clock paused
      }
      if (!settled) {
        throw new Error("the ensure-ready run never settled (dispatch refused, no run started)");
      }
      if (failure !== undefined) throw failure; // the gate's catch turns this into skipFailed(reason)
      return verdict as T;
    },
  };
}
