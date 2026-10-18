// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// The conversation key the process-wide singletons currently serve. One tiny
// module so run-lock, session-affinity, details, and graph-store can all read
// (and graph-store alone writes) the active key without an import cycle.
// pi never activates a key, so this stays at the default: one process, one
// session, today's behavior (every partition then holds exactly one entry).

/** The key served when nobody ever activated one (pi's world). */
export const DEFAULT_CONVERSATION_KEY = "(default)";

let activeConversationKey = DEFAULT_CONVERSATION_KEY;

/** Point the process at `key` (graph-store's activateConversation writes). */
export function setActiveConversationKey(key: string): void {
  activeConversationKey = key;
}

/** The conversation key every singleton partition reads at call time. */
export function currentConversationKey(): string {
  return activeConversationKey;
}
