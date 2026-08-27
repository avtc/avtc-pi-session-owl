// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// Activation-time conflict state (see detect.ts): WHAT conflicted, recorded
// once per process at activation (the installed package set cannot change
// mid-process). Whether memkeeper is actually PAUSED is decided live at each
// hook call by isConflictPaused() — hits exist AND the operator has not set
// ignoreConflicts — so a settings reload (reloadConfig, e.g. the bench
// harness co-running other memory extensions) resumes memkeeper mid-session.

import { getMemkeeperSettings } from "../config/schema.js";
import type { ConflictHit } from "./detect.js";

let conflictHits: ConflictHit[] | null = null;

/** Record (or clear) the activation-time conflict detection result. */
export function setConflictHits(hits: ConflictHit[] | null): void {
  conflictHits = hits;
}

/** The conflicts detected at activation (what paused memkeeper + why), or null. */
export function getConflictHits(): ConflictHit[] | null {
  return conflictHits;
}

/**
 * Whether memkeeper is conflict-paused RIGHT NOW: conflicts were detected at
 * activation and the operator has not opted into the deliberate last-wins
 * co-run (ignoreConflicts). Live — a settings reload flips it.
 */
export function isConflictPaused(): boolean {
  return conflictHits !== null && !getMemkeeperSettings().ignoreConflicts;
}
