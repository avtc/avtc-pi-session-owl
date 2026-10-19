// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import type { SessionEntry } from "@earendil-works/pi-coding-agent";
// The mid-run Builder on the trigger path — pi's makeObserverRun wrap: the
// chained Observer run RECEIVES a maybeBuild (makeMaybeBuilder, turn_end
// scope) and awaits it after each chunk, so an each-N/threshold Builder
// folds INSIDE the observation collection loop instead of waiting for the
// chain's post-Observer re-evaluation (which a long/starved Observer holds
// off indefinitely).
import { beforeEach, describe, expect, test } from "vitest";
import { DEFAULT_CONFIG, type SessionOwlConfig } from "../../core/src/config/schema.js";
import { getGraphStore, resetForNewSession } from "../../core/src/store/graph-store.js";
import { _resetCoreInstances } from "../../host/core-instances.js";
import { ownSummariesFor } from "../../host/storage/summary-identity.js";
import { _resetMeasureSnapshots } from "../../host/triggers/context.js";
import { evaluateAndLaunch, type TriggerHostDeps } from "../../host/triggers/eval.js";
import { _resetRunLocks } from "../../host/triggers/run-locks.js";

const PAD = "x".repeat(600);
const tick = (): Promise<void> => new Promise<void>((r) => setImmediate(r));

function entries(n: number): SessionEntry[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `e${i + 1}`,
    timestamp: `e${i + 1}-ts`,
    type: "message",
    message: { role: i % 2 === 0 ? "user" : "assistant", content: `entry ${i + 1} ${PAD}` },
  })) as unknown as SessionEntry[];
}

beforeEach(() => {
  _resetRunLocks();
  _resetMeasureSnapshots();
  _resetCoreInstances();
  resetForNewSession();
  getGraphStore().observerFrontier = null;
});

describe("the chained Observer's mid-run Builder", () => {
  test("runObserver receives maybeBuild; calling it inside the loop runs the Builder", async () => {
    const events: Array<string | boolean> = [];
    const rows = entries(4);
    // each-N-observations with threshold 0 ⇒ the decision always fires, so a
    // single maybeBuild() call must end in runs.runBuilder
    const settings = {
      ...DEFAULT_CONFIG,
      observerThresholdTokens: 60,
      builderMode: "each-N-observations",
      builderEveryNObservations: 0,
    } as SessionOwlConfig;
    const deps: TriggerHostDeps = {
      key: "sess-midbuild",
      settings,
      getLeafId: () => rows[rows.length - 1]?.id ?? null,
      getBranch: () => rows,
      thinkingLevel: null,
      isEnabled: () => true,
      cheapGateClean: () => true,
      getObserverFrontier: () => getGraphStore().observerFrontier,
      getOwnSummaries: () => ownSummariesFor(getGraphStore()),
      pinCore: async () => {},
      runs: {
        runObserver: async (args) => {
          events.push("observer-enter");
          if (args.maybeBuild === undefined) {
            events.push("no-maybeBuild");
            return;
          }
          // the mid-loop await the real Observer performs after each chunk
          const built = await args.maybeBuild();
          events.push(built ? "mid-build-ran" : "mid-build-skipped");
          events.push("observer-exit");
        },
        runBuilder: async () => {
          events.push("builder-run");
        },
        runSelector: async () => {},
      },
    };
    await evaluateAndLaunch(deps, false);
    await tick();
    expect(events).toContain("mid-build-ran");
    expect(events.indexOf("builder-run")).toBeGreaterThan(events.indexOf("observer-enter"));
    expect(events.indexOf("builder-run")).toBeLessThan(events.indexOf("observer-exit"));
  });

  test("a mid-run Builder re-eval keeps it skipped under threshold (no fire, no run)", async () => {
    const events: Array<string | boolean> = [];
    const rows = entries(4);
    const settings = {
      ...DEFAULT_CONFIG,
      observerThresholdTokens: 60,
      builderMode: "each-N-observations",
      builderEveryNObservations: 99,
    } as SessionOwlConfig;
    const deps: TriggerHostDeps = {
      key: "sess-midbuild-skip",
      settings,
      getLeafId: () => rows[rows.length - 1]?.id ?? null,
      getBranch: () => rows,
      thinkingLevel: null,
      isEnabled: () => true,
      cheapGateClean: () => true,
      getObserverFrontier: () => getGraphStore().observerFrontier,
      getOwnSummaries: () => ownSummariesFor(getGraphStore()),
      pinCore: async () => {},
      runs: {
        runObserver: async (args) => {
          if (args.maybeBuild !== undefined) events.push(await args.maybeBuild());
        },
        runBuilder: async () => {
          events.push("builder-run");
        },
        runSelector: async () => {},
      },
    };
    await evaluateAndLaunch(deps, false);
    await tick();
    expect(events).not.toContain("builder-run");
    expect(events).toContain(false); // maybeBuild answered false — no fire
  });
});
