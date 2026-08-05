// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { beforeEach, describe, expect, it } from "vitest";
import { clearDetailsCache, computeDetailsCounts, renderDetails } from "../../src/format/details.js";
import { estimateContentTokens } from "../../src/types.js";

// --- fake session entries (SessionEntry-shaped) ----------------------------

function userEntry(id: string, text: string): SessionEntry {
  return {
    type: "message",
    id,
    parentId: null,
    timestamp: 0,
    message: { role: "user", content: text, timestamp: 0 },
  } as unknown as SessionEntry;
}

/** An assistant entry with a tool call, plus its paired result entry. */
function toolPair(
  callId: string,
  toolName: string,
  args: object,
  resultId: string,
  resultText: string,
  isError: boolean,
): { call: SessionEntry; result: SessionEntry } {
  const call = {
    type: "message",
    id: callId,
    parentId: null,
    timestamp: 0,
    message: {
      role: "assistant",
      content: [{ type: "toolCall", id: "tc1", name: toolName, arguments: args }],
      api: "anthropic",
      provider: "anthropic",
      model: "m",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
      stopReason: "stop",
      timestamp: 0,
    },
  } as unknown as SessionEntry;
  const result = {
    type: "message",
    id: resultId,
    parentId: null,
    timestamp: 1,
    message: {
      role: "toolResult",
      toolCallId: "tc1",
      toolName,
      content: [{ type: "text", text: resultText }],
      isError,
      timestamp: 1,
    },
  } as unknown as SessionEntry;
  return { call, result };
}

// --- resolver fakes --------------------------------------------------------

/** A resolver backed by an id->entry map; missing ids dropped (graceful). */
function resolverFor(entries: SessionEntry[]): (ids: readonly string[]) => readonly unknown[] {
  const map = new Map(entries.map((e) => [e.id, e]));
  return (ids) => ids.map((id) => map.get(id)).filter((e): e is SessionEntry => e !== undefined);
}

describe("renderDetails", () => {
  beforeEach(() => clearDetailsCache());

  it("renders the verbatim source from sourceEntryIds, untruncated, in the chunk tag format WITHOUT entry=id", () => {
    const { call, result } = toolPair("c1", "bash", { command: "npm test" }, "r1", "all passing", false);
    const resolve = resolverFor([call, result]);
    const out = renderDetails("o1", ["c1", "r1"], resolve);
    expect(out).not.toBeNull();
    // toolcall+result paired (interleaved), full verbatim, NO entry= attribute (recall consumer)
    expect(out?.text).toBe('<TOOLCALL:bash>{"command":"npm test"}</TOOLCALL><TOOLRESULT>all passing</TOOLRESULT>');
  });

  it("includes thinking and never truncates (full verbatim, independent of observer config)", () => {
    const longResult = "x".repeat(5000);
    const { call, result } = toolPair("c1", "read", { path: "/f" }, "r1", longResult, false);
    const resolve = resolverFor([call, result]);
    const out = renderDetails("o2", ["c1", "r1"], resolve);
    // the full long result is present (toolBlockCapTokens=null — untruncated)
    expect(out?.text).toContain(longResult);
    expect(out?.text).not.toContain("[…truncated…]");
  });

  it("returns null when no source entries resolve (source_unavailable)", () => {
    const resolve = resolverFor([userEntry("u1", "hi")]);
    // "9" and "x" are not in the resolver's map → all missing → null
    expect(renderDetails("o3", ["9", "x"], resolve)).toBeNull();
  });

  it("returns null for empty sourceEntryIds", () => {
    expect(renderDetails("o4", [], resolverFor([]))).toBeNull();
  });

  it("counts lines and tokens (chars/4) of the rendered text", () => {
    const e = userEntry("u1", "line one\nline two\nline three");
    const resolve = resolverFor([e]);
    const out = renderDetails("o5", ["u1"], resolve);
    expect(out?.text).toBe("<USER>line one\nline two\nline three</USER>");
    expect(out?.lines).toBe(3); // three lines
    expect(out?.tokens).toBe(estimateContentTokens(out?.text ?? ""));
  });

  it("caches the render per observation id (second call is a cache hit, same object)", () => {
    const e = userEntry("u1", "hello");
    const resolve = resolverFor([e]);
    const first = renderDetails("o6", ["u1"], resolve);
    // a resolver that throws if called (proves the cache is hit, not re-resolved)
    const throwingResolve = (): readonly unknown[] => {
      throw new Error("resolver should not be called on a cache hit");
    };
    const second = renderDetails("o6", ["u1"], throwingResolve);
    expect(second).toEqual(first); // same rendered value
  });

  it("clearDetailsCache forces a re-render on the next call", () => {
    const e = userEntry("u1", "first");
    const resolve = resolverFor([e]);
    renderDetails("o7", ["u1"], resolve);
    clearDetailsCache();
    // after clear, a different resolver is used (re-render happens)
    const e2 = userEntry("u1", "second");
    const resolve2 = resolverFor([e2]);
    const out = renderDetails("o7", ["u1"], resolve2);
    expect(out?.text).toBe("<USER>second</USER>");
  });
});

describe("computeDetailsCounts", () => {
  beforeEach(() => clearDetailsCache());

  it("returns the verbatim-source line + token counts (no text, no cache)", () => {
    const { call, result } = toolPair("c1", "bash", { command: "npm test" }, "r1", "line a\nline b", false);
    const resolve = resolverFor([call, result]);
    const counts = computeDetailsCounts(["c1", "r1"], resolve);
    expect(counts).not.toBeNull();
    // text is '<TOOLCALL:bash>{...}</TOOLCALL><TOOLRESULT>line a\nline b</TOOLRESULT>'
    const expectedText = '<TOOLCALL:bash>{"command":"npm test"}</TOOLCALL><TOOLRESULT>line a\nline b</TOOLRESULT>';
    expect(counts?.lines).toBe(2); // two lines in the result text
    expect(counts?.tokens).toBe(estimateContentTokens(expectedText));
    // computeDetailsCounts returns only counts (no text field)
    expect(counts).not.toHaveProperty("text");
  });

  it("does NOT populate the details cache (capture counts must not cache every obs)", () => {
    const e = userEntry("u1", "hello");
    const resolve = resolverFor([e]);
    computeDetailsCounts(["u1"], resolve);
    // a resolver that throws proves renderDetails did NOT hit a cache populated by computeDetailsCounts
    const throwingResolve = (): readonly unknown[] => {
      throw new Error("cache should not have been populated by computeDetailsCounts");
    };
    expect(() => renderDetails("o8", ["u1"], throwingResolve)).toThrow();
  });

  it("returns null when no source entries resolve (source_unavailable)", () => {
    const resolve = resolverFor([userEntry("u1", "hi")]);
    expect(computeDetailsCounts(["9", "x"], resolve)).toBeNull();
  });
});
