// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// The goal-extract run — HOST PORT of src/goal-extract/run.ts's orchestration
// profile. The LLM call itself is an INJECTED one-shot completer (the
// trigger wiring maps it onto $.model.complete: one shot, no tools, no
// history, background, abortable); everything else is pi's profile verbatim
// except the knob swaps: the output cap rides the OBSERVER
// tokens knob (observerMaxTokens) and the effort rides the observer
// thinking-level ladder; takes stage "extract" on the run-lock when the
// conversation is idle (a same-queue boundary evaluation skips until the goal
// settles; under an existing holder it runs un-locked under that holder's
// authority — the goal-first sequencing rule), no widget stage, don't-clobber
// guard,
// one atomic applySetMeta + delta append, never throws (log + Builder
// backstop), usage ignored (pi folds none), and a per-conversation abort
// controller so a shutdown (or a second launch) stops the prior extraction.

import type { SessionOwlConfig } from "../../core/src/config/schema.js";
import { stripAnsi } from "../../core/src/format/sanitize.js";
import { applySetMeta, MUTATE_SOURCE } from "../../core/src/graph/mutations.js";
import { GOAL_EXTRACT_SYSTEM } from "../../core/src/prompts/goal-extract.js";
import type { StoreContext } from "../../core/src/store/graph-store.js";
import { N_GOAL } from "../../core/src/types.js";
import { reassertCore } from "../core-instances.js";
import {
  appendDump,
  appendHeaderDurable,
  flushRunDump,
  openStageDump,
  type StageDumpLocation,
  stageDumpHeader,
} from "../dumps/module.js";
import { effortFromThinking } from "../stage/agents.js";
import type { RunHandle } from "../triggers/run-locks.js";
import { runsLog, type StageCore, type StageWidget } from "./seams.js";

// --- named constants -------------------------------------------------------

/** Generous cap for a one-line reply (no thinking tokens to consume it). */

const EMPTY_SUMMARY = "";

// --- the completer seam -----------------------------------------------------

/** The one-shot completer the trigger wiring maps onto `$.model.complete`: one
 *  call, no tools, no history; abortable; the reply text resolves.  */
export interface GoalCompleterInput {
  /** The full prompt: the goal-extract system prompt + the verbatim text. */
  prompt: string;
  /** The extraction's abort signal (its conversation's controller). */
  signal: AbortSignal | undefined;
  /** The one-shot output cap (the OBSERVER tokens knob). */
  maxTokens: number;
  /** The effort level (the observer thinking ladder); undefined = omit. */
  effort?: string;
  /** The per-call timeout (llmCallTimeoutMs), or null = none. */
  timeoutMs: number | null;
}

/** Input to `runGoalExtract`. Honors the keyed abort; `lock` is the
 *  launch site's SYNCHRONOUS acquire (see `runGoalExtract`). */
/** The goal call's effort: the OBSERVER thinking-level ladder (the goal
 *  rides the observer's knobs), stage level → default → omitted. */
function goalEffort(settings: SessionOwlConfig): string | undefined {
  return effortFromThinking(settings.observerThinkingLevel ?? settings.defaultThinkingLevel);
}

export interface GoalExtractInput {
  core: StageCore;
  store: StoreContext;
  settings: SessionOwlConfig;
  /** The widget: re-renders once the set_meta lands. */
  widget: StageWidget;
  /** The verbatim initial user message (oInitialPrompt.summary). */
  verbatimText: string;
  /** The injected one-shot completer (the $.model.complete mapping). */
  completer: (input: GoalCompleterInput) => Promise<string>;
  /** The stage-dump seam (null/undefined = no dump — debugDumpLimit 0). */
  dumps?: StageDumpLocation | null;
  /** The pre-acquired run-lock (stage `extract`) — taken by the launch site
   *  synchronously before its first await (the goal-first sequencing rule).
   *  Null/omitted = runs under an existing holder's authority. */
  lock?: RunHandle | null;
  /** The ledger durability seam — awaited right after the append so the goal
   *  delta is ON DISK at persist time (the stage-run crash-window contract);
   *  absent in tests that assert buffering itself. */
  flushLedger?: () => Promise<void>;
}

/** The in-flight extraction's abort controllers, keyed by conversation
 *  (core.key) — pi's module singleton is safe only because pi runs one
 *  session per process; one host process serves MANY conversations, so each
 *  conversation owns its own slot (a second launch on the same conversation
 *  aborts its prior run; other conversations are untouched). */
const activeByKey = new Map<string, AbortController>();

/** Abort the in-flight extraction: one conversation (`key`), or every
 *  conversation when keyless (session shutdown / process teardown). */
export function abortGoalExtract(key?: string): void {
  if (key === undefined) {
    for (const controller of activeByKey.values()) controller.abort();
    activeByKey.clear();
    return;
  }
  const controller = activeByKey.get(key);
  if (controller !== undefined) {
    controller.abort();
    activeByKey.delete(key);
  }
}

/** Test-only: reset every slot to idle. */
export function _resetGoalExtractRun(): void {
  activeByKey.clear();
  inflightByKey.clear();
}

/** The in-flight extraction promises, keyed by conversation (one host process
 *  serves MANY conversations — pi's module singleton maps to a keyed slot).
 *  Rescan and catch-up flows await them — via `goalExtractSettled` — BEFORE
 *  acquiring the run-lock: never hold the lock while awaiting an extraction
 *  (the no-deadlock order); the settle includes the run-lock release. */
const inflightByKey = new Map<string, Promise<void>>();

/** Resolve once every in-flight extraction settles (immediately when none). */
export function goalExtractSettled(): Promise<void> {
  if (inflightByKey.size === 0) return Promise.resolve();
  return Promise.all([...inflightByKey.values()]).then(() => undefined);
}

/** Test seam — mark an extraction as in flight (drives `goalExtractSettled`). */
export function _setGoalExtractInFlightForTest(key: string, promise: Promise<void> | null): void {
  if (promise === null) inflightByKey.delete(key);
  else inflightByKey.set(key, promise);
}

/**
 * Run the goal extraction: ask the completer for a one-line goal from the
 * verbatim initial prompt and — when a non-empty line comes back and
 * nGoal.summary is still empty — set_meta it (applied + persisted atomically,
 * widget re-render). On any failure the summary stays empty (the Builder is
 * the backstop). Never throws — logs.
 *
 * One extraction per conversation at a time: a second fire waits for the
 * first to settle, never two concurrent runs racing the keyed `active` slot.
 * The `lock` (stage `extract`) is the launch site's synchronous acquire — see
 * `executeGoalExtract`.
 */
export function runGoalExtract(input: GoalExtractInput): Promise<void> {
  const key = input.core.key;
  const start = async (): Promise<void> => {
    const prior = inflightByKey.get(key);
    if (prior !== undefined) await prior;
    return executeGoalExtract(input);
  };
  const current = start();
  inflightByKey.set(key, current);
  const clear = (): void => {
    if (inflightByKey.get(key) === current) inflightByKey.delete(key);
  };
  void current.then(clear, clear);
  return current;
}

async function executeGoalExtract(input: GoalExtractInput): Promise<void> {
  // the run-lock (the goal-first sequencing rule): the launch site's
  // synchronous acquire, bound here — release/abort-link ride the finally.
  const lock = input.lock ?? null;
  // Abort any prior extraction on THIS conversation (never two at once).
  const key = input.core.key;
  const prior = activeByKey.get(key);
  if (prior !== undefined) prior.abort();
  const controller = new AbortController();
  activeByKey.set(key, controller);
  // Compaction/shutdown aborts through the LOCK handle (abortInFlight aborts
  // the holder's controller): the one-shot dies too; release rides the finally.
  if (lock !== null) {
    if (lock.abortController.signal.aborted) controller.abort();
    else lock.abortController.signal.addEventListener("abort", () => controller.abort(), { once: true });
  }
  // the one-shot stage dump (toolless: the header + input land PRE-CALL; the
  // reply row + footer only when a usable goal exists)
  const dumpHandle =
    input.dumps !== undefined && input.dumps !== null && (input.settings.debugDumpLimit ?? 0) > 0
      ? openStageDump("goal-extract", input.settings.debugDumpLimit, { ...input.dumps, now: Date.now() })
      : null;
  try {
    // Re-pin BEFORE the abort check: the swap yield is a window where a
    // compaction/shutdown abort can land (its listener above already ran) —
    // re-checking right after the yield keeps the one-shot responsive, and
    // the completer is only ever armed while non-aborted.
    await reassertCore(input.core.key);
    if (controller.signal.aborted) return;

    // Don't-clobber runs BEFORE the call: once the Builder (or a prior run)
    // set nGoal.summary, there is nothing to extract.
    const graph = input.core.store.getGraphStore().graph;
    if ((graph.nodes.get(N_GOAL)?.summary ?? "") !== EMPTY_SUMMARY) return;

    if (dumpHandle !== null && input.dumps !== undefined && input.dumps !== null) {
      // the header + input PRE-CALL (pi's durability: a one-shot that dies
      // still leaves its input record)
      try {
        const placed = await appendHeaderDurable(
          input.dumps.fs,
          dumpHandle,
          stageDumpHeader("goal-extract", dumpHandle.startedIso, GOAL_EXTRACT_SYSTEM, [], {
            session: dumpHandle.session,
            agent: dumpHandle.agent,
          }),
        );
        if (!placed) runsLog("goal-extract dump header not placed after retry");
        await appendDump(input.dumps.fs, dumpHandle, `<input>\n${input.verbatimText}\n</input>\n`);
      } catch (dumpErr) {
        runsLog("goal extract dump pre-call append failed", dumpErr);
      }
    }
    const reply = await input.completer({
      prompt: `${GOAL_EXTRACT_SYSTEM}\n\n${input.verbatimText}`,
      signal: controller.signal,
      maxTokens: input.settings.observerMaxTokens,
      timeoutMs: input.settings.llmCallTimeoutMs,
      effort: goalEffort(input.settings),
    });
    if (controller.signal.aborted) return;

    const goal = stripAnsi(reply).trim();
    if (goal.length === 0) return; // nothing usable → leave empty (Builder backstop)
    if (dumpHandle !== null && input.dumps !== undefined && input.dumps !== null) {
      try {
        // the reply row + the footer (header + input landed pre-call)
        await flushRunDump(input.dumps.fs, dumpHandle, {
          inputs: [],
          sections: [],
          outputRows: [goal],
          handback: null,
          fabricatedStop: null,
        });
      } catch (dumpErr) {
        runsLog("goal extract dump flush failed", dumpErr);
      }
    }

    // Re-check the guard after the await: the Builder may have set the
    // summary while the extraction was in flight.
    if ((graph.nodes.get(N_GOAL)?.summary ?? "") !== EMPTY_SUMMARY) return;

    const delta = applySetMeta(
      graph,
      { nodeId: N_GOAL, importance: null, archived: null, obsolete: null, summary: goal },
      MUTATE_SOURCE,
    );
    input.core.store.appendGraphDelta(input.store, delta);
    if (input.flushLedger !== undefined) await input.flushLedger(); // the goal delta is durable now
    input.widget.render();
  } catch (cause) {
    // Never throw: a fire-and-forget one-shot must not surface a stage error.
    runsLog("goal extract run failed", cause);
  } finally {
    if (lock !== null) lock.release();
    if (activeByKey.get(key) === controller) activeByKey.delete(key);
  }
}
