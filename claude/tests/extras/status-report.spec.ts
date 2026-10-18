// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

//  /owl:status — the pure report builders, fixture-parity pinned against
// pi's outputs (the builders are a host-side verbatim port of
// src/status/command.ts's pure half; every output text below is pi's).
import { describe, expect, test } from "vitest";
import { cloneLedger, EMPTY_LEDGER } from "../../core/src/store/codecs.js";
import type { Node, Observation } from "../../core/src/types.js";
import { makeNode } from "../../core/src/types.js";
import { _resetConflictStateForTest, buildPausedStatusReport, setConflictHits } from "../../host/conflicts/pause.js";
import { buildStatusReport, gatherStatusInput, type StatusInput, serveStatusReport } from "../../host/status/report.js";

/** A minimal Observation-shaped record (only the fields StatusInput reads). */
function obs(summaryTokens: number, detailsTokens: number, detailsLines: number) {
  return { summaryTokens, detailsTokens, detailsLines } as Pick<
    Observation,
    "summaryTokens" | "detailsTokens" | "detailsLines"
  >;
}

/** A minimal Node-shaped record (the real factory keeps the graph fields). */
function node(summaryTokens: number): Node {
  const n = makeNode({
    id: "n1",
    summary: "the summary",
    importance: "med",
    state: "active",
    parentNode: null,
    createdAt: "2026-01-01T00:00:00.000Z",
  });
  n.summaryTokens = summaryTokens;
  return n;
}

const BASE_INPUT: StatusInput = {
  enabled: true,
  settings: {
    renderMode: "selected-root",
    builderRootViewThreshold: 4000,
    selectorRootViewThreshold: 1000,
  },
  sessionStartMs: 0, // per-test: set fresh below (the duration clock is live)
  compactionCount: 2,
  nodes: [node(40), node(60)],
  observations: [obs(30, 1_000, 40), obs(20, 2_000, 60), obs(10, 500, 12)],
  levels: 3,
  rootsCount: 2,
  rootsViewTokens: 800,
  selectedView: { rootsCount: 1, viewTokens: 300 },
  usageLedger: {
    observe: {
      input: 1_000_000,
      output: 200_000,
      cacheRead: 4_000_000,
      cacheWrite: 0,
      cost: 1.25,
      turns: 10,
      runs: 3,
      elapsedMs: 45_000,
    },
    build: { ...EMPTY_LEDGER.build },
    select: {
      input: 500_000,
      output: 0,
      cacheRead: 0,
      cacheWrite: 100_000,
      cost: 0.5,
      turns: 4,
      runs: 2,
      elapsedMs: 10_000,
    },
  },
  lastCompactionLedger: cloneLedger(EMPTY_LEDGER),
};

describe("buildStatusReport — pi fixture parity", () => {
  test("the full multi-line report (header, session, Memory, both Usage blocks)", () => {
    // fresh bounds right at the call — the duration line must not race the clock
    const report = buildStatusReport({ ...BASE_INPUT, sessionStartMs: Date.now() - 90_000 });
    const lines = report.split("\n");
    expect(lines[0]).toBe("🦉 session-owl — status");
    expect(lines[1]).toBe("");
    expect(lines[2]).toBe("Session  00:01:30 · 2 compactions");
    // Memory block
    expect(lines.slice(3, 10)).toEqual([
      "",
      "Memory",
      "    Observations  3",
      "           Nodes  2 (3 levels)",
      "         Details  3.5k tokens 112 lines",
      "       Summaries  160 tokens (node + obs)",
      "   Builder roots  2 · 800 / 4.0k tokens",
    ]);
    // selected-root adds the Selector line
    expect(lines[10]).toBe("  Selector roots  1 · 300 / 1.0k tokens");
    // Usage since session start
    expect(lines[11]).toBe("");
    expect(lines[12]).toBe("Usage since session start");
    expect(lines[13]).toBe("  observe  in 1.0M · out 200k · cache 4.0M · $1.25 · 00:00:45");
    expect(lines[14]).toBe("  build    in 0 · out 0 · cache 0 · $0.0000 · 00:00:00");
    expect(lines[15]).toBe("  select   in 500k · out 0 · cache 0 · $0.500 · 00:00:10");
    // Usage since last compaction — the zero baseline = the same numbers
    expect(lines[16]).toBe("");
    expect(lines[17]).toBe("Usage since last compaction");
    expect(lines[18]).toBe("  observe  in 1.0M · out 200k · cache 4.0M · $1.25 · 00:00:45");
  });

  test("disabled ⇒ pi's exact one-liner", () => {
    expect(buildStatusReport({ ...BASE_INPUT, enabled: false })).toBe("session-owl is disabled.");
  });

  test("observations-root mode omits the Selector line; null selectedView too", () => {
    const report = buildStatusReport({
      ...BASE_INPUT,
      sessionStartMs: Date.now() - 90_000,
      settings: { ...BASE_INPUT.settings, renderMode: "observations-root" },
      selectedView: null,
    });
    expect(report).not.toContain("Selector roots");
    expect(report).toContain("Builder roots");
  });

  test("the since-last-compaction block subtracts the baseline", () => {
    // an earlier cumulative snapshot: some input/cost/turns already spent
    const baseline = cloneLedger(EMPTY_LEDGER);
    baseline.observe.input = 400_000;
    baseline.observe.turns = 6;
    baseline.observe.cost = 0.25;
    const report = buildStatusReport({ ...BASE_INPUT, lastCompactionLedger: baseline });
    expect(report).toContain("Usage since last compaction");
    expect(report.split("\n")).toContain("  observe  in 600k · out 200k · cache 4.0M · $1.00 · 00:00:45");
  });
});

describe("gatherStatusInput — the port seams", () => {
  test("gathers from the graph/settings/session deps (pure)", () => {
    const nodes = new Map([["n1", node(40)]]);
    const o1 = obs(30, 1000, 40) as unknown as import("../../core/src/types.js").Observation;
    (o1 as { id?: string }).id = "o1";
    const observations = new Map([["o1", o1]]);
    const deps = {
      enabled: true,
      settings: {
        renderMode: "selected-root" as const,
        builderRootViewThreshold: 4000,
        selectorRootViewThreshold: 1000,
      },
      graph: { nodes, observations },
      selectedTreeNodes: null,
      session: { sessionStartMs: 123, compactionCount: 1 },
      usageLedger: cloneLedger(EMPTY_LEDGER),
      lastCompactionLedger: null,
    };
    const input = gatherStatusInput(deps);
    expect(input.enabled).toBe(true);
    expect(input.nodes).toHaveLength(1);
    expect(input.observations).toHaveLength(1);
    expect(input.sessionStartMs).toBe(123);
    expect(input.compactionCount).toBe(1);
    expect(input.levels).toBe(1);
    expect(input.rootsCount).toBe(1);
    expect(input.selectedView).toBeNull(); // no tree
  });
});

describe("serveStatusReport — the paused-first composition", () => {
  test("an ACTIVE pause serves the paused report; no pause serves the status report", async () => {
    const deps = {
      enabled: true,
      settings: {
        renderMode: "observations-root" as const,
        builderRootViewThreshold: 4000,
        selectorRootViewThreshold: 1000,
        ignoreConflicts: false,
      },
      graph: { nodes: new Map(), observations: new Map() },
      selectedTreeNodes: null,
      session: { sessionStartMs: Date.now() - 1000, compactionCount: 0 },
      usageLedger: cloneLedger(EMPTY_LEDGER),
      lastCompactionLedger: null,
    };
    // no pause → the status report
    _resetConflictStateForTest();
    const live = await serveStatusReport(deps);
    expect(live).toContain("session-owl — status");
    expect(live).toContain("Memory");
    // an active pause (hits + enabled + !ignoreConflicts) → the paused report
    setConflictHits([{ channel: "plugin.register", name: "other-mod" } as never]);
    const paused = await serveStatusReport(deps);
    expect(paused).toContain("Paused — another compaction-handling mod is installed:");
    // ignoreConflicts un-pauses (deliberate co-run) → the live report again
    const coRun = await serveStatusReport({ ...deps, settings: { ...deps.settings, ignoreConflicts: true } });
    expect(coRun).toContain("Memory");
    _resetConflictStateForTest();
  });
});

describe("buildPausedStatusReport — the ported conflicts wording (approval-owed)", () => {
  test("paused-first ordering source: the conflicts module's own report serves", () => {
    _resetConflictStateForTest();
    setConflictHits([
      { channel: "plugin.register", name: "some-other-plugin" } as never,
      { channel: "classic.SessionStart", name: "yet-another" } as never,
    ]);
    const report = buildPausedStatusReport();
    const lines = report.split("\n");
    expect(lines[0]).toBe("session-owl status");
    expect(lines[2]).toBe("Paused — another compaction-handling mod is installed:");
    expect(lines[4]).toBe("  plugin.register      some-other-plugin");
    expect(lines[5]).toBe("  classic.SessionStart yet-another");
    expect(report).toContain("co-run deliberately via ignoreConflicts in /owl-settings");
    _resetConflictStateForTest();
  });
});
