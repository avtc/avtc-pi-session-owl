// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// The notify adapter seam for the host run modules: pi's runs call
// notify(ctx, message, level) (ctx.ui.notify); on the engine the user-facing
// surface is $.ui.log (the ui.log adapter the binding wires in; the
// logger-only default serves callers without a surface) — the messages
// and levels are pi's verbatim, so the adapter is a pure transport swap.
import { describe, expect, test } from "vitest";
import {
  countCompactionsFromBranch,
  loggerNotify,
  NO_OP_WIDGET,
  sessionStartMsFromBranch,
} from "../../host/runs/seams.js";

describe("loggerNotify (the logger-only default adapter)", () => {
  test("writes message + level through the log sink", () => {
    const lines: string[] = [];
    const notify = loggerNotify((m) => lines.push(m));
    notify("Observer returned no observations", "warning");
    expect(lines).toEqual(["session-owl: Observer returned no observations"]);
  });

  test("messages pass through unchanged at every level (the level rides the adapter, not the log line)", () => {
    const lines: string[] = [];
    const notify = loggerNotify((m) => lines.push(m));
    notify("a", "info");
    notify("b", "error");
    expect(lines).toEqual(["session-owl: a", "session-owl: b"]);
  });

  test("multi-line messages pass through whole (splitting is the ui.log adapter's rule)", () => {
    const lines: string[] = [];
    const notify = loggerNotify((m) => lines.push(m));
    notify("one\ntwo", "warning");
    expect(lines).toEqual(["session-owl: one\ntwo"]);
  });
});

describe("NO_OP_WIDGET", () => {
  test("absorbs every stage call without throwing", () => {
    expect(() => {
      NO_OP_WIDGET.startStage("observe", { batch: { done: 0, total: 2 } });
      NO_OP_WIDGET.setBatch(1, 2);
      NO_OP_WIDGET.setPass(2);
      NO_OP_WIDGET.onEvent({ type: "x" });
      NO_OP_WIDGET.invalidateRoots();
      NO_OP_WIDGET.render();
      NO_OP_WIDGET.endStage();
    }).not.toThrow();
  });
});

describe("sessionStartMsFromBranch — the branch's first entry is the session's birth (pi's readSessionBounds)", () => {
  test("reads and parses the first entry timestamp", () => {
    const ms = sessionStartMsFromBranch(
      [
        { type: "message", id: "a", parentId: null, timestamp: "2026-10-14T08:00:00.000Z" },
        { type: "compaction", id: "b", parentId: "a", timestamp: "2026-10-16T01:00:00.000Z" },
      ],
      1,
    );
    expect(ms).toBe(Date.parse("2026-10-14T08:00:00.000Z"));
  });

  test("an empty branch falls back (never NaN)", () => {
    expect(sessionStartMsFromBranch([], 123_456)).toBe(123_456);
  });

  test("an unparseable timestamp falls back (pi's NaN guard)", () => {
    expect(
      sessionStartMsFromBranch([{ type: "message", id: "a", parentId: null, timestamp: "not-a-date" }], 654_321),
    ).toBe(654_321);
  });
});

describe("countCompactionsFromBranch — unchanged (regression)", () => {
  test("counts only compaction entries", () => {
    const store = {
      getBranch: () => [
        { type: "message", id: "a" },
        { type: "compaction", id: "b" },
        { type: "message", id: "c" },
        { type: "compaction", id: "d" },
      ],
      getLeafId: () => "d",
    } as never;
    expect(countCompactionsFromBranch(store)).toBe(2);
  });
});
