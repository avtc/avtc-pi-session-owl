// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentMessage, AgentTool } from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { _resetGetSessionOwlSettings, _setGetSessionOwlSettings, DEFAULT_CONFIG } from "../../src/config/schema.js";
import { _setDumpHomeForTest, sanitizeForPath } from "../../src/debug-dump.js";
import { setClock } from "../../src/graph/mutations.js";
import { _setBaseLoggerForTest } from "../../src/log.js";
import { type ObserverRunInput, runObserver } from "../../src/observer/run.js";
import type { TurnPredicate } from "../../src/runtime/agent-loop.js";
import { _resetSessionAffinity, setSessionOwlSessionBase } from "../../src/runtime/session-affinity.js";
import { getGraphStore, resetForNewSession } from "../../src/store/graph-store.js";
import { NO_OP_WIDGET, type WidgetController } from "../../src/widget/tracker.js";

// --- helpers ---------------------------------------------------------------

/** A minimal user/assistant message entry for the chunk source. */
function userEntry(id: string, text: string): SessionEntry {
  return {
    id,
    type: "message",
    parentId: null,
    timestamp: "2026-07-29T10:00:00.000Z",
    message: { role: "user", content: text },
  } as unknown as SessionEntry;
}
function assistantEntry(id: string, text: string): SessionEntry {
  return {
    id,
    type: "message",
    parentId: null,
    timestamp: "2026-07-29T10:01:00.000Z",
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
 *  id (simulating pi assigning the leaf id). The branch is settable: makeArgs
 *  points it at the test's unobserved slice (the real branch always contains
 *  the entries the Observer covers — the frontier advance resolves on it). */
function makeFakeCtx(): ExtensionContext & { setBranchForTest: (entries: SessionEntry[]) => void } {
  let leafId = "seed-leaf";
  let branch: SessionEntry[] = [];
  const fakeModel = { provider: "test", id: "observer-model" } as unknown as Model<never>;
  const ctx = {
    sessionManager: {
      getLeafId: () => leafId,
      getBranch: () => branch,
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
    setBranchForTest: (entries: SessionEntry[]) => {
      branch = entries;
    },
  } as unknown as ExtensionContext & { setBranchForTest: (entries: SessionEntry[]) => void };
  return ctx;
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
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1, elapsedMs: 0 },
      outputTokens: 0,
      aborted: false,
      timedOut: false,
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
  summary: string;
  importance: "crit" | "high" | "med" | "low";
  sourceEntryIds: string[];
};

/** Build runObserver args with all the standard plumbing + a scripted runStage. */
function makeArgs(opts: {
  pi: ExtensionAPI;
  ctx: ExtensionContext;
  unobserved: SessionEntry[];
  runStageFn: ObserverRunInput["runStageFn"];
  thresholdTokens?: number;
  debugDumpLimit?: number;
  widget?: WidgetController;
  maybeBuild?: ObserverRunInput["maybeBuild"];
}): ObserverRunInput {
  // point the fake ctx's branch at the unobserved slice (the frontier advance
  // resolves coversUpToId against it)
  const withBranch = opts.ctx as ExtensionContext & {
    setBranchForTest?: (entries: SessionEntry[]) => void;
  };
  if (typeof withBranch.setBranchForTest === "function") withBranch.setBranchForTest(opts.unobserved);
  return {
    ctx: opts.ctx,
    pi: opts.pi,
    settings: {
      ...DEFAULT_CONFIG,
      enabled: true,
      observerMode: "on-threshold",
      observerThresholdTokens: opts.thresholdTokens ?? 100000,
      ...(opts.debugDumpLimit !== undefined ? { debugDumpLimit: opts.debugDumpLimit } : {}),
    },
    unobserved: opts.unobserved,
    signal: new AbortController().signal,
    runStageFn: opts.runStageFn,
    widget: opts.widget ?? NO_OP_WIDGET,
    ...(opts.maybeBuild !== undefined ? { maybeBuild: opts.maybeBuild } : {}),
  };
}

describe("runObserver", () => {
  beforeEach(() => {
    resetForNewSession();
    setClock(() => "2026-07-29T10:05:00.000Z");
    _resetSessionAffinity();
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
      [{ summary: "Chose vitest for all new tests.", importance: "high", sourceEntryIds: ["a1"] }],
    ]);

    await runObserver(makeArgs({ pi, ctx, unobserved, runStageFn: script.fn }));

    // exactly one graph_delta (a batched envelope) + one session-owl.observation entry
    const graphDeltas = appended.filter((e) => e.type === "session-owl.graph_delta");
    const obsEntries = appended.filter((e) => e.type === "session-owl.observation");
    expect(graphDeltas).toHaveLength(1);
    // the batched envelope carries the chunk's ops in live order: create_node
    // immediately followed by its record_observation (replay re-executes the
    // exact live sequence, so later Builder merges relocate the record)
    const batch = (graphDeltas[0].data as { deltas?: Record<string, unknown>[] }).deltas;
    expect(Array.isArray(batch)).toBe(true);
    expect(batch?.map((d) => d.type)).toEqual(["create_node", "record_observation"]);
    const wrapperDelta = batch?.[0] as unknown as { id: string };
    const recordDelta = batch?.[1] as unknown as { obs: { parentNode: string } };
    expect(recordDelta.obs.parentNode).toBe(wrapperDelta.id);
    expect(obsEntries).toHaveLength(1);

    // the single observation delta covers the whole unobserved range and carries
    // the exact accumulated token count.
    const obsEntry = obsEntries[0].data as { coversFromId: string | null; coversUpToId: string; tokenCount: number };
    expect(obsEntry.coversFromId).toBe("u1");
    expect(obsEntry.coversUpToId).toBe("a1");
    // tokenCount = the verbatim source size (Σ detailsTokens), NOT the summary.
    // The verbatim render of a1 is '<ASSISTANT>we chose vitest for tests</ASSISTANT>'.
    expect(obsEntry.tokenCount).toBe(Math.ceil("<ASSISTANT>we chose vitest for tests</ASSISTANT>".length / 4));

    // the wrapper node exists in-memory at root, state new, with the obs
    const graph = getGraphStore().graph;
    const wrapper = [...graph.nodes.values()].find((n) => n.id !== "nGoal" && n.state === "new");
    expect(wrapper).toBeDefined();
    expect(wrapper?.parentNode).toBeNull();
    expect(wrapper?.importance).toBe("high");
    // the wrapper is seeded with the observation's summary at birth (every
    // node always reads with a summary); the Builder refines it later.
    expect(wrapper?.summary).toBe("Chose vitest for all new tests.");
    expect(wrapper?.observationIds).toHaveLength(1);
    const obsId = wrapper !== undefined ? wrapper.observationIds[0] : undefined;
    const obs = obsId !== undefined ? graph.observations.get(obsId) : undefined;
    expect(obs?.summary).toBe("Chose vitest for all new tests.");

    // details counts are the VERBATIM SOURCE size (computed from the record's
    // sourceEntryIds at capture), NOT the one-line summary placeholder. The
    // verbatim render of a1 is '<ASSISTANT>we chose vitest for tests</ASSISTANT>'
    // (43 chars -> 11 tokens, 1 line), distinct from the summary (32 chars -> 8).
    expect(obs?.detailsLines).toBe(1);
    expect(obs?.detailsTokens).toBe(Math.ceil("<ASSISTANT>we chose vitest for tests</ASSISTANT>".length / 4));
    expect(obs?.detailsTokens).not.toBe(obs?.summaryTokens);

    // frontier advanced to the last unobserved entry id
    expect(getGraphStore().observerFrontier).toBe("a1");
  });

  it("stores a real ISO source timestamp as the UTC ISO contract (rendered to local at display)", async () => {
    const { pi } = makeFakePi();
    const ctx = makeFakeCtx();
    // real SessionEntry timestamps are ISO (e.g. '2026-07-29T09:22:50.283Z'); the
    // observation's stored timestamp keeps the UTC ISO instant (absolute/
    // TZ-agnostic) and the render layer converts it to local at display time.
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
    const script = scriptedRunStage([[{ summary: "Chose vitest.", importance: "high", sourceEntryIds: ["a1"] }]]);

    await runObserver(makeArgs({ pi, ctx, unobserved, runStageFn: script.fn }));

    const wrapper = [...getGraphStore().graph.nodes.values()].find((n) => n.state === "new");
    const obsId = wrapper !== undefined ? wrapper.observationIds[0] : undefined;
    const obs = obsId !== undefined ? getGraphStore().graph.observations.get(obsId) : undefined;
    // the UTC ISO instant is preserved verbatim (render converts to local)
    expect(obs?.timestamp).toBe("2026-07-29T09:22:50.283Z");
    // clean case: the whole batch landed — the shortest confirmation, no directives
    expect(script.acks[0]).toBe("accepted: all");
  });

  it("writes no session-owl.usage entry when no chunk reports usage (the hasUsage guard)", async () => {
    const { pi, appended } = makeFakePi();
    const ctx = makeFakeCtx();
    // empty unobserved → zero chunks → the stage opens with 0 batches but no
    // per-chunk onStageEnd fires, so hasUsage() stays false and no usage delta
    // is persisted.
    const script = scriptedRunStage([]);
    await runObserver(makeArgs({ pi, ctx, unobserved: [], runStageFn: script.fn }));
    expect(script.calls).toBe(0);
    expect(appended.filter((e) => e.type === "session-owl.usage")).toHaveLength(0);
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
    const script = scriptedRunStage([[{ summary: "Chose vitest.", importance: "high", sourceEntryIds: ["a1"] }]]);

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
        { summary: "Every commit must keep the build green.", importance: "crit", sourceEntryIds: ["a1"] }, // good
        { summary: "Foreign fact.", importance: "med", sourceEntryIds: ["ZZZ-not-in-chunk"] }, // foreign id
      ],
    ]);

    await runObserver(makeArgs({ pi, ctx, unobserved, runStageFn: script.fn }));

    // only the good record wrapped; the ack is a pure state report — which of
    // the model's own records landed, why the other didn't
    const graph = getGraphStore().graph;
    const newNodes = [...graph.nodes.values()].filter((n) => n.state === "new");
    expect(newNodes).toHaveLength(1);
    expect(newNodes[0].importance).toBe("crit");
    expect(script.acks[0]).toBe("accepted: #1\nrejected:\n#2: source id not in this chunk");

    // one observation entry with exactly one record
    const obsEntries = appended.filter((e) => e.type === "session-owl.observation");
    expect(obsEntries).toHaveLength(1);
    expect((obsEntries[0].data as { records: unknown[] }).records).toHaveLength(1);
  });

  it("rejects a non-substantive summary (no letters/digits) per-observation (good record still recorded)", async () => {
    const { pi, appended } = makeFakePi();
    const ctx = makeFakeCtx();
    const unobserved = [
      userEntry("u1", "initial prompt captured mechanically"),
      assistantEntry("a1", "keep build green; chose vitest"),
    ];
    // a degenerate model turn (thinking-only garbage) must not reach the graph
    const script = scriptedRunStage([
      [
        { summary: "Every commit must keep the build green.", importance: "crit", sourceEntryIds: ["a1"] }, // good
        { summary: "!!!!!!", importance: "med", sourceEntryIds: ["a1"] }, // symbols only
        { summary: "  ...", importance: "low", sourceEntryIds: ["a1"] }, // punctuation only
      ],
    ]);

    await runObserver(makeArgs({ pi, ctx, unobserved, runStageFn: script.fn }));

    // only the good record wrapped; per-record rejection report, model-indexed
    const graph = getGraphStore().graph;
    const newNodes = [...graph.nodes.values()].filter((n) => n.state === "new");
    expect(newNodes).toHaveLength(1);
    expect(script.acks[0]).toBe("accepted: #1\nrejected:\n#2: non-substantive summary\n#3: non-substantive summary");
    // one observation entry with exactly one record (the garbage was dropped)
    const obsEntries = appended.filter((e) => e.type === "session-owl.observation");
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
      [{ summary: "Bad 1.", importance: "low", sourceEntryIds: ["ZZZ"] }], // all-bad chunk 1
      [{ summary: "Chose vitest.", importance: "high", sourceEntryIds: ["a2"] }], // good chunk 2
    ]);

    await runObserver(makeArgs({ pi, ctx, unobserved, runStageFn: script.fn, thresholdTokens: 50 }));

    // chunk 2's good record was recorded; chunk 1 (all-rejected) persists an
    // empty-verdict entry covering itself — never auto-retried
    const newNodes = [...getGraphStore().graph.nodes.values()].filter((n) => n.state === "new");
    expect(newNodes).toHaveLength(1);
    expect(newNodes[0].importance).toBe("high");
    // notify was called for the all-bad chunk
    expect(notify).toHaveBeenCalled();
    // frontier advanced to the last entry (whole run committed)
    expect(getGraphStore().observerFrontier).toBe("a2");
  });

  it("on signal abort mid-run (chunk throws): nothing persisted for the in-flight chunk", async () => {
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
        observations: [{ summary: "Chose vitest.", importance: "high", sourceEntryIds: ["a1"] }],
      });
      // ...then abort before the run completes
      controller.abort();
      throw new Error("aborted");
    };

    await runObserver({ ...makeArgs({ pi, ctx, unobserved, runStageFn: fn }), signal: controller.signal });

    expect(calls).toBe(1);
    // nothing persisted (no create_node, no observation)
    expect(appended.filter((e) => e.type === "session-owl.graph_delta")).toHaveLength(0);
    expect(appended.filter((e) => e.type === "session-owl.observation")).toHaveLength(0);
    // frontier unchanged
    expect(getGraphStore().observerFrontier).toBeNull();
  });

  it("aborts during model resolution: post-await guard fires, nothing persisted (carried R23-2)", async () => {
    const { pi, appended } = makeFakePi();
    const controller = new AbortController();
    const fakeModel = { provider: "test", id: "observer-model" } as unknown as ExtensionContext["model"];
    // abort DURING the model-resolution await — resolution succeeds, but the
    // signal is aborted by the time the post-await guard runs.
    const ctx = {
      ...makeFakeCtx(),
      modelRegistry: {
        find: () => fakeModel,
        getApiKeyAndHeaders: async () => {
          controller.abort();
          return { ok: true as const, apiKey: "key" };
        },
      } as unknown as ExtensionContext["modelRegistry"],
    } as unknown as ExtensionContext;
    let calls = 0;
    const fn = async () => {
      calls += 1;
      return {
        messages: [],
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0, elapsedMs: 0 },
        outputTokens: 0,
        aborted: false,
        timedOut: false,
      };
    };
    const unobserved = [userEntry("u1", "initial prompt captured mechanically"), assistantEntry("a1", "chose vitest")];
    await runObserver({ ...makeArgs({ pi, ctx, unobserved, runStageFn: fn }), signal: controller.signal });
    expect(calls).toBe(0);
    expect(appended.filter((e) => e.type === "session-owl.graph_delta")).toHaveLength(0);
    expect(appended.filter((e) => e.type === "session-owl.observation")).toHaveLength(0);
    expect(getGraphStore().observerFrontier).toBeNull();
  });

  it("stops after the current block when `enabled` flips off mid-run (live master switch, per-block re-check)", async () => {
    const { pi, appended } = makeFakePi();
    const ctx = makeFakeCtx();
    // two chunks (threshold 1 → each entry its own chunk): [u1], [a1].
    const unobserved = [userEntry("u1", "initial prompt captured mechanically"), assistantEntry("a1", "chose vitest")];
    let call = 0;
    const runStageFn: ObserverRunInput["runStageFn"] = async (input) => {
      call += 1;
      const tool = input.tools[0] as AgentTool;
      await tool.execute("c1", {
        observations: [{ summary: `chunk ${call}.`, importance: "high", sourceEntryIds: [call === 1 ? "u1" : "a1"] }],
      });
      // disable session-owl AFTER the first chunk's stage run (mid-run toggle).
      if (call === 1) _setGetSessionOwlSettings(() => ({ ...DEFAULT_CONFIG, enabled: false }));
      return {
        messages: [] as AgentMessage[],
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1, elapsedMs: 0 },
        outputTokens: 0,
        aborted: false,
        timedOut: false,
      };
    };

    // the per-chunk enabled re-check stops chunk 2; the run completes cleanly.
    await runObserver(makeArgs({ pi, ctx, unobserved, runStageFn, thresholdTokens: 1 }));

    // only chunk 1 ran; its record was persisted (per-chunk durability).
    expect(call).toBe(1);
    const obsEntries = appended.filter((e) => e.type === "session-owl.observation");
    expect(obsEntries).toHaveLength(1);
    expect((obsEntries[0].data as { coversUpToId: string }).coversUpToId).toBe("u1");
    // frontier advanced to chunk 1 — chunk 2 re-observes on a later run.
    expect(getGraphStore().observerFrontier).toBe("u1");
    _resetGetSessionOwlSettings();
  });

  it("maybeBuild fires after each record-bearing chunk; when it runs the Builder the observe stage is re-asserted", async () => {
    const { pi } = makeFakePi();
    const ctx = makeFakeCtx();
    // two record-bearing chunks (threshold 1 → each entry its own chunk)
    const unobserved = [userEntry("u1", "initial prompt captured mechanically"), assistantEntry("a1", "chose vitest")];
    const script = scriptedRunStage([
      [{ summary: "Initial goal.", importance: "high", sourceEntryIds: ["u1"] }],
      [{ summary: "Chose vitest.", importance: "high", sourceEntryIds: ["a1"] }],
    ]);
    // track startStage calls (observe → build [via builder runs] → observe re-assert)
    const stageCalls: string[] = [];
    const widget: WidgetController = {
      ...NO_OP_WIDGET,
      startStage: (stage, init) => stageCalls.push(`${stage}:${init?.batch?.done ?? "?"}/${init?.batch?.total ?? "?"}`),
    };
    let builds = 0;
    const maybeBuild = async (): Promise<boolean> => {
      builds += 1;
      // simulate the Builder flipping the widget to build then ending it
      widget.startStage("build", {});
      return true;
    };

    await runObserver(makeArgs({ pi, ctx, unobserved, runStageFn: script.fn, thresholdTokens: 1, widget, maybeBuild }));

    // maybeBuild was called after each of the 2 record-bearing chunks
    expect(builds).toBe(2);
    // observe stage opened at start, then re-asserted after each build (done/total tracks progress)
    expect(stageCalls.filter((s) => s.startsWith("observe"))).toEqual(["observe:0/2", "observe:1/2", "observe:2/2"]);
  });

  it("persists chunk 1 before chunk 2 aborts: abort loses only the in-flight chunk (per-chunk durability)", async () => {
    const { pi, appended } = makeFakePi();
    const ctx = makeFakeCtx();
    const controller = new AbortController();
    // two chunks (threshold 1 → each entry its own chunk): [u1], [a1].
    const unobserved = [userEntry("u1", "initial prompt captured mechanically"), assistantEntry("a1", "chose vitest")];
    let chunk = 0;
    const fn = async (input: Parameters<NonNullable<ObserverRunInput["runStageFn"]>>[0]) => {
      chunk += 1;
      const tool = input.tools[0] as AgentTool;
      // chunk 1 COMPLETES with a valid record → persisted immediately per-chunk...
      await tool.execute("c1", {
        observations: [{ summary: "Initial goal stated.", importance: "high", sourceEntryIds: ["u1"] }],
      });
      // ...then abort fires before chunk 2 starts (chunk 2 never passes the top-of-loop guard)
      if (chunk === 1) controller.abort();
      return {
        messages: [] as AgentMessage[],
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1, elapsedMs: 0 },
        outputTokens: 0,
        aborted: controller.signal.aborted,
        timedOut: false,
      };
    };

    await runObserver({
      ...makeArgs({ pi, ctx, unobserved, runStageFn: fn, thresholdTokens: 1 }),
      signal: controller.signal,
    });

    // only chunk 1 ran (the top-of-loop abort guard stopped chunk 2)
    expect(chunk).toBe(1);
    // chunk 1's record WAS persisted (per-chunk durability) — the fix for the
    // old accumulate-then-append that lost everything on abort.
    expect(appended.filter((e) => e.type === "session-owl.graph_delta")).toHaveLength(1);
    const obsEntries = appended.filter((e) => e.type === "session-owl.observation");
    expect(obsEntries).toHaveLength(1);
    expect((obsEntries[0].data as { coversUpToId: string }).coversUpToId).toBe("u1");
    // frontier advanced to chunk 1's last entry (chunk 2 re-observed next run)
    expect(getGraphStore().observerFrontier).toBe("u1");
  });

  it("does NOT flush new nodes (leaves them state:new for the Builder)", async () => {
    const { pi } = makeFakePi();
    const ctx = makeFakeCtx();
    const unobserved = [userEntry("u1", "initial prompt captured mechanically"), assistantEntry("a1", "chose vitest")];
    const script = scriptedRunStage([[{ summary: "Chose vitest.", importance: "high", sourceEntryIds: ["a1"] }]]);

    await runObserver(makeArgs({ pi, ctx, unobserved, runStageFn: script.fn }));

    const wrapper = [...getGraphStore().graph.nodes.values()].find((n) => n.state === "new");
    expect(wrapper?.state).toBe("new");
  });

  it("records nothing but persists an EMPTY-VERDICT entry covering the chunk — automatic triggers never retry it", async () => {
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

    // no records, no wrapper nodes — but ONE empty observation entry covering the
    // chunk advances the frontier past it (a completed chunk is never re-observed
    // automatically; /owl:reobserve-0-obs-chunks is the only retry)
    const obsEntries = appended.filter((e) => e.type === "session-owl.observation");
    expect(obsEntries).toHaveLength(1);
    const entry = obsEntries[0].data as { coversFromId: string | null; coversUpToId: string; records: unknown[] };
    expect(entry.coversFromId).toBe("u1");
    expect(entry.coversUpToId).toBe("a1");
    expect(entry.records).toEqual([]);
    expect(appended.filter((e) => e.type === "session-owl.graph_delta")).toHaveLength(0);
    expect(getGraphStore().observerFrontier).toBe("a1");
    expect(notify).toHaveBeenCalled();
  });

  it("persists each good chunk immediately: one observation delta per chunk (per-chunk durability)", async () => {
    const { pi, appended } = makeFakePi();
    const ctx = makeFakeCtx();
    // two chunks (threshold 1 → each entry its own chunk): [u1], [a1].
    const unobserved = [userEntry("u1", "initial prompt captured mechanically"), assistantEntry("a1", "chose vitest")];
    const script = scriptedRunStage([
      [{ summary: "Initial goal stated.", importance: "high", sourceEntryIds: ["u1"] }], // chunk 1 [u1]
      [{ summary: "Chose vitest.", importance: "high", sourceEntryIds: ["a1"] }], // chunk 2 [a1]
    ]);

    await runObserver(makeArgs({ pi, ctx, unobserved, runStageFn: script.fn, thresholdTokens: 1 }));

    // per-chunk persistence: TWO observation deltas (one per chunk), each its own range.
    const obsEntries = appended.filter((e) => e.type === "session-owl.observation");
    expect(obsEntries).toHaveLength(2);
    const e1 = obsEntries[0].data as {
      coversFromId: string;
      coversUpToId: string;
      records: { summary: string }[];
      tokenCount: number;
    };
    const e2 = obsEntries[1].data as {
      coversFromId: string;
      coversUpToId: string;
      records: { summary: string }[];
      tokenCount: number;
    };
    expect(e1.records.map((r) => r.summary)).toEqual(["Initial goal stated."]);
    expect(e1.coversFromId).toBe("u1");
    expect(e1.coversUpToId).toBe("u1");
    expect(e2.records.map((r) => r.summary)).toEqual(["Chose vitest."]);
    expect(e2.coversFromId).toBe("a1");
    expect(e2.coversUpToId).toBe("a1");
    // per-chunk tokenCount = that chunk's record's verbatim source size
    const u1Details = "<USER>initial prompt captured mechanically</USER>";
    const a1Details = "<ASSISTANT>chose vitest</ASSISTANT>";
    expect(e1.tokenCount).toBe(Math.ceil(u1Details.length / 4));
    expect(e2.tokenCount).toBe(Math.ceil(a1Details.length / 4));
    // two wrapper create_node deltas — ONE graph_delta envelope per chunk
    expect(appended.filter((e) => e.type === "session-owl.graph_delta")).toHaveLength(2);
    // frontier advanced to the last entry of the whole run
    expect(getGraphStore().observerFrontier).toBe("a1");
  });

  it("throws at the first failed chunk: frontier advances only over the successful prefix (later entries re-observable)", async () => {
    const { pi, appended } = makeFakePi();
    const ctx = makeFakeCtx();
    // three chunks (threshold 1 → each entry its own chunk): [u1], [a1], [a2].
    const unobserved = [
      userEntry("u1", "initial prompt captured mechanically"),
      assistantEntry("a1", "chose vitest"),
      assistantEntry("a2", "picked biome"),
    ];
    let chunk = 0;
    const fn = async (input: Parameters<NonNullable<ObserverRunInput["runStageFn"]>>[0]) => {
      chunk += 1;
      // chunk 1 succeeds (records a valid observation)...
      if (chunk === 1) {
        const tool = input.tools[0] as AgentTool;
        await tool.execute("c1", {
          observations: [{ summary: "Initial goal stated.", importance: "high", sourceEntryIds: ["u1"] }],
        });
        return {
          messages: [] as AgentMessage[],
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1, elapsedMs: 0 },
          outputTokens: 0,
          aborted: false,
          timedOut: false,
        };
      }
      // ...chunk 2 THROWS a non-abort error (LLM failure)...
      if (chunk === 2) throw new Error("LLM boom");
      // ...chunk 3 must never run (the run stops at the first failure).
      throw new Error("chunk 3 should not run");
    };

    await expect(runObserver(makeArgs({ pi, ctx, unobserved, runStageFn: fn, thresholdTokens: 1 }))).rejects.toThrow(
      "LLM boom",
    );

    // only chunks 1 + 2 ran (chunk 3 was never reached)
    expect(chunk).toBe(2);
    // chunk 1's record WAS persisted (partial work kept)
    const obsEntries = appended.filter((e) => e.type === "session-owl.observation");
    expect(obsEntries).toHaveLength(1);
    const entry = obsEntries[0].data as {
      coversFromId: string | null;
      coversUpToId: string;
      records: { summary: string }[];
    };
    expect(entry.records.map((r) => r.summary)).toEqual(["Initial goal stated."]);
    // frontier advanced ONLY to chunk 1's last entry (u1), NOT the gap tail (a2)
    expect(entry.coversUpToId).toBe("u1");
    expect(getGraphStore().observerFrontier).toBe("u1");
  });

  it("opens the observe widget stage, reports batch progress, and closes it", async () => {
    const { pi, appended } = makeFakePi();
    const ctx = makeFakeCtx();
    // two chunks (threshold 1 → each entry its own chunk): [u1], [a1].
    const unobserved = [userEntry("u1", "initial prompt captured mechanically"), assistantEntry("a1", "chose vitest")];
    const script = scriptedRunStage([
      [{ summary: "Goal.", importance: "high", sourceEntryIds: ["u1"] }],
      [{ summary: "Decision.", importance: "high", sourceEntryIds: ["a1"] }],
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
    expect(appended.some((e) => e.type === "session-owl.observation")).toBe(true);
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

    await expect(runObserver(makeArgs({ pi, ctx, unobserved, runStageFn: throwing, widget }))).rejects.toThrow(
      "LLM boom",
    );

    // stage opened then closed despite the throw (finally ran)
    expect(calls).toContain("start");
    expect(calls).toContain("end");
    expect(calls[calls.length - 1]).toBe("end");
  });

  it("closes the observe stage when the run aborts mid-loop (endStage in finally)", async () => {
    const { pi } = makeFakePi();
    const ctx = makeFakeCtx();
    // two chunks so the loop iterates; abort fires before the second chunk passes.
    const unobserved = [userEntry("u1", "x".repeat(50)), assistantEntry("a1", "y".repeat(50))];
    const controller = new AbortController();
    let chunk = 0;
    const abortAfterFirst = async () => {
      chunk += 1;
      if (chunk === 1) controller.abort(); // abort after the first chunk processes
      return {
        messages: [] as AgentMessage[],
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1, elapsedMs: 0 },
        outputTokens: 0,
        aborted: controller.signal.aborted,
        timedOut: false,
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

  it("feeds each chunk's stage usage into the store ledger (persisted per chunk)", async () => {
    const { pi, appended } = makeFakePi();
    const ctx = makeFakeCtx();
    // two small chunks (low threshold forces a chunk per entry) → two stage passes
    const unobserved = [userEntry("u1", "x".repeat(50)), assistantEntry("a1", "y".repeat(50))];
    // a runStage that behaves like the real one: invokes onStageEnd with usage,
    // then returns the result. Returns a distinct non-zero usage per call.
    let call = 0;
    const usages = [
      { input: 1000, output: 500, cacheRead: 300, cacheWrite: 0, cost: 0.05, turns: 3, elapsedMs: 0 },
      { input: 2000, output: 1500, cacheRead: 700, cacheWrite: 0, cost: 0.11, turns: 5, elapsedMs: 0 },
    ];
    const runStageFn: ObserverRunInput["runStageFn"] = async (input) => {
      call += 1;
      const usage = usages[call - 1] ?? usages[0];
      // the real runStage invokes onStageEnd with the accumulated usage.
      input.onStageEnd?.(usage);
      return { messages: [], usage, outputTokens: 0, aborted: false, timedOut: false };
    };

    await runObserver(makeArgs({ pi, ctx, unobserved, runStageFn, thresholdTokens: 10 }));

    // observe phase accumulated BOTH chunks' usage but counts the run once
    // (two chunks, one Observer run).
    const obs = getGraphStore().usageLedger.observe;
    expect(obs.input).toBe(3000);
    expect(obs.output).toBe(2000);
    expect(obs.cacheRead).toBe(1000);
    expect(obs.runs).toBe(1);
    // build/select untouched.
    expect(getGraphStore().usageLedger.build.runs).toBe(0);
    expect(getGraphStore().usageLedger.select.runs).toBe(0);
    // the ledger is persisted PER CHUNK (two chunks → two durable
    // session-owl.usage entries) so an interrupted run keeps the usage tally for
    // every completed chunk — matching the per-chunk durability of observations.
    expect(appended.filter((e) => e.type === "session-owl.usage")).toHaveLength(2);
  });

  it("persists usage per chunk so a mid-run abort keeps the tally for completed chunks", async () => {
    const { pi, appended } = makeFakePi();
    const ctx = makeFakeCtx();
    const controller = new AbortController();
    // two chunks (threshold 1 → each entry its own chunk): [u1], [a1].
    const unobserved = [userEntry("u1", "initial prompt captured mechanically"), assistantEntry("a1", "chose vitest")];
    let call = 0;
    const runStageFn: ObserverRunInput["runStageFn"] = async (input) => {
      call += 1;
      const tool = input.tools[0] as AgentTool;
      // chunk 1 records an observation + reports usage, then abort fires
      await tool.execute("c1", { observations: [{ summary: "Initial.", importance: "high", sourceEntryIds: ["u1"] }] });
      input.onStageEnd?.({ input: 1000, output: 500, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1, elapsedMs: 0 });
      if (call === 1) controller.abort();
      return {
        messages: [],
        usage: { input: 1000, output: 500, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1, elapsedMs: 0 },
        outputTokens: 0,
        aborted: controller.signal.aborted,
        timedOut: false,
      };
    };

    await runObserver({
      ...makeArgs({ pi, ctx, unobserved, runStageFn, thresholdTokens: 1 }),
      signal: controller.signal,
    });

    // only chunk 1 ran (the top-of-loop abort guard stopped chunk 2)
    expect(call).toBe(1);
    // chunk 1's usage WAS persisted (per-chunk) even though the run was aborted —
    // matching the per-chunk durability of its observation. Previously usage was
    // lost (persisted only at run end, which the abort skipped).
    const usageEntries = appended.filter((e) => e.type === "session-owl.usage");
    expect(usageEntries).toHaveLength(1);
    expect(getGraphStore().usageLedger.observe.input).toBe(1000);
  });

  it("forwards a per-stage affinity id (:observe) to runStage when a session base is set", async () => {
    setSessionOwlSessionBase("sess-7");
    const { pi } = makeFakePi();
    const ctx = makeFakeCtx();
    const unobserved = [userEntry("u1", "do the thing"), assistantEntry("a1", "ok")];
    const seen: string[] = [];
    const runStageFn = async (input: Parameters<NonNullable<ObserverRunInput["runStageFn"]>>[0]) => {
      seen.push(input.sessionId ?? "");
      // execute the record tool so the chunk is acknowledged, then resolve
      const tool = input.tools[0] as AgentTool;
      await tool.execute("call-1", {
        observations: [{ summary: "x", importance: "med", sourceEntryIds: ["u1"] }],
      });
      return {
        messages: [] as AgentMessage[],
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1, elapsedMs: 0 },
        outputTokens: 0,
        aborted: false,
        timedOut: false,
      };
    };
    await runObserver(makeArgs({ pi, ctx, unobserved, runStageFn, thresholdTokens: 1 }));
    expect(seen.length).toBeGreaterThanOrEqual(1);
    for (const id of seen) expect(id).toBe("sess-7:observe");
  });
});

describe("runObserver chunk atomicity", () => {
  beforeEach(() => {
    resetForNewSession();
    setClock(() => "2026-07-29T10:05:00.000Z");
    _resetSessionAffinity();
  });
  afterAll(() => {
    setClock(null);
  });

  it("a structurally invalid graph rejects the whole chunk: nothing applied, nothing persisted, no wrapper cruft", async () => {
    const { pi, appended } = makeFakePi();
    const ctx = makeFakeCtx();
    // seed a corrupt graph: nGoal listing a phantom observation
    resetForNewSession();
    const store = getGraphStore();
    store.graph.nodes.set("nGoal", {
      id: "nGoal",
      summary: "",
      summaryTokens: 0,
      importance: "crit",
      state: "active",
      parentNode: null,
      observationIds: ["o404"],
      childNodeIds: [],
      supersededBy: null,
      timestamps: { createdAt: "t", updatedAt: "t", rangeStart: "t", rangeEnd: "t" },
    });
    const nodesBefore = store.graph.nodes.size;
    const obsBefore = store.graph.observations.size;

    const unobserved = [userEntry("u1", "initial prompt captured mechanically"), assistantEntry("a1", "chose vitest")];
    const script = scriptedRunStage([
      [
        { summary: "Chose vitest for all new tests.", importance: "high", sourceEntryIds: ["a1"] },
        { summary: "A second record in the same chunk.", importance: "med", sourceEntryIds: ["a1"] },
      ],
    ]);

    await expect(runObserver(makeArgs({ pi, ctx, unobserved, runStageFn: script.fn }))).rejects.toThrow(
      /missing observation|multi|parent/i,
    );

    // memory untouched: no wrapper, no observation — applied state == persisted state
    expect(store.graph.nodes.size).toBe(nodesBefore);
    expect(store.graph.observations.size).toBe(obsBefore);
    // nothing persisted for the chunk
    expect(appended.filter((e) => e.type === "session-owl.graph_delta")).toHaveLength(0);
    expect(appended.filter((e) => e.type === "session-owl.observation")).toHaveLength(0);
    expect(getGraphStore().observerFrontier).toBeNull();
  });
});

// --- no-progress turn stop + record-call debug logging -----------------------

/** A shouldStopAfterTurn payload with a fabricated assistant message. */
function stopTurn(text: string | null): Parameters<TurnPredicate>[0] {
  const content = text === null ? [] : [{ type: "text", text }];
  return { message: { role: "assistant", content } } as unknown as Parameters<TurnPredicate>[0];
}

describe("runObserver — no-progress turn stop", () => {
  beforeEach(() => {
    resetForNewSession();
    setClock(() => "2026-07-29T10:05:00.000Z");
    _resetSessionAffinity();
  });
  afterAll(() => {
    setClock(null);
  });

  it("wires a per-chunk stopAfterTurn: 3 consecutive no-progress turns stop; text does not reset", async () => {
    const { pi } = makeFakePi();
    const ctx = makeFakeCtx();
    const unobserved = [userEntry("u1", "initial prompt captured mechanically"), assistantEntry("a1", "chose vitest")];
    const stops: (TurnPredicate | null)[] = [];
    let seen: TurnPredicate | null = null;
    const fn = async (input: Parameters<NonNullable<ObserverRunInput["runStageFn"]>>[0]) => {
      seen = input.stopAfterTurn ?? null;
      stops.push(seen);
      const tool = input.tools[0] as AgentTool;
      await tool.execute("c1", {
        observations: [{ summary: "Chose vitest.", importance: "high", sourceEntryIds: ["a1"] }],
      });
      return {
        messages: [] as AgentMessage[],
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1, elapsedMs: 0 },
        outputTokens: 0,
        aborted: false,
        timedOut: false,
      };
    };

    await runObserver(makeArgs({ pi, ctx, unobserved, runStageFn: fn }));

    // the chunk's stop rule saw records land (0 → 1): the FIRST stop call
    // observes that advance and resets; then three consecutive no-progress
    // turns stop on the fourth call
    expect(seen).not.toBeNull();
    const stop = seen as unknown as TurnPredicate;
    expect(stop(stopTurn(null))).toBe(false); // advance observed -> reset
    expect(stop(stopTurn(null))).toBe(false); // streak 1
    expect(stop(stopTurn(null))).toBe(false); // streak 2
    expect(stop(stopTurn(null))).toBe(true); // streak 3 -> stop
    // a fresh chunk's rule: no records accepted — text beside failing calls is
    // NOT progress, so the streak keeps growing through the text turn
    const fn2 = async (input: Parameters<NonNullable<ObserverRunInput["runStageFn"]>>[0]) => {
      seen = input.stopAfterTurn ?? null;
      stops.push(seen);
      return {
        messages: [] as AgentMessage[],
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1, elapsedMs: 0 },
        outputTokens: 0,
        aborted: false,
        timedOut: false,
      };
    };
    await runObserver(makeArgs({ pi: makeFakePi().pi, ctx: makeFakeCtx(), unobserved, runStageFn: fn2 }));
    const stop2 = seen as unknown as TurnPredicate;
    expect(stop2(stopTurn(null))).toBe(false); // streak 1
    expect(stop2(stopTurn(null))).toBe(false); // streak 2
    expect(stop2(stopTurn("all rejected — retrying smaller"))).toBe(true); // text ≠ progress -> streak 3 -> stop
    expect(stops.length).toBeGreaterThanOrEqual(2);
  });
});

describe("runObserver — record_observations debug logging", () => {
  const sink = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  beforeEach(() => {
    resetForNewSession();
    setClock(() => "2026-07-29T10:05:00.000Z");
    _resetSessionAffinity();
    _setBaseLoggerForTest(sink);
    _setGetSessionOwlSettings(() => ({ ...DEFAULT_CONFIG, debugLog: true }));
    sink.debug.mockClear();
  });
  afterAll(() => {
    setClock(null);
    _setBaseLoggerForTest(null);
    _resetGetSessionOwlSettings();
  });

  it("logs accepted/rejected counts per record_observations call when debugLog is on", async () => {
    const { pi } = makeFakePi();
    const ctx = makeFakeCtx();
    const unobserved = [userEntry("u1", "initial prompt captured mechanically"), assistantEntry("a1", "chose vitest")];
    const script = scriptedRunStage([
      [
        { summary: "Every commit must keep the build green.", importance: "crit", sourceEntryIds: ["a1"] }, // good
        { summary: "Foreign fact.", importance: "med", sourceEntryIds: ["ZZZ-not-in-chunk"] }, // foreign id
      ],
    ]);
    await runObserver(makeArgs({ pi, ctx, unobserved, runStageFn: script.fn }));
    const line = sink.debug.mock.calls.map((c) => String(c[0])).find((l) => l.includes("record_observations"));
    expect(line).toBeDefined();
    expect(line).toContain("accepted=1");
    expect(line).toContain("rejected=1");
  });

  it("dumps the call's accepted summaries — numbered, 200-char cap, max 10 (+N more)", async () => {
    const { pi } = makeFakePi();
    const ctx = makeFakeCtx();
    const unobserved = [userEntry("u1", "initial prompt captured mechanically"), assistantEntry("a1", "chose vitest")];
    // 12 valid records: #1 over the 200-char cap (must collapse + truncate), the
    // rest short; only the first 10 appear, 11–12 fold into (+2 more).
    const batch: RecordObservationInput[] = Array.from({ length: 12 }, (_, i) =>
      i === 0
        ? { summary: "x".repeat(250), importance: "med", sourceEntryIds: ["a1"] }
        : { summary: `Fact ${i}.`, importance: "med", sourceEntryIds: ["a1"] },
    );
    const script = scriptedRunStage([batch]);
    await runObserver(makeArgs({ pi, ctx, unobserved, runStageFn: script.fn }));
    const line = sink.debug.mock.calls.map((c) => String(c[0])).find((l) => l.startsWith("observer: recorded "));
    expect(line).toBeDefined();
    expect(line).toContain("recorded 12 —");
    expect(line).toContain(`1. ${"x".repeat(199)}…`); // whitespace-collapsed + capped
    expect(line).toContain("2. Fact 1.");
    expect(line).toContain("10. Fact 9.");
    expect(line).not.toContain("11. Fact 10.");
    expect(line).toContain("(+2 more)");
  });

  it("logs a chunk-start line — index/total, coverage range, rendered token size", async () => {
    const { pi } = makeFakePi();
    const ctx = makeFakeCtx();
    const unobserved = [userEntry("u1", "initial prompt captured mechanically"), assistantEntry("a1", "chose vitest")];
    const script = scriptedRunStage([[{ summary: "Chose vitest.", importance: "high", sourceEntryIds: ["a1"] }]]);
    await runObserver(makeArgs({ pi, ctx, unobserved, runStageFn: script.fn }));
    const line = sink.debug.mock.calls.map((c) => String(c[0])).find((l) => l.startsWith("observer: chunk "));
    expect(line).toBeDefined();
    expect(line).toContain("chunk 1/1 covers u1..a1");
    expect(line).toMatch(/ tokens$/);
  });
});

describe("runObserver — stage dump", () => {
  beforeEach(() => {
    resetForNewSession();
    setClock(() => "2026-07-29T10:05:00.000Z");
    _resetSessionAffinity();
  });
  afterAll(() => setClock(null));

  it("debugDumpLimit > 0: header + per-chunk wrappers carrying EACH chunk's record tool", async () => {
    const { pi } = makeFakePi();
    const ctx = makeFakeCtx();
    const unobserved = [
      userEntry("u1", "initial prompt captured mechanically"),
      assistantEntry("a1", "we chose vitest for tests"),
    ];
    const script = scriptedRunStage([
      [{ summary: "Chose vitest for all new tests.", importance: "high", sourceEntryIds: ["a1"] }],
    ]);
    const dumpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "owl-observer-dump-"));
    let seenDumpPath: string | null | undefined;
    const scripted = script.fn as NonNullable<ObserverRunInput["runStageFn"]>;
    _setDumpHomeForTest(dumpRoot); // dumps land under <dumpRoot>/.pi/session-owl/dumps/<project>
    try {
      await runObserver(
        makeArgs({
          pi,
          ctx,
          unobserved,
          thresholdTokens: 1,
          debugDumpLimit: 5,
          runStageFn: (input) => {
            seenDumpPath = input.dumpPath;
            return scripted(input);
          },
        }),
      );
    } finally {
      _setDumpHomeForTest(null);
    }
    expect(seenDumpPath).toContain(path.join(".pi", "session-owl", "dumps"));
    const debugDir = path.join(dumpRoot, ".pi", "session-owl", "dumps", sanitizeForPath(process.cwd()));
    const files = fs.readdirSync(debugDir).filter((f) => f.startsWith("observe-"));
    expect(files.length).toBe(1);
    const text = fs.readFileSync(path.join(debugDir, files[0] as string), "utf8");
    expect(text.startsWith('<dump stage="observe" started="')).toBe(true);
    expect(text).toContain("</system-prompt>\n");
    // the header carries the (static) record tool schema once
    const headerPart = text.slice(0, text.indexOf("<chunk"));
    expect(headerPart).toContain('<tool name="record_observations">');
    expect(text).toContain('<chunk i="1/2">\n<allowed>\nu1\n</allowed>');
    expect(text).toContain('<chunk i="2/2">\n<allowed>\na1\n</allowed>');
    expect(text).toContain("</chunk>\n");
    expect(text.trimEnd().endsWith("</dump>")).toBe(true);
  });

  it("a zero-chunk run opens a dump but leaves NO file (nothing appended)", async () => {
    const { pi } = makeFakePi();
    const ctx = makeFakeCtx();
    const script = scriptedRunStage([]);
    const dumpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "owl-observer-dump-"));
    _setDumpHomeForTest(dumpRoot);
    try {
      await runObserver(
        makeArgs({
          pi,
          ctx,
          unobserved: [],
          thresholdTokens: 1,
          debugDumpLimit: 5,
          runStageFn: script.fn,
        }),
      );
    } finally {
      _setDumpHomeForTest(null);
    }
    expect(fs.existsSync(path.join(dumpRoot, ".pi", "session-owl", "dumps"))).toBe(false);
  });
});
