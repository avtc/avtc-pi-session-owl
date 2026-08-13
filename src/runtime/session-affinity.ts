// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// Per-session, per-stage LLM session-affinity ids for the maintenance stages.
//
// Observer/Builder/Selector each carry a stable system prompt + tool set that
// recurs across passes, chunks, and runs — a recurring prefix worth prompt-cache
// reuse. A stable per-stage affinity id routes one session's calls for that stage
// to a consistent backend (Anthropic `x-session-affinity`) and namespaces its
// cache entries (Mistral `promptCacheKey`), so back-to-back passes/chunks hit.
//
// The cache itself keys on the CONTENT prefix, not the id — so the per-stage ids
// are about routing + readability, not cache correctness. Goal-extract is a
// one-shot (no recurring prefix) and so uses neither an affinity id nor caching.
//
// Session-scoped: a fresh base per session keeps unrelated sessions from coupling
// on a node (Anthropic) or sharing a cache namespace (Mistral). The base is set
// on session_start and cleared on session_shutdown (see lifecycle.ts).

/** The session-scoped base; suffixed per stage. null outside an active session. */
let sessionBase: string | null = null;

/** Set the per-session base id (called once on session_start). */
export function setMemkeeperSessionBase(id: string): void {
  sessionBase = id;
}

/** Clear the base (called on session_shutdown). */
export function clearMemkeeperSessionBase(): void {
  sessionBase = null;
}

/** The per-stage affinity id for a maintenance stage, or null outside a session.
 *  `stage` is the run's stage label ("observe"/"build"/"select"). */
export function getStageAffinityId(stage: string): string | null {
  return sessionBase === null ? null : `${sessionBase}:${stage}`;
}

/** Test-only: reset to the no-session state. */
export function _resetSessionAffinity(): void {
  sessionBase = null;
}
