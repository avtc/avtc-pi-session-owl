// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { describe, expect, test } from "vitest";
import {
  collectTailThinking,
  renderThinkingSection,
  THINKING_SECTION_HEADING,
} from "../../host/compaction/thinking.js";

function msg(id: string, role: "user" | "assistant", content: unknown): SessionEntry {
  return {
    id,
    type: "message",
    at: id,
    message: { role, content: content as never },
  } as unknown as SessionEntry;
}

function thinking(text: string, redacted = false): Record<string, unknown> {
  return { type: "thinking", thinking: text, ...(redacted ? { redacted: true } : {}) };
}

describe("collectTailThinking", () => {
  test("collects the kept tail's assistant thinking, oldest first; redacted skipped", () => {
    const entries: SessionEntry[] = [
      msg("e1", "assistant", [{ type: "thinking", thinking: "before the cut" }]),
      msg("e2", "user", "go"),
      msg("e3", "assistant", [thinking("first kept"), { type: "text", text: "answer" }]),
      msg("e4", "user", "again"),
      msg("e5", "assistant", [thinking("redacted one", true), { type: "tool_use", id: "t1" }]),
      msg("e6", "assistant", [thinking("Thinking: second kept")]),
    ];
    expect(collectTailThinking(entries, "e3")).toEqual(["first kept", "second kept"]);
  });

  test("a null boundary reads the whole view (the cut's fallback rule)", () => {
    const entries: SessionEntry[] = [msg("e1", "assistant", [thinking("only")])];
    expect(collectTailThinking(entries, null)).toEqual(["only"]);
  });

  test("user thinking-shaped content never applies; ANSI + lead-in sanitized", () => {
    const entries: SessionEntry[] = [
      msg("e1", "user", [{ type: "text", text: "plain" }]),
      msg("e2", "assistant", [thinking("\u001b[2mThinking: shaded\u001b[22m")]),
    ];
    expect(collectTailThinking(entries, null)).toEqual(["shaded"]);
  });
});

describe("renderThinkingSection", () => {
  test("null when nothing to carry; otherwise the heading plus separated blocks", () => {
    expect(renderThinkingSection([])).toBeNull();
    const section = renderThinkingSection(["one", "two"]);
    expect(section).not.toBeNull();
    expect((section as string).startsWith(THINKING_SECTION_HEADING)).toBe(true);
    expect(section).toContain("one");
    expect(section).toContain("---");
    expect(section).toContain("two");
  });
});
