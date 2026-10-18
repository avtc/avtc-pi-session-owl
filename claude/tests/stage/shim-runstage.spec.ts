// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// The shim's runStage: the engine-backed stage run the host runs
// call. Spawn → registry → completion gate → TurnUsage→StageUsage mapping,
// with the dump call-sites and the abort levers observable.
import { describe, expect, test } from "vitest";
import { estimateContentTokens } from "../../core/src/types.js";
import * as bridge from "../../host/engine-bridge.js";
import { StageModelError, StageRunError } from "../../host/runs/stage-errors.js";
import { clearAllStageRuns, enableStageDumpArchive, getStageRun, takeStageDump } from "../../host/stage/runs.js";
import { completionUsageOf } from "../../host/stage/usage.js";
import {
  type EngineStageRunInput,
  flattenStagePrompt,
  runStage,
  translateStageClosings,
} from "../../shims/pi-agent-core/index.js";

function arm(spawnImpl: (input: Record<string, unknown>) => Promise<{ model: string; agentId?: string }>) {
  bridge.arm({
    agentSpawn: spawnImpl as never,
    agentRegister: (async () => ({})) as never,
    clockAfter: ((_ms: number, _fn: () => void) => ({ cancel: () => {} })) as never,
    clockEvery: ((_ms: number, _fn: () => void) => () => {}) as never,
    log: ((_m: string) => {}) as never,
  });
}

/** Let runStage reach its completion await before routing. */
async function settle(): Promise<void> {
  await new Promise((r) => setImmediate(r));
}

function baseInput(over: Partial<EngineStageRunInput> = {}): EngineStageRunInput {
  return {
    stage: "observer",
    systemPrompt: "OBS",
    messages: [
      {
        role: "user",
        // pi's observer closing rides the fixture verbatim (source line
        // wraps included) — the spawn prompt translates it in place
        content:
          "chunk text. When the chunk is fully covered, reply\nwith the single word Done; if the chunk has nothing worth capturing, skip the\ntool and reply Done.",
      },
    ],
    model: null,
    signal: undefined,
    maxTokens: 2000,
    timeoutMs: 30_000,
    noProgressTurns: 3,
    onEvent: null,
    onStageEnd: null,
    dumpPath: null,
    onSpawn: null,
    ...over,
  };
}

describe("runStage — spawn + registry", () => {
  test("spawns the namespaced type with the flattened prompt and records the run", async () => {
    clearAllStageRuns();
    bridge.clearRouting();
    const spawns: unknown[] = [];
    let n = 0;
    arm(async (input) => {
      spawns.push(input);
      n += 1;
      return { model: "glm-5.1", agentId: `ag-${n}` };
    });
    const promise = runStage(baseInput());
    await new Promise((r) => setImmediate(r)); // let the spawn resolve
    const run = getStageRun("ag-1");
    expect(run).toBeDefined();
    expect(run?.stage).toBe("observer");
    expect(run?.config).toMatchObject({ maxTokens: 2000, timeoutMs: 30_000, noProgressTurns: 3 });
    // the buffer carries no prompt — the run modules append their own
    // pre-call <input> blocks
    expect(run?.dump.outputRows).toEqual([]);
    expect(spawns[0]).toMatchObject({ subagentType: "session-owl:observer" });
    expect((spawns[0] as { prompt: string }).prompt).toContain("chunk text");
    // no prepended platform note — pi's closing sentences are translated
    // in place (the handback phrasing)
    expect((spawns[0] as { prompt: string }).prompt.startsWith("(Platform note:")).toBe(false);
    expect((spawns[0] as { prompt: string }).prompt).toContain(
      'call the "SubagentHandback" tool with the single word "Done"',
    );
    bridge.routeAgentCompletion({ answer: "done", isAborted: false, agentId: "ag-1", usage: null });
    const result = await promise;
    expect(result.aborted).toBe(false);
    expect(result.messages).toEqual([{ role: "assistant", content: "done" }]);
    // THE retention invariant: the real runStage keeps the registry
    // membership past completion — the handback arrives after turn.complete
    // and the delivery drop reads membership there.
    expect(bridge.spawnRegistry.has("ag-1")).toBe(true);
    expect(result.abortReason).toBeNull(); // a clean end classifies as none
    bridge.forgetSpawn("ag-1");
  });

  test("a model string rides the spawn (per-run resolution)", async () => {
    clearAllStageRuns();
    bridge.clearRouting();
    const spawns: unknown[] = [];
    arm(async (input) => {
      spawns.push(input);
      return { model: "haiku", agentId: "ag-m" };
    });
    const p = runStage(baseInput({ model: "haiku" }));
    await settle();
    bridge.routeAgentCompletion({ answer: "", isAborted: false, agentId: "ag-m", usage: null });
    await p;
    expect(spawns[0]).toMatchObject({ model: "haiku" });
  });
});

describe("runStage — usage mapping", () => {
  test("TurnUsage maps to StageUsage; cost comes from the rates seam", async () => {
    clearAllStageRuns();
    bridge.clearRouting();
    arm(async () => ({ model: "m1", agentId: "ag-u" }));
    const ends: unknown[] = [];
    const p = runStage(
      baseInput({
        modelRates: (m) => (m === "m1" ? { inputPerM: 3, outputPerM: 15 } : null),
        onStageEnd: (u) => ends.push(u),
      }),
    );
    await settle();
    bridge.routeAgentCompletion({
      answer: "x",
      isAborted: false,
      agentId: "ag-u",
      usage: completionUsageOf({
        input_tokens: 1_000_000,
        output_tokens: 100_000,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
        model: "m1",
      }),
    });
    const r = await p;
    expect(r.usage.input).toBe(1_000_000);
    expect(r.usage.output).toBe(100_000);
    expect(r.usage.cost).toBeCloseTo(3 + 1.5, 5); // 1M×$3/M + 100k×$15/M
    expect(r.usage.turns).toBe(0); // no turn.step observed in this test
    expect(ends).toHaveLength(1); // onStageEnd fired
  });

  test("unknown rates zero the cost with a log line (gateway models)", async () => {
    clearAllStageRuns();
    bridge.clearRouting();
    arm(async () => ({ model: "gateway-model", agentId: "ag-z" }));
    const logs: string[] = [];
    bridge.arm({
      agentSpawn: (async () => ({ model: "gateway-model", agentId: "ag-z" })) as never,
      agentRegister: (async () => ({})) as never,
      clockAfter: ((_ms: number, _fn: () => void) => ({ cancel: () => {} })) as never,
      clockEvery: ((_ms: number, _fn: () => void) => () => {}) as never,
      log: (m: string) => logs.push(m),
    });
    const p = runStage(baseInput());
    await settle();
    bridge.routeAgentCompletion({
      answer: "y",
      isAborted: false,
      agentId: "ag-z",
      usage: completionUsageOf({
        input_tokens: 10,
        output_tokens: 5,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
        model: "gateway-model",
      }),
    });
    const r = await p;
    expect(r.usage.cost).toBe(0);
    expect(logs.some((l) => l.includes("gateway-model") && l.includes("cost"))).toBe(true);
  });

  test("outputTokens is two-tier: usage.output first, chars/4 fallback", async () => {
    clearAllStageRuns();
    bridge.clearRouting();
    arm(async () => ({ model: "m", agentId: "ag-t1" }));
    const p1 = runStage(baseInput());
    await settle();
    bridge.routeAgentCompletion({
      answer: "a".repeat(400),
      isAborted: false,
      agentId: "ag-t1",
      usage: completionUsageOf({
        input_tokens: 0,
        output_tokens: 77,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
        model: "m",
      }),
    });
    expect((await p1).outputTokens).toBe(77);
    arm(async () => ({ model: "m", agentId: "ag-2" }));
    const p2 = runStage(baseInput());
    await settle();
    bridge.routeAgentCompletion({ answer: "b".repeat(400), isAborted: false, agentId: "ag-2", usage: null });
    const r2 = await p2;
    expect(r2.outputTokens).toBe(estimateContentTokens("b".repeat(400)));
    // the zero arm: a reported output of 0 falls back too (pi's > 0 tier)
    arm(async () => ({ model: "m", agentId: "ag-z0" }));
    const p3 = runStage(baseInput());
    await settle();
    bridge.routeAgentCompletion({
      answer: "c".repeat(40),
      isAborted: false,
      agentId: "ag-z0",
      usage: completionUsageOf({
        input_tokens: 0,
        output_tokens: 0,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
        model: "m",
      }),
    });
    expect((await p3).outputTokens).toBe(10); // chars/4 over the answer, not the reported 0
    expect(getStageRun("ag-2")).toBeUndefined(); // completed run cleaned up
  });
});

describe("runStage — abort", () => {
  test("the run's signal aborts: fabricated completion, aborted result, Defect-A surface", async () => {
    clearAllStageRuns();
    bridge.clearRouting();
    arm(async () => ({ model: "m", agentId: "ag-a" }));
    const controller = new AbortController();
    const p = runStage(baseInput({ signal: controller.signal }));
    await settle();
    controller.abort();
    // the relay's fabricated steps end the agent — its turn.complete follows
    bridge.routeAgentCompletion({ answer: "", isAborted: true, agentId: "ag-a", usage: null });
    const r = await p;
    expect(r.aborted).toBe(true);
    expect(getStageRun("ag-a")).toBeUndefined();
  });

  test("the fabricated-stop marker rides the completion merge (marked BEFORE the archive)", async () => {
    clearAllStageRuns();
    bridge.clearRouting();
    enableStageDumpArchive("observer");
    arm(async () => ({ model: "m", agentId: "ag-mk" }));
    const controller = new AbortController();
    const p = runStage({ ...baseInput({ signal: controller.signal }), stage: "observer" });
    await settle();
    controller.abort();
    bridge.routeAgentCompletion({ answer: "", isAborted: true, agentId: "ag-mk", usage: null });
    const r = await p;
    expect(r.aborted).toBe(true);
    // the marker was set BEFORE completeStageRun merged the buffer — the
    // drained archive carries it (the dump shows the fabricated stop)
    const archived = takeStageDump("observer");
    expect(archived?.fabricatedStop).toBe("signal");
  });

  test("the run's abort classification surfaces (distinguishes timeout-class from a user abort)", async () => {
    clearAllStageRuns();
    bridge.clearRouting();
    arm(async () => ({ model: "m", agentId: "ag-mx" }));
    const p = runStage(baseInput());
    await settle();
    // the relay tripped a lever mid-run (the timeout class)
    const runs = await import("../../host/stage/runs.js");
    const live = runs.getStageRun("ag-mx");
    expect(live).toBeDefined();
    if (live !== undefined) {
      live.abortFlag = true;
      live.abortReason = "timeout";
    }
    bridge.routeAgentCompletion({ answer: "", isAborted: true, agentId: "ag-mx", usage: null });
    const r = await p;
    expect(r.aborted).toBe(true);
    expect(r.abortReason).toBe("timeout"); // the skip-and-notify surface
  });

  test("onSpawn fires with the resolved agentId right after the run registers", async () => {
    clearAllStageRuns();
    bridge.clearRouting();
    arm(async () => ({ model: "m", agentId: "ag-os" }));
    const seen: string[] = [];
    const bindings: string[] = [];
    const p = runStage(
      baseInput({
        onSpawn: (id) => {
          seen.push(id);
          // the run exists and is unbound-invisible to the gate until bodies bind
          bindings.push(String(getStageRun(id) !== undefined));
        },
      }),
    );
    await settle();
    bridge.routeAgentCompletion({ answer: "x", isAborted: false, agentId: "ag-os", usage: null });
    await p;
    expect(seen).toEqual(["ag-os"]);
    expect(bindings).toEqual(["true"]);
  });

  test("an aborted turn.complete maps to aborted:true", async () => {
    clearAllStageRuns();
    bridge.clearRouting();
    arm(async () => ({ model: "m", agentId: "ag-ab" }));
    const p = runStage(baseInput());
    await settle();
    bridge.routeAgentCompletion({ answer: "", isAborted: true, agentId: "ag-ab", usage: null });
    expect((await p).aborted).toBe(true);
  });

  test("a DELIBERATE abort (the handback-enforcer kill) is forgiven: aborted:false, records kept", async () => {
    clearAllStageRuns();
    bridge.clearRouting();
    arm(async () => ({ model: "m", agentId: "ag-kill" }));
    const p = runStage(baseInput());
    await settle();
    // the register side marked the abort right before $.turn.abort fired
    const bridge2 = await import("../../host/engine-bridge.js");
    bridge2.markDeliberateAbort("ag-kill");
    bridge.routeAgentCompletion({ answer: "Done", isAborted: true, agentId: "ag-kill", usage: null });
    const r = await p;
    expect(r.aborted).toBe(false); // the run's work was already done — a clean finish
    expect(bridge2.consumeDeliberateAbort("ag-kill")).toBe(false); // one-shot: consumed
  });

  test("onStageEnd fires even when the run aborts (partial usage folds)", async () => {
    clearAllStageRuns();
    bridge.clearRouting();
    arm(async () => ({ model: "m", agentId: "ag-ae" }));
    const ends: unknown[] = [];
    const controller = new AbortController();
    const p = runStage(baseInput({ signal: controller.signal, onStageEnd: (u) => ends.push(u) }));
    await settle();
    controller.abort();
    bridge.routeAgentCompletion({ answer: "", isAborted: true, agentId: "ag-ae", usage: null });
    await p;
    expect(ends).toHaveLength(1);
  });
});

describe("completionUsageOf", () => {
  test("snake_case API counts normalize; absent/malformed usage reads null", () => {
    expect(
      completionUsageOf({
        input_tokens: 5,
        output_tokens: 6,
        cache_read_input_tokens: 7,
        cache_creation_input_tokens: 8,
        model: "m",
      }),
    ).toEqual({ input: 5, output: 6, cacheRead: 7, cacheWrite: 8, model: "m" });
    expect(completionUsageOf(undefined)).toBeNull();
    expect(completionUsageOf("nope")).toBeNull();
    expect(completionUsageOf({})).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, model: "" });
  });
});

describe("runStage — failure surfaces", () => {
  test("an already-aborted signal makes zero spawns (the pre-check)", async () => {
    clearAllStageRuns();
    bridge.clearRouting();
    let spawns = 0;
    arm(async () => {
      spawns += 1;
      return { model: "m", agentId: "ag-pre" };
    });
    const controller = new AbortController();
    controller.abort();
    const ends: unknown[] = [];
    const r = await runStage(baseInput({ signal: controller.signal, onStageEnd: (u) => ends.push(u) }));
    expect(spawns).toBe(0);
    expect(r.aborted).toBe(true);
    expect(r.messages).toEqual([]);
    expect(ends).toHaveLength(1); // the stage-end hook still fires
  });

  test("unarmed services reject with the typed StageRunError", async () => {
    clearAllStageRuns();
    arm({} as never); // armed object without agentSpawn/log
    await expect(runStage(baseInput())).rejects.toBeInstanceOf(StageRunError);
    await expect(runStage(baseInput())).rejects.toThrow("stage engine services not armed");
  });

  test("a spawn resolving without an agentId rejects with the typed StageRunError", async () => {
    clearAllStageRuns();
    bridge.clearRouting();
    arm(async () => ({ model: "m1" })); // no agentId in the resolution
    await expect(runStage(baseInput())).rejects.toBeInstanceOf(StageRunError);
    await expect(runStage(baseInput())).rejects.toThrow("stage spawn resolved without an agentId");
  });

  test("an engine-side error/refusal reason throws (the skip+notify surface)", async () => {
    clearAllStageRuns();
    bridge.clearRouting();
    arm(async () => ({ model: "m", agentId: "ag-err" }));
    const p = runStage(baseInput());
    await settle();
    bridge.routeAgentCompletion({
      answer: "provider exploded",
      isAborted: false,
      agentId: "ag-err",
      usage: null,
      reason: "error",
    });
    await expect(p).rejects.toThrow("stage engine failure (error)");
    await expect(p).rejects.toBeInstanceOf(StageModelError); // typed so callers classify skip-and-notify
    expect(getStageRun("ag-err")).toBeUndefined(); // torn down despite the throw
  });

  test("session.end resolves a still-awaiting gate as aborted (no hang)", async () => {
    clearAllStageRuns();
    bridge.clearRouting();
    arm(async () => ({ model: "m", agentId: "ag-hang" }));
    const p = runStage(baseInput());
    await settle();
    bridge.clearAllForSessionEnd(); // the session ends mid-run
    const r = await p;
    expect(r.aborted).toBe(true);
  });
});

describe("flattenStagePrompt", () => {
  test("messages flatten to bare text joined with blank-line separators (no role headers)", () => {
    expect(
      flattenStagePrompt([
        { role: "user", content: "one" },
        { role: "assistant", content: [{ type: "text", text: "two" }] },
      ]),
    ).toBe("one\n\ntwo");
  });
  test("a string content passes through; block arrays join their text parts", () => {
    expect(flattenStagePrompt([{ role: "user", content: "plain" }])).toBe("plain");
    expect(
      flattenStagePrompt([
        {
          role: "assistant",
          content: [
            { type: "thinking", text: "hmm" },
            { type: "text", text: "said" },
          ],
        },
      ]),
    ).toBe("said");
  });
});

describe("runStage — the widget event sink", () => {
  test("onEvent receives message_start at spawn and message_end with the completion usage", async () => {
    clearAllStageRuns();
    bridge.clearRouting();
    arm(async () => ({ model: "glm-5.1", agentId: "ag-we1" }));
    const events: Array<{ type: string; usage?: unknown }> = [];
    const promise = runStage(
      baseInput({
        onEvent: (event) => events.push(event as { type: string; usage?: unknown }),
      }),
    );
    await settle();
    expect(events.map((e) => e.type)).toContain("message_start");
    bridge.routeAgentCompletion({
      answer: "done",
      reason: "stop",
      agentId: "ag-we1",
      isAborted: false,
      usage: { input: 11, output: 7, cacheRead: 0, cacheWrite: 0, model: "glm-5.1" },
    });
    await promise;
    const end = events.find((e) => e.type === "message_end");
    expect(end).toBeDefined();
    expect((end as { message?: { usage?: { input?: number } } }).message?.usage?.input).toBe(11);
  });
});

describe("runStage — the closing translation", () => {
  test("the closing translation is whitespace-tolerant (pi's source wrapping, any re-wrap, single-line)", async () => {
    // the anchor matches regardless of how pi's paragraph wraps: the
    // source's three-line break, a single line, extra spaces
    const rewrapped = translateStageClosings(
      flattenStagePrompt([
        {
          role: "user",
          content:
            "x. When the chunk is fully covered, reply with the single word Done; if the chunk has nothing worth capturing, skip the tool and reply Done.",
        },
        {
          role: "user",
          content:
            "y. Stop when it accepts, or when you can make no   further progress. Stop when it accepts, or when you can make no further progress.",
        },
      ] as never),
    );
    const translated = (rewrapped.match(/call the "SubagentHandback" tool with the single word "Done"\./g) ?? [])
      .length;
    expect(translated).toBe(3); // observer + both builder/selector closings
    expect(rewrapped).not.toContain("reply with the single word Done");
    expect(rewrapped).not.toContain("Stop when it accepts");
  });

  test("the spawn prompt translates pi's closing sentence in place (cooperates with the handback enforcer)", async () => {
    clearAllStageRuns();
    bridge.clearRouting();
    const spawns: Array<{ prompt?: string }> = [];
    arm(async (input) => {
      spawns.push(input as { prompt?: string });
      return { model: "m", agentId: "ag-note" };
    });
    const p = runStage(baseInput());
    await settle();
    bridge.routeAgentCompletion({ answer: "Done", reason: "stop", agentId: "ag-note", isAborted: false, usage: null });
    await p;
    const prompt = spawns[0]?.prompt ?? "";
    expect(prompt.startsWith("(Platform note:")).toBe(false); // no prepended note — in-place translation
    // the handback phrasings replace pi's closing sentences
    expect(prompt).toContain('call the "SubagentHandback" tool with the single word "Done"');
    expect(prompt).not.toContain("reply with the single word Done"); // pi's observer closing is gone
    expect(prompt).not.toContain("Stop when it accepts"); // pi's builder/selector closing is gone
    expect(prompt).toContain("chunk text"); // the flattened messages still ride
  });
});
