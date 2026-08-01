// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import type { AgentMessage, AgentTool } from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { setClock } from "../../src/graph/mutations.js";
import { type ObserverRunInput, runObserver } from "../../src/observer/run.js";
import { getGraphStore, resetForNewSession } from "../../src/store/graph-store.js";

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
    onEvent: null,
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
});
