// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import type { ConflictHit } from "./scan.js";
// Channel C — the integrity safety net at Observer row ingest: a
// door-"compaction" row counts as a foreign override only when it
// is temporally inside an owl-active window of this session (after owl's
// first activation, inside an enabled ∧ not-paused interval). The hit
// ADJUDICATES its row: the hit + row coordinate persist in the timeline,
// so later ingests of the same row are inert; the pause clears on the
// reload-wave recompute like every other channel's hits.
import { activeIntervals, adjudicatedRows, checkForeignCompactionRow, type TimelineEvent } from "./timeline.js";

/** The ingest-side io seam (the wiring supplies it). */
export interface ChannelCIo {
  /** The unioned timeline events across this session's processes. */
  readTimelines: () => Promise<TimelineEvent[]>;
  /** Append one event to this process's timeline (adjudication persists). */
  appendEvent: (event: TimelineEvent) => Promise<void>;
}

/**
 * Observe one row at Observer ingest. Returns the hit when the row is a
 * foreign compaction inside an owl-active window (null = legitimate:
 * pre-owl history, disabled/paused windows, owl's own answer, or already
 * adjudicated); a hit is appended to the timeline before returning, so its
 * re-ingest is inert.
 */
export async function observeCompactionRow(
  row: { uuid: string; at: number; door: string },
  io: ChannelCIo,
  now: number,
): Promise<ConflictHit | null> {
  if (row.door !== "compaction") return null;
  const unioned = await io.readTimelines();
  const hit = checkForeignCompactionRow(row, activeIntervals(unioned), adjudicatedRows(unioned));
  if (hit !== null) {
    await io.appendEvent({ t: "c-hit", at: now, uuid: row.uuid, name: hit.name });
  }
  return hit;
}

/** Record owl's own compaction answer (the produced row coordinate, when
 *  known) — an owl-answered coordinate is never foreign. */
export async function recordCompactAnswer(uuid: string | null, io: ChannelCIo, now: number): Promise<void> {
  await io.appendEvent({ t: "compact-answer", at: now, ...(uuid !== null ? { uuid } : {}) });
}
