// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import type { AgentMessage, AgentTool } from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { setClock } from "../../src/graph/mutations.js";
import { type ObserverRunInput, runObserver } from "../../src/observer/run.js";
import { getGraphStore, resetForNewSession } from "../../src/store/graph-store.js";
import { NO_OP_WIDGET, type WidgetController } from "../../src/widget/tracker.js";

// --- helpers ---------------------------------------------------------------

/** A minimal user/assistant message entry for the chunk source. */
function userEntry(id: string, text: string): SessionEntry {
  return {
    id,
    type: "message",
    parentId: null,
    timestamp: "2026-07-29 10:00",
    message: { role: "user", content: text },
  } as unknown as SessionEntry;
}
function assistantEntry(id: string, text: string): SessionEntry {
  return {
    id,
    type: "message",
    parentId: null,
    timestamp: "2026-07-29 10:01",
    message: { role: "assistant", content: [{ type: "text", text }] },
  } as unknown as SessionEntry;
}

/** A fake pi that records every appendEntry call (customType, data). */
function makeFakePi(): { pi: ExtensionAPI; appended: { type: string; data: unknown }[] } {
  const appended: { type: string; data: unknown }[] = [];
  const pi = {
    appendEntry: (customType: string, data: unknown) => {
      appended.push({ type: customType, data });
    },
  } as unknown as ExtensionAPI;
  return { pi, appended };
}

/** A fake ctx whose sessionManager.getLeafId returns the last appended entry's
 *  id (simulating pi assigning the leaf id). The branch is whatever the test
 *  passes (unused by runObserver beyond getLeafId). */
function makeFakeCtx(): ExtensionContext {
  let leafId = "seed-leaf";
  const fakeModel = { provider: "test", id: "observer-model" } as unknown as Model<never>;
  return {
    sessionManager: {
      getLeafId: () => leafId,
      getBranch: () => [],
      setLeafId: (id: string) => {
        leafId = id;
      },
    },
    modelRegistry: {
      find: () => fakeModel,
      getApiKeyAndHeaders: async () => ({ ok: true as const, apiKey: "key" }),
    } as unknown as ExtensionContext,
    model: fakeModel,
    ui: { notify: (..._a: unknown[]) => {} } as unknown as ExtensionContext["ui"],
  } as unknown as ExtensionContext;
}

/** A scripted runStage: each call executes the record_observations tool once
 *  with the given batch of observations, then resolves. Returns an object whose
 *  `calls` records how many times the fake loop ran (= number of chunks). */
function scriptedRunStage(batchesPerChunk: RecordObservationInput[][]): {
  fn: ObserverRunInput["runStageFn"];
  calls: number;
  acks: string[];
} {
  let calls = 0;
  const acks: string[] = [];
  const fn = async (input: Parameters<NonNullable<ObserverRunInput["runStageFn"]>>[0]) => {
    const tool = input.tools[0] as AgentTool;
    const batch = batchesPerChunk[calls] ?? [];
    calls += 1;
    if (batch.length > 0) {
      const result = await tool.execute("call-1", { observations: batch });
      const text = (result.content[0] as { text: string }).text;
      acks.push(text);
    }
    return {
      messages: [] as AgentMessage[],
      usage: { input: 0, output: 0, cacheRead: 0, cost: 0, turns: 1 },
      streamingOutputTokens: 0,
      aborted: false,
    };
  };
  return {
    fn,
    get calls() {
      return calls;
    },
    acks,
  };
}

type RecordObservationInput = {
  content: string;
  importance: "critical" | "high" | "medium" | "low";
  sourceEntryIds: string[];
};

/** Build runObserver args with all the standard plumbing + a scripted runStage. */
function makeArgs(opts: {
  pi: ExtensionAPI;
  ctx: ExtensionContext;
  unobserved: SessionEntry[];
  runStageFn: ObserverRunInput["runStageFn"];
  thresholdTokens?: number;
  widget?: WidgetController;
}): ObserverRunInput {
  return {
    ctx: opts.ctx,
    pi: opts.pi,
    settings: {
      enabled: true,
      defaultModel: null,
      observerModel: null,
      observerMode: "on-threshold",
      observerThresholdTokens: opts.thresholdTokens ?? 100000,
      observerIncludeThinking: false,
      observerToolBlockCapTokens: null,
      builderModel: null,
      builderMode: "on-compaction",
      builderEveryNObservations: 40,
      builderSessionContextThresholdTokens: 200000,
      builderRootViewThreshold: 8000,
      maxBuilderPasses: 5,
      selectorModel: null,
      selectorMode: "on-compaction",
      selectorSessionContextThresholdTokens: 200000,
      selectorRootViewThreshold: 4000,
      maxSelectorPasses: 5,
      renderMode: "selected-root",
      commandResultCap: 50,
    },
    unobserved: opts.unobserved,
    signal: new AbortController().signal,
    runStageFn: opts.runStageFn,
    widget: opts.widget ?? NO_OP_WIDGET,
  };
}

describe("runObserver", () => {
  beforeEach(() => {
    resetForNewSession();
    setClock(() => "2026-07-29 10:05");
  });
  afterAll(() => {
    setClock(null);
  });

  it("wraps a good record under a new node at root and persists both deltas", async () => {
    const { pi, appended } = makeFakePi();
    const ctx = makeFakeCtx();
    const unobserved = [
      userEntry("u1", "initial prompt captured mechanically"),
      assistantEntry("a1", "we chose vitest for tests"),
    ];
    const script = scriptedRunStage([
      [{ content: "Chose vitest for all new tests.", importance: "high", sourceEntryIds: ["a1"] }],
    ]);

    await runObserver(makeArgs({ pi, ctx, unobserved, runStageFn: script.fn }));

    // exactly one create_node graph_delta + one memkeeper.observation entry
    const graphDeltas = appended.filter((e) => e.type === "memkeeper.graph_delta");
    const obsEntries = appended.filter((e) => e.type === "memkeeper.observation");
    expect(graphDeltas).toHaveLength(1);
    expect(obsEntries).toHaveLength(1);

    // the single observation delta covers the whole unobserved range and carries
    // the exact accumulated token count.
    const obsEntry = obsEntries[0].data as { coversFromId: string | null; coversUpToId: string; tokenCount: number };
    expect(obsEntry.coversFromId).toBe("u1");
    expect(obsEntry.coversUpToId).toBe("a1");
    expect(obsEntry.tokenCount).toBe(Math.ceil("Chose vitest for all new tests.".length / 4));

    // the wrapper node exists in-memory at root, state new, with the obs
    const graph = getGraphStore().graph;
    const wrapper = [...graph.nodes.values()].find((n) => n.id !== "nGoal" && n.state === "new");
    expect(wrapper).toBeDefined();
    expect(wrapper?.parentNode).toBeNull();
    expect(wrapper?.importance).toBe("high");
    expect(wrapper?.summary).toBe("");
    expect(wrapper?.observationIds).toHaveLength(1);
    const obsId = wrapper !== undefined ? wrapper.observationIds[0] : undefined;
    const obs = obsId !== undefined ? graph.observations.get(obsId) : undefined;
    expect(obs?.content).toBe("Chose vitest for all new tests.");

    // frontier advanced to the last unobserved entry id
    expect(getGraphStore().observerFrontier).toBe("a1");
  });

  it("converts a real ISO source timestamp into the stored 'YYYY-MM-DD HH:MM' contract format", async () => {
    const { pi } = makeFakePi();
    const ctx = makeFakeCtx();
    // real SessionEntry timestamps are ISO (e.g. '2026-07-29T09:22:50.283Z'); the
    // observation's stored timestamp must be the 'YYYY-MM-DD HH:MM' format the
    // render layer expects, not the raw ISO.
    const unobserved: SessionEntry[] = [
      {
        id: "u1",
        type: "message",
        parentId: null,
        timestamp: "2026-07-29T09:00:00.000Z",
        message: { role: "user", content: "initial prompt captured mechanically" },
      } as unknown as SessionEntry,
      {
        id: "a1",
        type: "message",
        parentId: null,
        timestamp: "2026-07-29T09:22:50.283Z",
        message: { role: "assistant", content: [{ type: "text", text: "we chose vitest for tests" }] },
      } as unknown as SessionEntry,
    ];
    const script = scriptedRunStage([[{ content: "Chose vitest.", importance: "high", sourceEntryIds: ["a1"] }]]);

    await runObserver(makeArgs({ pi, ctx, unobserved, runStageFn: script.fn }));

    const wrapper = [...getGraphStore().graph.nodes.values()].find((n) => n.state === "new");
    const obsId = wrapper !== undefined ? wrapper.observationIds[0] : undefined;
    const obs = obsId !== undefined ? getGraphStore().graph.observations.get(obsId) : undefined;
    // contract format, not raw ISO: 'YYYY-MM-DD HH:MM' derived from '2026-07-29T09:22:50.283Z'
    expect(obs?.timestamp).toBe("2026-07-29 09:22");
  });

  it("skips + notifies when the model cannot be resolved (no model available)", async () => {
    const { pi, appended } = makeFakePi();
    // a ctx with no resolvable model and no session model
    const ctx = {
      sessionManager: { getLeafId: () => "leaf", getBranch: () => [] },
      modelRegistry: { find: () => undefined, getApiKeyAndHeaders: async () => ({ ok: false, error: "no key" }) },
      model: undefined,
      ui: { notify: () => {} },
    } as unknown as ExtensionContext;
    const notify = vi.spyOn(ctx.ui, "notify");
    const unobserved = [userEntry("u1", "initial prompt captured mechanically"), assistantEntry("a1", "chose vitest")];
    const script = scriptedRunStage([[{ content: "Chose vitest.", importance: "high", sourceEntryIds: ["a1"] }]]);

    await runObserver(makeArgs({ pi, ctx, unobserved, runStageFn: script.fn }));

    // the run never started (script.calls === 0), nothing persisted, user warned
    expect(script.calls).toBe(0);
    expect(appended).toHaveLength(0);
    expect(getGraphStore().observerFrontier).toBeNull();
    expect(notify).toHaveBeenCalledWith(expect.stringMatching(/Observer skipped a run/i), "warning");
  });

  it("rejects a record citing a foreign id per-observation (good record still recorded)", async () => {
    const { pi, appended } = makeFakePi();
    const ctx = makeFakeCtx();
    const unobserved = [
      userEntry("u1", "initial prompt captured mechanically"),
      assistantEntry("a1", "keep build green; chose vitest"),
    ];
    const script = scriptedRunStage([
      [
        { content: "Every commit must keep the build green.", importance: "critical", sourceEntryIds: ["a1"] }, // good
        { content: "Foreign fact.", importance: "medium", sourceEntryIds: ["ZZZ-not-in-chunk"] }, // foreign id
      ],
    ]);

    await runObserver(makeArgs({ pi, ctx, unobserved, runStageFn: script.fn }));

    // only the good record wrapped; the ack reports 1 recorded, 1 rejected
    const graph = getGraphStore().graph;
    const newNodes = [...graph.nodes.values()].filter((n) => n.state === "new");
    expect(newNodes).toHaveLength(1);
    expect(newNodes[0].importance).toBe("critical");
    expect(script.acks[0]).toMatch(/recorded 1/i);
    expect(script.acks[0]).toMatch(/reject/i);

    // one observation entry with exactly one record
    const obsEntries = appended.filter((e) => e.type === "memkeeper.observation");
    expect(obsEntries).toHaveLength(1);
    expect((obsEntries[0].data as { records: unknown[] }).records).toHaveLength(1);
  });

  it("skips a chunk whose every record is rejected: no delta, notify, run continues", async () => {
    const { pi } = makeFakePi();
    const ctx = makeFakeCtx();
    ctx.ui = { notify: (..._a: unknown[]) => {} } as unknown as ExtensionContext["ui"];
    const notify = vi.spyOn(ctx.ui, "notify");
    // two chunks: first all-bad, second good
    const unobserved = [
      userEntry("u1", "initial prompt captured mechanically"),
      assistantEntry("a1", `noise one ${"x".repeat(200)}`),
      assistantEntry("a2", `chose vitest ${"y".repeat(200)}`),
    ];
    const script = scriptedRunStage([
      [{ content: "Bad 1.", importance: "low", sourceEntryIds: ["ZZZ"] }], // all-bad chunk 1
      [{ content: "Chose vitest.", importance: "high", sourceEntryIds: ["a2"] }], // good chunk 2
    ]);

    await runObserver(makeArgs({ pi, ctx, unobserved, runStageFn: script.fn, thresholdTokens: 50 }));

    // chunk 2's good record was recorded
    const newNodes = [...getGraphStore().graph.nodes.values()].filter((n) => n.state === "new");
    expect(newNodes).toHaveLength(1);
    expect(newNodes[0].importance).toBe("high");
    // notify was called for the all-bad chunk
    expect(notify).toHaveBeenCalled();
    // frontier advanced to the last entry (whole run committed)
    expect(getGraphStore().observerFrontier).toBe("a2");
  });

  it("on signal abort mid-run, stops and writes nothing (accumulate-then-append)", async () => {
    const { pi, appended } = makeFakePi();
    const ctx = makeFakeCtx();
    const controller = new AbortController();
    const unobserved = [userEntry("u1", "initial prompt captured mechanically"), assistantEntry("a1", "chose vitest")];
    // script a runStage that aborts before the tool call resolves its result return
    let calls = 0;
    const fn = async (input: Parameters<NonNullable<ObserverRunInput["runStageFn"]>>[0]) => {
      calls += 1;
      const tool = input.tools[0] as AgentTool;
      // execute the tool (records accumulate in-memory)...
      await tool.execute("c1", {
        observations: [{ content: "Chose vitest.", importance: "high", sourceEntryIds: ["a1"] }],
      });
      // ...then abort before the run completes
      controller.abort();
      throw new Error("aborted");
    };

    await runObserver({ ...makeArgs({ pi, ctx, unobserved, runStageFn: fn }), signal: controller.signal });

    expect(calls).toBe(1);
    // nothing persisted (no create_node, no observation)
    expect(appended.filter((e) => e.type === "memkeeper.graph_delta")).toHaveLength(0);
    expect(appended.filter((e) => e.type === "memkeeper.observation")).toHaveLength(0);
    // frontier unchanged
    expect(getGraphStore().observerFrontier).toBeNull();
  });

  it("does NOT flush new nodes (leaves them state:new for the Builder)", async () => {
    const { pi } = makeFakePi();
    const ctx = makeFakeCtx();
    const unobserved = [userEntry("u1", "initial prompt captured mechanically"), assistantEntry("a1", "chose vitest")];
    const script = scriptedRunStage([[{ content: "Chose vitest.", importance: "high", sourceEntryIds: ["a1"] }]]);

    await runObserver(makeArgs({ pi, ctx, unobserved, runStageFn: script.fn }));

    const wrapper = [...getGraphStore().graph.nodes.values()].find((n) => n.state === "new");
    expect(wrapper?.state).toBe("new");
  });

  it("records nothing and notifies when the model returns no observations", async () => {
    const { pi, appended } = makeFakePi();
    const ctx = makeFakeCtx();
    ctx.ui = { notify: (..._a: unknown[]) => {} } as unknown as ExtensionContext["ui"];
    const notify = vi.spyOn(ctx.ui, "notify");
    const unobserved = [
      userEntry("u1", "initial prompt captured mechanically"),
      assistantEntry("a1", "nothing of note"),
    ];
    // empty batch = model called the tool with zero observations then replied Done
    const script = scriptedRunStage([[]]);

    await runObserver(makeArgs({ pi, ctx, unobserved, runStageFn: script.fn }));

    expect(appended).toHaveLength(0);
    expect(getGraphStore().observerFrontier).toBeNull();
    expect(notify).toHaveBeenCalled();
  });

  it("accumulates records across multiple good chunks into ONE observation delta", async () => {
    const { pi, appended } = makeFakePi();
    const ctx = makeFakeCtx();
    // two chunks (threshold 1 → each entry its own chunk): [u1], [a1].
    const unobserved = [userEntry("u1", "initial prompt captured mechanically"), assistantEntry("a1", "chose vitest")];
    const script = scriptedRunStage([
      [{ content: "Initial goal stated.", importance: "high", sourceEntryIds: ["u1"] }], // chunk 1 [u1]
      [{ content: "Chose vitest.", importance: "high", sourceEntryIds: ["a1"] }], // chunk 2 [a1]
    ]);

    await runObserver(makeArgs({ pi, ctx, unobserved, runStageFn: script.fn, thresholdTokens: 1 }));

    // exactly ONE observation delta for the whole run, with BOTH records.
    const obsEntries = appended.filter((e) => e.type === "memkeeper.observation");
    expect(obsEntries).toHaveLength(1);
    const entry = obsEntries[0].data as {
      coversFromId: string | null;
      coversUpToId: string;
      records: { content: string }[];
      tokenCount: number;
    };
    expect(entry.records.map((r) => r.content)).toEqual(["Initial goal stated.", "Chose vitest."]);
    expect(entry.coversFromId).toBe("u1");
    expect(entry.coversUpToId).toBe("a1");
    // exact tokenCount = sum of the two records' chars/4 estimates.
    const expectedTokens = Math.ceil("Initial goal stated.".length / 4) + Math.ceil("Chose vitest.".length / 4);
    expect(entry.tokenCount).toBe(expectedTokens);
    // two wrapper create_node deltas (one per record)
    expect(appended.filter((e) => e.type === "memkeeper.graph_delta")).toHaveLength(2);
    // frontier advanced to the last entry of the whole run
    expect(getGraphStore().observerFrontier).toBe("a1");
  });

  it("opens the observe widget stage, reports batch progress, and closes it", async () => {
    const { pi, appended } = makeFakePi();
    const ctx = makeFakeCtx();
    // two chunks (threshold 1 → each entry its own chunk): [u1], [a1].
    const unobserved = [userEntry("u1", "initial prompt captured mechanically"), assistantEntry("a1", "chose vitest")];
    const script = scriptedRunStage([
      [{ content: "Goal.", importance: "high", sourceEntryIds: ["u1"] }],
      [{ content: "Decision.", importance: "high", sourceEntryIds: ["a1"] }],
    ]);
    const calls: { method: string; args: unknown[] }[] = [];
    const widget: WidgetController = {
      ...NO_OP_WIDGET,
      startStage: (stage, init) => calls.push({ method: "startStage", args: [stage, init] }),
      setBatch: (done, total) => calls.push({ method: "setBatch", args: [done, total] }),
      endStage: () => calls.push({ method: "endStage", args: [] }),
      onEvent: (event) => calls.push({ method: "onEvent", args: [event] }),
      render: () => calls.push({ method: "render", args: [] }),
    };

    await runObserver(makeArgs({ pi, ctx, unobserved, runStageFn: script.fn, thresholdTokens: 1, widget }));

    // observe stage opened once with the chunk count as the batch total
    const starts = calls.filter((c) => c.method === "startStage");
    expect(starts).toHaveLength(1);
    expect(starts[0]?.args[0]).toBe("observe");
    expect(starts[0]?.args[1]).toEqual({ batch: { done: 0, total: 2 } });
    // batch advanced per chunk (2 chunks → 2 setBatch calls)
    const batches = calls.filter((c) => c.method === "setBatch").map((c) => c.args);
    expect(batches).toEqual([
      [1, 2],
      [2, 2],
    ]);
    // stage closed exactly once at the end
    expect(calls.filter((c) => c.method === "endStage")).toHaveLength(1);
    // appended sanity (the run still persisted)
    expect(appended.some((e) => e.type === "memkeeper.observation")).toBe(true);
  });

  it("closes the observe stage even when a chunk throws (endStage in finally)", async () => {
    const { pi } = makeFakePi();
    const ctx = makeFakeCtx();
    const unobserved = [userEntry("u1", "x".repeat(50))];
    // a runStage that always throws (non-abort error → the chunk is skipped, run continues)
    const throwing = async () => {
      throw new Error("LLM boom");
    };
    const calls: string[] = [];
    const widget: WidgetController = {
      ...NO_OP_WIDGET,
      startStage: () => calls.push("start"),
      endStage: () => calls.push("end"),
    };

    await runObserver(makeArgs({ pi, ctx, unobserved, runStageFn: throwing, widget }));

    // stage opened then closed despite the throw (finally ran)
    expect(calls).toContain("start");
    expect(calls).toContain("end");
    expect(calls[calls.length - 1]).toBe("end");
  });

  it("closes the observe stage when the run aborts mid-loop (endStage in finally)", async () => {
    const { pi } = makeFakePi();
    const ctx = makeFakeCtx();
    // two chunks so the loop iterates; abort fires before the second chunk runs.
    const unobserved = [userEntry("u1", "x".repeat(50)), assistantEntry("a1", "y".repeat(50))];
    const controller = new AbortController();
    let chunk = 0;
    const abortAfterFirst = async () => {
      chunk += 1;
      if (chunk === 1) controller.abort(); // abort after the first chunk processes
      return {
        messages: [] as AgentMessage[],
        usage: { input: 0, output: 0, cacheRead: 0, cost: 0, turns: 1 },
        streamingOutputTokens: 0,
        aborted: controller.signal.aborted,
      };
    };
    const calls: string[] = [];
    const widget: WidgetController = {
      ...NO_OP_WIDGET,
      startStage: () => calls.push("start"),
      endStage: () => calls.push("end"),
    };

    await runObserver({
      ...makeArgs({ pi, ctx, unobserved, runStageFn: abortAfterFirst, widget }),
      signal: controller.signal,
    });

    // abort mid-run → endStage still fired (finally ran)
    expect(calls).toContain("start");
    expect(calls).toContain("end");
  });

  it("feeds each chunk's stage usage into the store ledger (onStageEnd seam)", async () => {
    const { pi } = makeFakePi();
    const ctx = makeFakeCtx();
    // two small chunks (low threshold forces a chunk per entry) → two stage runs
    const unobserved = [userEntry("u1", "x".repeat(50)), assistantEntry("a1", "y".repeat(50))];
    // a runStage that behaves like the real one: invokes onStageEnd with usage,
    // then returns the result. Returns a distinct non-zero usage per call.
    let call = 0;
    const usages = [
      { input: 1000, output: 500, cacheRead: 300, cost: 0.05, turns: 3 },
      { input: 2000, output: 1500, cacheRead: 700, cost: 0.11, turns: 5 },
    ];
    const runStageFn: ObserverRunInput["runStageFn"] = async (input) => {
      call += 1;
      const usage = usages[call - 1] ?? usages[0];
      // the real runStage invokes onStageEnd with the accumulated usage.
      input.onStageEnd?.(usage);
      return { messages: [], usage, streamingOutputTokens: 0, aborted: false };
    };

    await runObserver(makeArgs({ pi, ctx, unobserved, runStageFn, thresholdTokens: 10 }));

    // observe phase accumulated BOTH chunks' usage + counted two runs.
    const obs = getGraphStore().usageLedger.observe;
    expect(obs.input).toBe(3000);
    expect(obs.output).toBe(2000);
    expect(obs.cacheRead).toBe(1000);
    expect(obs.runs).toBe(2);
    // build/select untouched.
    expect(getGraphStore().usageLedger.build.runs).toBe(0);
    expect(getGraphStore().usageLedger.select.runs).toBe(0);
  });
});
