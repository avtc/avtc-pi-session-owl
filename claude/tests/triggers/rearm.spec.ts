// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import type { SessionEntry } from "@earendil-works/pi-coding-agent";
// The settle-rearm: a boundary evaluation that collides with an in-flight
// run is not DROPPED — the skip arms one coalesced re-entry, fired on
// the run's release through the same launch guards (the master switch and
// the bootstrap/pause state are re-read live at re-entry). An ABORTED
// run's release drops the pending rearm (the takeover flow that aborted it
// owns the next evaluation). Deliberate divergence from pi's
// skip-if-busy policy.
import { beforeEach, describe, expect, test, vi } from "vitest";
import { DEFAULT_CONFIG, type SessionOwlConfig } from "../../core/src/config/schema.js";
import { clearDetailsCache } from "../../core/src/format/details.js";
import { getGraphStore, resetForNewSession } from "../../core/src/store/graph-store.js";
import { _resetCoreInstances } from "../../host/core-instances.js";
import { resetRunsLogSink } from "../../host/runs/seams.js";
import { ownSummariesFor } from "../../host/storage/summary-identity.js";
import { _resetMeasureSnapshots } from "../../host/triggers/context.js";
import { evaluateAndLaunch, type TriggerHostDeps } from "../../host/triggers/eval.js";
import { _resetRunLocks, abortInFlight, acquireOrSkip, inFlight } from "../../host/triggers/run-locks.js";

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

interface LaunchLog {
  stage: string;
  unobserved: SessionEntry[] | null;
}

function makeDeps(over: Partial<TriggerHostDeps> & { rows?: SessionEntry[] } = {}): TriggerHostDeps & {
  launches: LaunchLog[];
} {
  const launches: LaunchLog[] = [];
  const rows = over.rows ?? entries(4);
  return {
    key: "sess-rearm",
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
  resetRunsLogSink(); // pin the default stderr sink before the spies below
  _resetRunLocks();
  _resetMeasureSnapshots();
  _resetCoreInstances();
  resetForNewSession();
  clearDetailsCache();
  getGraphStore().observerFrontier = null;
});

describe("settle-rearm — a skip no longer drops its evaluation", () => {
  test("collision arms one coalesced re-entry; the release re-enters exactly once", async () => {
    const deps = makeDeps();
    const held = acquireOrSkip(deps.key, "observe");
    expect(held).not.toBeNull();

    await evaluateAndLaunch(deps, false); // skip #1 → armed
    await evaluateAndLaunch(deps, false); // skip #2 → coalesced (still one)
    expect(deps.launches).toEqual([]); // nothing launched while the lock was held

    held?.release();
    await tick();

    expect(deps.launches.map((l) => l.stage)).toEqual(["observer"]); // reentered ONCE
    expect(inFlight(deps.key)).toBe(false);
  });

  test("the re-entry re-reads the launch guard — a declined guard never launches", async () => {
    const logSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const deps = makeDeps({ launchGuard: () => false });
    const held = acquireOrSkip(deps.key, "observe");
    await evaluateAndLaunch(deps, false);
    expect(deps.launches).toEqual([]);

    held?.release();
    await tick();

    expect(deps.launches).toEqual([]); // guard declined the deferred evaluation
    expect(logSpy.mock.calls.flat().join(" ")).toContain("settle-rearm held");
    logSpy.mockRestore();
  });

  test("an ABORTED run's release drops the pending rearm (the takeover owns the next evaluation)", async () => {
    const logSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const deps = makeDeps();
    const held = acquireOrSkip(deps.key, "observe");
    await evaluateAndLaunch(deps, false);
    expect(deps.launches).toEqual([]);

    abortInFlight(deps.key); // the takeover aborts the holder…
    held?.release(); // …the run unwinds and releases from its finally
    await tick();

    expect(deps.launches).toEqual([]); // no rearm after the abort
    expect(logSpy.mock.calls.flat().join(" ")).toContain("settle-rearm dropped");
    logSpy.mockRestore();
  });

  test("an idle conversation arms nothing (a plain run releases a clean slate)", async () => {
    const deps = makeDeps();
    await evaluateAndLaunch(deps, false); // no collision — the chain runs and releases
    expect(deps.launches.map((l) => l.stage)).toEqual(["observer"]);
    await tick();
    expect(deps.launches.map((l) => l.stage)).toEqual(["observer"]); // no SECOND re-entry
  });

  test("the dispatch survives a runtime WITHOUT a queueMicrotask global", async () => {
    // the engine's worker scope does not expose the identifier — a release
    // must still re-enter
    vi.stubGlobal("queueMicrotask", undefined);
    try {
      const deps = makeDeps();
      const held = acquireOrSkip(deps.key, "observe");
      await evaluateAndLaunch(deps, false); // skip → arms
      expect(deps.launches).toEqual([]);

      held?.release(); // RED today: throws "queueMicrotask is not defined"
      await tick();

      expect(deps.launches.map((l) => l.stage)).toEqual(["observer"]);
      expect(inFlight(deps.key)).toBe(false);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
