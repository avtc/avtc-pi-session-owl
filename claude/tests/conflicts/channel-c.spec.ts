// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// Channel C — the Observer-ingest integrity net: the hit
// adjudicates its row (the coordinate persists in the timeline, re-ingest
// inert); owl's own answers record their coordinate and never read as
// foreign.
import { describe, expect, test } from "vitest";
import { type ChannelCIo, observeCompactionRow, recordCompactAnswer } from "../../host/conflicts/channel-c.js";
import type { TimelineEvent } from "../../host/conflicts/timeline.js";

function makeIo(seed: TimelineEvent[] = []): ChannelCIo & { events: TimelineEvent[] } {
  const events = [...seed];
  return {
    events,
    readTimelines: async () => events,
    appendEvent: async (e) => {
      events.push(e);
    },
  };
}

describe("conflicts Channel C — the integrity net", () => {
  test("a compaction row inside an owl-active window hits and adjudicates (re-ingest inert)", async () => {
    const io = makeIo([{ t: "enable", at: 100 }]);
    const first = await observeCompactionRow({ uuid: "row-1", at: 200, door: "compaction" }, io, 250);
    expect(first).toEqual({ channel: "C", name: "foreign compaction", evidence: "row row-1" });
    expect(io.events).toContainEqual({ t: "c-hit", at: 250, uuid: "row-1", name: "foreign compaction" });
    const again = await observeCompactionRow({ uuid: "row-1", at: 200, door: "compaction" }, io, 300);
    expect(again).toBeNull(); // adjudicated — inert
  });

  test("non-compaction doors never hit; pre-owl and paused-window rows are legitimate", async () => {
    const io = makeIo([
      { t: "enable", at: 100 },
      { t: "pause", at: 150 },
      { t: "resume", at: 300 },
    ]);
    expect(await observeCompactionRow({ uuid: "r0", at: 120, door: "prompt" }, io, 130)).toBeNull();
    expect(await observeCompactionRow({ uuid: "r1", at: 50, door: "compaction" }, io, 130)).toBeNull();
    expect(await observeCompactionRow({ uuid: "r2", at: 200, door: "compaction" }, io, 210)).toBeNull();
    expect(await observeCompactionRow({ uuid: "r3", at: 350, door: "compaction" }, io, 360)).toEqual({
      channel: "C",
      name: "foreign compaction",
      evidence: "row r3",
    });
  });

  test("owl's own answer records its coordinate and is never foreign", async () => {
    const io = makeIo([{ t: "enable", at: 100 }]);
    await recordCompactAnswer("row-own", io, 200);
    expect(await observeCompactionRow({ uuid: "row-own", at: 210, door: "compaction" }, io, 220)).toBeNull();
  });
});
