// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// The pause module (pi's src/conflicts/pause.ts + the activation
// logging): WHAT conflicted is recorded once at
// activation; whether session-owl is actually PAUSED is decided live at
// each hook call — hits exist AND the operator has not set
// ignoreConflicts AND owl is enabled — so a settings reload flips it
// mid-session. The pause is dormant, not absent (owl keeps its registered
// surface and passes through every hook).

import type { ConflictAdvisory } from "./channel-a.js";
import type { ConflictHit } from "./scan.js";

/** The live settings the predicate reads (the settings consumer supplies it). */
export interface PauseSettings {
  enabled: boolean;
  ignoreConflicts: boolean;
}

let conflictHits: ConflictHit[] | null = null;
let conflictAdvisories: ConflictAdvisory[] = [];

/** Record (or clear) the activation-time conflict detection result. An
 *  UNDEFINED advisories argument keeps the last-known advisories — the
 *  pause recompute path (hits merge over the live set on every envelope)
 *  must not silently forget them; pass [] to clear explicitly. */
export function setConflictHits(hits: ConflictHit[] | null, advisories?: ConflictAdvisory[]): void {
  conflictHits = hits !== null && hits.length > 0 ? hits : null;
  if (advisories !== undefined) conflictAdvisories = advisories;
}

/** The conflicts detected at activation (what paused session-owl + why), or null. */
export function getConflictHits(): ConflictHit[] | null {
  return conflictHits;
}

/** The advisories (no pause): disabled curated matches, classic-only registrants. */
export function getConflictAdvisories(): ConflictAdvisory[] {
  return conflictAdvisories;
}

/** The display name of a hit: the evidence for scan hits (pi's `matched`),
 *  the unscannable marker, or the row id for Channel C. */
function hitLabel(hit: ConflictHit): string {
  return hit.evidence;
}

/**
 * Whether session-owl is conflict-paused RIGHT NOW: conflicts were detected
 * at activation, owl is enabled (off by choice is not a pause), and the
 * operator has not opted into the deliberate co-run. Live — a settings
 * reload flips it.
 */
export function isConflictPaused(getSettings: () => PauseSettings): boolean {
  const settings = getSettings();
  return settings.enabled && conflictHits !== null && !settings.ignoreConflicts;
}

/** The pause log line (pi-verbatim; only the names differ). */
export function conflictPauseLogLine(): string {
  const hits = conflictHits ?? [];
  return (
    `conflict pause: ${hits.map(hitLabel).join(", ")} also handles compaction — ` +
    "session-owl stays dormant; remove it, or set ignoreConflicts (see README → Conflicts), to resume"
  );
}

/** The deliberate-co-run log line (pi's wording, the mechanism sentence
 *  adapted to the platform's chain semantics: an earlier hook can answer
 *  without calling next — approval-owed, see the approvals queue). */
export function conflictsDetectedLogLine(): string {
  const hits = conflictHits ?? [];
  return (
    `conflict detected (${hits.map(hitLabel).join(", ")}) but ignoreConflicts=true — ` +
    "running anyway; Claude's compaction chain lets an earlier hook answer first"
  );
}

/** The paused status report (pi's buildPausedStatusReport, pi→Claude /
 *  extension→mod / kebab command substitutions; the mechanism sentence
 *  adapted to the chain semantics — approval-owed, see the approvals
 *  queue). Pure over the activation-time hits. */
export function buildPausedStatusReport(): string {
  const hits = conflictHits ?? [];
  const header = "session-owl status";
  if (hits.length === 0) return header;
  const nameWidth = Math.max(...hits.map((h) => h.channel.length));
  const listed = hits.map((h) => `  ${h.channel.padEnd(nameWidth)} ${h.name}`).join("\n");
  return [
    header,
    "",
    "Paused — another compaction-handling mod is installed:",
    "",
    listed,
    "",
    "Claude's compaction chain lets an earlier hook answer without calling next,",
    "so session-owl stays dormant this session — it collects no observations and",
    "leaves compaction to the other mod. To resolve: remove the other mod and",
    "restart Claude; co-run deliberately via ignoreConflicts in /owl-settings;",
    "or turn session-owl off (enabled in /owl-settings) — see README → Conflicts.",
  ].join("\n");
}

/** Test seam: clear the recorded state. */
export function _resetConflictStateForTest(): void {
  conflictHits = null;
  conflictAdvisories = [];
}
