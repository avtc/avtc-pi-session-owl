// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// The pause module ("Pause wiring"): activation-time hits +
// advisories recorded once; the PAUSED fact decided live at every hook
// call — enabled ∧ hits ∧ ¬ignoreConflicts — so a settings reload flips it
// mid-session. Transitions append to the timeline (Channel C windows).
// Surfaces: the pause/ignore log lines, the paused status report.
import { afterEach, describe, expect, test } from "vitest";
import {
  _resetConflictStateForTest,
  buildPausedStatusReport,
  conflictPauseLogLine,
  conflictsDetectedLogLine,
  getConflictAdvisories,
  getConflictHits,
  isConflictPaused,
  setConflictHits,
} from "../../host/conflicts/pause.js";
import type { ConflictHit } from "../../host/conflicts/scan.js";

function settings(enabled: boolean, ignoreConflicts: boolean): { enabled: boolean; ignoreConflicts: boolean } {
  return { enabled, ignoreConflicts };
}

const HITS: ConflictHit[] = [
  { channel: "A", name: "evil@market", evidence: "session.compact" },
  { channel: "B", name: "later-mod", evidence: "session.*" },
];

// this file arms hits in its tests; it must never hand them to the next
// file through the shared module registry
afterEach(() => {
  _resetConflictStateForTest();
});

describe("conflicts pause — the live predicate", () => {
  test("paused iff enabled && hits && !ignoreConflicts", () => {
    _resetConflictStateForTest();
    expect(isConflictPaused(() => settings(true, false))).toBe(false); // no hits yet
    setConflictHits(HITS);
    expect(isConflictPaused(() => settings(true, false))).toBe(true);
    expect(isConflictPaused(() => settings(false, false))).toBe(false); // off by choice
    expect(isConflictPaused(() => settings(true, true))).toBe(false); // deliberate co-run
    expect(getConflictHits()).toEqual(HITS);
  });

  test("advisories ride alongside (disabled curated match, classic-only registrant)", () => {
    _resetConflictStateForTest();
    setConflictHits(
      [],
      [
        { name: "known-bad@market", evidence: "known-bad", reason: "disabled" },
        { name: "classic-mod", evidence: "classic.*", reason: "classic-only" },
      ],
    );
    expect(isConflictPaused(() => settings(true, false))).toBe(false);
    expect(getConflictAdvisories()).toHaveLength(2);
  });
});

describe("conflicts pause — the log lines", () => {
  test("the pause line names what conflicted; the ignoreConflicts line records the deliberate co-run", () => {
    _resetConflictStateForTest();
    setConflictHits(HITS);
    expect(conflictPauseLogLine()).toBe(
      "conflict pause: session.compact, session.* also handles compaction — " +
        "session-owl stays dormant; remove it, or set ignoreConflicts (see README → Conflicts), to resume",
    );
    expect(conflictsDetectedLogLine()).toBe(
      "conflict detected (session.compact, session.*) but ignoreConflicts=true — " +
        "running anyway; Claude's compaction chain lets an earlier hook answer first",
    );
  });
});

describe("conflicts pause — the paused status report", () => {
  test("the report lists channel + name and the recovery ladder", () => {
    _resetConflictStateForTest();
    setConflictHits(HITS);
    const report = buildPausedStatusReport();
    expect(report).toContain("Paused — another compaction-handling mod is installed:");
    expect(report).toContain("A evil@market");
    expect(report).toContain("B later-mod");
    expect(report).toContain("/owl-settings");
    expect(report).toContain("remove the other mod and");
    expect(report).toContain("restart Claude");
    expect(report).toContain("ignoreConflicts");
  });
});
