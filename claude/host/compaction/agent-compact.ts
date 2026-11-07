// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// The Claude host of agent-initiated compaction. The unified flow (both
// platforms): the owl_compact tool.call validates + stashes the notes for the
// conversation; the turn completes; the fire helper — deferred past the hook
// on the timer lane — calls $.session.compact with the notes as instructions
// (the session.compact event then runs owl's takeover, which consumes the
// stash and renders the notes into the summary); the continuation prompt is
// submitted once the compaction resolves, so the next turn starts on its own.

import {
  clearPendingCompact,
  OWL_COMPACT_CONTINUE_PROMPT,
  OWL_COMPACT_DISABLED_TEXT,
  OWL_COMPACT_SCHEDULED_TEXT,
  owlCompactBelowFloorText,
  type parseAgentCompactValue,
  peekPendingCompact,
  setPendingCompact,
} from "../../core/src/compaction/agent-compact-core.js";

/** The engine-call capsules the fire needs; each is spelled literally inside
 *  a handler-authored closure at the wiring (the scanner's rule). */
export interface AgentCompactFireDeps {
  /** `$.session.compact({ instructions })` — between turns. */
  sessionCompact: (input: { instructions: string }) => Promise<{ skip?: string }>;
  /** `$.prompt.submit({ text })` — the automatic continuation turn. */
  promptSubmit: (input: { text: string }) => Promise<unknown>;
  /** `$.clock.after(ms, cb)` — the timer lane past the hook. */
  clockAfter: (ms: number, cb: () => void) => unknown;
  /** Log seam (the file logger). */
  log: (message: string) => void;
}

/** The tool.call serve: validate against the live setting and the context
 *  floor, stash the notes for the conversation, and answer. Nothing here
 *  compacts — the fire waits for the turn boundary. */
export function serveOwlCompactCall(
  input: { continue_notes?: unknown },
  deps: {
    /** The parsed live agentCompact setting. */
    setting: ReturnType<typeof parseAgentCompactValue>;
    /** Context tokens in thousands, or null when unknown. */
    contextTokensK: number | null;
    /** The conversation key the stash is filed under. */
    key: string;
  },
): { text: string; error: boolean } {
  if (deps.key === "" || deps.setting.mode === "off") {
    return { text: OWL_COMPACT_DISABLED_TEXT, error: true };
  }
  if (
    deps.setting.thresholdK !== null &&
    deps.contextTokensK !== null &&
    deps.contextTokensK < deps.setting.thresholdK
  ) {
    return { text: owlCompactBelowFloorText(deps.contextTokensK, deps.setting.thresholdK), error: true };
  }
  const notes = typeof input.continue_notes === "string" ? input.continue_notes : "";
  setPendingCompact(deps.key, notes);
  return { text: OWL_COMPACT_SCHEDULED_TEXT, error: false };
}

/** Fire the pending agent-initiated compaction for a conversation at its
 *  turn boundary. No pending request = a no-op. The compact call is deferred
 *  past the hook (the turn's own completion must settle first — a call inside
 *  the turn.complete handler can still count as "a turn runs" and reject).
 *  The continuation prompt fires ONLY when the compaction stood: a veto
 *  (skip), a user abort, an unavailable service/provider, or any other
 *  failure ends the flow without a continuation — the session stays where
 *  the failure left it.
 *
 *  Main conversation only: $.session.compact takes no agentId, so a
 *  subagent loop's request is not fired explicitly — its stash waits for the
 *  loop's own engine compaction (the compaction hook consumes it there). */
const firing = new Set<string>();

export function firePendingAgentCompact(
  key: string,
  setting: ReturnType<typeof parseAgentCompactValue>,
  deps: AgentCompactFireDeps,
): void {
  const pending = peekPendingCompact(key);
  if (pending === null) return;
  if (setting.mode === "off" || firing.has(key)) {
    if (setting.mode === "off") clearPendingCompact(key);
    return;
  }
  firing.add(key);
  deps.clockAfter(0, () => {
    void (async () => {
      let stood = false;
      try {
        const result = await deps.sessionCompact({ instructions: pending.notes });
        if (typeof result?.skip === "string") {
          // a hook vetoed it (owl's own skip paths, a classic PreCompact
          // block) — the compaction did not stand
          deps.log(`agent-initiated compaction skipped (no continuation): ${result.skip}`);
          clearPendingCompact(key);
        } else {
          stood = true;
        }
      } catch (err) {
        // a user abort, an unavailable service/provider, a running turn —
        // the compaction did not stand
        deps.log(
          `agent-initiated compaction rejected (no continuation): ${err instanceof Error ? err.message : String(err)} — clearing the pending request`,
        );
        clearPendingCompact(key);
      } finally {
        firing.delete(key);
      }
      if (!stood) return;
      try {
        await deps.promptSubmit({ text: OWL_COMPACT_CONTINUE_PROMPT });
      } catch (submitErr) {
        deps.log(`continuation prompt rejected: ${submitErr instanceof Error ? submitErr.message : String(submitErr)}`);
      }
    })();
  });
}
