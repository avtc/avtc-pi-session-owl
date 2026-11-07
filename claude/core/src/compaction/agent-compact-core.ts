// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// Agent-initiated compaction — the shared core. The owl_compact tool call
// leaves a pending-notes record for its conversation; the compaction that
// runs next (the one the fire helper triggers at the turn boundary, or any
// compaction that happens to run first) consumes it and renders the notes
// into the summary block under an origin label. Both hosts (pi and the
// Claude port) share this module verbatim.

/** The tool name, as the model calls it. */
export const OWL_COMPACT_TOOL = "owl_compact";

/** The tool description the model reads (pi-verbatim). */
export const OWL_COMPACT_DESCRIPTION =
  "Runs compaction at the end of this turn. continue_notes will be rendered into compaction summary - " +
  "pass everything you keep in mind to effectively continue planned work after compaction. " +
  "The past turns are observed by owl, but future plans are only in your mind. " +
  "Consult with owl_recall to see root nodes summaries if needed";

/** The single parameter's name. */
export const OWL_COMPACT_NOTES_PARAM = "continue_notes";

/** The parameter description the model reads. */
export const OWL_COMPACT_NOTES_DESCRIPTION =
  "What you need to know after compaction to effectively continue planned work";

/** The tool result when the compaction is scheduled. */
export const OWL_COMPACT_SCHEDULED_TEXT =
  "compaction scheduled at the end of this turn — end your turn; the session compacts and continues automatically with your notes";

/** The tool result when the context is under the floor. */
export function owlCompactBelowFloorText(currentK: number, floorK: number): string {
  return `compaction not scheduled: context at ${currentK}k is below the user set ${floorK}k threshold`;
}

/** The tool result when the setting was flipped off mid-session. */
export const OWL_COMPACT_DISABLED_TEXT = "compaction not scheduled: user temporary disabled agent-initiated compact";

/** The summary block label for notes the agent sent. */
export const OWL_COMPACT_AGENT_LABEL = "## Continue instructions you have sent before executing compaction";

/** The summary block label for instructions the user typed with /compact. */
export const OWL_COMPACT_USER_LABEL = "## Continue instructions from user";

/** The automatic continuation prompt after the compaction. */
export const OWL_COMPACT_CONTINUE_PROMPT = "Continue from where you left off.";

/** A parsed agentCompact setting value. */
export interface AgentCompactSetting {
  mode: "off" | "on";
  /** Thousands of context tokens the context must reach first; null = no floor. */
  thresholdK: number | null;
}

/** Parse an agentCompact setting value: "off", "on", or "on>Nk" (e.g.
 *  "on>40k"). An absent value is the shipped default ("on"); a present but
 *  unparseable one is off (never register on garbage). */
export function parseAgentCompactValue(value: string | undefined | null): AgentCompactSetting {
  if (typeof value !== "string") return { mode: "on", thresholdK: null };
  const trimmed = value.trim().toLowerCase();
  if (trimmed === "on") return { mode: "on", thresholdK: null };
  const match = /^on>(\d+)k$/i.exec(trimmed);
  if (match !== null) return { mode: "on", thresholdK: Number.parseInt(match[1] ?? "0", 10) };
  return { mode: "off", thresholdK: null };
}

/** The notes the summary renders, with who sent them. */
export interface CompactNotes {
  text: string;
  origin: "agent" | "user";
}

/** A pending agent request: the notes stashed by the tool call, waiting for
 *  the turn boundary's compaction. */
export interface PendingCompactRequest {
  notes: string;
  ts: number;
}

/** The stash key on pi: one conversation per process (subagents are their
 *  own processes with their own module instance), so a constant names it. */
export const OWL_COMPACT_KEY = "session";

const pending = new Map<string, PendingCompactRequest>();

/** Stash (or replace — the latest call wins) the pending request for a
 *  conversation key. */
export function setPendingCompact(key: string, notes: string): void {
  pending.set(key, { notes, ts: Date.now() });
}

/** Read the pending request without consuming it. */
export function peekPendingCompact(key: string): PendingCompactRequest | null {
  return pending.get(key) ?? null;
}

/** Take (and clear) the pending request. */
export function consumePendingCompact(key: string): PendingCompactRequest | null {
  const request = pending.get(key) ?? null;
  pending.delete(key);
  return request;
}

/** Drop the pending request (a compaction that ran first, a session end). */
export function clearPendingCompact(key: string): void {
  pending.delete(key);
}

/** Drop every pending request of one session (main key and its loop keys).
 *  A request never outlives its session: a residual entry from an aborted or
 *  blocked flow must not fire a stale compaction after a resume or re-enable. */
export function clearPendingCompactForSession(sessionId: string): void {
  pending.delete(sessionId);
  const prefix = `${sessionId}|`;
  for (const key of pending.keys()) {
    if (key.startsWith(prefix)) pending.delete(key);
  }
}

/** Resolve the notes a compaction renders: the agent's pending request when
 *  one waits (the agent asked for THIS compaction), else the instructions
 *  the user typed with their /compact, else none. */
export function compactNotesFor(key: string, userInstructions: string | undefined): CompactNotes | null {
  const request = consumePendingCompact(key);
  if (request !== null) return { text: request.notes, origin: "agent" };
  if (typeof userInstructions === "string" && userInstructions.length > 0) {
    return { text: userInstructions, origin: "user" };
  }
  return null;
}
