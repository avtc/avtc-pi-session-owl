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
// Owns NO run-lock and opens NO widget stage: a sub-second one-shot, not a
// multi-pass/multi-chunk maintenance stage. A module-level AbortController is
// aborted on session shutdown so a discarded session's pending extraction stops.

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { CacheRetention } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { MemkeeperConfig } from "../config/schema.js";
import { stripAnsi } from "../format/sanitize.js";
import { applySetMeta, MUTATE_SOURCE } from "../graph/mutations.js";
import { log } from "../log.js";
import { GOAL_EXTRACT_SYSTEM } from "../prompts/goal-extract.js";
import {
  NO_EVENT_SINK,
  NO_LOOP_OVERRIDE,
  NO_REASONING,
  NO_STAGE_END_HOOK,
  runStage,
  type StageRunInput,
  type StageRunResult,
} from "../runtime/agent-loop.js";
import { resolveStageModel } from "../runtime/model.js";
import { appendGraphDelta, getGraphStore, type StoreContext } from "../store/graph-store.js";
import { N_GOAL } from "../types.js";
import type { WidgetController } from "../widget/tracker.js";

// --- named constants (no bare literals at call sites) ----------------------

/** A one-line goal needs no deliberation: disable thinking so the call is fast,
 *  cheap, and never truncated by a thinking budget eating the output cap. */
const GOAL_REASONING = NO_REASONING;
/** One turn: the model replies once (no tools), then the loop stops. */
const GOAL_MAX_TURNS = 1;
/** Generous cap for a one-line reply (no thinking tokens to consume it). */
const GOAL_MAX_TOKENS = 512;
/** One-shot extraction: its prefix never recurs, so disable prompt-cache writes
 *  (no wasted cache write that is never read). No session-affinity id either. */
const GOAL_CACHE_RETENTION: CacheRetention = "none";

/** Input to `runGoalExtract`. The run honors its own abort controller (aborted
 *  on shutdown); it takes no run-lock. */
export interface GoalExtractInput {
  ctx: ExtensionContext;
  settings: MemkeeperConfig;
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
}

/**
 * Run the goal extraction: resolve the default model, ask it for a one-line goal
 * from the verbatim initial prompt, and — when a non-empty line comes back and
 * nGoal.summary is still empty — set_meta it (persisted + rendered). On any
 * failure (model unavailable, timeout, abort, empty reply) the summary stays
 * empty; the Builder backstop refines/sets it later. Never throws — logs.
 */
export async function runGoalExtract(input: GoalExtractInput): Promise<void> {
  // Abort any prior extraction (defensive — capture is one-shot, so a prior in
  // flight is unexpected; still, never run two at once).
  if (active !== null) active.abort();
  const controller = new AbortController();
  active = controller;
  try {
    if (controller.signal.aborted) return;

    // Model resolution uses the default model (null → session model). A
    // fire-and-forget one-shot's model gap is invisible to the user and covered
    // by the Builder backstop, so it logs (no user notification — that would be
    // noise for a background best-effort call).
    const resolved = await resolveStageModel(input.ctx, input.settings.defaultModel);
    if (!resolved.ok) {
      log.warn(`goal extract skipped: ${resolved.error}`);
      return;
    }
    if (controller.signal.aborted) return;

    const run = input.runStageFn ?? runStage;
    const result = await run({
      systemPrompt: GOAL_EXTRACT_SYSTEM,
      messages: [{ role: "user", content: input.verbatimText } as AgentMessage],
      tools: [],
      model: resolved.model,
      apiKey: resolved.apiKey,
      signal: controller.signal,
      reasoning: GOAL_REASONING,
      maxTurns: GOAL_MAX_TURNS,
      maxTokens: GOAL_MAX_TOKENS,
      timeoutMs: input.settings.llmCallTimeoutMs,
      onEvent: NO_EVENT_SINK,
      onStageEnd: NO_STAGE_END_HOOK,
      loopFn: NO_LOOP_OVERRIDE,
      // One-shot: the prefix never recurs, so skip cache writes (and no affinity id).
      cacheRetention: GOAL_CACHE_RETENTION,
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
