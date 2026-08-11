// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import type { AgentContext, AgentEvent, AgentLoopConfig, AgentMessage } from "@earendil-works/pi-agent-core";
import type {
  Api,
  AssistantMessage,
  AssistantMessageEvent,
  Model,
  StopReason,
  ThinkingLevel,
  Usage,
} from "@earendil-works/pi-ai";
import { EventStream } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import {
  makeTurnCap,
  NO_EVENT_SINK,
  NO_LOOP_OVERRIDE,
  NO_REASONING,
  NO_STAGE_END_HOOK,
  NO_TURN_LIMIT,
  runStage,
  SEQUENTIAL,
  StageModelError,
  StageRunError,
  type StageRunInput,
  type StageUsage,
} from "../../src/runtime/agent-loop.js";
import { estimateContentTokens } from "../../src/types.js";

/** Per-LLM-call output cap used across tests (large enough not to bite). */
const TEST_MAX_TOKENS = 8192;

// --- scripted-event helpers ------------------------------------------------

/** A bare-minimum assistant message with a usage block. */
function asstMsg(usage: Usage): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: "openai",
    provider: "openai",
    model: "test-model",
    usage,
    stopReason: "stop",
    timestamp: 0,
  };
}

const NO_USAGE: Usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function usageOf(input: number, output: number, cacheRead: number, costTotal: number): Usage {
  return {
    input,
    output,
    cacheRead,
    cacheWrite: 0,
    totalTokens: input + output + cacheRead,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: costTotal },
  };
}

/** A `message_update` carrying a text/thinking/toolcall delta (no provider usage yet). */
function deltaUpdate(type: "text_delta" | "thinking_delta" | "toolcall_delta", delta: string): AgentEvent {
  const partial = asstMsg(NO_USAGE);
  const ev: AssistantMessageEvent =
    type === "text_delta"
      ? { type: "text_delta", contentIndex: 0, delta, partial }
      : type === "thinking_delta"
        ? { type: "thinking_delta", contentIndex: 0, delta, partial }
        : { type: "toolcall_delta", contentIndex: 0, delta, partial };
  return { type: "message_update", message: partial, assistantMessageEvent: ev };
}

/** A `message_update` whose partial carries a provider-streamed usage.output. */
function usageUpdate(output: number): AgentEvent {
  const partial = asstMsg(usageOf(0, output, 0, 0));
  const ev: AssistantMessageEvent = { type: "text_end", contentIndex: 0, content: "", partial };
  return { type: "message_update", message: partial, assistantMessageEvent: ev };
}

function messageEnd(u: Usage): AgentEvent {
  return { type: "message_end", message: asstMsg(u) };
}

/** A `message_end` carrying a non-assistant message (prompt/steering user message) — no usage. */
function nonAssistantMessageEnd(): AgentEvent {
  const userMsg = { role: "user", content: [], timestamp: 0 } as unknown as AgentMessage;
  return { type: "message_end", message: userMsg };
}

function turnEnd(): AgentEvent {
  return { type: "turn_end", message: asstMsg(NO_USAGE), toolResults: [] };
}

function agentEnd(messages: AgentMessage[]): AgentEvent {
  return { type: "agent_end", messages };
}

/**
 * Build a fake `agentLoop` that plays a scripted event sequence, honouring an
 * abort signal between microtasks. The stream's terminal `agent_end` (or an
 * explicit `end`) carries the final messages.
 */
function makeFakeLoop(opts: {
  events: AgentEvent[];
  messages: AgentMessage[];
}): typeof import("@earendil-works/pi-agent-core").agentLoop {
  const { events, messages } = opts;
  const isComplete = (e: AgentEvent) => e.type === "agent_end";
  const extractResult = (e: AgentEvent) => (e.type === "agent_end" ? e.messages : messages);
  return ((_prompts, _context, _config, signal) => {
    const stream = new EventStream<AgentEvent, AgentMessage[]>(isComplete, extractResult);
    let i = 0;
    const pushNext = () => {
      if (signal?.aborted) {
        stream.end(messages);
        return;
      }
      if (i >= events.length) {
        stream.end(messages);
        return;
      }
      const ev = events[i];
      i += 1;
      stream.push(ev);
      queueMicrotask(pushNext);
    };
    queueMicrotask(pushNext);
    return stream;
  }) as typeof import("@earendil-works/pi-agent-core").agentLoop;
}

/**
 * A minimal async-iterable stream that plays scripted events then REJECTS on
 * `result()` — simulates a runtime failure after partial usage. Unlike an
 * EventStream spread, it keeps its own `[Symbol.asyncIterator]`.
 */
class RejectingStream {
  private queue: AgentEvent[] = [];
  private done = false;
  private waiters: Array<(r: { value?: AgentEvent; done: boolean }) => void> = [];
  constructor(events: AgentEvent[], signal: AbortSignal | undefined) {
    let i = 0;
    const pushNext = () => {
      if (signal?.aborted || i >= events.length) {
        this.finish();
        return;
      }
      this.emit(events[i]);
      i += 1;
      queueMicrotask(pushNext);
    };
    queueMicrotask(pushNext);
  }
  private emit(ev: AgentEvent): void {
    const waiter = this.waiters.shift();
    if (waiter) waiter({ value: ev, done: false });
    else this.queue.push(ev);
  }
  private finish(): void {
    this.done = true;
    while (this.waiters.length > 0) {
      const w = this.waiters.shift();
      if (w !== undefined) w({ done: true });
    }
  }
  async *[Symbol.asyncIterator](): AsyncIterator<AgentEvent> {
    while (true) {
      const next = this.queue.shift();
      if (next !== undefined) {
        yield next;
      } else if (this.done) {
        return;
      } else {
        const r = await new Promise<{ value?: AgentEvent; done: boolean }>((resolve) => this.waiters.push(resolve));
        if (r.done) return;
        yield r.value as AgentEvent;
      }
    }
  }
  result(): Promise<AgentMessage[]> {
    return Promise.reject(new Error("runtime failure"));
  }
}

/** A minimal valid StageRunInput using a fake loop + null sinks. */
function baseInput(over: Partial<StageRunInput>): StageRunInput {
  return {
    systemPrompt: "system",
    messages: [],
    tools: [],
    model: { id: "test-model" } as unknown as Model<Api>,
    apiKey: undefined,
    signal: new AbortController().signal,
    reasoning: NO_REASONING,
    maxTurns: NO_TURN_LIMIT,
    maxTokens: TEST_MAX_TOKENS,
    timeoutMs: null,
    onEvent: NO_EVENT_SINK,
    onStageEnd: NO_STAGE_END_HOOK,
    loopFn: NO_LOOP_OVERRIDE,
    ...over,
  };
}

// --- tests -----------------------------------------------------------------

describe("runStage — usage accumulation", () => {
  it("sums usage across every message_end event (multi-turn)", async () => {
    const events: AgentEvent[] = [
      messageEnd(usageOf(100, 50, 10, 0.001)),
      turnEnd(),
      messageEnd(usageOf(200, 80, 20, 0.002)),
      turnEnd(),
      messageEnd(usageOf(300, 120, 30, 0.003)),
      agentEnd([]),
    ];
    const result = await runStage(baseInput({ loopFn: makeFakeLoop({ events, messages: [] }) }));
    expect(result.usage).toEqual(
      expect.objectContaining({
        input: 600,
        output: 250,
        cacheRead: 60,
        cost: 0.006,
        turns: 2,
      }),
    );
    // elapsedMs is wall-clock (non-deterministic); just assert it's a number.
    expect(typeof result.usage.elapsedMs).toBe("number");
  });

  it("reports zero usage for a stream with no message_end events", async () => {
    const events: AgentEvent[] = [agentEnd([])];
    const result = await runStage(baseInput({ loopFn: makeFakeLoop({ events, messages: [] }) }));
    expect(result.usage).toEqual(expect.objectContaining({ input: 0, output: 0, cacheRead: 0, cost: 0, turns: 0 }));
  });

  it("counts a non-assistant message_end (no usage) as zero, not NaN", async () => {
    const events: AgentEvent[] = [
      messageEnd(usageOf(100, 50, 10, 0.001)),
      nonAssistantMessageEnd(), // prompt/steering user message — no usage block
      turnEnd(),
      agentEnd([]),
    ];
    const result = await runStage(baseInput({ loopFn: makeFakeLoop({ events, messages: [] }) }));
    expect(result.usage).toEqual(
      expect.objectContaining({ input: 100, output: 50, cacheRead: 10, cost: 0.001, turns: 1 }),
    );
  });
});

describe("runStage — streaming output tokens (two-tier)", () => {
  it("uses provider usage.output as the primary source when reported", async () => {
    const events: AgentEvent[] = [
      deltaUpdate("text_delta", "hello world"), // 11 chars -> 3 tokens fallback
      usageUpdate(77), // provider streams usage mid-stream
      messageEnd(usageOf(0, 77, 0, 0)), // authoritative output -> primary
      agentEnd([]),
    ];
    const result = await runStage(baseInput({ loopFn: makeFakeLoop({ events, messages: [] }) }));
    expect(result.outputTokens).toBe(77);
  });

  it("falls back to chars/4 estimate over deltas when usage is not streamed", async () => {
    // 8 chars + 8 chars + 4 chars = 20 chars -> 5 tokens (Math.ceil(20/4))
    const events: AgentEvent[] = [
      deltaUpdate("text_delta", "12345678"), // 8
      deltaUpdate("thinking_delta", "abcdefgh"), // 8
      deltaUpdate("toolcall_delta", "abcd"), // 4
      messageEnd(usageOf(0, 0, 0, 0)), // output 0 -> primary never fires
      agentEnd([]),
    ];
    const result = await runStage(baseInput({ loopFn: makeFakeLoop({ events, messages: [] }) }));
    expect(result.outputTokens).toBe(5);
  });

  it("prefers primary over a larger fallback (primary wins, not max)", async () => {
    // deltas -> 400 chars / 4 = 100 fallback tokens; usage.output = 5 primary.
    // primary wins (5), NOT max(5, 100) — chars/4 overestimates once real tokens are known.
    const events: AgentEvent[] = [
      deltaUpdate("text_delta", "x".repeat(400)), // 400 chars -> 100 fallback
      usageUpdate(5), // provider streams usage -> primary = 5
      messageEnd(usageOf(0, 5, 0, 0)),
      agentEnd([]),
    ];
    const result = await runStage(baseInput({ loopFn: makeFakeLoop({ events, messages: [] }) }));
    expect(result.outputTokens).toBe(5);
  });

  it("fallback tier equals the canonical chars/4 estimator (no drift)", async () => {
    const text = "some longer delta text for the fallback estimate";
    const events: AgentEvent[] = [
      deltaUpdate("text_delta", text),
      messageEnd(usageOf(0, 0, 0, 0)), // no provider usage -> fallback path
      agentEnd([]),
    ];
    const result = await runStage(baseInput({ loopFn: makeFakeLoop({ events, messages: [] }) }));
    expect(result.outputTokens).toBe(estimateContentTokens(text));
  });

  it("sums provider output across multiple turns (not a global max of per-message peaks)", async () => {
    // Each turn's partial.usage.output resets per message (Anthropic/OpenAI). A
    // global-max would stall at turn 1's peak (50) and ignore turn 2 (30).
    // The correct cumulative is the SUM of every message_end usage.output (80).
    const events: AgentEvent[] = [
      usageUpdate(50), // turn 1 partial climbs to 50
      messageEnd(usageOf(0, 50, 0, 0)),
      turnEnd(),
      usageUpdate(30), // turn 2 partial resets, climbs to 30
      messageEnd(usageOf(0, 30, 0, 0)),
      turnEnd(),
      agentEnd([]),
    ];
    const result = await runStage(baseInput({ loopFn: makeFakeLoop({ events, messages: [] }) }));
    expect(result.outputTokens).toBe(80);
  });
});

describe("runStage — turns", () => {
  it("counts turns from turn_end events", async () => {
    const events: AgentEvent[] = [
      messageEnd(usageOf(0, 0, 0, 0)),
      turnEnd(),
      messageEnd(usageOf(0, 0, 0, 0)),
      messageEnd(usageOf(0, 0, 0, 0)),
      turnEnd(),
      agentEnd([]),
    ];
    const result = await runStage(baseInput({ loopFn: makeFakeLoop({ events, messages: [] }) }));
    expect(result.usage.turns).toBe(2);
  });
});

describe("runStage — onEvent + onStageEnd hooks", () => {
  it("forwards every event to onEvent", async () => {
    const seen: AgentEvent[] = [];
    const events: AgentEvent[] = [
      deltaUpdate("text_delta", "x"),
      messageEnd(usageOf(0, 0, 0, 0)),
      turnEnd(),
      agentEnd([]),
    ];
    await runStage(
      baseInput({
        loopFn: makeFakeLoop({ events, messages: [] }),
        onEvent: (e) => seen.push(e),
      }),
    );
    expect(seen.map((e) => e.type)).toEqual(["message_update", "message_end", "turn_end", "agent_end"]);
  });

  it("invokes onStageEnd once on success with the accumulated usage", async () => {
    const calls: StageUsage[] = [];
    const events: AgentEvent[] = [messageEnd(usageOf(10, 5, 0, 0)), turnEnd(), agentEnd([])];
    await runStage(
      baseInput({
        loopFn: makeFakeLoop({ events, messages: [] }),
        onStageEnd: (u) => calls.push(u),
      }),
    );
    expect(calls).toEqual([expect.objectContaining({ input: 10, output: 5, cacheRead: 0, cost: 0, turns: 1 })]);
  });

  it("invokes onStageEnd once on throw with the partial usage accumulated so far", async () => {
    const calls: StageUsage[] = [];
    const events: AgentEvent[] = [messageEnd(usageOf(7, 3, 0, 0))];
    const throwingLoop: typeof import("@earendil-works/pi-agent-core").agentLoop = (_p, _c, _cfg, signal) =>
      new RejectingStream(events, signal) as unknown as EventStream<AgentEvent, AgentMessage[]>;
    await expect(
      runStage(
        baseInput({
          loopFn: throwingLoop,
          onStageEnd: (u) => calls.push(u),
        }),
      ),
    ).rejects.toBeInstanceOf(StageRunError);
    expect(calls).toEqual([expect.objectContaining({ input: 7, output: 3, cacheRead: 0, cost: 0, turns: 0 })]);
  });
});

describe("runStage — abort", () => {
  it("reports aborted=true when the signal fires mid-stream", async () => {
    const controller = new AbortController();
    const events: AgentEvent[] = [
      messageEnd(usageOf(10, 5, 0, 0)),
      turnEnd(),
      messageEnd(usageOf(20, 8, 0, 0)),
      turnEnd(),
      agentEnd([]),
    ];
    // abort after the first turn_end is observed
    let sawTurnEnd = false;
    const result = await runStage(
      baseInput({
        signal: controller.signal,
        loopFn: makeFakeLoop({ events, messages: [] }),
        onEvent: (e) => {
          if (e.type === "turn_end") {
            if (!sawTurnEnd) {
              sawTurnEnd = true;
              controller.abort();
            }
          }
        },
      }),
    );
    expect(result.aborted).toBe(true);
  });

  it("reports aborted=false when the run completes cleanly", async () => {
    const events: AgentEvent[] = [messageEnd(usageOf(1, 1, 0, 0)), agentEnd([])];
    const result = await runStage(baseInput({ loopFn: makeFakeLoop({ events, messages: [] }) }));
    expect(result.aborted).toBe(false);
  });

  it("fires onStageEnd with the partial usage accumulated before the abort", async () => {
    const controller = new AbortController();
    const calls: StageUsage[] = [];
    const events: AgentEvent[] = [
      messageEnd(usageOf(10, 5, 0, 0)),
      turnEnd(),
      messageEnd(usageOf(20, 8, 0, 0)),
      turnEnd(),
      agentEnd([]),
    ];
    let sawTurnEnd = false;
    const result = await runStage(
      baseInput({
        signal: controller.signal,
        loopFn: makeFakeLoop({ events, messages: [] }),
        onStageEnd: (u) => calls.push(u),
        onEvent: (e) => {
          if (e.type === "turn_end") {
            if (!sawTurnEnd) {
              sawTurnEnd = true;
              controller.abort();
            }
          }
        },
      }),
    );
    expect(result.aborted).toBe(true);
    expect(calls).toHaveLength(1);
    // at least the first message_end's usage was accumulated before the abort
    expect(calls[0]?.input).toBeGreaterThanOrEqual(10);
  });
});

describe("runStage — per-LLM-call bounds (maxTokens + timeout)", () => {
  it("forwards maxTokens into the agentLoop config", async () => {
    let captured: AgentLoopConfig | undefined;
    const capturingLoop: typeof import("@earendil-works/pi-agent-core").agentLoop = (_p, _c, config, signal) => {
      captured = config;
      const stream = new EventStream<AgentEvent, AgentMessage[]>(
        (e) => e.type === "agent_end",
        () => [],
      );
      queueMicrotask(() => {
        if (signal?.aborted) {
          stream.end([]);
          return;
        }
        stream.push(agentEnd([]));
        stream.end([]);
      });
      return stream;
    };
    await runStage(baseInput({ loopFn: capturingLoop, maxTokens: 4096 }));
    expect(captured?.maxTokens).toBe(4096);
  });

  it("aborts a stalled run when a single LLM call exceeds timeoutMs (per-turn)", async () => {
    // A stream that never completes on its own — it only ends when the signal
    // aborts (simulating a provider stall: connection open, no chunks).
    const stallingLoop: typeof import("@earendil-works/pi-agent-core").agentLoop = (_p, _c, _config, signal) => {
      const stream = new EventStream<AgentEvent, AgentMessage[]>(
        (e) => e.type === "agent_end",
        () => [],
      );
      if (signal) {
        const onAbort = (): void => {
          stream.end([]);
        };
        if (signal.aborted) onAbort();
        else signal.addEventListener("abort", onAbort, { once: true });
      }
      return stream;
    };
    const result = await runStage(baseInput({ loopFn: stallingLoop, timeoutMs: 50 }));
    expect(result.aborted).toBe(true);
  });

  it("does not abort a clean run under timeoutMs (the timer is cleared on settle)", async () => {
    const events: AgentEvent[] = [messageEnd(usageOf(1, 1, 0, 0)), agentEnd([])];
    const result = await runStage(baseInput({ loopFn: makeFakeLoop({ events, messages: [] }), timeoutMs: 50 }));
    expect(result.aborted).toBe(false);
  });
});

describe("runStage — error propagation", () => {
  it("throws StageRunError on a stage failure", async () => {
    const events: AgentEvent[] = [messageEnd(usageOf(5, 2, 0, 0))];
    const rejecting: typeof import("@earendil-works/pi-agent-core").agentLoop = (_p, _c, _cfg, signal) =>
      new RejectingStream(events, signal) as unknown as EventStream<AgentEvent, AgentMessage[]>;
    try {
      await runStage(baseInput({ loopFn: rejecting }));
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(StageRunError);
    }
  });
});

describe("runStage — model failure (stopReason error)", () => {
  // Per the StreamFn contract, a model/runtime failure (server unavailable,
  // wrong model hosted, provider error) is encoded as a final assistant message
  // with stopReason "error" — it does NOT throw from the stream. Without
  // stopReason inspection runStage would return a clean no-record result, the
  // stage caller would proceed, and Pi would prune an unobserved gap (silent
  // data loss). runStage must throw StageModelError so the catch-chain
  // (Observer/Builder/Selector -> compaction hook) cancels compaction.

  /** A final assistant message with a given stopReason (+ optional error msg). */
  function asstWithStop(stopReason: StopReason, errorMessage: string | null): AssistantMessage {
    return { ...asstMsg(NO_USAGE), stopReason, errorMessage: errorMessage ?? undefined };
  }

  it("throws StageModelError when the final assistant message has stopReason error", async () => {
    const failed = asstWithStop("error", "connect ECONNREFUSED 127.0.0.1:11434");
    const events: AgentEvent[] = [{ type: "message_end", message: failed }, turnEnd(), agentEnd([failed])];
    await expect(runStage(baseInput({ loopFn: makeFakeLoop({ events, messages: [failed] }) }))).rejects.toBeInstanceOf(
      StageModelError,
    );
  });

  it("StageModelError carries the model's errorMessage in its message", async () => {
    const failed = asstWithStop("error", "model 'qwen2.5' not found");
    const events: AgentEvent[] = [{ type: "message_end", message: failed }, agentEnd([failed])];
    await expect(runStage(baseInput({ loopFn: makeFakeLoop({ events, messages: [failed] }) }))).rejects.toThrow(
      /model 'qwen2.5' not found/,
    );
  });

  it("still fires onStageEnd with partial usage before throwing", async () => {
    // The ledger hook runs in runStage's finally regardless of the throw, so a
    // model failure still accounts for the usage consumed up to it.
    const failed: AssistantMessage = {
      ...asstMsg(usageOf(120, 40, 5, 0.001)),
      stopReason: "error",
      errorMessage: "boom",
    };
    const events: AgentEvent[] = [{ type: "message_end", message: failed }, agentEnd([failed])];
    const calls: StageUsage[] = [];
    await expect(
      runStage(baseInput({ loopFn: makeFakeLoop({ events, messages: [failed] }), onStageEnd: (u) => calls.push(u) })),
    ).rejects.toBeInstanceOf(StageModelError);
    expect(calls).toEqual([expect.objectContaining({ input: 120, output: 40, cacheRead: 5, cost: 0.001, turns: 0 })]);
  });

  it("does NOT throw when the model succeeds with a normal stop reason", async () => {
    const events: AgentEvent[] = [messageEnd(usageOf(10, 5, 0, 0)), turnEnd(), agentEnd([])];
    await expect(runStage(baseInput({ loopFn: makeFakeLoop({ events, messages: [] }) }))).resolves.toBeDefined();
  });

  it("does NOT throw on stopReason aborted (covered by the signal-based flags)", async () => {
    // aborted is NOT a model error — it accompanies a signal abort, detected via
    // the aborted/timedOut flags. runStage must return normally (not throw).
    const aborted = asstWithStop("aborted", null);
    const events: AgentEvent[] = [{ type: "message_end", message: aborted }, agentEnd([aborted])];
    const result = await runStage(baseInput({ loopFn: makeFakeLoop({ events, messages: [aborted] }) }));
    expect(result.aborted).toBe(false);
  });
});

describe("makeTurnCap", () => {
  it("returns false forever when maxTurns is null (no limit)", () => {
    const cap = makeTurnCap(NO_TURN_LIMIT);
    for (let n = 0; n < 5; n += 1) {
      expect(cap({} as unknown as Parameters<ReturnType<typeof makeTurnCap>>[0])).toBe(false);
    }
  });

  it("stops after maxTurns turn_end callbacks", () => {
    const cap = makeTurnCap(2);
    expect(cap({} as unknown as Parameters<ReturnType<typeof makeTurnCap>>[0])).toBe(false); // turn 1
    expect(cap({} as unknown as Parameters<ReturnType<typeof makeTurnCap>>[0])).toBe(true); // turn 2 -> stop
  });

  it("stops at maxTurns=1 immediately after the first turn", () => {
    const cap = makeTurnCap(1);
    expect(cap({} as unknown as Parameters<ReturnType<typeof makeTurnCap>>[0])).toBe(true);
  });
});

describe("runStage — config wiring", () => {
  it("uses sequential tool execution and identity convertToLlm", async () => {
    const captured: Array<{ ctx: AgentContext; cfg: AgentLoopConfig }> = [];
    const spy: typeof import("@earendil-works/pi-agent-core").agentLoop = (_p, ctx, cfg) => {
      captured.push({ ctx, cfg });
      const stream = new EventStream<AgentEvent, AgentMessage[]>(
        (e) => e.type === "agent_end",
        (e) => (e.type === "agent_end" ? e.messages : []),
      );
      queueMicrotask(() => stream.push(agentEnd([])));
      return stream;
    };
    const tools = [{ name: "record_observations" }] as unknown as StageRunInput["tools"];
    await runStage(
      baseInput({
        loopFn: spy,
        systemPrompt: "SYS",
        messages: [{ role: "user", content: [], timestamp: 0 }] as unknown as AgentMessage[],
        tools,
        reasoning: "med" as ThinkingLevel,
      }),
    );
    expect(captured).toHaveLength(1);
    expect(captured[0]?.ctx.systemPrompt).toBe("SYS");
    expect(captured[0]?.ctx.tools).toBe(tools);
    expect(captured[0]?.cfg.toolExecution).toBe(SEQUENTIAL);
    expect(typeof captured[0]?.cfg.shouldStopAfterTurn).toBe("function");
    expect(captured[0]?.cfg).toHaveProperty("reasoning", "med");
  });
});
