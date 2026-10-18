// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import type { SessionEntry } from "@earendil-works/pi-coding-agent";
// The arm matrix table — every mode × gate combination, driven through
// the boundary evaluator with synthetic
// pending rows/settings. The vendored decisions ARE pi's code; this table
// pins the HOST composition: the boundary launches exactly the firing
// stages, and every skip arm holds.
import { beforeEach, describe, expect, test } from "vitest";
import { DEFAULT_CONFIG, type SessionOwlConfig } from "../../core/src/config/schema.js";
import { clearDetailsCache } from "../../core/src/format/details.js";
import { getGraphStore, resetForNewSession } from "../../core/src/store/graph-store.js";
import { makeNode, nowStoredTimestamp } from "../../core/src/types.js";
import { _resetCoreInstances } from "../../host/core-instances.js";
import { _resetMeasureSnapshots, recordMeasure } from "../../host/triggers/context.js";
import { evaluateAndLaunch, type TriggerHostDeps } from "../../host/triggers/eval.js";
import { _resetRunLocks } from "../../host/triggers/run-locks.js";

const PAD = "x".repeat(600);
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

/** Seed a non-obsolete ROOT node; `summary` sized to order its rendered
 *  line's token estimate (chars/4). */
function seedRoot(id: string, summary: string, state: "active" | "new" = "active"): void {
  const g = getGraphStore().graph;
  g.nodes.set(
    id as never,
    makeNode({ id: id as never, summary, importance: "med", parentNode: null, state, createdAt: nowStoredTimestamp() }),
  );
}

async function launch(settings: SessionOwlConfig, rows: SessionEntry[] = entries(4)): Promise<string[]> {
  const stages: string[] = [];
  const deps: TriggerHostDeps = {
    key: "sess-matrix",
    settings,
    getLeafId: () => (rows.length === 0 ? null : (rows[rows.length - 1]?.id ?? null)),
    getBranch: () => rows,
    thinkingLevel: null,
    isEnabled: () => true,
    cheapGateClean: () => true,
    getObserverFrontier: () => getGraphStore().observerFrontier,
    pinCore: async () => {},
    runs: {
      runObserver: async () => {
        stages.push("observer");
      },
      runBuilder: async () => {
        stages.push("builder");
      },
      runSelector: async () => {
        stages.push("selector");
      },
    },
  };
  await evaluateAndLaunch(deps);
  await tick();
  return stages;
}

const OVER_THRESHOLD_ROWS = entries(4); // ≥ threshold at chars/4 after rendering
const EMPTY_ROWS: SessionEntry[] = [];

beforeEach(() => {
  _resetRunLocks();
  _resetMeasureSnapshots();
  _resetCoreInstances();
  resetForNewSession();
  clearDetailsCache();
  getGraphStore().observerFrontier = null;
});

describe("the arm matrix — Observer gates (on-threshold mode default)", () => {
  test("mode on-compaction ⇒ never at a turn boundary (the compaction catch-up owns observation)", async () => {
    const stages = await launch(
      { ...DEFAULT_CONFIG, observerMode: "on-compaction", observerThresholdTokens: 60 } as SessionOwlConfig,
      OVER_THRESHOLD_ROWS,
    );
    expect(stages).toEqual([]);
  });

  test("empty (no unobserved renderable entries) ⇒ no launch", async () => {
    const stages = await launch({ ...DEFAULT_CONFIG, observerThresholdTokens: 60 } as SessionOwlConfig, EMPTY_ROWS);
    expect(stages).toEqual([]);
  });

  test("unobserved tokens ≥ observerThresholdTokens ⇒ the Observer launches (no turn-count gate)", async () => {
    const stages = await launch(
      { ...DEFAULT_CONFIG, observerThresholdTokens: 60 } as SessionOwlConfig,
      OVER_THRESHOLD_ROWS,
    );
    expect(stages).toEqual(["observer"]);
  });
});

describe("the arm matrix — Builder modes", () => {
  const OBS_OWNED = { observerMode: "on-compaction" } as const; // isolate the Builder arm

  test("on-compaction ⇒ no launch regardless of new nodes", async () => {
    seedRoot("n1", "x".repeat(400), "new");
    seedRoot("n2", "x".repeat(400), "new");
    const stages = await launch(
      {
        ...DEFAULT_CONFIG,
        ...OBS_OWNED,
        builderMode: "on-compaction",
        builderEveryNObservations: 2,
      } as SessionOwlConfig,
      EMPTY_ROWS,
    );
    expect(stages).toEqual([]);
  });

  test("each-N-observations: count < N ⇒ no; ≥ N ⇒ fire", async () => {
    seedRoot("n1", "small", "new");
    const below = await launch(
      {
        ...DEFAULT_CONFIG,
        ...OBS_OWNED,
        builderMode: "each-N-observations",
        builderEveryNObservations: 2,
      } as SessionOwlConfig,
      EMPTY_ROWS,
    );
    expect(below).toEqual([]);
    seedRoot("n2", "small", "new");
    const at = await launch(
      {
        ...DEFAULT_CONFIG,
        ...OBS_OWNED,
        builderMode: "each-N-observations",
        builderEveryNObservations: 2,
      } as SessionOwlConfig,
      EMPTY_ROWS,
    );
    expect(at).toEqual(["builder"]);
  });

  test("each-N fast-path arm: builderSkipWithinBudget + root-view ≥ threshold fires even below N", async () => {
    seedRoot("n1", "x".repeat(400), "new"); // one new node (< N=2) but a fat root view
    const stages = await launch(
      {
        ...DEFAULT_CONFIG,
        ...OBS_OWNED,
        builderMode: "each-N-observations",
        builderEveryNObservations: 2,
        builderSkipWithinBudget: true,
        builderRootViewThreshold: 60,
      } as SessionOwlConfig,
      EMPTY_ROWS,
    );
    expect(stages).toEqual(["builder"]); // the trigger maintains the skip's invariant
  });

  test("on-root-view-threshold: below ⇒ no; ≥ ⇒ fire", async () => {
    seedRoot("n1", "small");
    const below = await launch(
      {
        ...DEFAULT_CONFIG,
        ...OBS_OWNED,
        builderMode: "on-root-view-threshold",
        builderRootViewThreshold: 60,
      } as SessionOwlConfig,
      EMPTY_ROWS,
    );
    expect(below).toEqual([]);
    seedRoot("n2", "x".repeat(400));
    const at = await launch(
      {
        ...DEFAULT_CONFIG,
        ...OBS_OWNED,
        builderMode: "on-root-view-threshold",
        builderRootViewThreshold: 60,
      } as SessionOwlConfig,
      EMPTY_ROWS,
    );
    expect(at).toEqual(["builder"]);
  });

  test("on-session-context-threshold: unknown (null) ⇒ skip; ≥ ⇒ fire", async () => {
    const settings = {
      ...DEFAULT_CONFIG,
      ...OBS_OWNED,
      builderMode: "on-session-context-threshold",
      builderSessionContextThresholdTokens: 40_000,
    } as SessionOwlConfig;
    const unknown = await launch(settings, EMPTY_ROWS); // no measure recorded
    expect(unknown).toEqual([]);
    recordMeasure("sess-matrix", { tokens: 50_000, window: 200_000 });
    const at = await launch(settings, EMPTY_ROWS);
    expect(at).toEqual(["builder"]);
  });
});

describe("the arm matrix — Selector (renderMode gates everything)", () => {
  const OBS_OWNED = { observerMode: "on-compaction" } as const;

  test("renderMode observations-root ⇒ the Selector is inactive even ≥ threshold", async () => {
    recordMeasure("sess-matrix", { tokens: 50_000, window: 200_000 });
    const stages = await launch(
      {
        ...DEFAULT_CONFIG,
        ...OBS_OWNED,
        renderMode: "observations-root",
        selectorMode: "on-session-context-threshold",
        selectorSessionContextThresholdTokens: 40_000,
      } as SessionOwlConfig,
      EMPTY_ROWS,
    );
    expect(stages).toEqual([]);
  });

  test("selected-root + on-compaction ⇒ no launch; selected-root + on-session-context-threshold ≥ ⇒ fire", async () => {
    recordMeasure("sess-matrix", { tokens: 50_000, window: 200_000 });
    const compaction = await launch(
      {
        ...DEFAULT_CONFIG,
        ...OBS_OWNED,
        renderMode: "selected-root",
        selectorMode: "on-compaction",
      } as SessionOwlConfig,
      EMPTY_ROWS,
    );
    expect(compaction).toEqual([]);
    const at = await launch(
      {
        ...DEFAULT_CONFIG,
        ...OBS_OWNED,
        renderMode: "selected-root",
        selectorMode: "on-session-context-threshold",
        selectorSessionContextThresholdTokens: 40_000,
      } as SessionOwlConfig,
      EMPTY_ROWS,
    );
    expect(at).toEqual(["selector"]);
  });
});
