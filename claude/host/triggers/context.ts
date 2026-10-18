// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// The narrow host inputs the vendored trigger evaluation consumes:
// `getLeafId`/`getBranch` from the storage layer, `getContextUsage`
// from the latest `session.measure` snapshot, thinking level from settings.
// `session.measure` is session-scoped — it reports the MAIN conversation's
// context fill; a subagent loop's own context is never measured, so loop
// keys read unknown (null) and their on-session-context-threshold arms skip
// exactly as they do for any unknown-context conversation.

/** One session.measure context figure (the subset the triggers read). */
export interface MeasureSnapshot {
  /** The context fill; absent when the window has no reading yet. */
  tokens?: number;
  /** The context window of the session's model, in tokens. */
  window: number;
}

/** The latest snapshot per session id (the MAIN conversation). */
const snapshots = new Map<string, MeasureSnapshot>();

/** Record the latest session.measure context figure (session-scoped). */
export function recordMeasure(sessionId: string, snapshot: MeasureSnapshot): void {
  snapshots.set(sessionId, snapshot);
}

/** The conversation's context fill for the on-session-context-threshold
 *  arms: the latest snapshot's tokens, or null when unknown (no snapshot,
 *  a snapshot without a fill, or a LOOP key — subagent contexts are never
 *  measured; those arms skip on unknown context).  */
export function contextTokensFor(conversationKey: string): number | null {
  // a loop key carries "|agentId" — the main conversation's fill is not its own
  if (conversationKey.includes("|")) return null;
  return snapshots.get(conversationKey)?.tokens ?? null;
}

/** Latest snapshot's window only, never clobbered: the widget's denominator
 *  before any measure has landed (the engine's own window reading pulled at
 *  session start — the port's model-registry stand-in). A measured snapshot
 *  keeps its fill; a later `session.measure` supersedes both wholesale. */
export function seedWindow(sessionId: string, window: number): void {
  if (snapshots.has(sessionId)) return;
  snapshots.set(sessionId, { window });
}

/** The session's measured context window (the widget's context-figure
 *  denominator; null when no measure has landed — the honest unknown). */
export function windowFor(sessionId: string): number | null {
  return snapshots.get(sessionId)?.window ?? null;
}

/** Test-only: drop every snapshot. */
export function _resetMeasureSnapshots(): void {
  snapshots.clear();
}

/** Production teardown (session.end): drop every snapshot — the sessions
 *  are gone, and stale fills must not feed a future session's arms. */
export function pruneMeasures(): void {
  snapshots.clear();
}

/** The storage-layer reads the evaluators need (the conversation's branch). */
export interface TriggerStorageInput {
  getLeafId: () => string | null;
  getBranch: (leafId: string | null) => unknown[];
}

/** The pi-shaped ctx the vendored evaluation functions expect, over the
 *  host's narrow inputs (a structural adapter — the vendored code reads
 *  ctx.sessionManager.getLeafId/getBranch and ctx.getContextUsage()?.tokens,
 *  ctx.thinkingLevel for the runs' reasoning resolution). */
export function makeTriggerCtx(
  input: TriggerStorageInput & {
    key: string;
    thinkingLevel: string | null;
  },
): {
  sessionManager: { getLeafId: () => string | null; getBranch: (leafId?: string) => unknown[] };
  getContextUsage: () => { tokens: number } | undefined;
  thinkingLevel: string | null;
} {
  return {
    sessionManager: {
      getLeafId: () => input.getLeafId(),
      getBranch: (leafId?: string) => input.getBranch(leafId ?? input.getLeafId()),
    },
    getContextUsage: () => {
      const tokens = contextTokensFor(input.key);
      return tokens === null ? undefined : { tokens };
    },
    thinkingLevel: input.thinkingLevel,
  };
}
