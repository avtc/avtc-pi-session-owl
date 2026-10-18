// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// The turn.step relay: abort fabrication, the per-step stall race, the
// per-step output cap, and the no-progress hookup. The relay is driven with
// fake step streams (async generators) + a fake clock — the engine shapes
// (chunk kinds, result fields) mirror the generated types.
import { describe, expect, test } from "vitest";
import { deltaTokens } from "../../core/src/runtime/streaming-tokens.js";
import { estimateContentTokens } from "../../core/src/types.js";
import {
  estimateStepTokens,
  relayTurnStep,
  type StepResult,
  type StepStream,
  type TimerHandle,
} from "../../host/stage/relay.js";
import { clearAllStageRuns, createStageRun, noteAccepted, type StageRunConfig } from "../../host/stage/runs.js";

const CFG: StageRunConfig = { maxTokens: 1000, timeoutMs: 30_000, noProgressTurns: 3 };

type Chunk =
  | { kind: "text"; index: number; text: string }
  | { kind: "thinking"; index: number; text: string }
  | { kind: "tool"; index: number; id: string; name: string }
  | { kind: "input"; index: number; json: string }
  | { kind: "stop"; stopReason: "end_turn" | "max_tokens" | "tool_use"; usage: null }
  | { kind: "engine"; ref: number };

/** Build a next() seam yielding the given chunks then resolving result. */
function fakeStream(chunks: Chunk[], result: Partial<StepResult> = {}): StepStream {
  return async function* step(_e: unknown) {
    for (const c of chunks) yield c as never;
    return {
      turnId: "t1",
      index: 0,
      answer: "",
      toolUses: [],
      stopReason: "end_turn",
      usage: null,
      ...result,
    } as StepResult;
  };
}

/** A never-firing fake clock (tests that need timeouts build their own). */
const noTimer = (_ms: number, _fn: () => void): TimerHandle => ({ cancel: () => {} });

async function collect(gen: AsyncGenerator<unknown, unknown>): Promise<{ chunks: unknown[]; result: StepResult }> {
  const chunks: unknown[] = [];
  let r = await gen.next();
  while (!r.done) {
    chunks.push(r.value);
    r = await gen.next();
  }
  return { chunks, result: r.value as StepResult };
}

describe("relay — abort fabrication", () => {
  test("once the abort flag is set, the step is answered without calling next", async () => {
    clearAllStageRuns();
    const run = createStageRun("ag-abort", "observer", CFG);
    let nextCalls = 0;
    const shapeOnly = false; // flipped never — biome: useYield (shape-only stream)
    const stream: StepStream = async function* (_e) {
      nextCalls += 1;
      if (shapeOnly) yield undefined as never;
      return { turnId: "t", index: 0, answer: "x", toolUses: [], stopReason: "end_turn", usage: null } as StepResult;
    };
    const { result } = await collect(
      relayTurnStep({ turnId: "t", index: 0, agentId: "ag-abort" }, stream, { clockAfter: noTimer }),
    );
    // not aborted yet — the real stream ran
    expect(result.answer).toBe("x");
    expect(nextCalls).toBe(1);

    run.abortFlag = true;
    run.abortReason = "signal";
    const r2 = await collect(
      relayTurnStep({ turnId: "t", index: 1, agentId: "ag-abort" }, stream, { clockAfter: noTimer }),
    );
    expect(nextCalls).toBe(1); // zero real model calls
    expect(r2.result).toMatchObject({
      answer: "",
      toolUses: [],
      stopReason: "end_turn",
      usage: null,
      turnId: "t",
      index: 1,
    });
    expect(r2.chunks).toEqual([]);
    expect(run.dump.fabricatedStop).toBe("signal");
  });
});

describe("relay — stall race", () => {
  test("a step that never produces within timeoutMs is fabricated-stopped and the run timed out", async () => {
    clearAllStageRuns();
    const run = createStageRun("ag-stall", "observer", { ...CFG, timeoutMs: 20 });
    const stream: StepStream = async function* (_e) {
      await new Promise(() => {}); // stalled provider — never a chunk
      return {} as StepResult;
    };
    const clockAfter = (ms: number, fn: () => void): TimerHandle => {
      const t = setTimeout(fn, ms);
      return { cancel: () => clearTimeout(t) };
    };
    const { result } = await collect(
      relayTurnStep({ turnId: "t", index: 0, agentId: "ag-stall" }, stream, { clockAfter }),
    );
    expect(result.stopReason).toBe("end_turn");
    expect(run.timedOut).toBe(true);
    expect(run.abortReason).toBe("timeout");
    expect(run.dump.fabricatedStop).toBe("timeout");
  });

  test("a step that completes inside the window streams normally (timer cancelled)", async () => {
    clearAllStageRuns();
    createStageRun("ag-ok", "observer", { ...CFG, timeoutMs: 1000 });
    let cancelled = 0;
    const clockAfter = (ms: number, fn: () => void): TimerHandle => {
      const t = setTimeout(fn, ms);
      return {
        cancel: () => {
          cancelled += 1;
          clearTimeout(t);
        },
      };
    };
    const { result, chunks } = await collect(
      relayTurnStep(
        { turnId: "t", index: 0, agentId: "ag-ok" },
        fakeStream([{ kind: "text", index: 0, text: "hi" }], { answer: "hi" }),
        { clockAfter },
      ),
    );
    expect(result.answer).toBe("hi");
    expect(chunks).toHaveLength(1);
    // inter-token: one cancel re-arming after the chunk + one at settle
    expect(cancelled).toBe(2);
  });

  test("inter-token: mid-stream silence longer than the window aborts (stuck between tokens)", async () => {
    clearAllStageRuns();
    const run = createStageRun("ag-gap", "observer", { ...CFG, timeoutMs: 30 });
    const stream: StepStream = async function* (_e) {
      yield { kind: "text", index: 0, text: "first" } as never;
      await new Promise(() => {}); // silence — the response never finishes
      return {} as StepResult;
    };
    const clockAfter = (ms: number, fn: () => void): TimerHandle => {
      const t = setTimeout(fn, ms);
      return { cancel: () => clearTimeout(t) };
    };
    const { result } = await collect(
      relayTurnStep({ turnId: "t", index: 0, agentId: "ag-gap" }, stream, { clockAfter }),
    );
    expect(result.stopReason).toBe("end_turn");
    expect(run.timedOut).toBe(true);
    expect(run.abortReason).toBe("timeout");
  });

  test("inter-token: a slow trickle (every gap under the window) never aborts, however long the total", async () => {
    clearAllStageRuns();
    const run = createStageRun("ag-trickle", "observer", { ...CFG, timeoutMs: 500 });
    const stream: StepStream = async function* (_e) {
      for (let i = 0; i < 6; i += 1) {
        await new Promise((r) => setTimeout(r, 20)); // each gap well under the window
        yield { kind: "text", index: 0, text: `t${i}` } as never;
      }
      return { stopReason: "end_turn", answer: "done" } as never;
    };
    const clockAfter = (ms: number, fn: () => void): TimerHandle => {
      const t = setTimeout(fn, ms);
      return { cancel: () => clearTimeout(t) };
    };
    const { result } = await collect(
      relayTurnStep({ turnId: "t", index: 0, agentId: "ag-trickle" }, stream, { clockAfter }),
    );
    expect(run.timedOut).toBe(false);
    expect(result.answer).toBe("done");
  });
});

describe("relay — per-step output cap", () => {
  test("streaming past maxTokens yields a synthetic max_tokens stop and rejects tool calls", async () => {
    clearAllStageRuns();
    createStageRun("ag-cap", "builder", { ...CFG, maxTokens: 10 }); // 10 tokens = 40 chars
    const big = "x".repeat(60);
    const stream = fakeStream(
      [
        { kind: "text", index: 0, text: big },
        { kind: "tool", index: 1, id: "tu-1", name: "mcp__session-owl__mv" },
        { kind: "input", index: 1, json: '{"id":"n1"}' },
        { kind: "stop", stopReason: "tool_use", usage: null },
      ],
      { answer: big, stopReason: "tool_use" },
    );
    const { result, chunks } = await collect(
      relayTurnStep({ turnId: "t", index: 0, agentId: "ag-cap" }, stream, { clockAfter: noTimer }),
    );
    expect(result.stopReason).toBe("max_tokens");
    expect(result.toolUses).toEqual([]);
    expect(result.answer).toBe(big); // the text streamed before the cap stays
    expect(chunks).toHaveLength(1); // only the text chunk relayed; tool/input dropped
  });

  test("estimateStepTokens is the streaming tier: per-chunk ceil(len/4), matching pi's deltaTokens", () => {
    expect(estimateStepTokens("text", "abcd")).toBe(deltaTokens("abcd"));
    expect(estimateStepTokens("text", "abc")).toBe(deltaTokens("abc")); // ceil — 1
    expect(estimateStepTokens("thinking", "ab")).toBe(1);
    expect(estimateStepTokens("input", '{"a":1}')).toBe(2);
    // whole-string tier stays the count floor (the two-tier parity pi keeps)
    expect(estimateStepTokens("text", "x".repeat(400))).toBe(100);
    expect(estimateContentTokens("x".repeat(400))).toBe(100);
  });
});

describe("relay — no-progress", () => {
  test("three zero-accepted steps trip the abort; the next step fabricates", async () => {
    clearAllStageRuns();
    const run = createStageRun("ag-np", "observer", { ...CFG, noProgressTurns: 3 });
    for (let i = 0; i < 3; i += 1) {
      const { result } = await collect(
        relayTurnStep(
          { turnId: "t", index: i, agentId: "ag-np" },
          fakeStream([{ kind: "text", index: 0, text: "chatter" }]),
          { clockAfter: noTimer },
        ),
      );
      expect(result.stopReason).toBe("end_turn"); // real steps until the trip
    }
    expect(run.abortFlag).toBe(true);
    expect(run.abortReason).toBe("no-progress");
    const { result } = await collect(
      relayTurnStep(
        { turnId: "t", index: 3, agentId: "ag-np" },
        fakeStream([{ kind: "text", index: 0, text: "never" }]),
        { clockAfter: noTimer },
      ),
    );
    expect(result.answer).toBe("");
  });

  test("accepted records between steps reset the counter (text alone does not)", async () => {
    clearAllStageRuns();
    const run = createStageRun("ag-np2", "observer", { ...CFG, noProgressTurns: 3 });
    // step 0 asks for the tool; its records land between the steps
    await collect(relayTurnStep({ turnId: "t", index: 0, agentId: "ag-np2" }, fakeStream([]), { clockAfter: noTimer }));
    noteAccepted("ag-np2", 4); // the tool's accepted batch, mid-run
    await collect(relayTurnStep({ turnId: "t", index: 1, agentId: "ag-np2" }, fakeStream([]), { clockAfter: noTimer }));
    expect(run.zeroAcceptedSteps).toBe(0); // step 1 measured the batch
    await collect(relayTurnStep({ turnId: "t", index: 2, agentId: "ag-np2" }, fakeStream([]), { clockAfter: noTimer }));
    expect(run.zeroAcceptedSteps).toBe(1); // the following zero step starts from 1
    expect(run.abortFlag).toBe(false);
    expect(run.abortFlag).toBe(false);
  });
});

describe("relay — mid-stream abort + cap markers", () => {
  test("an abort set mid-stream suppresses the in-flight tool calls (fabricated end)", async () => {
    clearAllStageRuns();
    const run = createStageRun("ag-mid", "builder", { ...CFG, timeoutMs: null });
    const stream: StepStream = async function* (_e) {
      yield { kind: "text", index: 0, text: "starting" };
      run.abortFlag = true; // the signal fires between chunks
      run.abortReason = "signal";
      yield { kind: "tool", index: 1, id: "tu-9", name: "mcp__session-owl__mv" };
      yield { kind: "input", index: 1, json: "{}" };
      return {
        turnId: "t",
        index: 0,
        answer: "starting",
        toolUses: [{ name: "mcp__session-owl__mv", input: {} }],
        stopReason: "tool_use",
        usage: null,
      } as StepResult;
    };
    const { result, chunks } = await collect(
      relayTurnStep({ turnId: "t", index: 0, agentId: "ag-mid" }, stream, { clockAfter: noTimer }),
    );
    expect(chunks).toHaveLength(1); // the text chunk only — the tool chunks never left
    expect(result.toolUses).toEqual([]);
    expect(result.stopReason).toBe("end_turn");
    expect(result.answer).toBe("");
    expect(run.dump.fabricatedStop).toBe("signal");
  });

  test("a cap stop marks the dump (abort/timeout/cap)", async () => {
    clearAllStageRuns();
    const run = createStageRun("ag-capm", "builder", { ...CFG, timeoutMs: null, maxTokens: 10 });
    const big = "y".repeat(80);
    await collect(
      relayTurnStep(
        { turnId: "t", index: 0, agentId: "ag-capm" },
        fakeStream([{ kind: "text", index: 0, text: big }], { answer: big }),
        { clockAfter: noTimer },
      ),
    );
    expect(run.dump.fabricatedStop).toBe("max_tokens");
  });
});

describe("relay — no double capture", () => {
  test("the chunk stream does NOT land in the dump rows (the capture layer's append rows own <output>)", async () => {
    clearAllStageRuns();
    const run = createStageRun("ag-dump", "observer", CFG);
    const chunks: Chunk[] = [
      { kind: "thinking", index: 0, text: "hm" },
      { kind: "text", index: 1, text: "answer body" },
      { kind: "input", index: 2, json: '{"name":"record_observations"}' },
    ];
    await collect(
      relayTurnStep({ turnId: "t", index: 0, agentId: "ag-dump" }, fakeStream(chunks, { answer: "x" }), {
        clockAfter: noTimer,
      }),
    );
    // the relay's chunks feed the token count only — the dump's <output>
    // rows come from the capture layer's append-row recordings (no duplicate
    // stream view alongside the message view)
    expect(run.dump.outputRows).toEqual([]);
  });
});

describe("relay — pass-through", () => {
  test("a step of a non-stage agent (or the main loop) relays untouched", async () => {
    clearAllStageRuns();
    const chunks = [{ kind: "text", index: 0, text: "main" }] as const;
    // the engine's OWN result object — identity must survive (hooks ABOVE
    // owl read the same value: serverToolUses, usage, any future field)
    const chainValue = {
      turnId: "t",
      index: 0,
      answer: "main",
      toolUses: [],
      stopReason: "end_turn",
      usage: { inputTokens: 42, outputTokens: 7 },
      serverToolUses: [{ name: "web_search", input: { q: "x" } }],
    };
    const inlineStream = async function* step(_e: unknown) {
      for (const c of chunks) yield c as never;
      return chainValue as never; // the engine's own object — identity must survive
    };
    const pass = await collect(relayTurnStep({ turnId: "t", index: 0 }, inlineStream, { clockAfter: noTimer }));
    expect(pass.result).toBe(chainValue); // NOT a reconstruction — the chain's own object
    expect(pass.chunks).toHaveLength(1);
    const other = await collect(
      relayTurnStep({ turnId: "t", index: 0, agentId: "someone-else" }, fakeStream([...chunks], { answer: "other" }), {
        clockAfter: noTimer,
      }),
    );
    expect(other.result.answer).toBe("other");
  });
});

describe("relayTurnStep — the widget's live stream", () => {
  test("text/thinking deltas reach the run's event sink as message_update; message_start precedes", async () => {
    const { relayTurnStep } = await import("../../host/stage/relay.js");
    const { createStageRun: mk } = await import("../../host/stage/runs.js");
    const run = mk("ag-live", "observer", {
      maxTokens: 4000,
      timeoutMs: 5000,
      noProgressTurns: 3,
    });
    const events: Array<{ type: string; assistantMessageEvent?: { type: string; delta: string } }> = [];
    run.onEvent = (ev) => events.push(ev as never);
    async function* stream() {
      yield { kind: "text", index: 0, text: "Hello" };
      yield { kind: "thinking", index: 1, text: "reasoning" };
      return { turnId: "t", index: 0, answer: "", toolUses: [], stopReason: "end_turn" };
    }
    const it = relayTurnStep({ turnId: "t", index: 0, agentId: "ag-live" }, stream as never, {
      clockAfter: () => Object.assign(() => {}, { cancel: () => {} }),
    });
    for await (const _ of it) void _;
    expect(events[0]?.type).toBe("message_start");
    const updates = events.filter((e) => e.type === "message_update");
    expect(updates[0]?.assistantMessageEvent).toEqual({ type: "text_delta", delta: "Hello" });
    expect(updates[1]?.assistantMessageEvent).toEqual({ type: "thinking_delta", delta: "reasoning" });
  });
});

describe("relay — step-end message lifecycle (the widget's context lens)", () => {
  function sink(): { events: Record<string, unknown>[]; collect: (e: unknown) => void } {
    const events: Record<string, unknown>[] = [];
    return { events, collect: (e) => events.push(e as Record<string, unknown>) };
  }
  const typesOf = (events: Record<string, unknown>[]): unknown[] => events.map((e) => e.type);
  const lastMessage = (events: Record<string, unknown>[]): Record<string, unknown> => {
    const ends = events.filter((e) => e.type === "message_end");
    return (ends.at(-1)?.message ?? {}) as Record<string, unknown>;
  };

  test("a completed step closes its message: accrual-neutral usage with the four-count totalTokens + the answering model", async () => {
    clearAllStageRuns();
    const s = sink();
    createStageRun("ag-ctx", "builder", CFG, s.collect);
    await collect(
      relayTurnStep(
        { turnId: "t", index: 0, agentId: "ag-ctx" },
        fakeStream([{ kind: "text", index: 0, text: "hi" }], {
          usage: {
            input_tokens: 9,
            output_tokens: 106,
            cache_read_input_tokens: 700,
            cache_creation_input_tokens: 32080,
            model: "m5",
          },
        }),
        { clockAfter: noTimer },
      ),
    );
    // the message pair closes: start … update … end
    expect(s.events[0]?.type).toBe("message_start");
    expect(typesOf(s.events).at(-1)).toBe("message_end");
    const message = lastMessage(s.events);
    // accrual fields stay zero (the stage completion's own message_end remains
    // the single summing source); totalTokens derives the four counts and the
    // model rides the usage (the resolved value's own top-level model is null)
    expect(message.usage).toEqual({
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      cost: 0,
      totalTokens: 32_895,
    });
    expect(message.model).toBe("m5");
  });

  test("a completed step whose response carried no usage closes the message with none (ctx keeps its last reading)", async () => {
    clearAllStageRuns();
    const s = sink();
    createStageRun("ag-ctx-0", "builder", CFG, s.collect);
    await collect(
      relayTurnStep(
        { turnId: "t", index: 0, agentId: "ag-ctx-0" },
        fakeStream([{ kind: "text", index: 0, text: "hi" }], { usage: null }),
        { clockAfter: noTimer },
      ),
    );
    const message = lastMessage(s.events);
    expect("usage" in message).toBe(false);
    expect("model" in message).toBe(false);
    expect(typesOf(s.events).at(-1)).toBe("message_end");
  });

  test("a stalled step closes the message it opened before the fabricated stop", async () => {
    clearAllStageRuns();
    const s = sink();
    const run = createStageRun("ag-ctx-stall", "observer", { ...CFG, timeoutMs: 20 }, s.collect);
    const stream: StepStream = async function* (_e) {
      await new Promise(() => {}); // never produces
      return {} as StepResult;
    };
    const clockAfter = (ms: number, fn: () => void): TimerHandle => {
      const t = setTimeout(fn, ms);
      return { cancel: () => clearTimeout(t) };
    };
    await collect(relayTurnStep({ turnId: "t", index: 0, agentId: "ag-ctx-stall" }, stream, { clockAfter }));
    expect(run.timedOut).toBe(true);
    expect(typesOf(s.events)).toEqual(["message_start", "message_end"]);
    expect(lastMessage(s.events)).toEqual({});
  });

  test("the per-step output cap's fabricated stop closes its message too", async () => {
    clearAllStageRuns();
    const s = sink();
    createStageRun("ag-ctx-cap", "builder", { ...CFG, maxTokens: 10 }, s.collect);
    const big = "x".repeat(60);
    const stream = fakeStream([{ kind: "text", index: 0, text: big }], { answer: big, stopReason: "max_tokens" });
    await collect(relayTurnStep({ turnId: "t", index: 0, agentId: "ag-ctx-cap" }, stream, { clockAfter: noTimer }));
    expect(typesOf(s.events).at(-1)).toBe("message_end");
    expect(lastMessage(s.events)).toEqual({});
  });

  test("an abort answered before any request opens no message (zero events, no close)", async () => {
    clearAllStageRuns();
    const s = sink();
    const run = createStageRun("ag-ctx-abort", "observer", CFG, s.collect);
    run.abortFlag = true;
    run.abortReason = "signal";
    await collect(
      relayTurnStep({ turnId: "t", index: 0, agentId: "ag-ctx-abort" }, fakeStream([]), { clockAfter: noTimer }),
    );
    expect(s.events).toEqual([]);
  });
});
