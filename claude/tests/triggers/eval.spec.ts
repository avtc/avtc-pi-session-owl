// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import type { SessionEntry } from "@earendil-works/pi-coding-agent";
// The boundary evaluator: the ported trigger matrix at the Claude
// boundaries — turn.step (the cheap mid-turn matrix, gated by the
// tripwire check), turn.complete (the wrap-up chain: observe → build →
// select under ONE keyed run-lock acquire, Builder/Selector re-evaluated
// after the Observer so its fresh `new` nodes are visible), session.measure
// (the context snapshot feeding the on-session-context-threshold arms).
// The vendored evaluation functions are reused verbatim; the run-lock is
// the keyed host port (a colliding trigger on the same conversation SKIPS
// — the mapping arms the settle-rearm, the gap re-enters on release).
import { beforeEach, describe, expect, test } from "vitest";
import { DEFAULT_CONFIG, type SessionOwlConfig } from "../../core/src/config/schema.js";
import { clearDetailsCache } from "../../core/src/format/details.js";
import { getGraphStore, resetForNewSession } from "../../core/src/store/graph-store.js";
import { makeNode, nowStoredTimestamp } from "../../core/src/types.js";
import { _resetCoreInstances } from "../../host/core-instances.js";
import { installRunsLogSink, resetRunsLogSink } from "../../host/runs/seams.js";
import { noteOwnSummary, ownSummariesFor } from "../../host/storage/summary-identity.js";
import { _resetMeasureSnapshots, recordMeasure } from "../../host/triggers/context.js";
import {
  evaluateAndLaunch,
  onStepBoundary,
  onTurnCompleteBoundary,
  type TriggerHostDeps,
} from "../../host/triggers/eval.js";
import { _resetRunLocks, abortInFlight, acquireOrSkip, current, inFlight } from "../../host/triggers/run-locks.js";

const PAD = "x".repeat(600); // ≥ threshold headroom at chars/4 after block rendering
const tick = (): Promise<void> => new Promise<void>((r) => setImmediate(r));

function entries(n: number): SessionEntry[] {
  return Array.from(
    { length: n },
    (_, i) =>
      ({
        id: `e${i + 1}`,
        timestamp: `e${i + 1}-ts`,
        type: "message",
        message: { role: i % 2 === 0 ? "user" : "assistant", content: `entry ${i + 1} ${PAD}` },
      }) as unknown as SessionEntry,
  );
}

interface LaunchLog {
  stage: string;
  unobserved: SessionEntry[] | null;
}

function makeDeps(
  over: Partial<TriggerHostDeps> & { rows?: SessionEntry[] } = {},
): TriggerHostDeps & { launches: LaunchLog[] } {
  const launches: LaunchLog[] = [];
  const rows = over.rows ?? entries(4);
  return {
    key: "sess-t",
    settings: { ...DEFAULT_CONFIG, observerThresholdTokens: 60 } as SessionOwlConfig,
    getLeafId: () => (rows.length === 0 ? null : (rows[rows.length - 1]?.id ?? null)),
    getBranch: () => rows,
    thinkingLevel: null,
    isEnabled: () => true,
    cheapGateClean: () => true,
    getObserverFrontier: () => getGraphStore().observerFrontier,
    getOwnSummaries: () => ownSummariesFor(getGraphStore()),
    pinCore: async () => {},
    runs: {
      runObserver: async (args) => {
        launches.push({ stage: "observer", unobserved: args.unobserved });
      },
      runBuilder: async () => {
        launches.push({ stage: "builder", unobserved: null });
      },
      runSelector: async () => {
        launches.push({ stage: "selector", unobserved: null });
      },
    },
    launches,
    ...over,
  };
}

beforeEach(() => {
  // shared module registry: the hooks module's load installs the file-logger
  // sink; these tests spy console.error, so pin the default sink here
  resetRunsLogSink();
  _resetRunLocks();
  _resetMeasureSnapshots();
  _resetCoreInstances();
  resetForNewSession();
  clearDetailsCache();
  getGraphStore().observerFrontier = null;
});

describe("onStepBoundary — the mid-turn cheap matrix (primary point)", () => {
  test("a firing matrix launches the chain fire-and-forget (observer gets its unobserved slice)", async () => {
    const deps = makeDeps();
    onStepBoundary(deps, {});
    await tick();
    await tick();
    expect(deps.launches.map((l) => l.stage)).toEqual(["observer"]);
    expect(deps.launches[0]?.unobserved?.length).toBeGreaterThanOrEqual(2);
    expect(inFlight("sess-t")).toBe(false); // released in the chain's finally
  });

  test("a dirty tripwire gate defers the mid-turn launch to the boundary (no launch)", async () => {
    const deps = makeDeps({ cheapGateClean: () => false });
    onStepBoundary(deps, {});
    await tick();
    await tick();
    expect(deps.launches).toEqual([]); // deferred — the turn.complete boundary re-evaluates
  });

  test("below-threshold pending rows launch nothing (the cheap matrix is the vendored decision)", async () => {
    const deps = makeDeps({ rows: entries(0) });
    onStepBoundary(deps, {});
    await tick();
    await tick();
    expect(deps.launches).toEqual([]);
  });
});

describe("onTurnCompleteBoundary — the wrap-up chain (pi's onTurnEnd semantics)", () => {
  test("observe → build under ONE acquire: the Builder re-evaluates AFTER the Observer's fresh `new` nodes", async () => {
    const launches: LaunchLog[] = [];
    const settings = {
      ...DEFAULT_CONFIG,
      observerThresholdTokens: 60,
      builderMode: "each-N-observations",
      builderEveryNObservations: 2,
    } as SessionOwlConfig;
    const deps = makeDeps({
      settings,
      runs: {
        runObserver: async (args) => {
          launches.push({ stage: "observer", unobserved: args.unobserved });
          // the Observer's effect: fresh `new` wrapper roots (2 ≥ threshold)
          const g = getGraphStore().graph;
          for (let i = 0; i < 2; i += 1) {
            const id = `n${i + 100}` as never;
            g.nodes.set(
              id,
              makeNode({
                id,
                summary: `fresh ${i}`,
                importance: "med",
                parentNode: null,
                state: "new",
                createdAt: nowStoredTimestamp(),
              }),
            );
          }
        },
        runBuilder: async () => {
          launches.push({ stage: "builder", unobserved: null });
        },
        runSelector: async () => {
          launches.push({ stage: "selector", unobserved: null });
        },
      },
    });
    onTurnCompleteBoundary(deps, {});
    await tick();
    await tick();
    await tick();
    expect(launches.map((l) => l.stage)).toEqual(["observer", "builder"]);
    expect(inFlight("sess-t")).toBe(false); // released in the finally
  });

  test("a colliding run on the SAME conversation skips (the settle-rearm arms); another conversation is unaffected", async () => {
    const deps = makeDeps();
    const holder = acquireOrSkip("sess-t", "observe");
    expect(holder).not.toBeNull();
    onTurnCompleteBoundary(deps, {});
    await tick();
    await tick();
    expect(deps.launches).toEqual([]); // SKIP — in flight
    const other = makeDeps({ key: "sess-other" });
    onTurnCompleteBoundary(other, {});
    await tick();
    await tick();
    expect(other.launches.map((l) => l.stage)).toEqual(["observer"]); // independent lock
    holder?.release();
  });

  test("disabled ⇒ nothing evaluates", async () => {
    const deps = makeDeps({ isEnabled: () => false });
    onTurnCompleteBoundary(deps, {});
    await tick();
    expect(deps.launches).toEqual([]);
  });

  test("an abort of the in-flight chain after the Observer stops the Builder/Selector", async () => {
    const launches: LaunchLog[] = [];
    const settings = {
      ...DEFAULT_CONFIG,
      observerThresholdTokens: 60,
      builderMode: "each-N-observations",
      builderEveryNObservations: 1,
    } as SessionOwlConfig;
    const deps = makeDeps({
      settings,
      runs: {
        runObserver: async (args) => {
          launches.push({ stage: "observer", unobserved: args.unobserved });
          const g = getGraphStore().graph;
          g.nodes.set(
            "n100" as never,
            makeNode({
              id: "n100" as never,
              summary: "fresh",
              importance: "med",
              parentNode: null,
              state: "new",
              createdAt: nowStoredTimestamp(),
            }),
          );
          await tick();
          await tick(); // the abort lands while the Observer still holds the chain
        },
        runBuilder: async () => {
          launches.push({ stage: "builder", unobserved: null });
        },
        runSelector: async () => {
          launches.push({ stage: "selector", unobserved: null });
        },
      },
    });
    onTurnCompleteBoundary(deps, {});
    await tick();
    abortInFlight("sess-t"); // a compaction-class abort of the background run
    await tick();
    await tick();
    expect(launches.map((l) => l.stage)).toEqual(["observer"]); // builder skipped
    expect(inFlight("sess-t")).toBe(false);
  });

  test("a disable between phases stops the remaining stages (the live master switch)", async () => {
    const launches: LaunchLog[] = [];
    const settings = {
      ...DEFAULT_CONFIG,
      observerThresholdTokens: 60,
      builderMode: "each-N-observations",
      builderEveryNObservations: 1,
    } as SessionOwlConfig;
    let enabled = true;
    const deps = makeDeps({
      settings,
      isEnabled: () => enabled,
      runs: {
        runObserver: async (args) => {
          launches.push({ stage: "observer", unobserved: args.unobserved });
          const g = getGraphStore().graph;
          g.nodes.set(
            "n100" as never,
            makeNode({
              id: "n100" as never,
              summary: "fresh",
              importance: "med",
              parentNode: null,
              state: "new",
              createdAt: nowStoredTimestamp(),
            }),
          );
          enabled = false; // disabled mid-run (between phases)
        },
        runBuilder: async () => {
          launches.push({ stage: "builder", unobserved: null });
        },
        runSelector: async () => {
          launches.push({ stage: "selector", unobserved: null });
        },
      },
    });
    onTurnCompleteBoundary(deps, {});
    await tick();
    await tick();
    await tick();
    expect(launches.map((l) => l.stage)).toEqual(["observer"]); // builder skipped
    expect(inFlight("sess-t")).toBe(false);
  });
});

describe("the observation floor at the boundary — the walk stops at the newest own summary on the chain", () => {
  function compactionRow(id: string, summary: string): SessionEntry {
    return {
      id,
      timestamp: `${id}-ts`,
      type: "compaction",
      summary,
      firstKeptEntryId: "",
      tokensBefore: 0,
    } as unknown as SessionEntry;
  }

  test("an on-file own summary bounds the trigger scope with a wiped store", async () => {
    resetForNewSession();
    const rows = [
      ...entries(2),
      compactionRow("own-1", "# Memory\nthe answered render"),
      {
        id: "p1",
        timestamp: "p1-ts",
        type: "message",
        message: { role: "user", content: `post one ${PAD}` },
      } as unknown as SessionEntry,
      {
        id: "p2",
        timestamp: "p2-ts",
        type: "message",
        message: { role: "assistant", content: `post two ${PAD}` },
      } as unknown as SessionEntry,
      {
        id: "p3",
        timestamp: "p3-ts",
        type: "message",
        message: { role: "user", content: `post three ${PAD}` },
      } as unknown as SessionEntry,
    ];
    const deps = makeDeps({ rows });
    await evaluateAndLaunch(deps, false);
    const launch = deps.launches[0];
    expect(launch).toBeDefined();
    // strictly after the own summary row: the pre-summary entries never
    // re-enter the boundary catch-up even with no recorded texts
    expect(launch?.unobserved?.map((e) => e.id)).toEqual(["p2", "p3"]);
  });

  test("the rescan relaunch keeps the whole live path (the maintenance promise)", async () => {
    resetForNewSession();
    const rows = [
      ...entries(2),
      compactionRow("own-1", "# Memory\nthe answered render"),
      {
        id: "p1",
        timestamp: "p1-ts",
        type: "message",
        message: { role: "user", content: `post one ${PAD}` },
      } as unknown as SessionEntry,
      {
        id: "p2",
        timestamp: "p2-ts",
        type: "message",
        message: { role: "assistant", content: `post two ${PAD}` },
      } as unknown as SessionEntry,
      {
        id: "p3",
        timestamp: "p3-ts",
        type: "message",
        message: { role: "user", content: `post three ${PAD}` },
      } as unknown as SessionEntry,
    ];
    const deps = makeDeps({ rows });
    await evaluateAndLaunch(deps, true);
    const launch = deps.launches[0];
    expect(launch).toBeDefined();
    expect(launch?.unobserved?.map((e) => e.id)).toEqual(["e2", "p1", "p2", "p3"]);
  });
});

describe("measure snapshots — the context fill for the context-threshold arms", () => {
  test("feeds the on-session-context-threshold arm at the next boundary", async () => {
    recordMeasure("sess-t", { tokens: 50_000, window: 200_000 });
    const deps = makeDeps({
      settings: {
        ...DEFAULT_CONFIG,
        observerMode: "on-compaction",
        builderMode: "on-session-context-threshold",
        builderSessionContextThresholdTokens: 40_000,
      } as SessionOwlConfig,
    });
    await evaluateAndLaunch(deps, false);
    expect(deps.launches.map((l) => l.stage)).toEqual(["builder"]);
  });

  test("an unknown fill (loop key) skips the context arm", async () => {
    recordMeasure("sess-t", { tokens: 50_000, window: 200_000 });
    const deps = makeDeps({
      key: "sess-t|ag-5",
      settings: {
        ...DEFAULT_CONFIG,
        observerMode: "on-compaction",
        builderMode: "on-session-context-threshold",
        builderSessionContextThresholdTokens: 40_000,
      } as SessionOwlConfig,
    });
    await evaluateAndLaunch(deps, false);
    expect(deps.launches).toEqual([]);
  });
});

describe("core pinning — every decision call follows an awaited pinCore (no intervening awaits)", () => {
  test("a full three-stage chain pins before the pre-evaluation and between phases", async () => {
    const order: string[] = [];
    const deps = makeDeps({
      settings: {
        ...DEFAULT_CONFIG,
        observerThresholdTokens: 60,
        builderMode: "on-session-context-threshold",
        builderSessionContextThresholdTokens: 40_000,
        renderMode: "selected-root",
        selectorMode: "on-session-context-threshold",
        selectorSessionContextThresholdTokens: 40_000,
      } as SessionOwlConfig,
    });
    recordMeasure("sess-t", { tokens: 50_000, window: 200_000 });
    deps.pinCore = async () => {
      order.push("pin");
    };
    deps.getBranch = () => {
      order.push("read");
      return entries(4);
    };
    deps.runs.runObserver = async () => {
      order.push("observer");
    };
    deps.runs.runBuilder = async () => {
      order.push("builder");
    };
    deps.runs.runSelector = async () => {
      order.push("selector");
    };
    await evaluateAndLaunch(deps, false);
    // the pin PRECEDES the row read (pre-evaluation pinned), then a re-pin
    // follows each completed stage, before the next decision cluster
    expect(order).toEqual(["pin", "read", "observer", "pin", "builder", "pin", "selector"]);
  });
});

describe("error containment — a thrown stage releases and never rejects the boundary", () => {
  test("a throwing cheap-gate predicate defers to the boundary (contained, no launch)", async () => {
    const deps = makeDeps();
    deps.cheapGateClean = () => {
      throw new Error("tripwire read failed");
    };
    const original = console.error;
    const logs: unknown[][] = [];
    console.error = (...a: unknown[]) => logs.push(a);
    try {
      onStepBoundary(deps, {});
      await new Promise<void>((r) => setImmediate(r));
    } finally {
      console.error = original;
    }
    expect(deps.launches).toEqual([]); // fail-closed defer — nothing evaluated
    expect(logs.length).toBeGreaterThan(0); // logged, not thrown
  });
  test("a throwing runObserver: the chain resolves, the error is logged, the lock releases", async () => {
    const logs: unknown[][] = [];
    const deps = makeDeps();
    deps.runs.runObserver = async () => {
      throw new Error("observer exploded");
    };
    const original = console.error;
    console.error = (...a: unknown[]) => logs.push(a);
    try {
      await evaluateAndLaunch(deps, false); // must NOT reject
    } finally {
      console.error = original;
    }
    expect(deps.launches).toEqual([]);
    expect(inFlight("sess-t")).toBe(false);
    expect(logs.length).toBeGreaterThan(0);
  });

  test("a prefix throw (storage read) is contained at the boundary entry points", async () => {
    const deps = makeDeps();
    deps.getBranch = () => {
      throw new Error("row cache read failed");
    };
    const original = console.error;
    const logs: unknown[][] = [];
    console.error = (...a: unknown[]) => logs.push(a);
    try {
      onTurnCompleteBoundary(deps, {});
      await new Promise<void>((r) => setImmediate(r));
    } finally {
      console.error = original;
    }
    expect(logs.length).toBeGreaterThan(0); // logged, not an unhandled rejection
    expect(inFlight("sess-t")).toBe(false); // nothing was acquired
  });

  test("a no-launch decision (skip arm) never acquires the lock", async () => {
    const deps = makeDeps({ rows: [] }); // empty unobserved ⇒ no stage fires
    const h = acquireOrSkip("sess-t", "observe");
    expect(h).not.toBeNull();
    // the skip arm must not touch the lock ANOTHER holder owns
    await evaluateAndLaunch(deps, false);
    expect(inFlight("sess-t")).toBe(true); // still the test's own hold
    expect(current("sess-t")).toBe("observe");
    h?.release();
  });
});

describe("subagentMode — the subagent stage gate", () => {
  const disabled: SessionOwlConfig = {
    ...DEFAULT_CONFIG,
    observerThresholdTokens: 60,
    subagentMode: "disabled",
  } as SessionOwlConfig;

  test("an agent-keyed conversation launches nothing when disabled (no observation, no build)", async () => {
    const lines: string[] = [];
    installRunsLogSink((m) => lines.push(m));
    const deps = makeDeps({ key: "sess-t|agent-abc", settings: disabled });
    await evaluateAndLaunch(deps, false);
    expect(deps.launches).toHaveLength(0);
    expect(lines.join("\n")).toContain("session-owl disabled for subagents");
    resetRunsLogSink();
  });

  test("the MAIN conversation still launches under the same settings", async () => {
    const deps = makeDeps({ settings: disabled }); // key stays sess-t (main)
    await evaluateAndLaunch(deps, false);
    expect(deps.launches.map((l) => l.stage)).toContain("observer");
  });

  test("agent-keyed with on-compaction (the default) passes this gate — the observer deferral is the binding's effective-settings override, never a skip here", async () => {
    const deps = makeDeps({ key: "sess-t|agent-abc" }); // DEFAULT_CONFIG.subagentMode="on-compaction", observerMode stays "on-threshold"
    await evaluateAndLaunch(deps, false);
    expect(deps.launches.map((l) => l.stage)).toContain("observer");
  });

  test("agent-keyed with inherited launches", async () => {
    const deps = makeDeps({
      key: "sess-t|agent-abc",
      settings: { ...DEFAULT_CONFIG, observerThresholdTokens: 60, subagentMode: "inherited" } as SessionOwlConfig,
    });
    await evaluateAndLaunch(deps, false);
    expect(deps.launches.map((l) => l.stage)).toContain("observer");
  });
});

describe("onTurnCompleteBoundary — the observation floor (own summaries bound the scope)", () => {
  test("the trigger's unobserved slice starts strictly after the newest own-summary row", async () => {
    const summaryText = "# Memory\nthe boundary render";
    noteOwnSummary(getGraphStore(), summaryText);
    const summaryRow = {
      id: "e0",
      timestamp: "e0-ts",
      type: "message",
      message: { role: "user", content: summaryText },
    } as unknown as SessionEntry;
    const rows = [summaryRow, ...entries(4)];
    const deps = makeDeps({ rows });
    onTurnCompleteBoundary(deps, {});
    const p = Promise.resolve();
    await tick();
    await tick();
    await p;
    const launch = deps.launches.find((l) => l.stage === "observer");
    expect(launch).toBeTruthy();
    const ids = (launch?.unobserved ?? []).map((e) => e.id);
    // the summary row never re-observes; the scoped block's first user
    // message is the initial-prompt anchor the frontier rule skips
    expect(ids).toEqual(["e2", "e3", "e4"]);
  });

  test("a summary-shaped user row with NO recorded text is no boundary (full scope)", async () => {
    const lookAlike = {
      id: "e0",
      timestamp: "e0-ts",
      type: "message",
      message: { role: "user", content: "# Memory\na look-alike" },
    } as unknown as SessionEntry;
    const rows = [lookAlike, ...entries(4)];
    const deps = makeDeps({ rows });
    onTurnCompleteBoundary(deps, {});
    const p = Promise.resolve();
    await tick();
    await tick();
    await p;
    const launch = deps.launches.find((l) => l.stage === "observer");
    const ids = (launch?.unobserved ?? []).map((e) => e.id);
    expect(ids).toEqual(["e1", "e2", "e3", "e4"]); // e0 = the first user message (the anchor skip)
  });
});
