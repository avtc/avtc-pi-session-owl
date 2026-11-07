// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// The pi host of agent-initiated compaction: the owl_compact ToolDefinition
// and the turn-boundary fire. The unified flow (both platforms): the tool
// call validates + stashes the notes; the run settles; the fire helper calls
// ctx.compact with the notes as customInstructions; the compaction hook (see
// hook.ts) consumes the stash and renders it into the summary; the followUp
// resumes the agent automatically.

import type { ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { getSessionOwlSettings } from "../config/schema.js";
import { isConflictPaused } from "../conflicts/pause.js";
import { log } from "../log.js";
import {
  clearPendingCompact,
  OWL_COMPACT_CONTINUE_PROMPT,
  OWL_COMPACT_DESCRIPTION,
  OWL_COMPACT_DISABLED_TEXT,
  OWL_COMPACT_KEY,
  OWL_COMPACT_NOTES_DESCRIPTION,
  OWL_COMPACT_NOTES_PARAM,
  OWL_COMPACT_SCHEDULED_TEXT,
  OWL_COMPACT_TOOL,
  owlCompactBelowFloorText,
  parseAgentCompactValue,
  peekPendingCompact,
  setPendingCompact,
} from "./agent-compact-core.js";

/** The owl_compact parameters: one required, unbounded string. */
const OWL_COMPACT_PARAMS = Type.Object({
  [OWL_COMPACT_NOTES_PARAM]: Type.String({ description: OWL_COMPACT_NOTES_DESCRIPTION, minLength: 1 }),
});

/** How long the post-compaction follow-up waits before injecting, so a user
 *  steer typed during compaction is delivered first (the same race the todo
 *  extension's deferred inject solves). */
const FOLLOWUP_DEFER_MS = 600;

/** Text tool result helper. */
function textResult(text: string, error: boolean) {
  return {
    content: [{ type: "text" as const, text }],
    details: error ? { error: true } : { ok: true },
  };
}

/** Context tokens rounded to thousands, or null when unknown. */
async function contextTokensK(ctx: ExtensionContext): Promise<number | null> {
  if (typeof ctx.getContextUsage !== "function") return null;
  try {
    const usage = await ctx.getContextUsage();
    const tokens = usage?.tokens;
    return typeof tokens === "number" && tokens > 0 ? Math.round(tokens / 1000) : null;
  } catch (err) {
    log.warn(
      `context usage read failed (the floor check proceeds without it): ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}

/** Build the owl_compact ToolDefinition. The execute validates against the
 *  live setting, stashes the notes, and answers; nothing here compacts —
 *  the fire waits for the run to settle. */
export function makeOwlCompactTool(): ToolDefinition<typeof OWL_COMPACT_PARAMS> {
  return {
    name: OWL_COMPACT_TOOL,
    label: "Compact now",
    description: OWL_COMPACT_DESCRIPTION,
    parameters: OWL_COMPACT_PARAMS,
    async execute(
      _toolCallId: string,
      params: { continue_notes?: string },
      _signal: unknown,
      _onUpdate: unknown,
      ctx: ExtensionContext,
    ) {
      const settings = getSessionOwlSettings();
      // a dormant owl (disabled or conflict-paused) is compaction-transparent:
      // a fired request would run the engine's native compaction — refuse
      if (!settings.enabled || isConflictPaused()) {
        return textResult(OWL_COMPACT_DISABLED_TEXT, true);
      }
      const setting = parseAgentCompactValue(settings.agentCompact);
      if (setting.mode === "off") {
        return textResult(OWL_COMPACT_DISABLED_TEXT, true);
      }
      if (setting.thresholdK !== null) {
        const tokensK = await contextTokensK(ctx);
        if (tokensK !== null && tokensK < setting.thresholdK) {
          return textResult(owlCompactBelowFloorText(tokensK, setting.thresholdK), true);
        }
      }
      const notes = typeof params[OWL_COMPACT_NOTES_PARAM] === "string" ? params[OWL_COMPACT_NOTES_PARAM] : "";
      setPendingCompact(OWL_COMPACT_KEY, notes);
      return textResult(OWL_COMPACT_SCHEDULED_TEXT, false);
    },
  };
}

/** The message-sending slice of pi's ExtensionAPI the fire needs. */
export interface FollowUpSender {
  sendUserMessage: (text: string, options?: { deliverAs: "steer" | "followUp" }) => void;
}

/** The deferred follow-up: resume text delivered as a queued user message so
 *  anything the user typed during compaction goes first. */
function sendFollowUp(pi: FollowUpSender, text: string): void {
  setTimeout(() => {
    try {
      pi.sendUserMessage(text, { deliverAs: "followUp" });
    } catch (err) {
      log.error(`continuation follow-up failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }, FOLLOWUP_DEFER_MS);
}

/** Fire the pending agent-initiated compaction at the settled boundary. No
 *  pending request = a no-op (the plain agent_settled of every run). The
 *  notes ride customInstructions into the compaction hook, which consumes
 *  the stash when the compaction runs. The followUp resumes the agent ONLY
 *  when the compaction stood: a user abort (cancel), an unavailable
 *  service/provider, or any other failure ends the flow without a
 *  continuation — the session stays where the failure left it. */
export async function firePendingCompactAtSettled(ctx: ExtensionContext, pi: FollowUpSender): Promise<void> {
  const pending = peekPendingCompact(OWL_COMPACT_KEY);
  if (pending === null) return;
  const settings = getSessionOwlSettings();
  const setting = parseAgentCompactValue(settings.agentCompact);
  if (!settings.enabled || isConflictPaused() || setting.mode === "off") {
    clearPendingCompact(OWL_COMPACT_KEY);
    return;
  }
  try {
    if (setting.thresholdK !== null) {
      const tokensK = await contextTokensK(ctx);
      if (tokensK !== null && tokensK < setting.thresholdK) {
        log.warn("agent-initiated compaction not fired: context below the floor (re-checked at fire time)");
        clearPendingCompact(OWL_COMPACT_KEY);
        return;
      }
    }
    ctx.compact({
      customInstructions: pending.notes,
      onComplete: () => sendFollowUp(pi, OWL_COMPACT_CONTINUE_PROMPT),
      onError: (err: Error) => {
        log.warn(`agent-initiated compaction failed (no continuation): ${err.message}`);
        // a compact that never reached the compaction hook (nothing to
        // compact, already compacted), a user cancel, or a provider failure:
        // drop the request and continue nothing
        clearPendingCompact(OWL_COMPACT_KEY);
      },
    });
  } catch (err) {
    log.warn(
      `agent-initiated compaction rejected (no continuation): ${err instanceof Error ? err.message : String(err)}`,
    );
    clearPendingCompact(OWL_COMPACT_KEY);
  }
}
