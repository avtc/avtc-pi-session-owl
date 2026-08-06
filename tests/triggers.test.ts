// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../src/config/schema.js";
import { _resetRunLock, acquireOrSkip, inFlight as runLockInFlight } from "../src/runtime/run-lock.js";
import { getGraphStore, resetForNewSession } from "../src/store/graph-store.js";
import {
  computeUnobserved,
  evaluateBuilderTrigger,
  evaluateObserverTrigger,
  evaluateSelectorTrigger,
  onTurnEnd,
  type RunFn,
  resetStageRuns,
  setStageRuns,
  type TriggerInput,
} from "../src/triggers.js";
import { makeNode, type NodeId } from "../src/types.js";

// --- fakes -----------------------------------------------------------------

interface FakeEntry {
  id: string;
  type: string;
  parentId: string | null;
  timestamp: string;
  message?: AgentMessage;
}

function userEntry(id: string, text: string): FakeEntry {
  return {
    id,
    type: "message",
    parentId: null,
    timestamp: "2026-07-28T14:30:00.000Z",
    message: { role: "user", content: text, timestamp: 0 },
  };
}

function assistantEntry(id: string, text: string): FakeEntry {
  return {
    id,
    type: "message",
    parentId: null,
    timestamp: "2026-07-28T14:31:00.000Z",
    message: {
      role: "assistant",
      content: [{ type: "text", text }],
      provider: "p",
      model: "m",
      stopReason: "stop",
      timestamp: 0,
    } as AgentMessage,
  };
}

function customMessageEntry(id: string, text: string): FakeEntry {
  return {
    id,
    type: "custom_message",
    parentId: null,
    timestamp: "2026-07-28T14:32:00.000Z",
    content: text,
  } as FakeEntry;
}

function modelChange(id: string): FakeEntry {
  return {
    id,
    type: "model_change",
    parentId: null,
    timestamp: "",
    provider: "p",
    modelId: "m",
  } as unknown as FakeEntry;
}

function makeInput(over: Partial<TriggerInput> & { settings?: typeof DEFAULT_CONFIG } = {}): TriggerInput {
  const settings = { ...DEFAULT_CONFIG, ...over.settings };
  return {
    ctx: over.ctx ?? ({ getContextUsage: () => undefined } as unknown as ExtensionContext),
    settings,
  };
}

// ---------------------------------------------------------------------------
beforeEach(() => {
  _resetRunLock();
  resetForNewSession();
});

afterEach(() => {
  _resetRunLock();
  resetForNewSession();
  resetStageRuns();
});

// ===========================================================================
describe("computeUnobserved — the Observer frontier", () => {
  it("returns entries strictly after the frontier (renderable only)", () => {
    const entries = [
      userEntry("u1", "first user message body long enough"),
      assistantEntry("a1", "reply"),
      userEntry("u2", "second user message"),
      assistantEntry("a2", "reply two"),
    ];
    const unobserved = computeUnobserved(entries as unknown as SessionEntry[], "a1");
    expect(unobserved.map((e) => e.id)).toEqual(["u2", "a2"]);
  });

  it("with a null frontier, starts AFTER the first user message", () => {
    const entries = [
      userEntry("u1", "the verbatim initial prompt that got captured mechanically"),
      assistantEntry("a1", "reply"),
      userEntry("u2", "second"),
    ];
    const unobserved = computeUnobserved(entries as unknown as SessionEntry[], null);
    expect(unobserved.map((e) => e.id)).toEqual(["a1", "u2"]);
  });

  it("skips operational entries (only message/custom_message/branch_summary are renderable)", () => {
    const entries = [
      userEntry("u1", "initial prompt captured mechanically here"),
      modelChange("mc1"),
      assistantEntry("a1", "reply"),
    ];
    const unobserved = computeUnobserved(entries as unknown as SessionEntry[], null);
    expect(unobserved.map((e) => e.id)).toEqual(["a1"]);
  });

  it("returns nothing when the frontier is at or past the last entry", () => {
    const entries = [userEntry("u1", "initial prompt captured mechanically"), assistantEntry("a1", "reply")];
    expect(computeUnobserved(entries as unknown as SessionEntry[], "a1").map((e) => e.id)).toEqual([]);
  });

  it("includes custom_message entries as renderable", () => {
    const entries = [
      userEntry("u1", "initial prompt captured mechanically"),
      customMessageEntry("cm1", "a custom injected note"),
      assistantEntry("a1", "reply"),
    ];
    const unobserved = computeUnobserved(entries as unknown as SessionEntry[], null);
    expect(unobserved.map((e) => e.id)).toEqual(["cm1", "a1"]);
  });

  it("includes branch_summary entries as renderable", () => {
    const entries = [
      userEntry("u1", "initial prompt captured mechanically"),
      { id: "bs1", type: "branch_summary", parentId: null, timestamp: "", summary: "a branch recap" },
      assistantEntry("a1", "reply"),
    ];
    const unobserved = computeUnobserved(entries as unknown as SessionEntry[], null);
    expect(unobserved.map((e) => e.id)).toEqual(["bs1", "a1"]);
  });

  it("with a null frontier and no user message, observes nothing (no task anchor yet)", () => {
    const entries = [modelChange("mc1"), assistantEntry("a1", "reply before any user message")];
    const unobserved = computeUnobserved(entries as unknown as SessionEntry[], null);
    expect(unobserved).toEqual([]);
  });

  it("treats a stale frontier id (not on the branch) as nothing-after-it", () => {
    const entries = [userEntry("u1", "initial prompt captured mechanically"), assistantEntry("a1", "reply")];
    const unobserved = computeUnobserved(entries as unknown as SessionEntry[], "stale-id-not-in-branch");
    expect(unobserved).toEqual([]);
  });
});

// ===========================================================================
describe("evaluateObserverTrigger", () => {
  it("does not fire when observerMode is on-compaction", () => {
    const res = evaluateObserverTrigger({
      ...makeInput({ settings: { ...DEFAULT_CONFIG, observerMode: "on-compaction" } }),
      unobserved: [],
    });
    expect(res.shouldFire).toBe(false);
  });

  it("does not fire when there are zero unobserved entries", () => {
    const entries = [userEntry("u1", "initial prompt captured mechanically")];
    const unobserved = computeUnobserved(entries as unknown as SessionEntry[], null);
    const res = evaluateObserverTrigger({
      ...makeInput(),
      unobserved,
    });
    expect(res.shouldFire).toBe(false);
    expect(unobserved).toHaveLength(0);
  });

  it("fires when unobserved tokens reach the threshold", () => {
    // ~50 chars per message → many messages to cross the default 4K-token (16K-char) threshold.
    const entries = [
      userEntry("u1", "initial prompt captured mechanically"),
      ...Array.from({ length: 400 }, (_, i) => assistantEntry(`a${i}`, "x".repeat(50))),
    ];
    const unobserved = computeUnobserved(entries as unknown as SessionEntry[], null);
    const res = evaluateObserverTrigger({
      ...makeInput(),
      unobserved,
    });
    expect(res.shouldFire).toBe(true);
  });

  it("does not fire when unobserved tokens are below the threshold", () => {
    const entries = [userEntry("u1", "initial prompt captured mechanically"), assistantEntry("a1", "short reply")];
    const unobserved = computeUnobserved(entries as unknown as SessionEntry[], null);
    const res = evaluateObserverTrigger({
      ...makeInput(),
      unobserved,
    });
    expect(res.shouldFire).toBe(false);
  });

  it("respects a custom threshold", () => {
    const entries = [
      userEntry("u1", "initial prompt captured mechanically"),
      assistantEntry("a1", "a reply of a few tokens"),
    ];
    const unobserved = computeUnobserved(entries as unknown as SessionEntry[], null);
    const res = evaluateObserverTrigger({
      ...makeInput({ settings: { ...DEFAULT_CONFIG, observerThresholdTokens: 1 } }),
      unobserved,
    });
    expect(res.shouldFire).toBe(true);
  });

  it("skips when a run is in flight", () => {
    const handle = acquireOrSkip("observe");
    if (handle === null) throw new Error("lock not acquired");
    const entries = [
      userEntry("u1", "initial prompt captured mechanically"),
      ...Array.from({ length: 400 }, (_, i) => assistantEntry(`a${i}`, "x".repeat(50))),
    ];
    const unobserved = computeUnobserved(entries as unknown as SessionEntry[], null);
    const res = evaluateObserverTrigger({ ...makeInput(), unobserved });
    expect(res.shouldFire).toBe(false);
    handle.release();
  });
});

// --- helpers: seed the graph store ----------------------------------------

function ctxWithTokens(tokens: number | null): ExtensionContext {
  return { getContextUsage: () => ({ tokens, contextWindow: 200000, percent: null }) } as unknown as ExtensionContext;
}

const ROOT_NODE_SUMMARY = "x".repeat(40);

/** Add a root node with the given state to the singleton graph store. */
function addRootNode(id: NodeId, state: "new" | "active" | "archived" | "obsolete"): void {
  const { graph } = getGraphStore();
  graph.nodes.set(
    id,
    makeNode({
      id,
      summary: ROOT_NODE_SUMMARY,
      importance: "med",
      state,
      parentNode: null,
      createdAt: "2026-07-28T14:30:00.000Z",
    }),
  );
}

// ===========================================================================
describe("evaluateBuilderTrigger", () => {
  it("does not fire when builderMode is on-compaction", () => {
    const res = evaluateBuilderTrigger(makeInput({ settings: { ...DEFAULT_CONFIG, builderMode: "on-compaction" } }));
    expect(res.shouldFire).toBe(false);
  });

  it("each-N-observations: fires when the count of new wrapper nodes >= N", () => {
    addRootNode("n1" as NodeId, "new");
    addRootNode("n2" as NodeId, "new");
    addRootNode("n3" as NodeId, "new");
    const res = evaluateBuilderTrigger(
      makeInput({ settings: { ...DEFAULT_CONFIG, builderMode: "each-N-observations", builderEveryNObservations: 3 } }),
    );
    expect(res.shouldFire).toBe(true);
  });

  it("each-N-observations: does not fire when new wrapper nodes < N", () => {
    addRootNode("n1" as NodeId, "new");
    const res = evaluateBuilderTrigger(
      makeInput({ settings: { ...DEFAULT_CONFIG, builderMode: "each-N-observations", builderEveryNObservations: 3 } }),
    );
    expect(res.shouldFire).toBe(false);
  });

  it("each-N-observations: counts only new nodes (active/archived don't count)", () => {
    addRootNode("n1" as NodeId, "new");
    addRootNode("n2" as NodeId, "active");
    addRootNode("n3" as NodeId, "archived");
    const res = evaluateBuilderTrigger(
      makeInput({ settings: { ...DEFAULT_CONFIG, builderMode: "each-N-observations", builderEveryNObservations: 2 } }),
    );
    expect(res.shouldFire).toBe(false);
  });

  it("on-session-context-threshold: fires when context tokens >= threshold", () => {
    const res = evaluateBuilderTrigger(
      makeInput({
        ctx: ctxWithTokens(200000),
        settings: {
          ...DEFAULT_CONFIG,
          builderMode: "on-session-context-threshold",
          builderSessionContextThresholdTokens: 200000,
        },
      }),
    );
    expect(res.shouldFire).toBe(true);
  });

  it("on-session-context-threshold: does not fire below threshold", () => {
    const res = evaluateBuilderTrigger(
      makeInput({
        ctx: ctxWithTokens(199999),
        settings: {
          ...DEFAULT_CONFIG,
          builderMode: "on-session-context-threshold",
          builderSessionContextThresholdTokens: 200000,
        },
      }),
    );
    expect(res.shouldFire).toBe(false);
  });

  it("on-session-context-threshold: does not fire when context tokens is null", () => {
    const res = evaluateBuilderTrigger(
      makeInput({
        ctx: ctxWithTokens(null),
        settings: {
          ...DEFAULT_CONFIG,
          builderMode: "on-session-context-threshold",
          builderSessionContextThresholdTokens: 200000,
        },
      }),
    );
    expect(res.shouldFire).toBe(false);
  });

  it("on-root-view-threshold: fires when the non-obsolete root view >= threshold", () => {
    // 10 roots × ~19 rendered tokens/line (full node line, chars/4) = ~190; threshold 100
    for (let i = 0; i < 10; i++) addRootNode(`n${i}` as NodeId, "active");
    const res = evaluateBuilderTrigger(
      makeInput({
        settings: { ...DEFAULT_CONFIG, builderMode: "on-root-view-threshold", builderRootViewThreshold: 100 },
      }),
    );
    expect(res.shouldFire).toBe(true);
  });

  it("on-root-view-threshold: counts new + active + archived roots, excludes obsolete", () => {
    addRootNode("n1" as NodeId, "new");
    addRootNode("n2" as NodeId, "active");
    addRootNode("n3" as NodeId, "archived");
    addRootNode("n4" as NodeId, "obsolete");
    // 3 non-obsolete roots × ~19 rendered tokens/line = ~57; threshold 30
    const res = evaluateBuilderTrigger(
      makeInput({
        settings: { ...DEFAULT_CONFIG, builderMode: "on-root-view-threshold", builderRootViewThreshold: 30 },
      }),
    );
    expect(res.shouldFire).toBe(true);
  });

  it("on-root-view-threshold: does not fire below threshold", () => {
    addRootNode("n1" as NodeId, "active");
    const res = evaluateBuilderTrigger(
      makeInput({
        settings: { ...DEFAULT_CONFIG, builderMode: "on-root-view-threshold", builderRootViewThreshold: 100 },
      }),
    );
    expect(res.shouldFire).toBe(false);
  });

  it("skips when a run is in flight", () => {
    const handle = acquireOrSkip("build");
    if (handle === null) throw new Error("lock not acquired");
    addRootNode("n1" as NodeId, "new");
    const res = evaluateBuilderTrigger(
      makeInput({ settings: { ...DEFAULT_CONFIG, builderMode: "each-N-observations", builderEveryNObservations: 1 } }),
    );
    expect(res.shouldFire).toBe(false);
    handle.release();
  });
});

// ===========================================================================
describe("evaluateSelectorTrigger", () => {
  it("does not fire when selectorMode is on-compaction", () => {
    const res = evaluateSelectorTrigger(makeInput({ settings: { ...DEFAULT_CONFIG, selectorMode: "on-compaction" } }));
    expect(res.shouldFire).toBe(false);
  });

  it("does not fire when renderMode is observations-root (Selector is inactive)", () => {
    const res = evaluateSelectorTrigger(
      makeInput({
        ctx: ctxWithTokens(200000),
        settings: {
          ...DEFAULT_CONFIG,
          renderMode: "observations-root",
          selectorMode: "on-session-context-threshold",
        },
      }),
    );
    expect(res.shouldFire).toBe(false);
  });

  it("on-session-context-threshold: fires when context tokens >= threshold", () => {
    const res = evaluateSelectorTrigger(
      makeInput({
        ctx: ctxWithTokens(200000),
        settings: {
          ...DEFAULT_CONFIG,
          renderMode: "selected-root",
          selectorMode: "on-session-context-threshold",
          selectorSessionContextThresholdTokens: 200000,
        },
      }),
    );
    expect(res.shouldFire).toBe(true);
  });

  it("on-session-context-threshold: does not fire below threshold", () => {
    const res = evaluateSelectorTrigger(
      makeInput({
        ctx: ctxWithTokens(199999),
        settings: {
          ...DEFAULT_CONFIG,
          renderMode: "selected-root",
          selectorMode: "on-session-context-threshold",
          selectorSessionContextThresholdTokens: 200000,
        },
      }),
    );
    expect(res.shouldFire).toBe(false);
  });

  it("skips when a run is in flight", () => {
    const handle = acquireOrSkip("select");
    if (handle === null) throw new Error("lock not acquired");
    const res = evaluateSelectorTrigger(
      makeInput({
        ctx: ctxWithTokens(200000),
        settings: {
          ...DEFAULT_CONFIG,
          renderMode: "selected-root",
          selectorMode: "on-session-context-threshold",
          selectorSessionContextThresholdTokens: 200000,
        },
      }),
    );
    expect(res.shouldFire).toBe(false);
    handle.release();
  });

  it("on-session-context-threshold: does not fire when context tokens is null", () => {
    const res = evaluateSelectorTrigger(
      makeInput({
        ctx: ctxWithTokens(null),
        settings: {
          ...DEFAULT_CONFIG,
          renderMode: "selected-root",
          selectorMode: "on-session-context-threshold",
          selectorSessionContextThresholdTokens: 200000,
        },
      }),
    );
    expect(res.shouldFire).toBe(false);
  });
});

// ===========================================================================
describe("onTurnEnd chained launch", () => {
  // A single turn_end acquires the lock ONCE and runs observe → build → select
  // (each stage that fires) as one chained run, re-evaluating Builder/Selector
  // AFTER the Observer completes so they see the Observer's new nodes. This fixes
  // the starvation where a Builder/Selector that fired on the same turn as the
  // Observer used to SKIP because the Observer held the lock.
  it("runs observe → build → select in order when all three fire (one lock)", async () => {
    const order: string[] = [];
    setStageRuns({
      runObserver: async () => {
        order.push("observe");
      },
      runBuilder: async () => {
        order.push("build");
      },
      runSelector: async () => {
        order.push("select");
      },
    });
    const entries: FakeEntry[] = [
      userEntry("u1", "initial prompt"),
      ...Array.from({ length: 20 }, (_, i) => assistantEntry(`a${i}`, "x".repeat(200))),
    ];
    const ctx = {
      getContextUsage: () => ({ tokens: 100000, contextWindow: 200000, percent: 50 }),
      sessionManager: { getLeafId: () => "leaf-1", getBranch: () => entries },
    } as unknown as ExtensionContext;
    onTurnEnd(
      makeInput({
        ctx,
        settings: {
          ...DEFAULT_CONFIG,
          observerThresholdTokens: 1,
          builderMode: "on-session-context-threshold",
          builderSessionContextThresholdTokens: 1,
          selectorMode: "on-session-context-threshold",
          selectorSessionContextThresholdTokens: 1,
        },
      }),
    );
    await new Promise((r) => setTimeout(r, 10));
    expect(order).toEqual(["observe", "build", "select"]);
    expect(runLockInFlight()).toBe(false); // released by the chain's finally
  });

  it("re-evaluates the Builder AFTER the Observer — fires only because the Observer created new nodes (starvation fix)", async () => {
    // Pre-eval: NO new nodes → Builder's each-N-observations (N=3) does NOT fire.
    // The stubbed Observer then adds 3 `new` nodes (as a real Observer would),
    // and the re-eval AFTER the Observer sees them → Builder fires.
    let builderRan = false;
    setStageRuns({
      runObserver: async () => {
        addRootNode("n1", "new");
        addRootNode("n2", "new");
        addRootNode("n3", "new");
      },
      runBuilder: async () => {
        builderRan = true;
      },
      runSelector: async () => {},
    });
    const entries: FakeEntry[] = [
      userEntry("u1", "initial prompt"),
      ...Array.from({ length: 20 }, (_, i) => assistantEntry(`a${i}`, "x".repeat(200))),
    ];
    const ctx = {
      getContextUsage: () => ({ tokens: 0, contextWindow: 200000, percent: 0 }),
      sessionManager: { getLeafId: () => "leaf-1", getBranch: () => entries },
    } as unknown as ExtensionContext;
    onTurnEnd(
      makeInput({
        ctx,
        settings: {
          ...DEFAULT_CONFIG,
          observerThresholdTokens: 1,
          builderMode: "each-N-observations",
          builderEveryNObservations: 3,
          selectorMode: "on-compaction",
        },
      }),
    );
    await new Promise((r) => setTimeout(r, 10));
    // The Builder ran ONLY because the re-eval saw the Observer's new nodes —
    // the pre-eval (0 new nodes) would have skipped it (the starvation bug).
    expect(builderRan).toBe(true);
    expect(runLockInFlight()).toBe(false);
  });

  it("runs only the firing stages (e.g. Observer alone when Builder/Selector are on-compaction)", async () => {
    const order: string[] = [];
    setStageRuns({
      runObserver: async () => {
        order.push("observe");
      },
      runBuilder: async () => {
        order.push("build");
      },
      runSelector: async () => {
        order.push("select");
      },
    });
    const entries: FakeEntry[] = [userEntry("u1", "initial prompt"), assistantEntry("a1", "x".repeat(2000))];
    const ctx = {
      getContextUsage: () => ({ tokens: 0, contextWindow: 200000, percent: 0 }),
      sessionManager: { getLeafId: () => "leaf-1", getBranch: () => entries },
    } as unknown as ExtensionContext;
    // default profile: Observer on-threshold (fires), Builder + Selector on-compaction (skip).
    onTurnEnd(makeInput({ ctx, settings: { ...DEFAULT_CONFIG, observerThresholdTokens: 1 } }));
    await new Promise((r) => setTimeout(r, 10));
    expect(order).toEqual(["observe"]);
    expect(runLockInFlight()).toBe(false);
  });

  it("SKIPs the whole turn when a run is already in flight (no queue)", async () => {
    const handle = acquireOrSkip("observe"); // occupy the lock
    if (handle === null) throw new Error("lock not acquired");
    const order: string[] = [];
    setStageRuns({
      runObserver: async () => {
        order.push("observe");
      },
      runBuilder: async () => {
        order.push("build");
      },
      runSelector: async () => {
        order.push("select");
      },
    });
    const entries: FakeEntry[] = [userEntry("u1", "initial prompt"), assistantEntry("a1", "x".repeat(2000))];
    const ctx = {
      getContextUsage: () => ({ tokens: 100000, contextWindow: 200000, percent: 50 }),
      sessionManager: { getLeafId: () => "leaf-1", getBranch: () => entries },
    } as unknown as ExtensionContext;
    onTurnEnd(
      makeInput({
        ctx,
        settings: {
          ...DEFAULT_CONFIG,
          observerThresholdTokens: 1,
          builderMode: "on-session-context-threshold",
          builderSessionContextThresholdTokens: 1,
          selectorMode: "on-session-context-threshold",
          selectorSessionContextThresholdTokens: 1,
        },
      }),
    );
    await new Promise((r) => setTimeout(r, 10));
    expect(order).toEqual([]); // skipped — nothing ran; the gap batches on the next trigger
    handle.release();
  });

  it("releases the lock even when a chained stage rejects", async () => {
    setStageRuns({
      runObserver: async () => {
        throw new Error("boom");
      },
      runBuilder: async () => {},
      runSelector: async () => {},
    });
    const entries: FakeEntry[] = [userEntry("u1", "initial prompt"), assistantEntry("a1", "x".repeat(2000))];
    const ctx = {
      getContextUsage: () => ({ tokens: 0, contextWindow: 200000, percent: 0 }),
      sessionManager: { getLeafId: () => "leaf-1", getBranch: () => entries },
    } as unknown as ExtensionContext;
    onTurnEnd(makeInput({ ctx, settings: { ...DEFAULT_CONFIG, observerThresholdTokens: 1 } }));
    await new Promise((r) => setTimeout(r, 10));
    expect(runLockInFlight()).toBe(false);
  });
});

// ===========================================================================
describe("onTurnEnd", () => {
  it("is a no-op when enabled=false (no stage run is launched)", () => {
    let called = false;
    setStageRuns({
      runObserver: async () => {
        called = true;
      },
      runBuilder: async () => {
        called = true;
      },
      runSelector: async () => {
        called = true;
      },
    });
    const input = makeInput({
      settings: { ...DEFAULT_CONFIG, enabled: false, observerThresholdTokens: 1 },
    });
    onTurnEnd(input);
    expect(called).toBe(false);
  });

  it("returns synchronously (fire-and-forget): the run is not awaited", () => {
    let resolved = false;
    const observerRun: RunFn = async () => {
      await new Promise((r) => setTimeout(r, 50));
      resolved = true;
    };
    setStageRuns({ runObserver: observerRun, runBuilder: async () => {}, runSelector: async () => {} });
    const entries: FakeEntry[] = [
      userEntry("u1", "initial prompt captured mechanically"),
      assistantEntry("a1", "x".repeat(2000)),
    ];
    const ctx = {
      getContextUsage: () => ({ tokens: 0, contextWindow: 200000, percent: 0 }),
      sessionManager: { getLeafId: () => "leaf-1", getBranch: () => entries },
    } as unknown as ExtensionContext;
    onTurnEnd(makeInput({ ctx, settings: { ...DEFAULT_CONFIG, observerThresholdTokens: 1 } }));
    // returned immediately — the run hasn't resolved yet
    expect(resolved).toBe(false);
  });

  it("reads getContextUsage ONCE even when both Builder + Selector are on-session-context-threshold (dual threshold)", () => {
    // the non-default dual-threshold config would otherwise call the uncached
    // getContextUsage twice per turn; onTurnEnd prefetches once + threads it.
    setStageRuns({
      runObserver: async () => {},
      runBuilder: async () => {},
      runSelector: async () => {},
    });
    let calls = 0;
    const ctx = {
      getContextUsage: () => {
        calls += 1;
        return { tokens: 100000, contextWindow: 200000, percent: 50 };
      },
      sessionManager: { getLeafId: () => "leaf-1", getBranch: () => [] as FakeEntry[] },
    } as unknown as ExtensionContext;
    onTurnEnd(
      makeInput({
        ctx,
        settings: {
          ...DEFAULT_CONFIG,
          observerMode: "on-compaction",
          builderMode: "on-session-context-threshold",
          selectorMode: "on-session-context-threshold",
          builderSessionContextThresholdTokens: 50000,
          selectorSessionContextThresholdTokens: 50000,
        },
      }),
    );
    // prefetched once in onTurnEnd — NOT once per evaluator
    expect(calls).toBe(1);
  });
});
