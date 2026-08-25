// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// renderAgentMessages — the dump renderer: AgentMessage[] → the Observer chunk
// tag grammar (USER/ASSISTANT/THINKING/TOOLCALL:name/TOOLRESULT), full fidelity
// (no caps, thinking included, redacted skipped, results paired to their calls).

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { describe, expect, it } from "vitest";
import { renderAgentMessages } from "../../src/format/chunk.js";

function user(text: string): AgentMessage {
  return { role: "user", content: text, timestamp: 0 } as AgentMessage;
}

function toolResult(callId: string, text: string, isError: boolean): AgentMessage {
  return {
    role: "toolResult",
    toolCallId: callId,
    toolName: "ls",
    content: [{ type: "text", text }],
    isError,
  } as unknown as AgentMessage;
}

/** An assistant message carrying the given content parts (usage boilerplate shared). */
function assistantMsg(content: unknown[]): AgentMessage {
  return {
    role: "assistant",
    content,
    api: "openai",
    provider: "openai",
    model: "test-model",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: 0,
  } as unknown as AgentMessage;
}

describe("renderAgentMessages", () => {
  it("renders a user message as <USER>", () => {
    expect(renderAgentMessages([user("Organize the graph.")])).toBe("<USER>Organize the graph.</USER>");
  });

  it("renders assistant thinking + text as THINKING and ASSISTANT blocks, in content order", () => {
    const out = renderAgentMessages([
      assistantMsg([
        { type: "thinking", thinking: "Thinking: plan first" },
        { type: "text", text: "done" },
      ]),
    ]);
    expect(out).toContain("<THINKING>plan first</THINKING>"); // 'Thinking:' prefix stripped
    expect(out).toContain("<ASSISTANT>done</ASSISTANT>");
    expect(out.indexOf("<THINKING>")).toBeLessThan(out.indexOf("<ASSISTANT>"));
  });

  it("skips redacted thinking even though fidelity is full", () => {
    const out = renderAgentMessages([
      assistantMsg([
        { type: "thinking", thinking: "secret", thinkingSignature: "sig", redacted: true },
        { type: "text", text: "visible" },
      ]),
    ]);
    expect(out).not.toContain("secret");
    expect(out).toContain("<ASSISTANT>visible</ASSISTANT>");
  });

  it("pairs each TOOLCALL with its TOOLRESULT (absorbed right after the call, orphans standalone)", () => {
    const call = (id: string, name: string, args: unknown): AgentMessage =>
      assistantMsg([{ type: "toolCall", id, name, arguments: args }]);
    const out = renderAgentMessages([
      call("c1", "mkdir", { summary: "decisions" }),
      call("c2", "ls", { path: "n8" }),
      toolResult("c2", "3 nodes", false),
      toolResult("c1", "created n12", false),
    ]);
    // c1's result arrives after c2's — pairing pulls it up, adjacency preserved
    const c1 = out.indexOf("<TOOLCALL:mkdir>");
    const r1 = out.indexOf("<TOOLRESULT>created n12</TOOLRESULT>");
    const c2 = out.indexOf("<TOOLCALL:ls>");
    const r2 = out.indexOf("<TOOLRESULT>3 nodes</TOOLRESULT>");
    expect(c1).toBeLessThan(r1);
    expect(r1).toBeLessThan(c2);
    expect(c2).toBeLessThan(r2);
    expect(out).toContain(`<TOOLCALL:mkdir>{"summary":"decisions"}</TOOLCALL>`);
  });

  it("marks error results with the error attribute", () => {
    const call = assistantMsg([{ type: "toolCall", id: "c1", name: "merge", arguments: {} }]);
    const out = renderAgentMessages([call, toolResult("c1", "no such node", true)]);
    expect(out).toContain("<TOOLRESULT error>no such node</TOOLRESULT>");
  });

  it("renders an orphan result (no matching call) standalone, in place", () => {
    const orphan = toolResult("ghost", "late result", false);
    const withText = assistantMsg([{ type: "text", text: "summary" }]);
    const out = renderAgentMessages([withText, orphan]);
    expect(out).toContain("<ASSISTANT>summary</ASSISTANT>");
    expect(out.indexOf("<ASSISTANT>")).toBeLessThan(out.indexOf("<TOOLRESULT>late result</TOOLRESULT>"));
  });

  it("keeps full fidelity — no truncation markers on long content", () => {
    const long = "x".repeat(10_000);
    const out = renderAgentMessages([user(long)]);
    expect(out).toContain(long);
    expect(out).not.toContain("[…truncated…]");
  });
});
