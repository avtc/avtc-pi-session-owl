// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// The per-session conflict timeline: per-process
// timeline-<processId>.jsonl in the session dir holding enable/disable and
// pause/resume transitions plus compaction answers/skips with coordinates;
// the union read across processes feeds Channel C's owl-active windows and
// the adjudication set that keeps re-ingest inert.
import { describe, expect, test } from "vitest";
import {
  activeIntervals,
  adjudicatedRows,
  checkForeignCompactionRow,
  newestCompactionCut,
  parseTimelines,
  type TimelineEvent,
} from "../../host/conflicts/timeline.js";

const ev = (t: TimelineEvent["t"], at: number, extra: Partial<TimelineEvent> = {}): TimelineEvent =>
  ({
    t,
    at,
    ...extra,
  }) as TimelineEvent;

describe("conflicts timeline — parsing + active windows", () => {
  test("jsonl lines parse; malformed lines are skipped, never throw", () => {
    const events = parseTimelines(['{"t":"enable","at":100}', "{broken", '{"t":"pause","at":200}']);
    expect(events).toEqual([ev("enable", 100), ev("pause", 200)]);
  });

  test("owl-active intervals: enabled and not paused, after first activation", () => {
    const events = [ev("enable", 100), ev("pause", 200), ev("resume", 300), ev("disable", 400), ev("enable", 500)];
    expect(activeIntervals(events)).toEqual([
      { start: 100, end: 200 },
      { start: 300, end: 400 },
      { start: 500, end: null },
    ]);
  });

  test("a pause before any enable yields no interval (first activation bounds)", () => {
    expect(activeIntervals([ev("pause", 100), ev("resume", 200)])).toEqual([]);
  });

  test("union across processes: two timelines interleave by coordinate", () => {
    const a = [ev("enable", 100), ev("disable", 600)];
    const b = [ev("pause", 200), ev("resume", 500)];
    expect(activeIntervals([...a, ...b])).toEqual([
      { start: 100, end: 200 },
      { start: 500, end: 600 },
    ]);
  });

  test("newestCompactionCut: the newest cut-bearing compact-answer wins; cut-less answers are ignored", () => {
    expect(
      newestCompactionCut([
        ev("compact-answer", 100, { cut: "u2" }),
        ev("compact-answer", 260, { uuid: "row-y" }), // the claim-consumed row carries no cut
        ev("compact-answer", 200, { cut: "u5" }),
        ev("compact-skip", 300, {}),
      ]),
    ).toEqual({ uuid: "u5", at: 200 });
    expect(newestCompactionCut([ev("compact-skip", 10, {}), ev("compact-answer", 20, { uuid: "r" })])).toBeNull();
  });
});

describe("conflicts timeline — Channel C adjudication", () => {
  const active = activeIntervals([ev("enable", 100)]);

  test("a door-compaction row inside an owl-active window with no owl answer on record hits", () => {
    const r = checkForeignCompactionRow({ uuid: "row-1", at: 200 }, active, []);
    expect(r).toEqual({ channel: "C", name: "foreign compaction", evidence: "row row-1" });
  });

  test("a row before owl's first activation is the host's legitimate history — no hit", () => {
    expect(checkForeignCompactionRow({ uuid: "row-0", at: 50 }, active, [])).toBeNull();
  });

  test("a row inside a disabled or paused window is legitimate — no hit", () => {
    const windows = activeIntervals([ev("enable", 100), ev("disable", 150), ev("enable", 300)]);
    expect(checkForeignCompactionRow({ uuid: "r1", at: 200 }, windows, [])).toBeNull();
    expect(checkForeignCompactionRow({ uuid: "r2", at: 350 }, windows, [])).toEqual({
      channel: "C",
      name: "foreign compaction",
      evidence: "row r2",
    });
  });

  test("an owl-answered coordinate is not foreign; an adjudicated row never re-hits", () => {
    // owl's own compaction answer carries the row it produced
    const answered = ["row-own"];
    expect(checkForeignCompactionRow({ uuid: "row-own", at: 200 }, active, answered)).toBeNull();
    const adjudicated = ["row-1"];
    expect(checkForeignCompactionRow({ uuid: "row-1", at: 200 }, active, adjudicated)).toBeNull();
  });

  test("adjudicatedRows reads the c-hit events back (the persisted coordinate set)", () => {
    const events = [
      ev("enable", 100),
      ev("c-hit", 250, { uuid: "row-x", name: "foreign compaction" }),
      ev("compact-answer", 260, { uuid: "row-y" }),
    ];
    expect(adjudicatedRows(events)).toEqual(["row-x", "row-y"]);
  });
});

test("adjudicatedRows includes compact-skip coordinates (an owl-declined native row is owl-known)", () => {
  const uuids = adjudicatedRows([
    { t: "compact-skip", at: 5, uuid: "skip-row" },
    { t: "compact-skip", at: 6 }, // uuid-less skip claims nothing
    { t: "compact-answer", at: 7, uuid: "answer-row" },
    { t: "c-hit", at: 8, uuid: "hit-row" },
  ]);
  expect(uuids.sort()).toEqual(["answer-row", "hit-row", "skip-row"]);
});
