// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import type { SessionEntry } from "@earendil-works/pi-coding-agent";
// The boundary evaluator's decision visibility: every boundary evaluation
// leaves ONE file-log line carrying each arm's decision + reason, so a
// stage that never fires (or a starved chain) is diagnosable from the
// production log — runsLog routes through the installed sink (the register
// installs the file logger; the default stays console.error).
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { DEFAULT_CONFIG, type SessionOwlConfig } from "../../core/src/config/schema.js";
import { getGraphStore, resetForNewSession } from "../../core/src/store/graph-store.js";
import { _resetCoreInstances } from "../../host/core-instances.js";
import { installRunsLogSink, resetRunsLogSink, runsLog } from "../../host/runs/seams.js";
import { _resetMeasureSnapshots } from "../../host/triggers/context.js";
import { evaluateAndLaunch, type TriggerHostDeps } from "../../host/triggers/eval.js";
import { _resetRunLocks } from "../../host/triggers/run-locks.js";

const tick = (): Promise<void> => new Promise<void>((r) => setImmediate(r));

function entries(n: number, pad: number): SessionEntry[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `e${i + 1}`,
    timestamp: `e${i + 1}-ts`,
    type: "message",
    message: { role: i % 2 === 0 ? "user" : "assistant", content: `entry ${i + 1} ${"x".repeat(pad)}` },
  })) as unknown as SessionEntry[];
}

function makeDeps(rows: SessionEntry[], threshold: number): TriggerHostDeps {
  return {
    key: "sess-log",
    settings: { ...DEFAULT_CONFIG, observerThresholdTokens: threshold } as SessionOwlConfig,
    getLeafId: () => (rows.length === 0 ? null : (rows[rows.length - 1]?.id ?? null)),
    getBranch: () => rows,
    thinkingLevel: null,
    isEnabled: () => true,
    cheapGateClean: () => true,
    getObserverFrontier: () => getGraphStore().observerFrontier,
    pinCore: async () => {},
    runs: {
      runObserver: async () => {},
      runBuilder: async () => {},
      runSelector: async () => {},
    },
  };
}

const sinkLines: string[] = [];
const pushSink = (message: string, cause?: unknown): void => {
  sinkLines.push(cause === undefined ? message : `${message}: ${String(cause)}`);
};

beforeEach(() => {
  _resetRunLocks();
  _resetMeasureSnapshots();
  _resetCoreInstances();
  resetForNewSession();
  getGraphStore().observerFrontier = null;
  sinkLines.length = 0;
  // per-test install …
  installRunsLogSink(pushSink);
});

afterEach(() => {
  // … and restore: suite files share the module registry (isolate:false), so
  // a leaked file-logger sink would silence other suites' console.error spies
  resetRunsLogSink();
});

describe("evaluateAndLaunch — the decision line", () => {
  test("a no-fire boundary logs every arm's reason (why nothing ran)", async () => {
    // one short entry: observer under threshold, no new nodes — nothing fires
    const rows = [entries(1, 10)] as unknown as SessionEntry[];
    const deps = makeDeps(rows, 60000);
    await evaluateAndLaunch(deps);
    await tick();
    const line = sinkLines.find((l) => l.startsWith("trigger ["));
    expect(line).toBeDefined();
    expect(line).toContain("observe");
    expect(line).toContain("build");
    expect(line).toContain("select");
    expect(line).toContain("reason=");
    expect(line).toContain(`[${deps.key}]`); // keyed for attribution
  });

  test("a completed chain logs its re-evaluated build/select phases", async () => {
    const rows = entries(4, 600);
    await evaluateAndLaunch(makeDeps(rows, 60)); // observer fires and the fake runs settle
    await tick();
    const chained = sinkLines.filter((l) => l.startsWith("trigger ["));
    expect(chained.some((l) => l.includes("chained build"))).toBe(true);
    expect(chained.some((l) => l.includes("chained select"))).toBe(true);
  });

  test("a firing boundary logs the fire reason too (chained phases included)", async () => {
    const rows = entries(4, 600);
    const deps = makeDeps(rows, 60); // well under threshold ⇒ observer fires
    await evaluateAndLaunch(deps);
    await tick();
    const line = sinkLines.find((l) => l.startsWith("trigger ["));
    expect(line).toBeDefined();
    expect(line).toContain("observe=fire");
    expect(line).toMatch(/build=(skip|fire)/);
  });
});

describe("the runsLog sink contract", () => {
  test("reset under the default console.error sink (no register swap leaked)", () => {
    resetRunsLogSink();
    const orig = console.error;
    const captured: unknown[][] = [];
    console.error = (...a: unknown[]) => captured.push(a);
    try {
      runsLog("default-sink-line");
    } finally {
      console.error = orig;
    }
    expect(captured.length).toBe(1);
    expect(String(captured[0][0])).toContain("default-sink-line");
    installRunsLogSink(pushSink); // leave a known sink for the next file
  });
});
