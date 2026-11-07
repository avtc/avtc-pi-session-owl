// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// The pi owl_compact tool: the validation paths (off refusal, the context
// floor, the scheduled stash) and the settled-boundary fire (notes through
// customInstructions, the followUp on both outcomes, the stash cleanup).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { firePendingCompactAtSettled, makeOwlCompactTool } from "../../src/compaction/agent-compact.js";
import {
  clearPendingCompact,
  OWL_COMPACT_CONTINUE_PROMPT,
  OWL_COMPACT_DISABLED_TEXT,
  OWL_COMPACT_KEY,
  OWL_COMPACT_SCHEDULED_TEXT,
  peekPendingCompact,
  setPendingCompact,
} from "../../src/compaction/agent-compact-core.js";
import { _resetGetSessionOwlSettings, _setGetSessionOwlSettings, DEFAULT_CONFIG } from "../../src/config/schema.js";

let owlEnabled = true;

function setAgentCompact(value: string): void {
  _setGetSessionOwlSettings(() => ({ ...DEFAULT_CONFIG, agentCompact: value, enabled: owlEnabled }));
}

function setEnabled(value: boolean): void {
  owlEnabled = value;
}

/** Run the tool's execute with the engine-side arguments filled in. */
async function runTool(
  tool: ReturnType<typeof makeOwlCompactTool>,
  params: { continue_notes: string },
  ctx: unknown,
): Promise<{ content: { type: string; text?: string }[] }> {
  type Execute = ReturnType<typeof makeOwlCompactTool>["execute"];
  type Ctx = Parameters<Execute>[4];
  const outcome = await tool.execute("t", params, undefined, undefined, ctx as Ctx);
  return outcome as { content: { type: string; text?: string }[] };
}

function firstText(result: { content: { type: string; text?: string }[] }): string {
  return result.content.find((b) => b.type === "text")?.text ?? "";
}

describe("the owl_compact tool execute", () => {
  beforeEach(() => {
    clearPendingCompact(OWL_COMPACT_KEY);
    _resetGetSessionOwlSettings();
    owlEnabled = true;
  });

  it("schedules: stashes the notes and answers the scheduled text", async () => {
    setAgentCompact("on");
    const tool = makeOwlCompactTool();
    const result = await runTool(tool, { continue_notes: "finish the parser, then run the battery" }, {});
    expect(firstText(result)).toBe(OWL_COMPACT_SCHEDULED_TEXT);
    expect(peekPendingCompact(OWL_COMPACT_KEY)?.notes).toBe("finish the parser, then run the battery");
  });

  it("refuses when the setting is off mid-session", async () => {
    setAgentCompact("off");
    const tool = makeOwlCompactTool();
    const result = await runTool(tool, { continue_notes: "x" }, {});
    expect(firstText(result)).toBe(OWL_COMPACT_DISABLED_TEXT);
    expect(peekPendingCompact(OWL_COMPACT_KEY)).toBeNull();
  });

  it("refuses under the floor with the measured context", async () => {
    setAgentCompact("on>40k");
    const ctx = {
      getContextUsage: async () => ({ tokens: 25_000, contextWindow: 200_000, percent: 12.5 }),
    };
    const tool = makeOwlCompactTool();
    const result = await runTool(tool, { continue_notes: "x" }, ctx);
    expect(firstText(result)).toBe("compaction not scheduled: context at 25k is below the user set 40k threshold");
    expect(peekPendingCompact(OWL_COMPACT_KEY)).toBeNull();
  });

  it("refuses when owl is disabled (a dormant owl is compaction-transparent)", async () => {
    setAgentCompact("on");
    setEnabled(false);
    const tool = makeOwlCompactTool();
    const result = await runTool(tool, { continue_notes: "x" }, {});
    expect(firstText(result)).toBe(OWL_COMPACT_DISABLED_TEXT);
    expect(peekPendingCompact(OWL_COMPACT_KEY)).toBeNull();
  });

  it("schedules above the floor", async () => {
    setAgentCompact("on>40k");
    const ctx = { getContextUsage: async () => ({ tokens: 60_000, contextWindow: 200_000, percent: 30 }) };
    const tool = makeOwlCompactTool();
    const result = await runTool(tool, { continue_notes: "x" }, ctx);
    expect(firstText(result)).toBe(OWL_COMPACT_SCHEDULED_TEXT);
  });
});

describe("firePendingCompactAtSettled", () => {
  beforeEach(() => {
    clearPendingCompact(OWL_COMPACT_KEY);
    _resetGetSessionOwlSettings();
    owlEnabled = true;
  });

  afterEach(() => {
    _resetGetSessionOwlSettings();
  });

  function makeCtx(overrides: { isIdle?: () => boolean; hasPendingMessages?: () => boolean } | null) {
    return {
      compact: vi.fn(),
      isIdle: overrides?.isIdle ?? (() => true),
      hasPendingMessages: overrides?.hasPendingMessages ?? (() => false),
    };
  }

  function makePi() {
    return { sendUserMessage: vi.fn() };
  }

  it("is a no-op without a pending request", () => {
    setAgentCompact("on");
    const ctx = makeCtx(null);
    firePendingCompactAtSettled(ctx as unknown as Parameters<typeof firePendingCompactAtSettled>[0], makePi());
    expect(ctx.compact).not.toHaveBeenCalled();
  });

  it("passes the notes as customInstructions", () => {
    setAgentCompact("on");
    peekSet("the plan");
    const ctx = makeCtx(null);
    const pi = makePi();
    firePendingCompactAtSettled(ctx as unknown as Parameters<typeof firePendingCompactAtSettled>[0], pi);
    expect(ctx.compact).toHaveBeenCalledWith(expect.objectContaining({ customInstructions: "the plan" }));
  });

  it("onComplete sends the continuation followUp", () => {
    vi.useFakeTimers();
    setAgentCompact("on");
    peekSet("the plan");
    const ctx = makeCtx(null);
    const pi = makePi();
    firePendingCompactAtSettled(ctx as unknown as Parameters<typeof firePendingCompactAtSettled>[0], pi);
    const options = ctx.compact.mock.calls[0]?.[0] as { onComplete: () => void };
    options.onComplete();
    expect(pi.sendUserMessage).not.toHaveBeenCalled();
    vi.advanceTimersByTime(600);
    expect(pi.sendUserMessage).toHaveBeenCalledWith(OWL_COMPACT_CONTINUE_PROMPT, { deliverAs: "followUp" });
    vi.useRealTimers();
  });

  it("onError clears the stash and sends NO continuation (a failed compact stays failed)", () => {
    vi.useFakeTimers();
    setAgentCompact("on");
    peekSet("the plan");
    const ctx = makeCtx(null);
    const pi = makePi();
    firePendingCompactAtSettled(ctx as unknown as Parameters<typeof firePendingCompactAtSettled>[0], pi);
    // the compaction hook never ran (nothing to compact): the stash survives
    // the compact call itself — the error callback must drop it
    const options = ctx.compact.mock.calls[0]?.[0] as { onError: (err: Error) => void };
    options.onError(new Error("Nothing to compact"));
    expect(peekPendingCompact(OWL_COMPACT_KEY)).toBeNull();
    vi.advanceTimersByTime(600);
    expect(pi.sendUserMessage).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("a sync rejection clears the stash and sends NO continuation", () => {
    vi.useFakeTimers();
    setAgentCompact("on");
    peekSet("the plan");
    const ctx = {
      compact: vi.fn(() => {
        throw new Error("busy");
      }),
    };
    const pi = makePi();
    firePendingCompactAtSettled(ctx as unknown as Parameters<typeof firePendingCompactAtSettled>[0], pi);
    expect(peekPendingCompact(OWL_COMPACT_KEY)).toBeNull();
    vi.advanceTimersByTime(600);
    expect(pi.sendUserMessage).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("a user steer that started a run owns the continuation (the follow-up never sends)", () => {
    vi.useFakeTimers();
    setAgentCompact("on");
    peekSet("the plan");
    const ctx = makeCtx({ isIdle: () => false }); // the steer's run is streaming
    const pi = makePi();
    firePendingCompactAtSettled(ctx as unknown as Parameters<typeof firePendingCompactAtSettled>[0], pi);
    const options = ctx.compact.mock.calls[0]?.[0] as { onComplete: () => void };
    options.onComplete();
    vi.advanceTimersByTime(600);
    expect(pi.sendUserMessage).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("a queued steer waiting to deliver owns the continuation too", () => {
    vi.useFakeTimers();
    setAgentCompact("on");
    peekSet("the plan");
    const ctx = makeCtx({ hasPendingMessages: () => true });
    const pi = makePi();
    firePendingCompactAtSettled(ctx as unknown as Parameters<typeof firePendingCompactAtSettled>[0], pi);
    const options = ctx.compact.mock.calls[0]?.[0] as { onComplete: () => void };
    options.onComplete();
    vi.advanceTimersByTime(600);
    expect(pi.sendUserMessage).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("drops the request when the setting flipped off after the call", () => {
    setAgentCompact("off");
    peekSet("the plan");
    const ctx = makeCtx(null);
    firePendingCompactAtSettled(ctx as unknown as Parameters<typeof firePendingCompactAtSettled>[0], makePi());
    expect(ctx.compact).not.toHaveBeenCalled();
    expect(peekPendingCompact(OWL_COMPACT_KEY)).toBeNull();
  });
});

function peekSet(notes: string): void {
  setPendingCompact(OWL_COMPACT_KEY, notes);
}
