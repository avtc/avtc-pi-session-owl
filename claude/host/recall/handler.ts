// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// The owl_recall tool.call body — the port of the recall dispatch onto the
// Claude surface. Gate order: the calling loop's key resolves first; a
// conflict pause SERVES (pause is not disabled — the tool is read-only and
// reads whatever graph state exists, pi parity); a DISABLED session rejects
// by answering {deny: the reason} (the engine delivers the deny text as
// the tool's error result — is_error true — and the model reads why recall
// refuses); then the canonical-view check runs
// BEFORE the serve (the layered-check seam, wired behind the same
// interface), the conversation's core pins, and the VENDORED executeRecall
// serves — dispatch order, pagination, budget windows, and the safe-regex
// sandbox are all pi's own code. Success maps to {result: text}; an
// in-band error result ANSWERS {deny: its exact text}
// (identical error text to pi; a throwing hook would instead be SKIPPED —
// its text only in the debug log — so the handler never throws).
import { makeOwlRecallTool } from "../../core/src/recall/owl-recall.js";

/** The disabled-only reject reason — pi's own user-facing phrasing
 *  (commands/user.ts), delivered as the deny text so the model reads why
 *  recall refuses. Conflict-paused sessions are NOT rejected (they serve,
 *  pi parity). */
export const OWL_RECALL_DISABLED_REASON = "session-owl is disabled (enable it first).";

/** The subagentMode-disabled reject reason (pinned text:
 *  under subagentMode "disabled" session-owl is off for SUBAGENTS — their
 *  owl_recall calls are rejected with a simple clear reason; the deny text
 *  is the model's error result). The main conversation keeps serving. */
export const OWL_RECALL_SUBAGENT_DISABLED_REASON = "session-owl is disabled for subagents (subagentMode: disabled).";

/** The tool.call event slice the handler reads. */
export interface OwlRecallCallEvent {
  tool: string;
  /** The calling loop's id — absent for the main conversation. */
  agentId?: string;
  /** The model's call arguments (validated against the registered schema). */
  input: Record<string, unknown>;
}

/** The handler's named inputs — everything but the event, injected (the
 *  register wiring binds them; tests supply fakes). */
export interface RecallHandlerDeps {
  /** Resolves the conversation key for a call (agentId-scoped loops get
   *  their own graph). */
  resolveKey: (agentId: string | null) => string;
  /** The disabled live-predicate (mid-session disable ⇒ registered but
   *  REJECTING — disabled only). */
  isDisabled: () => boolean;
  /** The conflict-pause live predicate (paused sessions SERVE). */
  isConflictPaused: () => boolean;
  /** True when subagentMode is "disabled" — SUBAGENT loops (an agentId on
   *  the call) are rejected; the main conversation keeps serving. */
  subagentsDisabled: () => boolean;
  /** The canonical-view check awaited BEFORE serving (the layered check's
   *  entry point). */
  checkThenServe: (key: string) => Promise<void>;
  /** Pins the conversation's core before the vendored serve (the store
   *  singletons the vendored code reads). */
  pinCore: (key: string) => Promise<void>;
}

/** One shared tool instance (the vendored definition — execute is pi's). */
const OWL_RECALL_TOOL = makeOwlRecallTool();

/** The tool.call body. The register dispatches ONLY our full tool name
 *  here; error paths answer {deny: text} (the engine's error-result delivery
 *  — the model reads the exact text) and never throw. */
export async function handleOwlRecallCall(
  e: OwlRecallCallEvent,
  deps: RecallHandlerDeps,
): Promise<{ result: string } | { deny: string }> {
  const key = deps.resolveKey(typeof e.agentId === "string" ? e.agentId : null);
  // pause is not disabled: a conflict-paused session still serves (pi parity)
  if (!deps.isConflictPaused() && deps.isDisabled()) {
    return { deny: OWL_RECALL_DISABLED_REASON };
  }
  // subagentMode "disabled": session-owl is off for subagents — an
  // agent-scoped call (the main conversation carries no agentId) answers
  // the subagent reason instead of serving an empty graph
  if (typeof e.agentId === "string" && deps.subagentsDisabled()) {
    return { deny: OWL_RECALL_SUBAGENT_DISABLED_REASON };
  }
  // the canonical-view check precedes every serve (stale-recall window)
  await deps.checkThenServe(key);
  await deps.pinCore(key);
  const outcome = await OWL_RECALL_TOOL.execute(
    "owl_recall",
    e.input as never,
    undefined,
    undefined,
    undefined as never,
  );
  const text = outcome.content.find((block) => block.type === "text")?.text ?? "";
  const isError =
    typeof outcome.details === "object" &&
    outcome.details !== null &&
    (outcome.details as { error?: unknown }).error === true;
  if (isError) return { deny: text }; // pi's exact error text as the model's error result
  return { result: text };
}
