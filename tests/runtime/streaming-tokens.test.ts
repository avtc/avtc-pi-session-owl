// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import type { AgentEvent, AgentMessage } from "@earendil-works/pi-agent-core";
import { describe, expect, it } from "vitest";
import { deltaTextOf, deltaTokens, messageEndUsage, streamedOutputUsage } from "../../src/runtime/streaming-tokens.js";

function messageWith(usage: unknown): AgentMessage {
  return usage as AgentMessage;
}

function messageUpdate(payload: unknown): AgentEvent {
  return payload as unknown as AgentEvent;
}

describe("messageEndUsage", () => {
  it("reads input/output/cacheRead/cost off an assistant message carrying usage", () => {
    const u = messageEndUsage(messageWith({ usage: { input: 10, output: 20, cacheRead: 5, cost: { total: 3 } } }));
    expect(u).toEqual({ input: 10, output: 20, cacheRead: 5, cost: 3 });
  });

  it("returns null for a message with no usage (prompt/steering messages)", () => {
    expect(messageEndUsage(messageWith({}))).toBeNull();
  });

  it("treats missing sub-fields as zero rather than undefined", () => {
    const u = messageEndUsage(messageWith({ usage: { output: 7 } }));
    expect(u).toEqual({ input: 0, output: 7, cacheRead: 0, cost: 0 });
  });
});

describe("streamedOutputUsage", () => {
  it("reads message.usage.output off a message_update when the provider streams usage", () => {
    const ev = messageUpdate({ type: "message_update", message: { usage: { output: 42 } } });
    expect(streamedOutputUsage(ev)).toBe(42);
  });

  it("returns null for a message_update without usage", () => {
    const ev = messageUpdate({ type: "message_update", message: {} });
    expect(streamedOutputUsage(ev)).toBeNull();
  });

  it("returns null for non-message_update events", () => {
    expect(streamedOutputUsage({ type: "turn_end" } as unknown as AgentEvent)).toBeNull();
  });
});

describe("deltaTextOf", () => {
  it("extracts the delta string for text/thinking/toolcall deltas", () => {
    expect(
      deltaTextOf(
        messageUpdate({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "hi" } }),
      ),
    ).toBe("hi");
    expect(
      deltaTextOf(
        messageUpdate({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "thought" } }),
      ),
    ).toBe("thought");
    expect(
      deltaTextOf(
        messageUpdate({ type: "message_update", assistantMessageEvent: { type: "toolcall_delta", delta: '{"a"' } }),
      ),
    ).toBe('{"a"');
  });

  it("returns null for message_update events that are not text/thinking/toolcall deltas", () => {
    expect(
      deltaTextOf(messageUpdate({ type: "message_update", assistantMessageEvent: { type: "message_start" } })),
    ).toBeNull();
  });

  it("returns null for non-message_update events", () => {
    expect(deltaTextOf({ type: "turn_end" } as unknown as AgentEvent)).toBeNull();
  });
});

describe("deltaTokens", () => {
  it("estimates chars/4 (ceil) of a delta string", () => {
    expect(deltaTokens("")).toBe(0);
    expect(deltaTokens("abcdefgh")).toBe(2);
    expect(deltaTokens("abcdefghi")).toBe(3);
  });
});
