// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// compactionHook: the session_before_compact handler. Owns the run-lock for the
// duration of its ensure-ready stages (Observer catch-up → Builder → Selector),
// renders the summary, snapshots the graph to details, and returns the
// compaction result. Failure / abort → {cancel:true} + notify.

import type { Usage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, SessionBeforeCompactEvent } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type CompactionStageRuns,
  compactionHook,
  resetCompactionSeams,
  setCompactionSettingsGetter,
  setCompactionStageRuns,
} from "../../src/compaction/hook.js";
import { DEFAULT_CONFIG } from "../../src/config/schema.js";
import { _resetRunLock, acquireOrSkip } from "../../src/runtime/run-lock.js";
import { getGraphStore, resetForNewSession } from "../../src/store/graph-store.js";
import { N_GOAL } from "../../src/types.js";
import { NO_OP_WIDGET } from "../../src/widget/tracker.js";

// --- fixtures ---------------------------------------------------------------

interface FakeRunCalls {
  observer: number;
  builder: number;
  selector: number;
  observerUnobservedLen: number[];
  builderScope: ({ firstKeptEntryId: string | null } | null)[];
  order: string[];
}

function newCalls(): FakeRunCalls {
  return { observer: 0, builder: 0, selector: 0, observerUnobservedLen: [], builderScope: [], order: [] };
}

function fakeRuns(calls: FakeRunCalls): CompactionStageRuns {
  return {
    runObserver: vi.fn(async (args) => {
      calls.observer += 1;
      calls.observerUnobservedLen.push(args.unobserved.length);
      calls.order.push("observer");
    }),
    runBuilder: vi.fn(async (args) => {
      calls.builder += 1;
      calls.builderScope.push(args.scope);
      calls.order.push("builder");
    }),
    runSelector: vi.fn(async () => {
      calls.selector += 1;
      calls.order.push("selector");
    }),
  };
}

function makeFakePi(): ExtensionAPI {
  return { appendEntry: () => {} } as unknown as ExtensionAPI;
}

const NO_NOTIFY: (msg: string, level: "warning" | "info") => void = () => {};

/** avtc-pi-todo absent — no todo context or bridge (the graceful-degrade path). */
const TODO_ABSENT = { context: null, bridge: null } as const;
function makeFakeCtx(branch: unknown[], notify: (msg: string, level: "warning" | "info") => void): ExtensionContext {
  const fakeModel = { provider: "test", id: "m" } as unknown as ExtensionContext["model"];
  return {
    sessionManager: {
      getLeafId: () => "leaf-1",
      getBranch: () => branch,
      getEntry: (id: string) => branch.find((e) => (e as { id: string }).id === id),
    },
    modelRegistry: {
      find: () => fakeModel,
      getApiKeyAndHeaders: async () => ({ ok: true as const, apiKey: "key" }),
    } as unknown as ExtensionContext["modelRegistry"],
    model: fakeModel,
    ui: { notify: notify ?? (() => {}) },
  } as unknown as ExtensionContext;
}

function compactEvent(over: Partial<SessionBeforeCompactEvent>): SessionBeforeCompactEvent {
  return {
    type: "session_before_compact",
    preparation: { firstKeptEntryId: "cut-1", tokensBefore: 50000 } as SessionBeforeCompactEvent["preparation"],
    branchEntries: [],
    reason: "threshold",
    willRetry: false,
    signal: new AbortController().signal,
    ...over,
  } as unknown as SessionBeforeCompactEvent;
}

/** Seed the store's graph with nGoal so the summary has a root (and the
 *  root-view measurement is non-trivial). Mutates the singleton store directly. */
function seedStoreGraph(): void {
  getGraphStore().graph.nodes.set(N_GOAL, {
    id: N_GOAL,
    summary: "the goal",
    summaryTokens: 8,
    state: "active",
    importance: "crit",
    parentNode: null,
    observationIds: [],
    childNodeIds: [],
    supersededBy: null,
    timestamps: {
      createdAt: "2026-07-28T09:00:00.000Z",
      updatedAt: "2026-07-28T09:00:00.000Z",
      rangeStart: "2026-07-28T09:00:00.000Z",
      rangeEnd: "2026-07-28T09:00:00.000Z",
    },
  });
}

function assistantMsg(id: string, text: string): unknown {
  return {
    type: "message",
    id,
    parentId: null,
    timestamp: `2026-07-28T${id}0:00:00Z`,
    message: {
      role: "assistant",
      content: [{ type: "text", text }],
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      api: "a",
      provider: "p",
      model: "m",
      stopReason: "stop",
      timestamp: 0,
    },
  };
}

const settings = (over: Partial<typeof DEFAULT_CONFIG>): typeof DEFAULT_CONFIG => ({ ...DEFAULT_CONFIG, ...over });

describe("compactionHook", () => {
  beforeEach(() => {
    resetForNewSession();
    resetCompactionSeams();
    _resetRunLock();
  });
  afterEach(() => {
    resetForNewSession();
    resetCompactionSeams();
    _resetRunLock();
  });

  it("returns the compaction result with summary, firstKeptEntryId, tokensBefore, details", async () => {
    seedStoreGraph();
    const calls = newCalls();
    setCompactionStageRuns(fakeRuns(calls));

    const result = await compactionHook(
      compactEvent({}),
      makeFakeCtx([], NO_NOTIFY),
      makeFakePi(),
      NO_OP_WIDGET,
      TODO_ABSENT,
    );
    const compaction = (
      result as { compaction: { summary: string; firstKeptEntryId: string; tokensBefore: number; details: unknown } }
    ).compaction;
    expect(compaction.firstKeptEntryId).toBe("cut-1");
    expect(compaction.tokensBefore).toBe(50000);
    expect(compaction.summary).toContain("# Memory");
    expect(compaction.details).toBeDefined();
  });

  it("passes Observer catch-up (gap-driven), Builder, Selector in order", async () => {
    // threshold 0 → Builder always passes (no fast-path skip) so the ordering is observable.
    setCompactionSettingsGetter(() => settings({ builderRootViewThreshold: 0 }));
    // entries after the frontier (null → starts after first user msg; no user msg
    // here so the gap is empty) — use entries that computeUnobserved treats as a
    // gap: set a branch with a user anchor first.
    const branch = [
      {
        type: "message",
        id: "u1",
        parentId: null,
        timestamp: "2026-07-28T09:00:00Z",
        message: { role: "user", content: "first", timestamp: 0 },
      },
      assistantMsg("a1", "response"),
    ];
    const calls = newCalls();
    setCompactionStageRuns(fakeRuns(calls));

    await compactionHook(compactEvent({}), makeFakeCtx(branch, NO_NOTIFY), makeFakePi(), NO_OP_WIDGET, TODO_ABSENT);

    // Observer catch-up ran (gap-driven) and received the unobserved gap.
    expect(calls.observer).toBe(1);
    expect(calls.observerUnobservedLen[0]).toBeGreaterThan(0);
    // Builder ran with the compaction scope.
    expect(calls.builder).toBe(1);
    expect(calls.builderScope[0]).toEqual({ firstKeptEntryId: "cut-1" });
    // Selector ran (default renderMode = selected-root).
    expect(calls.selector).toBe(1);
    expect(calls.order).toEqual(["observer", "builder", "selector"]);
  });

  it("calls Builder unconditionally — the run owns the internal fast-path (no hook pre-gate)", async () => {
    seedStoreGraph(); // only nGoal → tiny root view (under threshold)
    const calls = newCalls();
    setCompactionStageRuns(fakeRuns(calls));

    await compactionHook(compactEvent({}), makeFakeCtx([], NO_NOTIFY), makeFakePi(), NO_OP_WIDGET, TODO_ABSENT);
    // the hook no longer pre-gates; runBuilder is always called and does the
    // fast-path (flush `new` + skip LLM passes) itself when under threshold.
    expect(calls.builder).toBe(1);
  });

  it("skips the Selector when renderMode is observations-root", async () => {
    seedStoreGraph();
    setCompactionSettingsGetter(() => settings({ renderMode: "observations-root" }));
    const calls = newCalls();
    setCompactionStageRuns(fakeRuns(calls));

    await compactionHook(compactEvent({}), makeFakeCtx([], NO_NOTIFY), makeFakePi(), NO_OP_WIDGET, TODO_ABSENT);
    expect(calls.selector).toBe(0);
    // Observer + Builder still ran (Builder always called; owns the fast-path).
    expect(calls.builder).toBe(1);
  });

  it("skips Observer catch-up when the frontier-to-cut gap is empty", async () => {
    seedStoreGraph();
    // no branch entries → no gap → Observer catch-up is a no-op.
    const calls = newCalls();
    setCompactionStageRuns(fakeRuns(calls));

    await compactionHook(compactEvent({}), makeFakeCtx([], NO_NOTIFY), makeFakePi(), NO_OP_WIDGET, TODO_ABSENT);
    expect(calls.observer).toBe(0);
  });

  it("returns cancel:true + notifies when a stage throws", async () => {
    seedStoreGraph();
    setCompactionSettingsGetter(() => settings({ builderRootViewThreshold: 0 }));
    const notify = vi.fn<(msg: string, level: "warning" | "info") => void>();
    setCompactionStageRuns({
      runObserver: vi.fn(async () => {}),
      runBuilder: vi.fn(async () => {
        throw new Error("boom");
      }),
      runSelector: vi.fn(async () => {}),
    });

    const result = await compactionHook(
      compactEvent({}),
      makeFakeCtx([], notify),
      makeFakePi(),
      NO_OP_WIDGET,
      TODO_ABSENT,
    );
    expect(result).toEqual({ cancel: true });
    expect(notify).toHaveBeenCalled();
  });

  it("returns cancel:true when event.signal is already aborted at entry", async () => {
    seedStoreGraph();
    const ac = new AbortController();
    ac.abort();
    const calls = newCalls();
    setCompactionStageRuns(fakeRuns(calls));

    const result = await compactionHook(
      compactEvent({ signal: ac.signal }),
      makeFakeCtx([], NO_NOTIFY),
      makeFakePi(),
      NO_OP_WIDGET,
      TODO_ABSENT,
    );
    expect(result).toEqual({ cancel: true });
    expect(calls.observer).toBe(0);
  });

  it("cancels when event.signal aborts between stages (Builder/Selector skipped)", async () => {
    seedStoreGraph();
    setCompactionSettingsGetter(() => settings({ builderRootViewThreshold: 0 }));
    const eventAc = new AbortController();
    const calls = newCalls();
    const passes = fakeRuns(calls);
    // The Observer stage aborts Pi's compaction signal mid-gate (simulating Pi
    // giving up the compaction); the hook links event.signal into its own
    // controller, so the next between-stage check cancels.
    passes.runObserver = vi.fn(async (args) => {
      calls.observer += 1;
      calls.observerUnobservedLen.push(args.unobserved.length);
      calls.order.push("observer");
      eventAc.abort();
    });
    setCompactionStageRuns(passes);

    const result = await compactionHook(
      compactEvent({ signal: eventAc.signal }),
      makeFakeCtx(
        [
          {
            type: "message",
            id: "u1",
            parentId: null,
            timestamp: "x",
            message: { role: "user", content: "f", timestamp: 0 },
          },
          assistantMsg("a1", "r"),
        ],
        NO_NOTIFY,
      ),
      makeFakePi(),
      NO_OP_WIDGET,
      TODO_ABSENT,
    );
    expect(result).toEqual({ cancel: true });
    // Observer ran; Builder + Selector skipped (signal aborted after Observer).
    expect(calls.observer).toBe(1);
    expect(calls.builder).toBe(0);
    expect(calls.selector).toBe(0);
  });

  it("acquireForCompaction awaits an in-flight background run's release before proceeding", async () => {
    _resetRunLock();
    seedStoreGraph();
    setCompactionSettingsGetter(() => settings({ builderRootViewThreshold: 0 }));
    // A background run holds the run-lock.
    const bgHandle = acquireOrSkip("observe");
    expect(bgHandle).not.toBeNull();

    const calls = newCalls();
    setCompactionStageRuns(fakeRuns(calls));

    // Start the compaction hook (it blocks on acquireForCompaction awaiting the
    // background run's release).
    const hookPromise = compactionHook(
      compactEvent({}),
      makeFakeCtx([], NO_NOTIFY),
      makeFakePi(),
      NO_OP_WIDGET,
      TODO_ABSENT,
    );
    // Yield once: the hook should still be awaiting (Builder not yet called).
    await Promise.resolve();
    expect(calls.observer).toBe(0);

    // Release the background run — the hook unblocks and proceeds.
    bgHandle?.release();
    await hookPromise;
    expect(calls.observer).toBe(0); // empty branch → no gap → Observer catch-up no-op
    expect(calls.builder).toBe(1); // unblocked → Builder ran
    _resetRunLock();
  });

  it("snapshots the usage ledger into lastCompactionLedger at compaction (deep copy)", async () => {
    seedStoreGraph();
    // pre-populate the cumulative ledger with some observe usage (one run).
    const { addPhaseUsage, bumpRun } = await import("../../src/status/usage-ledger.js");
    addPhaseUsage(getGraphStore().usageLedger, "observe", {
      input: 5000,
      output: 1000,
      cacheRead: 800,
      cacheWrite: 0,
      cost: 0.2,
      turns: 4,
      elapsedMs: 0,
    });
    bumpRun(getGraphStore().usageLedger, "observe");
    expect(getGraphStore().lastCompactionLedger).toBeNull(); // none yet

    setCompactionStageRuns(fakeRuns(newCalls()));
    await compactionHook(compactEvent({}), makeFakeCtx([], NO_NOTIFY), makeFakePi(), NO_OP_WIDGET, TODO_ABSENT);

    const snapshot = getGraphStore().lastCompactionLedger;
    expect(snapshot).not.toBeNull();
    expect(snapshot?.observe.input).toBe(5000);
    expect(snapshot?.observe.runs).toBe(1);
    // deep copy: later stage activity must not mutate the captured baseline.
    addPhaseUsage(getGraphStore().usageLedger, "observe", {
      input: 1000,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      cost: 0,
      turns: 1,
      elapsedMs: 0,
    });
    expect(getGraphStore().lastCompactionLedger?.observe.input).toBe(5000);
    expect(getGraphStore().lastCompactionLedger?.observe.runs).toBe(1);
  });

  it("returns compaction.usage (pi shape) aggregating THIS compaction's stage cost + per-stage breakdown in details", async () => {
    seedStoreGraph();
    // a branch with a user anchor + assistant msg so the Observer catch-up gap is non-empty
    // (otherwise Observer is skipped and its stage fake never folds usage).
    const branch = [
      {
        type: "message",
        id: "u1",
        parentId: null,
        timestamp: "t",
        message: { role: "user", content: "first", timestamp: 0 },
      },
      assistantMsg("a1", "response"),
    ];
    const { addPhaseUsage, bumpRun } = await import("../../src/status/usage-ledger.js");
    // fake stages fold usage into the store ledger (as the real Observer/Builder/Selector do).
    setCompactionStageRuns({
      runObserver: vi.fn(async () => {
        addPhaseUsage(getGraphStore().usageLedger, "observe", {
          input: 1000,
          output: 500,
          cacheRead: 300,
          cacheWrite: 40,
          cost: 0.05,
          turns: 3,
          elapsedMs: 0,
        });
        bumpRun(getGraphStore().usageLedger, "observe");
      }),
      runBuilder: vi.fn(async () => {
        addPhaseUsage(getGraphStore().usageLedger, "build", {
          input: 2000,
          output: 1000,
          cacheRead: 600,
          cacheWrite: 80,
          cost: 0.1,
          turns: 5,
          elapsedMs: 0,
        });
        bumpRun(getGraphStore().usageLedger, "build");
      }),
      runSelector: vi.fn(async () => {
        addPhaseUsage(getGraphStore().usageLedger, "select", {
          input: 500,
          output: 200,
          cacheRead: 100,
          cacheWrite: 20,
          cost: 0.02,
          turns: 1,
          elapsedMs: 0,
        });
        bumpRun(getGraphStore().usageLedger, "select");
      }),
    });

    const result = (await compactionHook(
      compactEvent({}),
      makeFakeCtx(branch, NO_NOTIFY),
      makeFakePi(),
      NO_OP_WIDGET,
      TODO_ABSENT,
    )) as unknown as {
      compaction: {
        usage: Usage;
        details: { compactionStages: { observe: Usage; build: Usage; select: Usage } };
      };
    };

    const usage = result.compaction.usage;
    expect(usage).toBeDefined();
    // aggregate of observe+build+select
    expect(usage.input).toBe(3500);
    expect(usage.output).toBe(1700);
    expect(usage.cacheRead).toBe(1000);
    expect(usage.cacheWrite).toBe(140);
    expect(usage.totalTokens).toBe(6340);
    // cost is an object with a finite total (NEVER undefined — addUsageToTotals has no guards)
    expect(typeof usage.cost).toBe("object");
    expect(usage.cost.total).toBeCloseTo(0.17, 10);
    // per-stage breakdown in details
    const stages = result.compaction.details.compactionStages;
    expect(stages).toBeDefined();
    expect(stages.observe.input).toBe(1000);
    expect(stages.build.input).toBe(2000);
    expect(stages.select.input).toBe(500);
  });

  it("compaction.usage emits zeros (never undefined) when no stage produced usage", async () => {
    seedStoreGraph();
    setCompactionStageRuns(fakeRuns(newCalls()));
    const result = (await compactionHook(
      compactEvent({}),
      makeFakeCtx([], NO_NOTIFY),
      makeFakePi(),
      NO_OP_WIDGET,
      TODO_ABSENT,
    )) as unknown as { compaction: { usage: Usage } };
    const usage = result.compaction.usage;
    expect(usage).toBeDefined();
    expect(usage.input).toBe(0);
    expect(usage.cacheWrite).toBe(0);
    expect(usage.cost.total).toBe(0);
    expect(Number.isFinite(usage.totalTokens)).toBe(true);
  });
});
