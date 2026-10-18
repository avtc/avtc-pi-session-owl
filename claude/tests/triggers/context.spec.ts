// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// The narrow host inputs the vendored trigger evaluation consumes: the
// per-session context-usage snapshots (session.measure is session-scoped —
// the MAIN conversation's fill; subagent loops never get one, so their
// context-threshold arms skip on unknown context) and the pi-shaped ctx
// adapter (getLeafId/getBranch from the storage layer, getContextUsage from
// the latest snapshot, thinking level from settings).
import { beforeEach, describe, expect, test } from "vitest";
import {
  _resetMeasureSnapshots,
  contextTokensFor,
  makeTriggerCtx,
  pruneMeasures,
  recordMeasure,
  seedWindow,
  windowFor,
} from "../../host/triggers/context.js";

const MAIN = "sess-1";
const LOOP = "sess-1|ag-9";

describe("measure snapshots — the contextTokens source", () => {
  beforeEach(() => {
    _resetMeasureSnapshots();
  });

  test("record + read: the latest snapshot's fill serves the MAIN conversation", () => {
    expect(contextTokensFor(MAIN)).toBeNull(); // unknown before any measure
    recordMeasure(MAIN, { tokens: 12_000, window: 200_000 });
    expect(contextTokensFor(MAIN)).toBe(12_000);
    recordMeasure(MAIN, { tokens: 15_000, window: 200_000 });
    expect(contextTokensFor(MAIN)).toBe(15_000); // latest wins
  });

  test("a snapshot without a fill reads as unknown (null)", () => {
    recordMeasure(MAIN, { window: 200_000 }); // no tokens field
    expect(contextTokensFor(MAIN)).toBeNull();
  });

  test("loop keys never see the main conversation's fill (unknown context on loops ⇒ the arms skip)", () => {
    recordMeasure(MAIN, { tokens: 12_000, window: 200_000 });
    expect(contextTokensFor(LOOP)).toBeNull();
    expect(contextTokensFor("other-session")).toBeNull();
  });

  test("seedWindow records the window before any measure (widget denominator at first step)", () => {
    expect(windowFor(MAIN)).toBeNull();
    seedWindow(MAIN, 128_000);
    expect(windowFor(MAIN)).toBe(128_000);
    expect(contextTokensFor(MAIN)).toBeNull(); // a window seed never claims a fill
  });

  test("seedWindow never clobbers a measured fill (window refresh is the measure's)", () => {
    recordMeasure(MAIN, { tokens: 12_000, window: 200_000 });
    seedWindow(MAIN, 99_000); // a startup re-seed after a resume
    expect(windowFor(MAIN)).toBe(200_000);
    expect(contextTokensFor(MAIN)).toBe(12_000);
    recordMeasure(MAIN, { tokens: 13_000, window: 128_000 }); // a later measure supersedes
    expect(windowFor(MAIN)).toBe(128_000);
    expect(contextTokensFor(MAIN)).toBe(13_000);
  });
});

describe("makeTriggerCtx — the pi-shaped ctx adapter", () => {
  test("sessionManager reads come from the storage layer; getContextUsage from the snapshot", () => {
    _resetMeasureSnapshots();
    const leaf = "u9";
    const branch = [{ id: "u8" }, { id: "u9" }] as never;
    const ctx = makeTriggerCtx({
      key: MAIN,
      getLeafId: () => leaf,
      getBranch: (id: string | null) => (id === leaf ? branch : []),
      thinkingLevel: "medium",
    });
    expect(ctx.sessionManager.getLeafId()).toBe(leaf);
    expect(ctx.sessionManager.getBranch(leaf)).toBe(branch);
    expect(ctx.getContextUsage()).toBeUndefined(); // no snapshot yet
    recordMeasure(MAIN, { tokens: 12_000, window: 200_000 });
    expect(ctx.getContextUsage()?.tokens).toBe(12_000);
    expect(ctx.thinkingLevel).toBe("medium");
  });
});

describe("pruneMeasures — production teardown", () => {
  test("drops every snapshot at session end (stale fills feed nothing)", () => {
    _resetMeasureSnapshots();
    recordMeasure("sess-a", { tokens: 10_000, window: 200_000 });
    recordMeasure("sess-b", { tokens: 20_000, window: 200_000 });
    pruneMeasures();
    expect(contextTokensFor("sess-a")).toBeNull();
    expect(contextTokensFor("sess-b")).toBeNull();
  });
});
