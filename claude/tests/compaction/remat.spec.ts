// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import type { SessionMessage } from "claude-code";
// The remat expectation suite: a hook-answered compaction's materialized
// rows are matched in order against the answer's own message list and
// stamped `remat` (skipped by the grouper — the originals' entries are the
// observation sources; the fresh rows are the platform re-persisting the
// same content under new uuids).
import { beforeEach, describe, expect, test, vi } from "vitest";
import type { ClaudeRow } from "../../host/capture/grouper.js";
import { _resetRematExpectations, matchRematRow, setRematExpectation } from "../../host/compaction/remat.js";

function contentRow(uuid: string, parentUuid: string | null, over: Partial<ClaudeRow>): ClaudeRow {
  return {
    uuid,
    parentUuid,
    door: "prompt",
    origin: { kind: "composer" },
    message: { type: "user", content: [] },
    ...over,
  };
}

const SUMMARY: SessionMessage = { role: "user", text: "# Memory\nthe roots", toolUses: [] };
const KEPT_USER: SessionMessage = { role: "user", text: "Here is reference document 4 (kept tail)", toolUses: [] };
const KEPT_ASSISTANT: SessionMessage = { role: "assistant", text: "got-4", toolUses: [] };

describe("remat expectation matcher", () => {
  beforeEach(() => {
    _resetRematExpectations();
    vi.useRealTimers();
  });

  test("the fold block matches in order; boundary/ceremony/attachment rows pass through unconsumed", () => {
    setRematExpectation("conv", [SUMMARY, KEPT_USER, KEPT_ASSISTANT]);
    // the engine's own boundary row rides inside the block — not one of ours
    expect(
      matchRematRow(
        "conv",
        contentRow("b1", null, {
          door: "compaction",
          message: { type: "user", content: [{ type: "text", text: "Conversation compacted" }] },
        }),
      ),
    ).toBe(false);
    // the summary row (a built user row → door note)
    expect(
      matchRematRow(
        "conv",
        contentRow("s1", "b1", {
          door: "note",
          message: { type: "user", content: [{ type: "text", text: SUMMARY.text }] },
        }),
      ),
    ).toBe(true);
    // kept user row (door note)
    expect(
      matchRematRow(
        "conv",
        contentRow("f1", "s1", {
          door: "note",
          message: { type: "user", content: [{ type: "text", text: KEPT_USER.text }] },
        }),
      ),
    ).toBe(true);
    // an attachment row inside the block does not consume
    expect(
      matchRematRow(
        "conv",
        contentRow("at1", "f1", { door: "attachment", message: { type: "attachment", content: [] } }),
      ),
    ).toBe(false);
    // kept assistant row (door response — the leak this matcher closes)
    expect(
      matchRematRow(
        "conv",
        contentRow("f2", "at1", {
          door: "response",
          message: { type: "assistant", content: [{ type: "text", text: KEPT_ASSISTANT.text }] } as never,
        }),
      ),
    ).toBe(true);
    // the list is exhausted: the next ceremony/content row is a normal row
    expect(
      matchRematRow(
        "conv",
        contentRow("c1", "f2", {
          door: "command",
          message: { type: "user", content: [{ type: "text", text: "/compact" }] },
        }),
      ),
    ).toBe(false);
  });

  test("a content row that does not match abandons the expectation — never skip a real row", () => {
    setRematExpectation("conv", [SUMMARY, KEPT_USER]);
    // the arriving user row's text differs from the expected summary
    expect(
      matchRematRow(
        "conv",
        contentRow("x1", null, {
          door: "note",
          message: { type: "user", content: [{ type: "text", text: "something else entirely" }] },
        }),
      ),
    ).toBe(false);
    // the expectation is gone: even the exact expected text no longer matches
    expect(
      matchRematRow(
        "conv",
        contentRow("x2", "x1", {
          door: "note",
          message: { type: "user", content: [{ type: "text", text: SUMMARY.text }] },
        }),
      ),
    ).toBe(false);
  });

  test("a role mismatch also abandons (an assistant row where a user row was expected)", () => {
    setRematExpectation("conv", [KEPT_USER]);
    expect(
      matchRematRow(
        "conv",
        contentRow("a9", null, {
          door: "response",
          message: { type: "assistant", content: [{ type: "text", text: KEPT_USER.text }] } as never,
        }),
      ),
    ).toBe(false);
    expect(
      matchRematRow(
        "conv",
        contentRow("u9", "a9", {
          door: "note",
          message: { type: "user", content: [{ type: "text", text: KEPT_USER.text }] },
        }),
      ),
    ).toBe(false);
  });

  test("an empty expected text matches the platform's placeholder row (a thinking-only kept message)", () => {
    setRematExpectation("conv", [{ role: "assistant", text: "", toolUses: [] }, KEPT_ASSISTANT]);
    expect(
      matchRematRow(
        "conv",
        contentRow("p1", null, {
          door: "response",
          message: { type: "assistant", content: [{ type: "text", text: "(no content)" }] } as never,
        }),
      ),
    ).toBe(true);
    // the expectation is still armed: the next kept row matches too
    expect(
      matchRematRow(
        "conv",
        contentRow("p2", "p1", {
          door: "response",
          message: { type: "assistant", content: [{ type: "text", text: KEPT_ASSISTANT.text }] } as never,
        }),
      ),
    ).toBe(true);
  });

  test("the placeholder matches only an empty expected text", () => {
    setRematExpectation("conv", [KEPT_ASSISTANT]);
    expect(
      matchRematRow(
        "conv",
        contentRow("p3", null, {
          door: "response",
          message: { type: "assistant", content: [{ type: "text", text: "(no content)" }] } as never,
        }),
      ),
    ).toBe(false);
  });

  test("no expectation for the key → false", () => {
    expect(
      matchRematRow(
        "conv",
        contentRow("n1", null, {
          door: "note",
          message: { type: "user", content: [{ type: "text", text: SUMMARY.text }] },
        }),
      ),
    ).toBe(false);
  });

  test("an expectation older than the window never matches (stale state cannot skip rows)", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    setRematExpectation("conv", [SUMMARY]);
    vi.setSystemTime(1_000_000 + 10 * 60_000);
    expect(
      matchRematRow(
        "conv",
        contentRow("s9", null, {
          door: "note",
          message: { type: "user", content: [{ type: "text", text: SUMMARY.text }] },
        }),
      ),
    ).toBe(false);
  });

  test("per-conversation keys: another conversation's fold does not consume this one's expectation", () => {
    setRematExpectation("conv-a", [SUMMARY]);
    setRematExpectation("conv-b", [KEPT_USER]);
    expect(
      matchRematRow(
        "conv-b",
        contentRow("b1", null, {
          door: "note",
          message: { type: "user", content: [{ type: "text", text: KEPT_USER.text }] },
        }),
      ),
    ).toBe(true);
    // conv-a's expectation is untouched
    expect(
      matchRematRow(
        "conv-a",
        contentRow("a1", null, {
          door: "note",
          message: { type: "user", content: [{ type: "text", text: SUMMARY.text }] },
        }),
      ),
    ).toBe(true);
  });
});
