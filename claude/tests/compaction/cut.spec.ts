// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import type { SessionMessage } from "claude-code";
// The cut — the kept-tail computation (the ported pi stack rule): walk back
// from the newest message accumulating chars/4 token estimates until
// approximately `keepRecentTokens` is retained; boundaries keep every tool
// result with its call; kept rows pass through handle-bearing.
import { describe, expect, test } from "vitest";
import { computeKeptTail, estimateMessageTokens } from "../../host/compaction/cut.js";

/** A message sized in chars: pad×4 ≈ pad tokens (chars/4). */
function msg(role: "user" | "assistant", pad: number, over: Record<string, unknown> = {}): SessionMessage {
  return { role, text: "x".repeat(pad), toolUses: [], ...over } as SessionMessage;
}

/** A call/result pair: assistant toolUses (real block shape — tool_use_id,
 *  tool, input) + the user toolResults answer ({tool_use_id, text, isError}). */
function pair(id: string, pad: number): [SessionMessage, SessionMessage] {
  return [
    {
      role: "assistant",
      text: `call ${id} ${"x".repeat(pad)}`,
      toolUses: [{ tool_use_id: id, tool: "owl_recall", input: { query: "y".repeat(pad) } }],
    } as unknown as SessionMessage,
    {
      role: "user",
      text: `pair ${"x".repeat(pad)}`,
      toolUses: [],
      toolResults: [{ tool_use_id: id, text: "r".repeat(pad), isError: false }],
    } as unknown as SessionMessage,
  ];
}

describe("estimateMessageTokens — chars/4 over the message's text and tool blocks", () => {
  test("text-only message: chars/4", () => {
    expect(estimateMessageTokens(msg("user", 400))).toBe(100);
    expect(estimateMessageTokens(msg("assistant", 0))).toBe(0);
  });

  test("the call side counts the tool NAME as well as the input (pi's sizing rule)", () => {
    const short = {
      role: "assistant",
      text: "",
      toolUses: [{ tool_use_id: "t", tool: "ls", input: { path: "/w" } }],
    } as unknown as SessionMessage;
    const long = {
      role: "assistant",
      text: "",
      toolUses: [{ tool_use_id: "t", tool: "owl_find_all".repeat(4), input: { path: "/w" } }],
    } as unknown as SessionMessage;
    const diff = estimateMessageTokens(long) - estimateMessageTokens(short);
    expect(diff).toBeGreaterThanOrEqual(4); // the name difference (44 chars) / 4
  });

  test("a completed pair is counted exactly ONCE: the call's input + the result's text", () => {
    const [call, result] = pair("t1", 200);
    expect(estimateMessageTokens(call)).toBeGreaterThanOrEqual(100); // text + input JSON
    expect(estimateMessageTokens(result)).toBeGreaterThanOrEqual(100); // text + result text
    // the pair's OUTCOME text appears on the RESULT side only — the call
    // block's own outcome copy is never counted (no double count)
    const withOutcomeCopy = {
      role: "assistant",
      text: "c",
      toolUses: [{ tool_use_id: "t9", tool: "x", input: {}, text: "z".repeat(4000), result: "z".repeat(4000) }],
    } as unknown as SessionMessage;
    expect(estimateMessageTokens(withOutcomeCopy)).toBeLessThan(50);
  });
});

describe("computeKeptTail — the walk-back rule", () => {
  test("whole tail kept when the transcript fits the budget", () => {
    const messages = [msg("user", 200), msg("assistant", 200), msg("user", 200)];
    const { kept, firstKeptIndex } = computeKeptTail(messages, 200);
    expect(kept).toHaveLength(3);
    expect(firstKeptIndex).toBe(0);
  });

  test("the cut drops the oldest messages once the budget is crossed (crossing message kept)", () => {
    // 10× 400-char messages ≈ 100 tokens each; budget 250 ⇒ keep the newest ~3
    const messages = Array.from({ length: 10 }, (_, i) => msg(i % 2 === 0 ? "user" : "assistant", 400));
    const { kept, firstKeptIndex } = computeKeptTail(messages, 250);
    expect(firstKeptIndex).toBe(7); // 3 newest (indexes 7,8,9 ≈ 300 ≥ 250 after the crossing message)
    expect(kept).toEqual(messages.slice(7));
  });

  test("kept rows pass through HANDLE-BEARING (the engine stands them whole)", () => {
    const messages = [
      msg("user", 400),
      { role: "assistant", text: "y".repeat(400), toolUses: [], handle: "h-1" } as SessionMessage,
      { role: "user", text: "z".repeat(400), toolUses: [], handle: "h-2" } as SessionMessage,
    ];
    const { kept } = computeKeptTail(messages, 150); // newest two ≈ 200 tokens
    expect(kept.map((m) => m.handle)).toEqual(["h-1", "h-2"]);
  });

  test("a tool result stays with its call — the boundary extends to include the call", () => {
    // newest-first accumulation stops INSIDE a pair: the result is kept, its
    // call must come along even though the budget alone would cut between them
    const [call, result] = pair("t1", 400);
    const messages = [msg("user", 4000), msg("assistant", 4000), call, result, msg("user", 100)];
    const { kept, firstKeptIndex } = computeKeptTail(messages, 130);
    // budget 130 ⇒ newest(25) + result(≈100+) ≈ 125+ crosses; the pair stays whole
    expect(firstKeptIndex).toBe(2);
    expect(kept[0]).toBe(call);
    expect(kept[1]).toBe(result);
  });

  test("budget smaller than every message still keeps the crossing (newest) message", () => {
    const messages = [msg("user", 4000), msg("assistant", 4000)];
    const { kept, firstKeptIndex } = computeKeptTail(messages, 10);
    expect(firstKeptIndex).toBe(1);
    expect(kept).toEqual([messages[1]]);
  });

  test("a degenerate zero budget still keeps the newest message", () => {
    const messages = [msg("user", 4000), msg("assistant", 4000)];
    const { kept, firstKeptIndex } = computeKeptTail(messages, 0);
    expect(firstKeptIndex).toBe(1);
    expect(kept).toEqual([messages[1]]);
  });

  test("empty transcript ⇒ empty tail, cut at the head", () => {
    const { kept, firstKeptIndex } = computeKeptTail([], 20_000);
    expect(kept).toEqual([]);
    expect(firstKeptIndex).toBe(0);
  });
});
