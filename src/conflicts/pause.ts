// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// Runtime conflict-pause state: set once at activation when another
// compaction-handling extension is installed (see detect.ts). Read by the
// widget and /mk:status to explain WHY memkeeper is paused. Never persisted —
// the pause is re-evaluated at every pi start, so removing the conflicting
// package is the only (and automatic) way out.

import type { ConflictHit } from "./detect.js";

let pausedFor: ConflictHit[] | null = null;

/** Record the activation-time conflict pause (called from activate only). */
export function setConflictPause(hits: ConflictHit[]): void {
  pausedFor = hits;
}

/** The conflicts memkeeper is paused for this process, or null when active. */
export function getConflictPause(): ConflictHit[] | null {
  return pausedFor;
}

/** Test seam: clear the pause between activation-level tests. */
export function clearConflictPause(): void {
  pausedFor = null;
}
