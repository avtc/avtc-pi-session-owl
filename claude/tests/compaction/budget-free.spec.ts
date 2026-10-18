// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// The compaction gate's budget-free wait seam:
// the engine's per-dispatch hook budget is 10s, and the clock stops only
// while a $ call of the hook is in flight — waiting for our own spawned
// observer/builder stages is our own promise time and burns the budget
// (a long catch-up trips the engine's "ran past its 10s budget" line and
// the answer is discarded). Routing the
// ensure-ready phases through a $.tool.call to our own in-process tool
// keeps the clock paused for the whole stage wait: plugin-hosted tools are
// type "sdk" — no engine-side duration limit (MCP_TOOL_TIMEOUT defaults to
// ~28h; the idle timeout is disabled for sdk servers).
import { beforeEach, describe, expect, test, vi } from "vitest";
import {
  AWAIT_STAGE_TOOL,
  awaitStageToolSpec,
  joinStageRun,
  joinStageRunSliced,
  raceTakeoverWithSignal,
  stageWorkCall,
  takeStageWork,
  withBudgetFreeWait,
} from "../../host/compaction/budget-free.js";

describe("await_stage — the registered tool", () => {
  test("the spec: deferred (off the main prompt), key-scoped input", () => {
    const spec = awaitStageToolSpec() as Record<string, unknown>;
    expect(spec.name).toBe("await_stage");
    expect(spec.isDeferred).toBe(true);
    const schema = spec.inputSchema as { required?: string[] };
    expect(schema.required).toContain("key");
  });

  test("the full engine-facing name is prefixed for $.tool.call", () => {
    expect(AWAIT_STAGE_TOOL).toBe("mcp__session-owl__await_stage");
  });
});

describe("await_stage — the pending-work map", () => {
  beforeEach(() => {
    // drain any leftovers
    for (const k of ["sess-x", "sess-y"]) takeStageWork(k);
  });

  test("set then take hands the closure over once", () => {
    let ran = 0;
    stageWorkCall("sess-x", async () => {
      ran += 1;
    });
    const work = takeStageWork("sess-x");
    expect(work).toBeDefined();
    expect(takeStageWork("sess-x")).toBeUndefined(); // one-shot
    void work?.().then(() => expect(ran).toBe(1));
  });
});

describe("withBudgetFreeWait — the deps wrapper", () => {
  test("the ensure-ready work rides the tool call; the result passes through", async () => {
    const calls: Array<{ tool: string; args: Record<string, unknown> }> = [];
    let storedWork: (() => Promise<unknown>) | undefined;
    const deps = { key: "sess-w" } as unknown as Parameters<typeof withBudgetFreeWait>[0];
    const wrapped = withBudgetFreeWait(deps, {
      call: async (tool, args) => {
        calls.push({ tool, args });
        // the real tool side TAKES and RUNS the parked work — its completion
        // is what the $.tool.call waits on
        storedWork = takeStageWork("sess-w");
        await storedWork?.();
        return { result: "done" };
      },
      onError: () => {
        throw new Error("must not fire");
      },
    });
    const verdict = await wrapped.viaToolCall?.(async () => {
      await new Promise((r) => setTimeout(r, 2));
      return "ok" as const;
    });
    expect(verdict).toBe("ok");
    expect(calls).toEqual([{ tool: AWAIT_STAGE_TOOL, args: { key: "sess-w" } }]);
    // the work itself was REGISTERED before the call — the tool side runs it
    expect(storedWork).toBeDefined(); // the tool side found and ran the gate's phases closure
  });

  test("a failed tool call falls back to running the work inline (never broken, budget risk said)", async () => {
    const said: string[] = [];
    let ranInline = false;
    const deps = { key: "sess-f" } as unknown as Parameters<typeof withBudgetFreeWait>[0];
    const wrapped = withBudgetFreeWait(deps, {
      call: async () => {
        throw new Error("tool dispatch refused");
      },
      onError: (m) => said.push(m),
    });
    const verdict = await wrapped.viaToolCall?.(async () => {
      ranInline = true;
      return "cancel" as const;
    });
    expect(verdict).toBe("cancel"); // the work's own verdict passes through the fallback
    expect(ranInline).toBe(true);
    expect(said.length).toBe(1);
    expect(said[0]).toContain("await_stage");
  });
});

describe("joinStageRun — the dispatch-agnostic run state (looped wait)", () => {
  test("the run executes exactly once across joined dispatches; settled runs clean up", async () => {
    let runs = 0;
    stageWorkCall("sess-join", async () => {
      runs += 1;
      await new Promise((r) => setTimeout(r, 10));
    });
    const a = joinStageRun("sess-join");
    const b = joinStageRun("sess-join");
    expect(a).toBeDefined();
    expect(b).toBeDefined();
    await Promise.all([a as Promise<void>, b as Promise<void>]);
    expect(runs).toBe(1); // one execution however many slices the engine cut
    await new Promise((r) => setTimeout(r, 5));
    expect(joinStageRun("sess-join")).toBeUndefined(); // settled + cleaned
  });

  test("a cold dispatch (nothing parked, nothing live) answers undefined — the deny case", () => {
    takeStageWork("sess-cold");
    expect(joinStageRun("sess-cold")).toBeUndefined();
  });
});

describe("joinStageRunSliced — the 9s slice (the serving hook yields BEFORE the engine's 10s cut)", () => {
  test("a run longer than the slice answers {done:false} at the boundary while the run continues in-process", async () => {
    vi.useFakeTimers();
    try {
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      stageWorkCall("slice-long", () => gate);
      const answer = joinStageRunSliced("slice-long") as Promise<{ result: string; done: boolean }>;
      expect(answer).toBeDefined();
      const raced = vi.advanceTimersByTimeAsync(9000); // the slice boundary
      await raced;
      const settled = await answer;
      expect(settled.done).toBe(false); // the slice yielded, no cut, no signal
      expect(settled.result).toBe("slice");
      release(); // the run finishes later, detached
      await vi.advanceTimersByTimeAsync(1);
    } finally {
      vi.useRealTimers();
    }
  });

  test("a run settling inside the slice answers {done:true, result:'done'}", async () => {
    stageWorkCall("slice-short", async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    const answer = await joinStageRunSliced("slice-short");
    expect(answer).toEqual({ result: "done", done: true });
  });

  test("a cold key answers undefined (the deny case, unchanged)", () => {
    expect(joinStageRunSliced("slice-cold")).toBeUndefined();
  });

  test("STAGE_SLICE_MS stays under the engine's 10s dispatch ceiling with real margin", async () => {
    const { STAGE_SLICE_MS } = await import("../../host/compaction/budget-free.js");
    expect(STAGE_SLICE_MS).toBeGreaterThan(0);
    expect(STAGE_SLICE_MS).toBeLessThan(9500); // the cut lands at ~10s; stay safely before it
  });
});

describe("withBudgetFreeWait — the user-abort wire (next.signal: Esc aborts the compaction)", () => {
  test("an aborted signal stops the re-dispatch loop; the run settles and the failure surfaces", async () => {
    const controller = new AbortController();
    let dispatches = 0;
    let releaseRun!: () => void;
    const gate = new Promise<void>((r) => (releaseRun = r));
    let started = false;
    const wrapped = withBudgetFreeWait({ key: "sess-abort" } as unknown as Parameters<typeof withBudgetFreeWait>[0], {
      call: async () => {
        dispatches += 1;
        await new Promise((r) => setTimeout(r, 1)); // a macrotask turn: the test's release timer must fire
        if (!started) {
          started = true;
          joinStageRun("sess-abort"); // pretend the serving side started the parked work
        }
        controller.abort(); // the user pressed Esc mid-slice
        return { done: false };
      },
      onError: () => {},
      signal: controller.signal,
    });
    const outcome = wrapped.viaToolCall?.(async () => {
      await gate;
      return "ok" as const;
    });
    await new Promise((r) => setTimeout(r, 5));
    releaseRun(); // the controller abort unwound the run (its failure is captured)
    const settled = await outcome;
    expect(dispatches).toBe(1); // NO re-dispatch after the abort
    expect(settled).toBe("ok");
  });

  test("a signal already aborted before the wait never dispatches", async () => {
    const controller = new AbortController();
    controller.abort();
    let dispatches = 0;
    const wrapped = withBudgetFreeWait(
      { key: "sess-aborted-early" } as unknown as Parameters<typeof withBudgetFreeWait>[0],
      {
        call: async () => {
          dispatches += 1;
          await new Promise((r) => setTimeout(r, 1));
          joinStageRun("sess-aborted-early"); // the serving side starts the parked work (instant settle)
          return { done: true };
        },
        onError: () => {},
        signal: controller.signal,
      },
    );
    const verdict = await wrapped.viaToolCall?.(async () => "pass" as const);
    expect(dispatches).toBe(0);
    expect(verdict).toBe("pass"); // the work ran inline-resolved via the closure capture
  });
});

describe("withBudgetFreeWait — the stalled-dispatch bail (the queued Esc detector)", () => {
  test("a dispatch stalled past the bail window unwinds via onStall and never re-dispatches", async () => {
    let dispatches = 0;
    const stalls: string[] = [];
    const wrapped = withBudgetFreeWait({ key: "sess-stall" } as unknown as Parameters<typeof withBudgetFreeWait>[0], {
      call: () =>
        new Promise(() => {
          dispatches += 1;
          // never resolves — the engine paused dispatching behind a queued interrupt
        }),
      onError: () => {},
      onStall: (key) => stalls.push(key),
      stallMs: 20, // test-fast bail window
    });
    const outcome = wrapped.viaToolCall?.(async () => "ok" as const);
    await new Promise((r) => setTimeout(r, 60));
    expect(dispatches).toBe(1); // the stalled one only — no re-dispatch
    expect(stalls).toEqual(["sess-stall"]); // the cancel wire fired for THIS conversation
    const verdict = await outcome;
    expect(verdict).toBe("ok"); // the aborted run settled; the closure carried the verdict
  });

  test("a dispatch answering inside the window never trips onStall", async () => {
    const stalls: string[] = [];
    let releaseRun!: () => void;
    const gate = new Promise<void>((r) => (releaseRun = r));
    const wrapped = withBudgetFreeWait({ key: "sess-nostall" } as unknown as Parameters<typeof withBudgetFreeWait>[0], {
      call: async () => {
        joinStageRun("sess-nostall");
        await new Promise((r) => setTimeout(r, 1));
        return { done: false };
      },
      onError: () => {},
      onStall: (key) => stalls.push(key),
      stallMs: 5000,
    });
    const outcome = wrapped.viaToolCall?.(async () => {
      await gate;
      return "ok" as const;
    });
    await new Promise((r) => setTimeout(r, 10));
    releaseRun();
    await new Promise((r) => setTimeout(r, 10));
    expect(await outcome).toBe("ok");
    expect(stalls).toEqual([]);
  });
});

describe("raceTakeoverWithSignal — the 5s turn-interrupt grace (Esc aborts the compaction)", () => {
  test("the takeover settles first when no abort fires (the outcome passes through untouched)", async () => {
    const controller = new AbortController();
    const cancelWire: string[] = [];
    const outcome = await raceTakeoverWithSignal(
      new Promise<{ kind: "pass" }>((r) => setTimeout(() => r({ kind: "pass" }), 10)),
      controller.signal,
      (key) => cancelWire.push(key),
      "conv-grace",
    );
    expect(outcome).toEqual({ kind: "pass" });
    expect(cancelWire).toEqual([]);
  });

  test("an abort mid-takeover resolves PASS immediately and fires the cancel wire; the detached takeover finishes silently", async () => {
    const controller = new AbortController();
    const cancelWire: string[] = [];
    let takeoverSettled = false;
    const outcomeP = raceTakeoverWithSignal(
      new Promise<{ kind: "pass" }>((r) =>
        setTimeout(() => {
          takeoverSettled = true;
          r({ kind: "answer" as never });
        }, 60),
      ),
      controller.signal,
      (key) => cancelWire.push(key),
      "conv-grace-2",
    );
    await new Promise((r) => setTimeout(r, 10));
    controller.abort(); // the user pressed Esc
    const outcome = await outcomeP;
    expect(outcome).toEqual({ kind: "pass" }); // returned IMMEDIATELY — the engine's 5s grace is met
    expect(cancelWire).toEqual(["conv-grace-2"]); // the gate's controller was aborted
    expect(takeoverSettled).toBe(false); // not yet — it unwinds detached, never blocking the hook
    await new Promise((r) => setTimeout(r, 60));
    expect(takeoverSettled).toBe(true);
  });

  test("a takeover REJECTION before any abort surfaces as pass (the engine is skipping us regardless)", async () => {
    const controller = new AbortController();
    const outcome = await raceTakeoverWithSignal(
      Promise.reject(new Error("gate blew up")),
      controller.signal,
      () => {},
      "conv-grace-3",
    );
    expect(outcome).toEqual({ kind: "pass" });
  });
});

describe("joinStageRunSliced — the turn-interrupt race (the in-flight slice honors the 5s grace)", () => {
  test("a signal abort mid-slice answers {done:false, result:'aborted'} at once — long before the slice boundary", async () => {
    const controller = new AbortController();
    let release!: () => void;
    stageWorkCall("slice-abort", () => new Promise<void>((r) => (release = r)));
    const answer = joinStageRunSliced("slice-abort", 9000, controller.signal) as Promise<{
      result: string;
      done: boolean;
    }>;
    const raced = answer.then((a) => a);
    setTimeout(() => controller.abort(), 15);
    const settled = await raced;
    expect(settled).toEqual({ result: "aborted", done: false });
    release();
    await new Promise((r) => setTimeout(r, 5));
  });

  test("no signal, no abort shape — the plain slice contract is unchanged", async () => {
    stageWorkCall("slice-nosig", async () => {
      await new Promise((r) => setTimeout(r, 5));
    });
    const settled = await joinStageRunSliced("slice-nosig", 9000, undefined);
    expect(settled).toEqual({ result: "done", done: true });
  });
});
