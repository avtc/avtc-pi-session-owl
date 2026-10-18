// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// The Goal-extract run: a one-shot LLM call fired at first oInitialPrompt
// capture that distills the verbatim initial user message into a concise goal
// line for nGoal.summary. Fire-and-forget from captureInitialPromptAndExtract
// (lifecycle). oInitialPrompt itself stays verbatim (the ground-truth record);
// only nGoal.summary is set here. On any failure or abort the summary stays
// empty — the Builder is the backstop (it refines/sets the goal as the session
// matures).
//
// When the run-lock is idle it is taken (stage "extract") so the capture's
// same-tick turn_end trigger SKIPs until the goal lands (the goal-first stage
// sequencing); when a holder already exists — the reuse rebuild fires this
// under its own compaction-class hold — it runs un-locked under that holder's
// authority (waiting would deadlock against the holder's release while a
// rescan awaits the extraction's settle on the other side). Opens NO widget
// stage: a one-shot, not a multi-pass/multi-chunk maintenance stage. A
// module-level AbortController is aborted on session shutdown so a discarded
// session's pending extraction stops.

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { CacheRetention } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { SessionOwlConfig } from "../config/schema.js";
import { appendDump, DEFAULT_DUMP_BASE, DUMP_FOOTER, NO_DUMP, openStageDump, stageDumpHeader } from "../debug-dump.js";
import { stripAnsi } from "../format/sanitize.js";
import { applySetMeta, MUTATE_SOURCE } from "../graph/mutations.js";
import { log } from "../log.js";
import { GOAL_EXTRACT_SYSTEM } from "../prompts/goal-extract.js";
import {
  NO_EVENT_SINK,
  NO_LOOP_OVERRIDE,
  NO_STAGE_END_HOOK,
  runStage,
  type StageRunInput,
  type StageRunResult,
} from "../runtime/agent-loop.js";
import { resolveStageModel, resolveStageReasoning } from "../runtime/model.js";
import { acquireForExtract } from "../runtime/run-lock.js";
import { appendGraphDelta, getGraphStore, type StoreContext } from "../store/graph-store.js";
import { N_GOAL } from "../types.js";
import type { WidgetController } from "../widget/tracker.js";

// --- named constants (no bare literals at call sites) ----------------------

/** One turn: the model replies once (no tools), then the loop stops. */
const GOAL_MAX_TURNS = 1;
/* Output cap + thinking level: the goal call rides the OBSERVER's knobs —
 *  settings.observerMaxTokens for the cap and the observer thinking-level
 *  ladder for reasoning (a one-line goal needs no deliberation by default;
 *  the knobs decide, not literals). */
/** One-shot extraction: its prefix never recurs, so disable prompt-cache writes
 *  (no wasted cache write that is never read). No session-affinity id either. */
const GOAL_CACHE_RETENTION: CacheRetention = "none";
/** Stage-dump label for the goal-extract one-shot (no widget stage — the run
 *  is fire-and-forget and invisible; the dump is its only trace). */
const GOAL_DUMP_STAGE = "goal-extract";

/** Input to `runGoalExtract`. The run honors its own abort controller (aborted
 *  on shutdown); with an idle run-lock it holds stage "extract" until it
 *  settles (see `extractionSettled`). */
export interface GoalExtractInput {
  ctx: ExtensionContext;
  settings: SessionOwlConfig;
  /** The store (built by the caller via `toStoreContext`) — keeps this module
   *  free of a lifecycle import (no import cycle). */
  store: StoreContext;
  /** The widget: forwards streaming events during the call and re-renders once
   *  the set_meta lands. */
  widget: WidgetController;
  /** The verbatim initial user message (oInitialPrompt.summary). */
  verbatimText: string;
  /** Test seam — fake stage runner, or omitted for the real `runStage`. */
  runStageFn?: (input: StageRunInput) => Promise<StageRunResult>;
}

/** The in-flight extraction's abort controller (module singleton), aborted on
 *  shutdown. Null when idle. */
let active: AbortController | null = null;

/** Abort the in-flight extraction (session shutdown). No-op when idle. */
export function abortGoalExtract(): void {
  if (active !== null) active.abort();
}

/** Test-only: reset the singleton to idle (test isolation). */
export function _resetGoalExtract(): void {
  active = null;
  inflight = null;
}

/** The in-flight extraction's promise (settle includes the run-lock release).
 *  Rescan and catch-up flows await it — via `extractionSettled` — BEFORE
 *  acquiring the run-lock: never hold the lock while awaiting an extraction
 *  (the no-deadlock order). */
let inflight: Promise<void> | null = null;

/** Resolve once the in-flight extraction settles (or immediately when none is
 *  pending). */
export function extractionSettled(): Promise<void> {
  return inflight ?? Promise.resolve();
}

/** Test seam — mark an extraction as in flight (drives `extractionSettled`). */
export function _setGoalExtractInFlightForTest(promise: Promise<void> | null): void {
  inflight = promise;
}

/**
 * Run the goal extraction: resolve the default model, ask it for a one-line goal
 * from the verbatim initial prompt, and — when a non-empty line comes back and
 * nGoal.summary is still empty — set_meta it (persisted + rendered). On any
 * failure (model unavailable, timeout, abort, empty reply) the summary stays
 * empty; the Builder backstop refines/sets it later. Never throws — logs.
 *
 * One extraction at a time: a second fire waits for the first to settle, never
 * two concurrent runs racing the `active` controller. The run-lock is taken in
 * the synchronous prefix (see `executeGoalExtract`) — before any await — so the
 * capture's trailing turn_end trigger, evaluated later in the same tick, sees
 * the holder and SKIPs.
 */
export function runGoalExtract(input: GoalExtractInput): Promise<void> {
  const current = (async () => {
    if (inflight !== null) await inflight;
    return executeGoalExtract(input);
  })();
  inflight = current;
  const clear = (): void => {
    if (inflight === current) inflight = null;
  };
  void current.then(clear, clear);
  return current;
}

async function executeGoalExtract(input: GoalExtractInput): Promise<void> {
  // The run-lock (the goal-first sequencing rule): taken HERE — in the sync
  // prefix, before the first await — so the same-tick trailing trigger skips.
  // Null = a holder already exists: run under its authority (never wait — a
  // rescan flow holding that holder awaits this extraction's settle).
  const lock = acquireForExtract();
  // Abort any prior extraction (defensive — capture is one-shot, so a prior in
  // flight is unexpected; still, never run two at once).
  if (active !== null) active.abort();
  const controller = new AbortController();
  active = controller;
  // Compaction/shutdown aborts through the LOCK handle (abortInFlight aborts
  // the holder's controller): the one-shot dies too; release rides the finally.
  if (lock !== null) {
    if (lock.abortController.signal.aborted) controller.abort();
    else lock.abortController.signal.addEventListener("abort", () => controller.abort(), { once: true });
  }
  // Stage dump (debugDumpLimit): opened inside the try after the skips (an
  // aborted / model-gap one-shot leaves no file); the footer closes it in the
  // finally.
  let dumpPath: string | null = NO_DUMP;
  let dumpHeaderWritten = false;
  try {
    if (controller.signal.aborted) return;

    // Model resolution rides the OBSERVER's chain (the extractor's
    // model resolves exactly as observerModel does — stage setting → default
    // model → session). A fire-and-forget one-shot's model gap is invisible to
    // the user and covered by the Builder backstop, so it logs (no user
    // notification — that would be noise for a background best-effort call).
    const resolved = await resolveStageModel(input.ctx, input.settings.observerModel ?? input.settings.defaultModel);
    if (!resolved.ok) {
      log.warn(`goal extract skipped: ${resolved.error}`);
      return;
    }
    if (controller.signal.aborted) return;

    dumpPath = openStageDump(GOAL_DUMP_STAGE, input.settings.debugDumpLimit, DEFAULT_DUMP_BASE);
    if (dumpPath !== null) {
      appendDump(dumpPath, stageDumpHeader(GOAL_DUMP_STAGE, new Date().toISOString(), GOAL_EXTRACT_SYSTEM, []));
      dumpHeaderWritten = true;
    }
    const run = input.runStageFn ?? runStage;
    const result = await run({
      systemPrompt: GOAL_EXTRACT_SYSTEM,
      messages: [{ role: "user", content: input.verbatimText } as AgentMessage],
      tools: [],
      model: resolved.model,
      apiKey: resolved.apiKey,
      signal: controller.signal,
      reasoning: resolveStageReasoning(
        input.settings.observerThinkingLevel,
        input.settings.defaultThinkingLevel,
        input.ctx.thinkingLevel,
      ),
      maxTurns: GOAL_MAX_TURNS,
      maxTokens: input.settings.observerMaxTokens,
      timeoutMs: input.settings.llmCallTimeoutMs,
      onEvent: NO_EVENT_SINK,
      onStageEnd: NO_STAGE_END_HOOK,
      loopFn: NO_LOOP_OVERRIDE,
      // One-shot: the prefix never recurs, so skip cache writes (and no affinity id).
      cacheRetention: GOAL_CACHE_RETENTION,
      dumpPath,
    });
    if (result.aborted) return;

    const goal = stripAnsi(lastAssistantText(result.messages)).trim();
    if (goal.length === 0) return; // nothing usable → leave empty (Builder backstop)

    // Don't clobber: once the Builder (or a prior run) set nGoal.summary, a
    // late-arriving extraction must not overwrite it.
    const graph = getGraphStore().graph;
    if ((graph.nodes.get(N_GOAL)?.summary ?? "") !== "") return;

    const delta = applySetMeta(
      graph,
      { nodeId: N_GOAL, importance: null, archived: null, obsolete: null, summary: goal },
      MUTATE_SOURCE,
    );
    appendGraphDelta(input.store, delta);
    input.widget.render();
  } catch (cause) {
    // Never throw: a fire-and-forget one-shot must not surface a stage error
    // (the Builder backstop covers an empty summary). Log and move on.
    log.error("goal extract run failed", cause);
  } finally {
    if (dumpHeaderWritten) appendDump(dumpPath, DUMP_FOOTER);
    if (lock !== null) lock.release();
    if (active === controller) active = null;
  }
}

/** Extract the text of the last assistant message in an agentLoop result
 *  (string content or TextContent[] parts). Empty when there is none. */
function lastAssistantText(messages: readonly AgentMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const msg = messages[i] as { role?: string; content?: unknown } | undefined;
    if (msg === undefined || msg.role !== "assistant") continue;
    const content = msg.content;
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
      return content
        .filter(
          (p): p is { type: "text"; text: string } =>
            typeof p === "object" && p !== null && (p as { type?: string }).type === "text",
        )
        .map((p) => p.text)
        .join("");
    }
    return "";
  }
  return "";
}
