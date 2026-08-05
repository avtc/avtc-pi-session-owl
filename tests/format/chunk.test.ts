// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import type {
  AssistantMessage,
  Message,
  TextContent,
  ThinkingContent,
  ToolCall,
  ToolResultMessage,
  Usage,
} from "@earendil-works/pi-ai";
import type {
  BranchSummaryEntry,
  CustomMessageEntry,
  SessionEntry,
  SessionMessageEntry,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { buildChunks, type ChunkOptions, hasAssistantText, renderBlocks } from "../../src/format/chunk.js";

// --- fixtures ---------------------------------------------------------------

const USAGE: Usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const FIXED_TS = "2026-07-29T00:00:00Z";

function msg(id: string, message: Message): SessionMessageEntry {
  return { type: "message", id, parentId: null, timestamp: FIXED_TS, message };
}

function userEntry(id: string, text: string): SessionMessageEntry {
  return msg(id, { role: "user", content: text, timestamp: 0 });
}

function assistantEntry(id: string, blocks: (TextContent | ThinkingContent | ToolCall)[]): SessionMessageEntry {
  const message: AssistantMessage = {
    role: "assistant",
    content: blocks,
    api: "anthropic",
    provider: "anthropic",
    model: "m",
    usage: USAGE,
    stopReason: "stop",
    timestamp: 0,
  };
  return msg(id, message);
}

function toolResultEntry(
  id: string,
  toolCallId: string,
  toolName: string,
  text: string,
  isError: boolean,
): SessionMessageEntry {
  const message: ToolResultMessage = {
    role: "toolResult",
    toolCallId,
    toolName,
    content: [{ type: "text", text }],
    isError,
    timestamp: 0,
  };
  return msg(id, message);
}

function customMessageEntry(id: string, content: string): CustomMessageEntry {
  return {
    type: "custom_message",
    id,
    parentId: null,
    timestamp: "2026-07-29T00:00:00Z",
    customType: "x",
    content,
    display: true,
  };
}

function branchSummaryEntry(id: string, summary: string): BranchSummaryEntry {
  return {
    type: "branch_summary",
    id,
    parentId: null,
    timestamp: "2026-07-29T00:00:00Z",
    fromId: "old",
    summary,
  };
}

const NO_CAP: ChunkOptions = {
  tokenThreshold: Number.POSITIVE_INFINITY,
  toolBlockCapTokens: null,
  includeThinking: true,
  includeEntryId: true,
};

// --- tag & entry=id shape -------------------------------------------------------

describe("renderBlocks: tags and entry=id attribute", () => {
  it("renders a user message as <USER entry=id>text</USER>", () => {
    const blocks = renderBlocks([userEntry("e1", "hello")], NO_CAP);
    expect(blocks.map((b) => b.text).join("")).toBe("<USER entry=e1>hello</USER>");
  });

  it("renders assistant text as <ASSISTANT entry=id>text</ASSISTANT>", () => {
    const blocks = renderBlocks([assistantEntry("e2", [{ type: "text", text: "hi there" }])], NO_CAP);
    expect(blocks.map((b) => b.text).join("")).toBe("<ASSISTANT entry=e2>hi there</ASSISTANT>");
  });

  it("renders a tool call as <TOOLCALL:name entry=id>args</TOOLCALL> immediately followed by its result <TOOLRESULT entry=rid>", () => {
    const entries: SessionEntry[] = [
      assistantEntry("e2", [{ type: "toolCall", id: "call1", name: "read", arguments: { path: "/x" } }]),
      toolResultEntry("e3", "call1", "read", "ok", false),
    ];
    const text = renderBlocks(entries, NO_CAP)
      .map((b) => b.text)
      .join("");
    expect(text).toBe('<TOOLCALL:read entry=e2>{"path":"/x"}</TOOLCALL><TOOLRESULT entry=e3>ok</TOOLRESULT>');
  });

  it("adds the error attribute on <TOOLRESULT> when the tool result failed (isError)", () => {
    const entries: SessionEntry[] = [
      assistantEntry("e2", [{ type: "toolCall", id: "call1", name: "read", arguments: {} }]),
      toolResultEntry("e3", "call1", "read", "EISDIR: illegal operation", true),
    ];
    const text = renderBlocks(entries, NO_CAP)
      .map((b) => b.text)
      .join("");
    expect(text).toBe(
      "<TOOLCALL:read entry=e2>{}</TOOLCALL><TOOLRESULT entry=e3 error>EISDIR: illegal operation</TOOLRESULT>",
    );
  });

  it("carries entry=id as an attribute on EACH block, never a separate wrapper", () => {
    const entries: SessionEntry[] = [
      userEntry("u1", "hi"),
      assistantEntry("a1", [
        { type: "thinking", thinking: "hmm" },
        { type: "text", text: "yo" },
      ]),
    ];
    const text = renderBlocks(entries, NO_CAP)
      .map((b) => b.text)
      .join("");
    expect(text).not.toContain("<E>");
    expect(text).toContain("entry=u1");
    expect(text).toContain("entry=a1");
  });

  it("does not emit c=callId on tool calls/results (rely on adjacency)", () => {
    const entries: SessionEntry[] = [
      assistantEntry("e2", [{ type: "toolCall", id: "call1", name: "read", arguments: {} }]),
      toolResultEntry("e3", "call1", "read", "ok", false),
    ];
    const text = renderBlocks(entries, NO_CAP)
      .map((b) => b.text)
      .join("");
    expect(text).not.toContain("c=");
  });

  it("does not emit timestamps in rendered text", () => {
    const entries: SessionEntry[] = [userEntry("e1", "hello")];
    const text = renderBlocks(entries, NO_CAP)
      .map((b) => b.text)
      .join("");
    expect(text).not.toContain("2026");
    expect(text).not.toContain("00:00");
  });
});

// --- thinking ---------------------------------------------------------------

describe("renderBlocks: thinking", () => {
  const thinking: ThinkingContent = { type: "thinking", thinking: "Let me think." };

  it("omits thinking blocks when includeThinking is false", () => {
    const opts: ChunkOptions = { ...NO_CAP, includeThinking: false };
    const text = renderBlocks([assistantEntry("a1", [thinking, { type: "text", text: "answer" }])], opts)
      .map((b) => b.text)
      .join("");
    expect(text).toBe("<ASSISTANT entry=a1>answer</ASSISTANT>");
  });

  it("includes thinking as <THINKING entry=id> when includeThinking is true", () => {
    const text = renderBlocks([assistantEntry("a1", [thinking, { type: "text", text: "answer" }])], NO_CAP)
      .map((b) => b.text)
      .join("");
    expect(text).toBe("<THINKING entry=a1>Let me think.</THINKING><ASSISTANT entry=a1>answer</ASSISTANT>");
  });

  it("strips ANSI escape codes from thinking", () => {
    const colored: ThinkingContent = { type: "thinking", thinking: "\u001b[32mLet me think.\u001b[0m" };
    const text = renderBlocks([assistantEntry("a1", [colored])], NO_CAP)
      .map((b) => b.text)
      .join("");
    expect(text).toBe("<THINKING entry=a1>Let me think.</THINKING>");
  });

  it("strips the leading 'Thinking:' prefix from thinking", () => {
    const prefixed: ThinkingContent = { type: "thinking", thinking: "Thinking: Let me think." };
    const text = renderBlocks([assistantEntry("a1", [prefixed])], NO_CAP)
      .map((b) => b.text)
      .join("");
    expect(text).toBe("<THINKING entry=a1>Let me think.</THINKING>");
  });

  it("strips ANSI then the 'Thinking:' prefix (ANSI-colored prefix)", () => {
    const colored: ThinkingContent = {
      type: "thinking",
      thinking: "\u001b[36mThinking:\u001b[0m Let me think.",
    };
    const text = renderBlocks([assistantEntry("a1", [colored])], NO_CAP)
      .map((b) => b.text)
      .join("");
    expect(text).toBe("<THINKING entry=a1>Let me think.</THINKING>");
  });

  it("always skips redacted thinking even when includeThinking is true", () => {
    const redacted: ThinkingContent = {
      type: "thinking",
      thinking: "secret",
      thinkingSignature: "sig",
      redacted: true,
    };
    const text = renderBlocks([assistantEntry("a1", [redacted, { type: "text", text: "answer" }])], NO_CAP)
      .map((b) => b.text)
      .join("");
    expect(text).toBe("<ASSISTANT entry=a1>answer</ASSISTANT>");
  });
});

// --- tool block cap ---------------------------------------------------------

describe("renderBlocks: tool block cap", () => {
  const longArgs = { blob: "x".repeat(2000) };
  const longResult = "y".repeat(2000);

  it("truncates tool args head/tail with a marker when over the cap (tokens→chars)", () => {
    // cap 100 tokens => 400 chars budget; args JSON ~2050 chars => truncate
    const opts: ChunkOptions = { ...NO_CAP, toolBlockCapTokens: 100 };
    const entries: SessionEntry[] = [
      assistantEntry("e2", [{ type: "toolCall", id: "c1", name: "run", arguments: longArgs }]),
      toolResultEntry("e3", "c1", "run", "ok", false),
    ];
    const cBlock = renderBlocks(entries, opts)[0];
    expect(cBlock.text).toContain("[…truncated…]");
    // head is first ~200 chars of the args JSON, tail is last ~200 chars
    const inner = cBlock.text.replace(/^<TOOLCALL:run entry=e2>/, "").replace(/<\/TOOLCALL>$/, "");
    expect(inner.startsWith('{"blob":"xxxx')).toBe(true);
    expect(inner.endsWith('xxxx"}')).toBe(true);
  });

  it("truncates tool results head/tail with a marker when over the cap", () => {
    const opts: ChunkOptions = { ...NO_CAP, toolBlockCapTokens: 100 };
    const entries: SessionEntry[] = [
      assistantEntry("e2", [{ type: "toolCall", id: "c1", name: "run", arguments: {} }]),
      toolResultEntry("e3", "c1", "run", longResult, false),
    ];
    const rBlock = renderBlocks(entries, opts)[1];
    expect(rBlock.text).toContain("[…truncated…]");
    const inner = rBlock.text.replace(/^<TOOLRESULT entry=e3>/, "").replace(/<\/TOOLRESULT>$/, "");
    expect(inner.startsWith("yyyy")).toBe(true);
    expect(inner.endsWith("yyyy")).toBe(true);
  });

  it("renders tool args/results in full when under the cap", () => {
    const opts: ChunkOptions = { ...NO_CAP, toolBlockCapTokens: 10000 };
    const entries: SessionEntry[] = [
      assistantEntry("e2", [{ type: "toolCall", id: "c1", name: "run", arguments: { a: 1 } }]),
      toolResultEntry("e3", "c1", "run", "small result", false),
    ];
    const text = renderBlocks(entries, opts)
      .map((b) => b.text)
      .join("");
    expect(text).toBe('<TOOLCALL:run entry=e2>{"a":1}</TOOLCALL><TOOLRESULT entry=e3>small result</TOOLRESULT>');
  });

  it("renders tool args/results in full when the cap is null (no truncation)", () => {
    const entries: SessionEntry[] = [
      assistantEntry("e2", [{ type: "toolCall", id: "c1", name: "run", arguments: longArgs }]),
      toolResultEntry("e3", "c1", "run", longResult, false),
    ];
    const text = renderBlocks(entries, NO_CAP)
      .map((b) => b.text)
      .join("");
    expect(text).not.toContain("[…truncated…]");
  });
});

// --- entry-type filtering ---------------------------------------------------

describe("renderBlocks: entry-type filtering", () => {
  it("renders custom_message as <USER entry=id>", () => {
    const text = renderBlocks([customMessageEntry("cm1", "injected context")], NO_CAP)
      .map((b) => b.text)
      .join("");
    expect(text).toBe("<USER entry=cm1>injected context</USER>");
  });

  it("renders branch_summary as <USER entry=id>", () => {
    const text = renderBlocks([branchSummaryEntry("bs1", "prior branch summary")], NO_CAP)
      .map((b) => b.text)
      .join("");
    expect(text).toBe("<USER entry=bs1>prior branch summary</USER>");
  });

  it("skips operational entry types (model_change, thinking_level_change, label, session_info, custom)", () => {
    const entries: SessionEntry[] = [
      { type: "model_change", id: "mc1", parentId: null, timestamp: "", provider: "p", modelId: "m" },
      { type: "thinking_level_change", id: "tl1", parentId: null, timestamp: "", thinkingLevel: "high" },
      { type: "label", id: "lb1", parentId: null, timestamp: "", targetId: "x", label: "y" },
      { type: "session_info", id: "si1", parentId: null, timestamp: "" },
      { type: "custom", id: "cu1", parentId: null, timestamp: "", customType: "memkeeper.observation" },
      userEntry("u1", "real"),
    ];
    const text = renderBlocks(entries, NO_CAP)
      .map((b) => b.text)
      .join("");
    expect(text).toBe("<USER entry=u1>real</USER>");
  });
});

// --- buildChunks: token gating & C-R atomicity -----------------------------

describe("buildChunks", () => {
  it("returns {text, allowedIds, lastEntryId} per chunk where allowedIds is exactly the entry= ids in text", () => {
    const entries: SessionEntry[] = [userEntry("u1", "hello world"), userEntry("u2", "bye now")];
    const chunks = buildChunks(entries, {
      tokenThreshold: Number.POSITIVE_INFINITY,
      toolBlockCapTokens: null,
      includeThinking: true,
      includeEntryId: true,
    });
    expect(chunks).toHaveLength(1);
    const only = chunks[0];
    expect(only.text).toBe("<USER entry=u1>hello world</USER><USER entry=u2>bye now</USER>");
    expect(only.allowedIds).toEqual(new Set(["u1", "u2"]));
    // lastEntryId = the highest-branch-position entry in the chunk (blocks in entry order)
    expect(only.lastEntryId).toBe("u2");
  });

  it("splits at the token threshold (entry-bounded)", () => {
    // each block ~ many tokens; threshold small => multiple chunks
    const entries: SessionEntry[] = [
      userEntry("u1", "a".repeat(400)), // ~100 tokens
      userEntry("u2", "b".repeat(400)), // ~100 tokens
    ];
    const chunks = buildChunks(entries, {
      tokenThreshold: 100,
      toolBlockCapTokens: null,
      includeThinking: true,
      includeEntryId: true,
    });
    expect(chunks.length).toBe(2);
    expect(chunks[0].text).toBe(`<USER entry=u1>${"a".repeat(400)}</USER>`);
    expect(chunks[1].text).toBe(`<USER entry=u2>${"b".repeat(400)}</USER>`);
    // each chunk's lastEntryId is its own tail (entry-order blocks) — the basis
    // for advancing the frontier without re-scanning the gap per chunk.
    expect(chunks[0].lastEntryId).toBe("u1");
    expect(chunks[1].lastEntryId).toBe("u2");
  });

  it("never splits a C from its R across chunk boundaries", () => {
    // A C-R pair whose combined size crosses the threshold must stay together.
    const bigArgs = "x".repeat(400);
    const entries: SessionEntry[] = [
      assistantEntry("a1", [{ type: "toolCall", id: "c1", name: "run", arguments: { blob: bigArgs } }]),
      toolResultEntry("r1", "c1", "run", "y".repeat(400), false),
    ];
    const chunks = buildChunks(entries, {
      tokenThreshold: 50, // tiny => would split if C-R were separable
      toolBlockCapTokens: null,
      includeThinking: true,
      includeEntryId: true,
    });
    // both ids land in the same chunk
    const owning = chunks.filter((c) => c.allowedIds.has("a1") || c.allowedIds.has("r1"));
    expect(owning).toHaveLength(1);
    expect(owning[0].allowedIds).toEqual(new Set(["a1", "r1"]));
    expect(owning[0].text).toContain("entry=a1");
    expect(owning[0].text).toContain("entry=r1");
  });

  it("keeps a multi-block assistant entry's blocks in order with its tool calls paired", () => {
    const entries: SessionEntry[] = [
      assistantEntry("a1", [
        { type: "text", text: "step 1" },
        { type: "thinking", thinking: "plan" },
        { type: "toolCall", id: "c1", name: "ls", arguments: {} },
      ]),
      toolResultEntry("r1", "c1", "ls", "out", false),
      userEntry("u2", "next"),
    ];
    const chunks = buildChunks(entries, {
      tokenThreshold: Number.POSITIVE_INFINITY,
      toolBlockCapTokens: null,
      includeThinking: true,
      includeEntryId: true,
    });
    expect(chunks[0].text).toBe(
      "<ASSISTANT entry=a1>step 1</ASSISTANT><THINKING entry=a1>plan</THINKING><TOOLCALL:ls entry=a1>{}</TOOLCALL><TOOLRESULT entry=r1>out</TOOLRESULT><USER entry=u2>next</USER>",
    );
  });

  it("returns an empty array when no entries produce renderable blocks", () => {
    const entries: SessionEntry[] = [
      { type: "model_change", id: "mc1", parentId: null, timestamp: "", provider: "p", modelId: "m" },
    ];
    const chunks = buildChunks(entries, NO_CAP);
    expect(chunks).toEqual([]);
  });
});

describe("renderBlocks: ANSI stripped from all text (not only thinking)", () => {
  it("strips ANSI from user message text", () => {
    const entry: SessionMessageEntry = msg("u1", {
      role: "user",
      content: "\u001b[31mred hello\u001b[0m world",
      timestamp: 0,
    });
    const text = renderBlocks([entry], NO_CAP)
      .map((b) => b.text)
      .join("");
    expect(text).toBe("<USER entry=u1>red hello world</USER>");
  });

  it("strips ANSI from assistant text", () => {
    const text = renderBlocks([assistantEntry("a1", [{ type: "text", text: "\u001b[32mok\u001b[0m done" }])], NO_CAP)
      .map((b) => b.text)
      .join("");
    expect(text).toBe("<ASSISTANT entry=a1>ok done</ASSISTANT>");
  });

  it("strips ANSI from tool result text", () => {
    const entries: SessionEntry[] = [
      assistantEntry("a1", [{ type: "toolCall", id: "c1", name: "run", arguments: {} }]),
      toolResultEntry("r1", "c1", "run", "\u001b[33mout\u001b[0m put", false),
    ];
    const text = renderBlocks(entries, NO_CAP)
      .map((b) => b.text)
      .join("");
    expect(text).toContain("<TOOLRESULT entry=r1>out put</TOOLRESULT>");
  });

  it("strips ANSI with ':' params (24-bit color) and '?' private modes", () => {
    const colored: ThinkingContent = {
      type: "thinking",
      thinking: "\u001b[38:2:255:0:0m\u001b[?25lx\u001b[0m",
    };
    const text = renderBlocks([assistantEntry("a1", [colored])], NO_CAP)
      .map((b) => b.text)
      .join("");
    expect(text).toBe("<THINKING entry=a1>x</THINKING>");
  });

  it("strips OSC sequences (terminal titles / hyperlinks) and the C1 8-bit intro", () => {
    const osc = "\u001b]0;title\u0007before";
    const c1 = "\u009b31mafter\u009b0m";
    const text = renderBlocks([userEntry("u1", osc + c1)], NO_CAP)
      .map((b) => b.text)
      .join("");
    expect(text).toBe("<USER entry=u1>beforeafter</USER>");
  });

  it("strips OSC-8 hyperlinks terminated by the String Terminator (ESC \\)", () => {
    // OSC-8 hyperlink: \x1b]8;;url\x1b\\ link-text \x1b]8;;\x1b\\
    const link = "\u001b]8;;https://x\u001b\\click\u001b]8;;\u001b\\here";
    const text = renderBlocks([userEntry("u1", link)], NO_CAP)
      .map((b) => b.text)
      .join("");
    expect(text).toBe("<USER entry=u1>clickhere</USER>");
  });
});

describe("buildChunks: entry-bounded (whole entry never split)", () => {
  it("keeps a multi-block assistant entry's text + tool-call in ONE chunk", () => {
    // assistant entry a1 has text + toolCall(+result); a tiny threshold would
    // split it if chunking were per-block — entry-bounding keeps it whole.
    const entries: SessionEntry[] = [
      assistantEntry("a1", [
        { type: "text", text: "x".repeat(400) }, // ~100 tokens
        { type: "toolCall", id: "c1", name: "ls", arguments: {} },
      ]),
      toolResultEntry("r1", "c1", "ls", "y".repeat(400), false),
    ];
    const chunks = buildChunks(entries, {
      tokenThreshold: 50, // tiny — forces a split at the entry boundary only
      toolBlockCapTokens: null,
      includeThinking: true,
      includeEntryId: true,
    });
    // a1's text AND its tool-call land in the same chunk (whole entry)
    const a1Chunks = chunks.filter((c) => c.allowedIds.has("a1"));
    expect(a1Chunks).toHaveLength(1);
    expect(a1Chunks[0].text).toContain("<ASSISTANT entry=a1>");
    expect(a1Chunks[0].text).toContain("<TOOLCALL:ls entry=a1>");
  });

  it("renders multiple tool calls in one assistant entry, each followed by its result", () => {
    const entries: SessionEntry[] = [
      assistantEntry("a1", [
        { type: "toolCall", id: "c1", name: "ls", arguments: {} },
        { type: "toolCall", id: "c2", name: "read", arguments: {} },
      ]),
      toolResultEntry("r1", "c1", "ls", "ls-out", false),
      toolResultEntry("r2", "c2", "read", "read-out", false),
    ];
    const chunks = buildChunks(entries, {
      tokenThreshold: Number.POSITIVE_INFINITY,
      toolBlockCapTokens: null,
      includeThinking: true,
      includeEntryId: true,
    });
    expect(chunks[0].text).toBe(
      "<TOOLCALL:ls entry=a1>{}</TOOLCALL><TOOLRESULT entry=r1>ls-out</TOOLRESULT><TOOLCALL:read entry=a1>{}</TOOLCALL><TOOLRESULT entry=r2>read-out</TOOLRESULT>",
    );
  });

  it("a single oversized entry-group becomes its own chunk (never split mid-entry)", () => {
    const entries: SessionEntry[] = [userEntry("u1", "z".repeat(1000))];
    const chunks = buildChunks(entries, {
      tokenThreshold: 10, // far below the ~250-token block
      toolBlockCapTokens: null,
      includeThinking: true,
      includeEntryId: true,
    });
    expect(chunks).toHaveLength(1);
    expect(chunks[0].allowedIds).toEqual(new Set(["u1"]));
  });
});

describe("renderBlocks: orphan calls and results", () => {
  it("emits an orphan tool call (no matching result) as a bare <TOOLCALL>", () => {
    const text = renderBlocks(
      [assistantEntry("a1", [{ type: "toolCall", id: "c1", name: "ls", arguments: {} }])],
      NO_CAP,
    )
      .map((b) => b.text)
      .join("");
    expect(text).toBe("<TOOLCALL:ls entry=a1>{}</TOOLCALL>");
  });

  it("emits an orphan tool result (no matching call) as a bare <TOOLRESULT>", () => {
    const text = renderBlocks([toolResultEntry("r1", "orphan", "run", "out", false)], NO_CAP)
      .map((b) => b.text)
      .join("");
    expect(text).toBe("<TOOLRESULT entry=r1>out</TOOLRESULT>");
  });
});

describe("renderBlocks: defensive branches", () => {
  it("skips a user message with empty text", () => {
    const entry: SessionMessageEntry = msg("u1", { role: "user", content: "", timestamp: 0 });
    expect(renderBlocks([entry], NO_CAP)).toHaveLength(0);
  });

  it("skips a branch_summary with empty summary", () => {
    expect(renderBlocks([branchSummaryEntry("bs1", "")], NO_CAP)).toHaveLength(0);
  });

  it("skips a branch_summary that is empty after ANSI stripping", () => {
    expect(renderBlocks([branchSummaryEntry("bs1", "\u001b[31m\u001b[0m")], NO_CAP)).toHaveLength(0);
  });

  it("skips an empty thinking block (after sanitization)", () => {
    const text = renderBlocks([assistantEntry("a1", [{ type: "thinking", thinking: "\u001b[31m\u001b[0m" }])], NO_CAP)
      .map((b) => b.text)
      .join("");
    expect(text).toBe("");
  });
});

describe("hasAssistantText", () => {
  it("true for an assistant message with a non-empty text part", () => {
    expect(hasAssistantText(assistantEntry("a1", [{ type: "text", text: "hello" }]))).toBe(true);
  });

  it("false for a tool-call-only assistant message (no text)", () => {
    expect(hasAssistantText(assistantEntry("a2", [{ type: "toolCall", id: "tc1", name: "t", arguments: {} }]))).toBe(
      false,
    );
  });

  it("false for a non-assistant entry (user message)", () => {
    expect(hasAssistantText(userEntry("u1", "hi"))).toBe(false);
  });

  it("false for an assistant message whose text strips to empty (ANSI-only)", () => {
    expect(hasAssistantText(assistantEntry("a3", [{ type: "text", text: "\u001b[31m\u001b[0m" }]))).toBe(false);
  });
});
