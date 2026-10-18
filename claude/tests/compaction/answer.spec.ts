// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import type { SessionMessage } from "claude-code";
// The answer — message assembly for the takeover: ONE handle-less user-role
// message whose text is renderSummary(...) verbatim (owl's own `# Memory`
// header opens it; the engine's continuation preamble is reserved for
// engine-authored summaries), followed by the kept tail as received; the
// token bracket around the takeover; the veto shape.
import { describe, expect, test } from "vitest";
import { buildSkip, buildTakeover, estimateTokensAfter, summaryMessage } from "../../host/compaction/answer.js";

const SUMMARY = "# Memory\n\nthe rendered root view…";

function keptRow(handle: string): SessionMessage {
  return { role: "user", text: `kept ${handle}`, toolUses: [], handle } as SessionMessage;
}

describe("summaryMessage — the one handle-less user-role summary", () => {
  test("user role, no handle, text VERBATIM (owl's own header; no engine preamble)", () => {
    const m = summaryMessage(SUMMARY);
    expect(m.role).toBe("user");
    expect(m.text).toBe(SUMMARY); // byte-identical, nothing prepended
    expect(m.handle).toBeUndefined(); // handle-less: the engine BUILDS it
    expect(m.toolUses).toEqual([]);
  });
});

describe("buildTakeover — the compaction answer", () => {
  test("messages = [summary, ...keptTail HANDLE-STRIPPED]; token bracket carried; usage ABSENT", () => {
    const kept = [keptRow("h-1"), keptRow("h-2")];
    const result = buildTakeover({ summary: SUMMARY, kept, tokensBefore: 27_356, tokensAfter: 2381 });
    expect(result.skip).toBeUndefined();
    expect(result.messages).toHaveLength(3);
    expect(result.messages[0]?.text).toBe(SUMMARY);
    expect(result.messages[0]?.handle).toBeUndefined();
    // handle-stripped: a handle-bearing kept row re-persists with its
    // pre-boundary parent linkage, and the resume parent-walk then goes
    // around the boundary — every kept row
    // is handed back BUILT (role/text/toolUses[/toolResults]), never whole
    expect(result.messages[1]).toEqual({ role: "user", text: "kept h-1", toolUses: [] });
    expect(result.messages[2]).toEqual({ role: "user", text: "kept h-2", toolUses: [] });
    for (const m of result.messages) expect(m.handle).toBeUndefined();
    expect(result.tokensBefore).toBe(27_356);
    expect(result.tokensAfter).toBe(2381);
    expect("usage" in result && result.usage !== undefined).toBe(false); // owl's stage cost lives in owl's ledger, not the engine field
  });

  test("kept tail fields survive the strip (toolUses + toolResults copied, handle dropped)", () => {
    const kept: SessionMessage[] = [
      {
        role: "assistant",
        text: "running the tool",
        toolUses: [{ id: "tu-1", name: "Bash", input: { command: "ls" }, outcome: "ok" }],
        handle: "h-a",
      } as unknown as SessionMessage,
      {
        role: "user",
        text: "",
        toolResults: [{ tool_use_id: "tu-1", text: "file-a\nfile-b" }],
        handle: "h-b",
      } as unknown as SessionMessage,
    ];
    const result = buildTakeover({ summary: SUMMARY, kept });
    expect(result.messages[1]?.handle).toBeUndefined();
    expect(result.messages[1]?.toolUses).toEqual(kept[0]?.toolUses);
    expect(result.messages[2]?.handle).toBeUndefined();
    expect(result.messages[2]?.toolResults).toEqual(kept[1]?.toolResults);
  });

  test("empty kept tail ⇒ the summary alone", () => {
    const result = buildTakeover({ summary: SUMMARY, kept: [] });
    expect(result.messages).toHaveLength(1);
    expect(result.tokensBefore).toBeUndefined(); // bracket fields optional
    expect(result.tokensAfter).toBeUndefined();
  });
});

describe("buildSkip — the veto", () => {
  test("{skip: reason} with no messages field", () => {
    const result = buildSkip("session-owl compaction failed: boom; retry");
    expect(result).toEqual({ skip: "session-owl compaction failed: boom; retry" });
  });
});

describe("estimateTokensAfter — the post-takeover size estimate", () => {
  test("chars/4 over the answer's messages (summary + tail)", () => {
    const messages = [summaryMessage("x".repeat(400)), keptRow("h-1")];
    // summary 400 chars + kept text 9 chars ⇒ ~103 tokens
    const estimate = estimateTokensAfter(messages);
    expect(estimate).toBeGreaterThanOrEqual(100);
    expect(estimate).toBeLessThanOrEqual(110);
  });
});
