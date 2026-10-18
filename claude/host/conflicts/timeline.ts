// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// The per-session conflict timeline: every enable/disable and
// pause/resume transition, every compaction answer/skip (with its row
// coordinate), and every Channel C adjudication append to a per-process
// timeline-<processId>.jsonl in the session dir; Channel C reads the UNION
// across processes to compute owl-active windows and the adjudicated-row
// set (a hit's row coordinate persists, so re-ingest is inert).

import { log } from "../../core/src/log.js";
import type { ConflictHit } from "./scan.js";

/** One timeline record. `at` is the wall-clock ms coordinate; compaction
 *  answers and C hits carry the row uuid they produced or adjudicated. */
function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export interface TimelineEvent {
  t: "enable" | "disable" | "pause" | "resume" | "compact-answer" | "compact-skip" | "c-hit";
  at: number;
  uuid?: string;
  name?: string;
  /** The kept tail's first row id — present on answer-time compact-answer
   *  rows (a hook-answered compaction leaves the engine no row to observe,
   *  so the answer itself records where the summarized prefix ends; the
   *  rewind alignment re-seeds its exemption boundary from here). */
  cut?: string;
}

/** Parse one process's timeline text (jsonl); malformed lines skip. */
export function parseTimelines(lines: string[]): TimelineEvent[] {
  const out: TimelineEvent[] = [];
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line) as TimelineEvent;
      if (typeof parsed?.t === "string" && typeof parsed?.at === "number") out.push(parsed);
    } catch (err) {
      log.info(`timeline parse: malformed line dropped: ${line.slice(0, 50)} — ${errText(err)}`);
      // malformed line — skip, the timeline is best-effort evidence
    }
  }
  return out;
}

/** One owl-active interval: enabled ∧ not conflict-paused, bounded by the
 *  next transition (null end = still active). The first enable/pause
 *  anchors first activation; pre-owl history yields nothing. */
export interface ActiveInterval {
  start: number;
  end: number | null;
}

/** Compute the owl-active windows from the unioned transitions. */
export function activeIntervals(events: readonly TimelineEvent[]): ActiveInterval[] {
  const ordered = [...events].sort((a, b) => a.at - b.at);
  const intervals: ActiveInterval[] = [];
  let open: number | null = null;
  let enabled = false;
  let paused = false;
  for (const e of ordered) {
    const wasActive = enabled && !paused;
    if (e.t === "enable") enabled = true;
    else if (e.t === "disable") enabled = false;
    else if (e.t === "pause") paused = true;
    else if (e.t === "resume") paused = false;
    else continue;
    const isActive = enabled && !paused;
    if (wasActive && !isActive && open !== null) {
      intervals.push({ start: open, end: e.at });
      open = null;
    } else if (!wasActive && isActive) {
      open = e.at;
    }
  }
  if (open !== null) intervals.push({ start: open, end: null });
  return intervals;
}

/** The adjudicated-row coordinate set: C-hit uuids + owl's own answers +
 *  owl's DECLINED compactions that claimed their row coordinate (the skip
 *  is still an owl decision — the resulting native row is owl-known). */
/** The newest answer-time cut anchor across the union (null when owl never
 *  answered a compaction, or none of the answers carried a cut — skips and
 *  claim-consumed rows never do). Restarts re-seed the alignment's
 *  exemption boundary from here: the in-memory note died with the process,
 *  and the engine wrote no row to re-observe. */
export function newestCompactionCut(events: readonly TimelineEvent[]): { uuid: string; at: number } | null {
  let best: { at: number; cut: string } | null = null;
  for (const e of events) {
    if (e.t !== "compact-answer" || typeof e.cut !== "string" || e.cut === "") continue;
    if (best === null || e.at >= best.at) best = { at: e.at, cut: e.cut };
  }
  return best === null ? null : { uuid: best.cut, at: best.at };
}

export function adjudicatedRows(events: readonly TimelineEvent[]): string[] {
  const out: string[] = [];
  for (const e of events) {
    if ((e.t === "c-hit" || e.t === "compact-answer" || e.t === "compact-skip") && typeof e.uuid === "string") {
      out.push(e.uuid);
    }
  }
  return out;
}

/** Channel C's check (pure): does a door-compaction row fall inside an
 *  owl-active window without an owl answer/adjudication on record? Null =
 *  legitimate (pre-owl, disabled-window, paused-window, or already
 *  adjudicated). */
export function checkForeignCompactionRow(
  row: { uuid: string; at: number },
  windows: readonly ActiveInterval[],
  adjudicated: readonly string[],
): ConflictHit | null {
  if (adjudicated.includes(row.uuid)) return null;
  const inside = windows.some((w) => row.at >= w.start && (w.end === null || row.at < w.end));
  if (!inside) return null;
  return { channel: "C", name: "foreign compaction", evidence: `row ${row.uuid}` };
}
