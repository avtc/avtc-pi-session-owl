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
// on session_start and cleared on session_shutdown (see lifecycle.ts). The base
// is stored PER CONVERSATION KEY (read/write at the active key), so a resident
// conversation keeps its base across another conversation's visit — pi never
// activates a key, so its map holds exactly one entry (today's behavior).

import { currentConversationKey } from "./conversation-key.js";

/** The session-scoped base per conversation; suffixed per stage. Absent outside
 *  an active session for that conversation. */
const sessionBases = new Map<string, string>();

/** Set the per-session base id (called once on session_start). */
export function setSessionOwlSessionBase(id: string): void {
  sessionBases.set(currentConversationKey(), id);
}

/** Clear the base of the ACTIVE conversation (called on session_shutdown). */
export function clearSessionOwlSessionBase(): void {
  sessionBases.delete(currentConversationKey());
}

/** The per-stage affinity id for a maintenance stage of the ACTIVE
 *  conversation, or null outside a session. `stage` is the run's stage label
 *  ("observe"/"build"/"select"). */
export function getStageAffinityId(stage: string): string | null {
  const base = sessionBases.get(currentConversationKey());
  return base === undefined ? null : `${base}:${stage}`;
}

/** Test-only: reset every conversation to the no-session state. */
export function _resetSessionAffinity(): void {
  sessionBases.clear();
}
