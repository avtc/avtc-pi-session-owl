// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import type { AgentEvent } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../../src/config/schema.js";
import { MERGE_TOOL, MKDIR_TOOL, MV_TOOL, SELECTOR_SET_META_TOOL } from "../../src/graph/mutate-tools.js";
import { applyCreateNode, applyRecordObservation, setClock } from "../../src/graph/mutations.js";
import { TRY_FINISH_TOOL } from "../../src/graph/read-tools.js";
import { SELECTOR_SYSTEM } from "../../src/prompts/selector.js";
import type { StageRunInput, StageRunResult } from "../../src/runtime/agent-loop.js";
import { makeSelectorPassTracker, runSelector } from "../../src/selector/run.js";
import { encodeSelection, SELECTION_TYPE, USAGE_TYPE } from "../../src/store/codecs.js";
import {
  getGraphStore,
  persistSelectedTree,
  resetForNewSession,
  type StoreEntry,
} from "../../src/store/graph-store.js";
import { makeObservation, N_GOAL, type NodeId } from "../../src/types.js";
import type { WidgetController } from "../../src/widget/tracker.js";
import { NO_OP_WIDGET, recordingWidget, scriptRunStage, scriptRunStageWithError } from "../builder/run-helpers.js";

const NOW = "2026-07-30T12:00:00.000Z";
// --- pass tracker ----------------------------------------------------------

// toolEndEvent two-arg form (isError false) and three-arg form.
function toolEndEvent(toolName: string, ok: boolean): AgentEvent {
  return endEvent(toolName, ok, false);
}
function endEvent(toolName: string, ok: boolean, isError: boolean): AgentEvent {
  return {
    type: "tool_execution_end",
    toolCallId: `c-${toolName}`,
    toolName,
    result: { content: [], details: { ok } },
    isError,
  } as unknown as AgentEvent;
}

describe("makeSelectorPassTracker", () => {
  it("counts applied mutates for the four Selector mutate tools", () => {
    const { outcome, onEvent } = makeSelectorPassTracker(() => {});
    onEvent(toolEndEvent(MKDIR_TOOL, true));
    onEvent(toolEndEvent(MV_TOOL, true));
    onEvent(toolEndEvent(MERGE_TOOL, true));
    onEvent(toolEndEvent(SELECTOR_SET_META_TOOL, true));
    expect(outcome.mutates).toBe(4);
    expect(outcome.converged).toBe(false);
  });

  it("marks converged on try_finish success", () => {
    const { outcome, onEvent } = makeSelectorPassTracker(() => {});
    onEvent(toolEndEvent(TRY_FINISH_TOOL, true));
    expect(outcome.converged).toBe(true);
  });

  it("ignores a rejected mutate (isError)", () => {
    const { outcome, onEvent } = makeSelectorPassTracker(() => {});
    onEvent(endEvent(MV_TOOL, true, true));
    expect(outcome.mutates).toBe(0);
  });

  it("forwards every event to the downstream sink", () => {
    const forwarded: unknown[] = [];
    const { onEvent } = makeSelectorPassTracker((e) => forwarded.push(e));
    const a = toolEndEvent(MKDIR_TOOL, true);
    onEvent(a);
    expect(forwarded).toEqual([a]);
  });
});

// --- runSelector fixture ----------------------------------------------------

/** Seed the singleton graph with nGoal (+oInitialPrompt) and optional roots. */
function seedGraph(roots: Array<{ id: NodeId; summary: string; state?: "active" | "new" | "archived" }>): void {
  resetForNewSession();
  const g = getGraphStore().graph;
  applyCreateNode(g, {
    id: N_GOAL,
    summary: "goal",
    importance: "crit",
    parentNode: null,
    state: "active",
  });
  applyRecordObservation(g, {
    obs: makeObservation({
      id: "oInitialPrompt",
      summary: "build a memory extension",
      importance: "crit",
      sourceEntryIds: ["1"],
      timestamp: NOW,
      parentNode: N_GOAL,
    }),
  });
  for (const root of roots) {
    applyCreateNode(g, {
      id: root.id,
      summary: root.summary,
      importance: "med",
      parentNode: null,
      state: root.state ?? "active",
    });
  }
}

function makeFakeCtx(): ExtensionContext {
  const fakeModel = { provider: "test", id: "selector-model" } as unknown as ExtensionContext["model"];
  return {
    sessionManager: { getLeafId: () => "leaf-1", getBranch: () => [] },
    cwd: "/proj",
    modelRegistry: {
      find: () => fakeModel,
      getApiKeyAndHeaders: async () => ({ ok: true as const, apiKey: "key" }),
    } as unknown as ExtensionContext["modelRegistry"],
    model: fakeModel,
    ui: { notify: () => {} },
  } as unknown as ExtensionContext;
}

/** A fake pi that records appended entries, exposed for assertions. */
function recordingPi(): { pi: ExtensionAPI; appended: { type: string; data: unknown }[] } {
  const appended: { type: string; data: unknown }[] = [];
  const pi = {
    appendEntry: (customType: string, data: unknown) => {
      appended.push({ type: customType, data });
    },
  } as unknown as ExtensionAPI;
  return { pi, appended };
}

function settings(overrides: Partial<typeof DEFAULT_CONFIG>): typeof DEFAULT_CONFIG {
  return { ...DEFAULT_CONFIG, ...overrides };
}

function selectionEntries(appended: { type: string; data: unknown }[]): unknown[] {
  return appended.filter((e) => e.type === SELECTION_TYPE);
}

/** A widget that records setSelectedCounts calls (and keeps the recording
 *  widget's stage/pass/end tracking via delegation). */
function selectionWidget(): WidgetController & {
  selectedCalls: Array<{ count: number; tokens: number }>;
  calls: string[];
} {
  const selectedCalls: Array<{ count: number; tokens: number }> = [];
  const base = recordingWidget();
  return {
    setCtx: base.setCtx,
    clearCtx: base.clearCtx,
    render: base.render,
    startStage: base.startStage,
    setPass: base.setPass,
    setBatch: base.setBatch,
    setSelectedCounts(count: number, tokens: number) {
      selectedCalls.push({ count, tokens });
    },
    endStage: base.endStage,
    onEvent: base.onEvent,
    invalidateRoots: base.invalidateRoots,
    get selectedCalls() {
      return selectedCalls;
    },
    get calls() {
      return base.calls;
    },
  };
}

// --- runSelector -----------------------------------------------------------

describe("runSelector", () => {
  beforeEach(() => {
    resetForNewSession();
    setClock(() => NOW);
  });
  afterAll(() => setClock(null));

  it("runs passes until try_finish succeeds and persists the selected tree", async () => {
    seedGraph([
      { id: "n3", summary: "decisions" },
      { id: "n4", summary: "spikes" },
    ]);
    let passCount = 0;
    const scripted = scriptRunStage({
      passes: [
        {
          tools: [
            { name: MV_TOOL, ok: true }, // demote n4 into nIrrelevant
            { name: MERGE_TOOL, ok: true }, // consolidate
            { name: SELECTOR_SET_META_TOOL, ok: true }, // condense (set_meta)
            { name: TRY_FINISH_TOOL, ok: false }, // reject → pass 2
          ],
        },
        {
          tools: [{ name: TRY_FINISH_TOOL, ok: true }],
        },
      ],
    });
    const countingRunStage = (input: StageRunInput): Promise<StageRunResult> => {
      passCount += 1;
      return scripted(input);
    };
    const cap = recordingPi();
    const widget = selectionWidget();
    await runSelector({
      ctx: makeFakeCtx(),
      pi: cap.pi,
      settings: settings({ selectorRootViewThreshold: 0, maxSelectorPasses: 5 }),
      signal: new AbortController().signal,
      widget,
      scope: { firstKeptEntryId: "e2" },
      todo: null,
      todoBridge: null,
      runStageFn: countingRunStage,
    });
    expect(passCount).toBe(2);
    // a memkeeper.selection snapshot was persisted
    const selections = selectionEntries(cap.appended);
    expect(selections.length).toBeGreaterThanOrEqual(1);
    // the widget opened/closed the select stage
    expect(widget.calls[0]).toBe("start:select:1");
    expect(widget.calls[widget.calls.length - 1]).toBe("end");
    // setSelectedCounts was pushed at least once per pass (live deltas)
    expect(widget.selectedCalls.length).toBeGreaterThanOrEqual(1);
  });

  it("re-renders the working tree each pass (pass 2 sees pass 1's mutations, not a stale view)", async () => {
    seedGraph([{ id: "n3", summary: "keep me", state: "active" }]);
    const capturedMessages: string[] = [];
    // pass 1: actually demote n3 into nIrrelevant via the real mv tool, then
    // try_finish-reject; pass 2: converge. The scripted runStage invokes the mv
    // tool on the working copy so pass 2's message must reflect the demotion.
    const scripted = scriptRunStage({
      passes: [
        {
          tools: [
            { name: MV_TOOL, ok: true },
            { name: TRY_FINISH_TOOL, ok: false },
          ],
        },
        { tools: [{ name: TRY_FINISH_TOOL, ok: true }] },
      ],
    });
    const countingRunStage = async (input: StageRunInput): Promise<StageRunResult> => {
      const userText = (input.messages[0] as unknown as { content: string })?.content ?? "";
      capturedMessages.push(userText);
      // pass 1: actually move n3 under nIrrelevant so the working copy changes
      if (capturedMessages.length === 1) {
        const mv = input.tools.find((t) => t.name === MV_TOOL);
        if (mv !== undefined) {
          await mv.execute("c-mv", { sourceIds: ["n3"], destId: "nIrrelevant" });
        }
      }
      return scripted(input);
    };
    await runSelector({
      ctx: makeFakeCtx(),
      pi: recordingPi().pi,
      settings: settings({ selectorRootViewThreshold: 0, maxSelectorPasses: 5 }),
      signal: new AbortController().signal,
      widget: NO_OP_WIDGET,
      scope: { firstKeptEntryId: "e2" },
      todo: null,
      todoBridge: null,
      runStageFn: countingRunStage,
    });
    expect(capturedMessages.length).toBe(2);
    // pass 1's working tree shows n3 at the root; pass 2's must NOT (it was
    // demoted into nIrrelevant) — proving pass 2 re-rendered the live copy.
    expect(capturedMessages[0]).toContain("keep me");
    expect(capturedMessages[1]).not.toContain("keep me");
  });

  it("persists a self-contained snapshot: nodes are deep copies (mutating source afterward doesn't change the snapshot)", async () => {
    seedGraph([{ id: "n3", summary: "original summary" }]);
    const scripted = scriptRunStage({ passes: [{ tools: [{ name: TRY_FINISH_TOOL, ok: true }] }] });
    const cap = recordingPi();
    await runSelector({
      ctx: makeFakeCtx(),
      pi: cap.pi,
      settings: settings({ selectorRootViewThreshold: 0 }),
      signal: new AbortController().signal,
      widget: NO_OP_WIDGET,
      scope: { firstKeptEntryId: "e2" },
      todo: null,
      todoBridge: null,
      runStageFn: scripted,
    });
    // grab the persisted snapshot
    const sel = getGraphStore().selectedTree;
    expect(sel).not.toBeNull();
    const n3 = sel?.nodes.find((n) => n.id === "n3");
    expect(n3?.summary).toBe("original summary");
    // now mutate the SOURCE graph's n3 summary — the snapshot must NOT change
    const srcN3 = getGraphStore().graph.nodes.get("n3");
    if (srcN3 !== undefined) srcN3.summary = "changed after persist";
    const n3Again = getGraphStore().selectedTree?.nodes.find((n) => n.id === "n3");
    expect(n3Again?.summary).toBe("original summary");
  });

  it("persisted observations are id refs (content resolved from the immutable store, not copied into the snapshot nodes)", async () => {
    seedGraph([]);
    // add an observation under nGoal
    applyRecordObservation(getGraphStore().graph, {
      obs: makeObservation({
        id: "o9",
        summary: "a load-bearing constraint",
        importance: "high",
        sourceEntryIds: ["5"],
        timestamp: NOW,
        parentNode: N_GOAL,
      }),
    });
    const scripted = scriptRunStage({ passes: [{ tools: [{ name: TRY_FINISH_TOOL, ok: true }] }] });
    const cap = recordingPi();
    await runSelector({
      ctx: makeFakeCtx(),
      pi: cap.pi,
      settings: settings({ selectorRootViewThreshold: 0 }),
      signal: new AbortController().signal,
      widget: NO_OP_WIDGET,
      scope: { firstKeptEntryId: "e2" },
      todo: null,
      todoBridge: null,
      runStageFn: scripted,
    });
    const sel = getGraphStore().selectedTree;
    expect(sel).not.toBeNull();
    // the obs id is a ref in obsRefs
    expect(sel?.obsRefs).toContain("o9");
    // the obs is NOT embedded in the snapshot as a full observation (only oInitialPrompt is)
    expect(sel?.oInitialPrompt?.id).toBe("oInitialPrompt");
  });

  it("fast-path: reuses a cached tree under threshold covering the compacted block (no agentLoop)", async () => {
    // Branch: [e0, e1, e2(cut), e3]. Compaction cut = e2 (firstKeptEntryId), so
    // the compacted-away block is [e0, e1] (last entry e1 at index 1). A cached
    // tree whose coveredFrontier is e1 (index 1 >= 1) covers the block → reuse.
    const branch = [
      { id: "e0", type: "message" },
      { id: "e1", type: "message" },
      { id: "e2", type: "message" },
      { id: "e3", type: "message" },
    ] as unknown as StoreEntry[];
    seedGraph([{ id: "n3", summary: "a" }]);
    const store = getGraphStore();
    store.observerFrontier = "e1"; // frontier at the last compacted-block entry
    const cached = encodeSelection(store.graph, "oInitialPrompt", "e1");
    persistSelectedTree({ appendEntry: () => {}, getLeafId: () => "leaf-1", getBranch: () => branch }, cached);
    let runStageCalls = 0;
    await runSelector({
      ctx: {
        ...makeFakeCtx(),
        sessionManager: { getLeafId: () => "leaf-1", getBranch: () => branch },
      } as unknown as ExtensionContext,
      pi: recordingPi().pi,
      // threshold high enough that the cached tree's root view fits
      settings: settings({ selectorRootViewThreshold: 10_000_000 }),
      signal: new AbortController().signal,
      widget: NO_OP_WIDGET,
      scope: { firstKeptEntryId: "e2" },
      todo: null,
      todoBridge: null,
      runStageFn: () => {
        runStageCalls += 1;
        return Promise.resolve({
          messages: [],
          usage: { input: 0, output: 0, cacheRead: 0, cost: 0, turns: 0, elapsedMs: 0 },
          outputTokens: 0,
          aborted: false,
          timedOut: false,
        });
      },
    });
    expect(runStageCalls).toBe(0); // fast-path: no pass ran
  });

  it("fast-path: reuses an over-threshold cached tree when it still covers the block (budget gate dropped)", async () => {
    // The budget fast-path is gone: a cached tree that covers the compacted-away
    // block is reused even if its root view exceeds selectorRootViewThreshold.
    const branch = [
      { id: "e0", type: "message" },
      { id: "e1", type: "message" },
      { id: "e2", type: "message" },
      { id: "e3", type: "message" },
    ] as unknown as StoreEntry[];
    seedGraph([{ id: "n3", summary: "a" }]);
    const store = getGraphStore();
    store.observerFrontier = "e1";
    const cached = encodeSelection(store.graph, "oInitialPrompt", "e1");
    persistSelectedTree({ appendEntry: () => {}, getLeafId: () => "leaf-1", getBranch: () => branch }, cached);
    let runStageCalls = 0;
    await runSelector({
      ctx: {
        ...makeFakeCtx(),
        sessionManager: { getLeafId: () => "leaf-1", getBranch: () => branch },
      } as unknown as ExtensionContext,
      pi: recordingPi().pi,
      // threshold deliberately LOW — the cached tree exceeds it, yet it covers
      // the block, so it must be reused (the budget gate no longer rebuilds).
      settings: settings({ selectorRootViewThreshold: 1 }),
      signal: new AbortController().signal,
      widget: NO_OP_WIDGET,
      scope: { firstKeptEntryId: "e2" },
      todo: null,
      todoBridge: null,
      runStageFn: () => {
        runStageCalls += 1;
        return Promise.resolve({
          messages: [],
          usage: { input: 0, output: 0, cacheRead: 0, cost: 0, turns: 0, elapsedMs: 0 },
          outputTokens: 0,
          aborted: false,
          timedOut: false,
        });
      },
    });
    expect(runStageCalls).toBe(0); // covers block → reused despite being over threshold
  });

  it("stale cached tree (frontier mismatch) rebuilds", async () => {
    seedGraph([{ id: "n3", summary: "a" }]);
    const store = getGraphStore();
    // cache a tree with a frontier that NO LONGER matches (advance the store frontier after)
    const cached = encodeSelection(store.graph, "oInitialPrompt", "old-frontier");
    persistSelectedTree({ appendEntry: () => {}, getLeafId: () => "leaf-1", getBranch: () => [] }, cached);
    // the store's frontier differs from the cached tree's coveredFrontier
    store.observerFrontier = "new-frontier";
    let runStageCalls = 0;
    const scripted = scriptRunStage({ passes: [{ tools: [{ name: TRY_FINISH_TOOL, ok: true }] }] });
    await runSelector({
      ctx: makeFakeCtx(),
      pi: recordingPi().pi,
      settings: settings({ selectorRootViewThreshold: 10_000_000 }),
      signal: new AbortController().signal,
      widget: NO_OP_WIDGET,
      scope: { firstKeptEntryId: "e2" },
      todo: null,
      todoBridge: null,
      runStageFn: (input) => {
        runStageCalls += 1;
        return scripted(input);
      },
    });
    expect(runStageCalls).toBeGreaterThanOrEqual(1); // stale → rebuild
  });

  it("fast-path coverage is >= prev(firstKeptEntryId), NOT firstKeptEntryId (off-by-one fix)", async () => {
    // The compacted-away block is [e0, e1]; firstKeptEntryId e2 is the FIRST
    // RETAINED entry. A cached tree covering up to e1 (the block's LAST entry =
    // prev(e2)) MUST be reused — a naive >= firstKeptEntryId check would wrongly
    // rebuild (off-by-one: the compacted block ends one before firstKeptEntryId).
    const branch = [
      { id: "e0", type: "message" },
      { id: "e1", type: "message" },
      { id: "e2", type: "message" },
      { id: "e3", type: "message" },
    ] as unknown as StoreEntry[];
    seedGraph([{ id: "n3", summary: "a" }]);
    const store = getGraphStore();
    // coveredFrontier = e1 (index 1 = prev(e2) at index 1) → covers the block
    store.observerFrontier = "e1";
    persistSelectedTree(
      { appendEntry: () => {}, getLeafId: () => "leaf-1", getBranch: () => branch },
      encodeSelection(store.graph, "oInitialPrompt", "e1"),
    );
    let runStageCalls = 0;
    await runSelector({
      ctx: {
        ...makeFakeCtx(),
        sessionManager: { getLeafId: () => "leaf-1", getBranch: () => branch },
      } as unknown as ExtensionContext,
      pi: recordingPi().pi,
      settings: settings({ selectorRootViewThreshold: 10_000_000 }),
      signal: new AbortController().signal,
      widget: NO_OP_WIDGET,
      scope: { firstKeptEntryId: "e2" },
      todo: null,
      todoBridge: null,
      runStageFn: () => {
        runStageCalls += 1;
        return Promise.resolve({
          messages: [],
          usage: { input: 0, output: 0, cacheRead: 0, cost: 0, turns: 0, elapsedMs: 0 },
          outputTokens: 0,
          aborted: false,
          timedOut: false,
        });
      },
    });
    // covered up to prev(e2) → reused (the off-by-one: e1 suffices, e2 not required)
    expect(runStageCalls).toBe(0);
  });

  it("legacy cached tree with null coveredFrontier rebuilds (compaction path)", async () => {
    seedGraph([{ id: "n3", summary: "a" }]);
    const store = getGraphStore();
    const branch = [
      { id: "e0", type: "message", timestamp: "2026-07-29T10:00:00.000Z" } as unknown as StoreEntry,
      { id: "e1", type: "message", timestamp: "2026-07-29T10:00:01.000Z" } as unknown as StoreEntry,
      { id: "e2", type: "message", timestamp: "2026-07-29T10:00:02.000Z" } as unknown as StoreEntry,
    ];
    // a LEGACY cached tree carries no coveredFrontier (null) → cannot prove it
    // covers the compacted block, so it must rebuild.
    const cached = encodeSelection(store.graph, "oInitialPrompt", null);
    persistSelectedTree({ appendEntry: () => {}, getLeafId: () => "leaf-1", getBranch: () => branch }, cached);
    let runStageCalls = 0;
    const scripted = scriptRunStage({ passes: [{ tools: [{ name: TRY_FINISH_TOOL, ok: true }] }] });
    await runSelector({
      ctx: makeFakeCtx(),
      pi: recordingPi().pi,
      settings: settings({ selectorRootViewThreshold: 10_000_000 }),
      signal: new AbortController().signal,
      widget: NO_OP_WIDGET,
      scope: { firstKeptEntryId: "e2" },
      todo: null,
      todoBridge: null,
      runStageFn: (input) => {
        runStageCalls += 1;
        return scripted(input);
      },
    });
    expect(runStageCalls).toBeGreaterThanOrEqual(1); // legacy null frontier → rebuild
  });

  it("stale coveredFrontier (entry no longer on the current branch) rebuilds", async () => {
    seedGraph([{ id: "n3", summary: "a" }]);
    const store = getGraphStore();
    // the current branch does NOT contain "stale-frontier" → coveredIndex -1 → rebuild
    const branch = [
      { id: "e0", type: "message", timestamp: "2026-07-29T10:00:00.000Z" } as unknown as StoreEntry,
      { id: "e1", type: "message", timestamp: "2026-07-29T10:00:01.000Z" } as unknown as StoreEntry,
      { id: "e2", type: "message", timestamp: "2026-07-29T10:00:02.000Z" } as unknown as StoreEntry,
    ];
    const cached = encodeSelection(store.graph, "oInitialPrompt", "stale-frontier");
    persistSelectedTree({ appendEntry: () => {}, getLeafId: () => "leaf-1", getBranch: () => branch }, cached);
    let runStageCalls = 0;
    const scripted = scriptRunStage({ passes: [{ tools: [{ name: TRY_FINISH_TOOL, ok: true }] }] });
    await runSelector({
      ctx: makeFakeCtx(),
      pi: recordingPi().pi,
      settings: settings({ selectorRootViewThreshold: 10_000_000 }),
      signal: new AbortController().signal,
      widget: NO_OP_WIDGET,
      scope: { firstKeptEntryId: "e2" },
      todo: null,
      todoBridge: null,
      runStageFn: (input) => {
        runStageCalls += 1;
        return scripted(input);
      },
    });
    expect(runStageCalls).toBeGreaterThanOrEqual(1); // coveredFrontier not on branch → rebuild
  });

  it("no-op pass ends the run; whatever tree exists is still persisted", async () => {
    seedGraph([{ id: "n3", summary: "a" }]);
    let passCount = 0;
    const scripted = scriptRunStage({ passes: [{ tools: [{ name: TRY_FINISH_TOOL, ok: false }] }] });
    const cap = recordingPi();
    await runSelector({
      ctx: makeFakeCtx(),
      pi: cap.pi,
      settings: settings({ selectorRootViewThreshold: 0, maxSelectorPasses: 5 }),
      signal: new AbortController().signal,
      widget: NO_OP_WIDGET,
      scope: { firstKeptEntryId: "e2" },
      todo: null,
      todoBridge: null,
      runStageFn: (input) => {
        passCount += 1;
        return scripted(input);
      },
    });
    expect(passCount).toBe(1); // no-op (0 mutates, not converged) → stop
    // a tree is still persisted (whatever the working copy held)
    expect(selectionEntries(cap.appended).length).toBeGreaterThanOrEqual(1);
  });

  it("stops at maxSelectorPasses without convergence, still persisting the tree", async () => {
    seedGraph([{ id: "n3", summary: "a" }]);
    let passCount = 0;
    const aPass = {
      tools: [
        { name: MV_TOOL, ok: true },
        { name: TRY_FINISH_TOOL, ok: false },
      ],
    };
    const scripted = scriptRunStage({ passes: [aPass, aPass, aPass, aPass] });
    const cap = recordingPi();
    await runSelector({
      ctx: makeFakeCtx(),
      pi: cap.pi,
      settings: settings({ selectorRootViewThreshold: 0, maxSelectorPasses: 2 }),
      signal: new AbortController().signal,
      widget: NO_OP_WIDGET,
      scope: { firstKeptEntryId: "e2" },
      todo: null,
      todoBridge: null,
      runStageFn: (input) => {
        passCount += 1;
        return scripted(input);
      },
    });
    expect(passCount).toBe(2);
    expect(selectionEntries(cap.appended).length).toBeGreaterThanOrEqual(1);
  });

  it("keeps partial work when a pass errors after a mutate, then persists on normal end", async () => {
    seedGraph([{ id: "n3", summary: "a" }]);
    let passCount = 0;
    const errorScript = scriptRunStageWithError(
      { passes: [{ tools: [{ name: TRY_FINISH_TOOL, ok: true }] }] },
      { toolsBeforeError: [{ name: MV_TOOL, ok: true }], errorPassIndex: 0 },
    );
    const cap = recordingPi();
    await runSelector({
      ctx: makeFakeCtx(),
      pi: cap.pi,
      settings: settings({ selectorRootViewThreshold: 0, maxSelectorPasses: 5 }),
      signal: new AbortController().signal,
      widget: NO_OP_WIDGET,
      scope: { firstKeptEntryId: "e2" },
      todo: null,
      todoBridge: null,
      runStageFn: (input) => {
        passCount += 1;
        return errorScript(input);
      },
    });
    expect(passCount).toBe(2); // errored after mutate → pass counts; pass 2 converges
    expect(selectionEntries(cap.appended).length).toBeGreaterThanOrEqual(1);
  });

  it("aborts before start: no pass, no persist", async () => {
    seedGraph([{ id: "n3", summary: "a" }]);
    const ac = new AbortController();
    ac.abort();
    let runStageCalls = 0;
    const cap = recordingPi();
    await runSelector({
      ctx: makeFakeCtx(),
      pi: cap.pi,
      settings: settings({ selectorRootViewThreshold: 0 }),
      signal: ac.signal,
      widget: NO_OP_WIDGET,
      scope: { firstKeptEntryId: "e2" },
      todo: null,
      todoBridge: null,
      runStageFn: () => {
        runStageCalls += 1;
        return Promise.resolve({
          messages: [],
          usage: { input: 0, output: 0, cacheRead: 0, cost: 0, turns: 0, elapsedMs: 0 },
          outputTokens: 0,
          aborted: false,
          timedOut: false,
        });
      },
    });
    expect(runStageCalls).toBe(0);
    expect(selectionEntries(cap.appended).length).toBe(0);
  });

  it("aborts during model resolution: post-await guard fires, no pass runs (carried R23-2)", async () => {
    seedGraph([{ id: "n3", summary: "a" }]);
    const ac = new AbortController();
    const fakeModel = { provider: "test", id: "selector-model" } as unknown as ExtensionContext["model"];
    // abort DURING the model-resolution await — resolution succeeds, but the
    // signal is aborted by the time the post-await guard runs.
    const ctx: ExtensionContext = {
      ...makeFakeCtx(),
      modelRegistry: {
        find: () => fakeModel,
        getApiKeyAndHeaders: async () => {
          ac.abort();
          return { ok: true as const, apiKey: "key" };
        },
      } as unknown as ExtensionContext["modelRegistry"],
    };
    let runStageCalls = 0;
    const cap = recordingPi();
    await runSelector({
      ctx,
      pi: cap.pi,
      settings: settings({ selectorRootViewThreshold: 0 }),
      signal: ac.signal,
      widget: NO_OP_WIDGET,
      scope: { firstKeptEntryId: "e2" },
      todo: null,
      todoBridge: null,
      runStageFn: () => {
        runStageCalls += 1;
        return Promise.resolve({
          messages: [],
          usage: { input: 0, output: 0, cacheRead: 0, cost: 0, turns: 0, elapsedMs: 0 },
          outputTokens: 0,
          aborted: false,
          timedOut: false,
        });
      },
    });
    expect(runStageCalls).toBe(0);
    expect(selectionEntries(cap.appended).length).toBe(0);
  });

  it("aborts during run: applied mutates kept (partial tree persisted), ledger persist skipped", async () => {
    // Distinguishes from abort-before-start: a stage opened + a working copy
    // exists, so the finally commits the partial tree. Mirrors the Builder's
    // abort-between-passes shape, but the Selector persists the working-copy
    // tree (load-bearing) and skips persistLedger (normalEnd false).
    seedGraph([{ id: "n3", summary: "keep", state: "active" }]);
    const ac = new AbortController();
    let passCount = 0;
    // pass 1 demotes n3 into nIrrelevant via the real mv tool, reports non-zero
    // usage (so the in-memory ledger folds it), then aborts the signal.
    const scripted = scriptRunStage({
      passes: [
        {
          tools: [
            { name: MV_TOOL, ok: true },
            { name: TRY_FINISH_TOOL, ok: false },
          ],
        },
      ],
    });
    const countingRunStage = async (input: StageRunInput): Promise<StageRunResult> => {
      passCount += 1;
      const res = await scripted(input);
      // report non-zero usage so the ledger folds it in-memory
      ac.abort();
      return { ...res, usage: { ...res.usage, input: 500, output: 10, turns: 1, elapsedMs: 0 } };
    };
    const cap = recordingPi();
    await runSelector({
      ctx: makeFakeCtx(),
      pi: cap.pi,
      settings: settings({ selectorRootViewThreshold: 0, maxSelectorPasses: 5 }),
      signal: ac.signal,
      widget: NO_OP_WIDGET,
      scope: { firstKeptEntryId: "e2" },
      todo: null,
      todoBridge: null,
      runStageFn: countingRunStage,
    });
    // only pass 1 ran (the signal-abort break stopped the loop before pass 2)
    expect(passCount).toBe(1);
    // partial tree persisted: a memkeeper.selection entry was written
    expect(selectionEntries(cap.appended).length).toBe(1);
    // persistLedger skipped on abort (normalEnd false): no memkeeper.usage entry
    expect(cap.appended.filter((e) => e.type === USAGE_TYPE).length).toBe(0);
  });

  it("skips when the model is unavailable (no pass, no persist)", async () => {
    seedGraph([{ id: "n3", summary: "a" }]);
    let runStageCalls = 0;
    const cap = recordingPi();
    await runSelector({
      ctx: makeFakeCtx(),
      pi: cap.pi,
      // selectorModel with no '/' → malformed → resolveStageModel !ok
      settings: settings({ selectorRootViewThreshold: 0, selectorModel: "badmodel" }),
      signal: new AbortController().signal,
      widget: NO_OP_WIDGET,
      scope: { firstKeptEntryId: "e2" },
      todo: null,
      todoBridge: null,
      runStageFn: () => {
        runStageCalls += 1;
        return Promise.resolve({
          messages: [],
          usage: { input: 0, output: 0, cacheRead: 0, cost: 0, turns: 0, elapsedMs: 0 },
          outputTokens: 0,
          aborted: false,
          timedOut: false,
        });
      },
    });
    expect(runStageCalls).toBe(0);
    expect(selectionEntries(cap.appended).length).toBe(0);
  });
});

// --- SELECTOR_SYSTEM sanity (cross-module: the run uses it) -----------------

describe("SELECTOR_SYSTEM (used by runSelector)", () => {
  it("is non-empty and includes the drill-in line", () => {
    expect(SELECTOR_SYSTEM.length).toBeGreaterThan(0);
    expect(SELECTOR_SYSTEM).toContain("Drill into any node");
  });

  it("names the budget levers (demote + condense), no 'remove' tool", () => {
    // The Selector's budget levers are demote (mv into nIrrelevant) + condense
    // (set_meta) — never remove (rollback risk).
    expect(SELECTOR_SYSTEM).toContain("set_meta");
    expect(SELECTOR_SYSTEM).toContain("nIrrelevant");
    expect(SELECTOR_SYSTEM).not.toMatch(/\bremove\b/);
  });
});
