// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// Tests for /mk:status. The report is built by a pure buildStatusReport(input)
// from structured data sources (no pi types) so it is unit-testable without
// mocking pi; runMkStatus gathers the data + notifies.

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, type MemkeeperConfig } from "../../src/config/schema.js";
import type { SizeHintObservation } from "../../src/format/render.js";
import { renderRootViewFromRoots } from "../../src/graph/read-tools.js";
import { buildStatusReport, gatherStatusInput, runMkStatus, type StatusInput } from "../../src/status/command.js";
import type { UsageLedger } from "../../src/store/codecs.js";
import { cloneLedger, EMPTY_LEDGER, encodeSelection } from "../../src/store/codecs.js";
import { getGraphStore, resetForNewSession } from "../../src/store/graph-store.js";
import type { Node, Observation, ObsId } from "../../src/types.js";
import { estimateContentTokens } from "../../src/types.js";

/** Empty size-hint map — no single-obs segments (the render under measure
 *  matches the fixture, which carries no observations). */
const EMPTY_SIZE_HINTS: ReadonlyMap<string, SizeHintObservation> = new Map();

function settings(over: Partial<MemkeeperConfig>): MemkeeperConfig {
  return { ...DEFAULT_CONFIG, ...over };
}

function node(over: Partial<Node>): Node {
  return {
    id: over.id ?? "n1",
    summary: over.summary ?? "a node",
    summaryTokens: over.summaryTokens ?? Math.ceil((over.summary ?? "a node").length / 4),
    state: over.state ?? "active",
    importance: over.importance ?? "med",
    parentNode: over.parentNode ?? null,
    observationIds: over.observationIds ?? [],
    childNodeIds: over.childNodeIds ?? [],
    supersededBy: over.supersededBy ?? null,
    timestamps: over.timestamps ?? {
      createdAt: "2026-07-28T09:00:00.000Z",
      updatedAt: "2026-07-28T09:00:00.000Z",
      rangeStart: "2026-07-28T09:00:00.000Z",
      rangeEnd: "2026-07-28T09:00:00.000Z",
    },
  };
}

function obs(
  id: ObsId,
  content: string,
  summaryTokens: number,
  detailsTokens: number,
  detailsLines: number,
): {
  id: ObsId;
  content: string;
  summaryTokens: number;
  detailsTokens: number;
  detailsLines: number;
  importance: "med";
  sourceEntryIds: string[];
  timestamps: { createdAt: string };
} {
  return {
    id,
    content,
    summaryTokens,
    detailsTokens,
    detailsLines,
    importance: "med",
    sourceEntryIds: [],
    timestamps: { createdAt: "2026-07-28T09:00:00.000Z" },
  };
}

function ledger(over: Partial<UsageLedger>): UsageLedger {
  return { ...cloneLedger(EMPTY_LEDGER), ...over };
}

function input(over: Partial<StatusInput>): StatusInput {
  return {
    enabled: true,
    settings: settings({}),
    sessionStartMs: Date.now() - 1000,
    compactionCount: 0,
    nodes: [],
    observations: [],
    levels: 0,
    rootsCount: 0,
    rootsViewTokens: 0,
    selectedView: null,
    usageLedger: cloneLedger(EMPTY_LEDGER),
    lastCompactionLedger: null,
    ...over,
  };
}

describe("buildStatusReport", () => {
  it("disabled → the disabled message only", () => {
    const report = buildStatusReport(input({ enabled: false }));
    expect(report).toBe("memkeeper is disabled.");
  });

  it("header + session line with duration + compaction count", () => {
    const report = buildStatusReport(input({ sessionStartMs: Date.now() - 3 * 3600_000, compactionCount: 5 }));
    expect(report).toContain("🦉 memkeeper — status");
    expect(report).toContain("Session");
    expect(report).toContain("· 5 compactions");
    expect(report).toContain("03:00:0"); // ~3h duration (seconds may vary by 1)
  });

  it("Memory section: counts + levels + details (tokens+lines) + summaries", () => {
    const report = buildStatusReport(
      input({
        levels: 2,
        rootsCount: 3,
        rootsViewTokens: 8700,
        nodes: [node({ id: "n1", summaryTokens: 320 }), node({ id: "n2", summaryTokens: 80 })],
        // obs summaries: 100 + 50 = 150; details: 4500+1500 = 6000 tokens, 300+100 = 400 lines
        observations: [obs("o1", "x", 100, 4500, 300), obs("o2", "y", 50, 1500, 100)],
      }),
    );
    expect(report).toContain("Memory");
    // exact approved lines (labels padded to one column, · separators)
    expect(report).toContain("  Observations  2");
    expect(report).toContain("         Nodes  2 (2 levels)");
    expect(report).toContain("       Details  6.0k tokens 400 lines");
    expect(report).toContain("     Summaries  550 tokens (node + obs)");
    expect(report).toContain(" Builder roots  3 · 8.7k / 40k tokens");
  });

  it("singular level — (1 level)", () => {
    const report = buildStatusReport(input({ nodes: [node({ id: "n1" })], levels: 1 }));
    expect(report).toContain("1 (1 level)");
  });

  it("counts are plain (no thousands separators) and the count column is right-aligned", () => {
    const bigNodes: Node[] = [];
    const bigObs: { summaryTokens: number; detailsTokens: number; detailsLines: number }[] = [];
    for (let i = 0; i < 1245; i += 1) bigObs.push({ summaryTokens: 0, detailsTokens: 0, detailsLines: 0 });
    for (let i = 0; i < 95; i += 1) bigNodes.push(node({ id: `n${i}` as unknown as Node["id"], summaryTokens: 0 }));
    const report = buildStatusReport(input({ nodes: bigNodes, observations: bigObs }));
    const memoryLines = report
      .split("\n")
      .filter((l) => l.includes("Observations") || l.trimStart().startsWith("Nodes"));
    expect(memoryLines.length).toBe(2);
    // plain counts, no separators
    expect(memoryLines[0]).toContain("1245");
    expect(memoryLines[1]).toContain("95");
    // right-aligned counts: both count strings END at the same column (padStart
    // to the derived count width).
    const obsEnd = memoryLines[0].indexOf("1245") + "1245".length;
    const nodesEnd = memoryLines[1].indexOf("95") + "95".length;
    expect(obsEnd).toBe(nodesEnd);
  });

  it("count column stays aligned even when counts exceed the typical width (100k+)", () => {
    // A fixed count width (e.g. 6 → max 99,999) would let 100,000 drift the
    // column. The width is derived from the actual counts, so it holds.
    const bigObs: { summaryTokens: number; detailsTokens: number; detailsLines: number }[] = [];
    for (let i = 0; i < 100_000; i += 1) bigObs.push({ summaryTokens: 0, detailsTokens: 0, detailsLines: 0 });
    const report = buildStatusReport(input({ nodes: [node({ id: "n1", summaryTokens: 0 })], observations: bigObs }));
    const memoryLines = report
      .split("\n")
      .filter((l) => l.includes("Observations") || l.trimStart().startsWith("Nodes"));
    expect(memoryLines.length).toBe(2);
    expect(memoryLines[0]).toContain("100000");
    expect(memoryLines[1]).toContain("1 ");
    // count column aligned regardless of the 6-digit count magnitude.
    const obsEnd = memoryLines[0].indexOf("100000") + "100000".length;
    const nodesEnd = memoryLines[1].indexOf("1 ") + "1".length;
    expect(obsEnd).toBe(nodesEnd);
  });

  it("Builder roots line shows count · viewTokens / threshold tokens", () => {
    const report = buildStatusReport(
      input({ rootsCount: 42, rootsViewTokens: 35000, settings: settings({ builderRootViewThreshold: 40000 }) }),
    );
    expect(report).toContain("Builder roots  42 · 35k / 40k tokens");
  });

  it("Selector roots line only in selected-root renderMode", () => {
    const withSelected = buildStatusReport(
      input({
        selectedView: { rootsCount: 12, viewTokens: 15000 },
        settings: settings({ renderMode: "selected-root", selectorRootViewThreshold: 20000 }),
      }),
    );
    expect(withSelected).toContain("Selector roots  12 · 15k / 20k tokens");
    // observations-root → no Selector roots line
    const noSelected = buildStatusReport(
      input({
        selectedView: { rootsCount: 12, viewTokens: 15000 },
        settings: settings({ renderMode: "observations-root" }),
      }),
    );
    expect(noSelected).not.toContain("Selector roots");
  });

  it("Usage since session start + since last compaction sections (per-phase in/out/cache/$/time)", () => {
    const usage = ledger({
      observe: {
        input: 45000,
        output: 4000,
        cacheRead: 30000,
        cacheWrite: 0,
        cost: 0.082,
        turns: 10,
        runs: 3,
        elapsedMs: 90061000,
      },
    });
    const baseline = ledger({
      observe: {
        input: 30000,
        output: 2500,
        cacheRead: 22000,
        cacheWrite: 0,
        cost: 0.06,
        turns: 6,
        runs: 2,
        elapsedMs: 86400000,
      },
    });
    const report = buildStatusReport(input({ usageLedger: usage, lastCompactionLedger: baseline }));
    expect(report).toContain("Usage since session start");
    // since-session-start observe line: 45k in / 4.0k out / 30k cache / $0.082 / 1d 01:01:01
    const startIdx = report.indexOf("Usage since session start");
    const sinceStartBlock = report.slice(startIdx, report.indexOf("Usage since last compaction"));
    expect(sinceStartBlock).toContain("observe");
    expect(sinceStartBlock).toContain("in 45k · out 4.0k · cache 30k · $0.082");
    // elapsed = 90061000ms → 1d 01:01:01
    expect(sinceStartBlock).toContain("1d 01:01:01");
    // since-last-compaction observe line: 15k in (45k-30k) / 1.5k out / 8.0k cache / 01:01:01
    const sinceCompactionBlock = report.slice(report.indexOf("Usage since last compaction"));
    expect(sinceCompactionBlock).toContain("15k");
    expect(sinceCompactionBlock).toContain("1.5k");
    expect(sinceCompactionBlock).toContain("8.0k");
    // elapsed delta = 90061000 - 86400000 = 3661000ms → 01:01:01
    expect(sinceCompactionBlock).toContain("01:01:01");
  });

  it("since last compaction mirrors since session start when lastCompactionLedger is null (no compaction yet)", () => {
    const usage = ledger({
      observe: {
        input: 45000,
        output: 4000,
        cacheRead: 30000,
        cacheWrite: 0,
        cost: 0.082,
        turns: 10,
        runs: 3,
        elapsedMs: 0,
      },
    });
    const report = buildStatusReport(input({ usageLedger: usage, lastCompactionLedger: null }));
    const sinceCompactionBlock = report.slice(report.indexOf("Usage since last compaction"));
    expect(sinceCompactionBlock).toContain("45k");
  });

  it("formats all three phases (observe/build/select) in each usage section", () => {
    const usage = ledger({
      observe: { input: 1000, output: 100, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1, runs: 1, elapsedMs: 0 },
      build: { input: 2000, output: 200, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1, runs: 1, elapsedMs: 0 },
      select: { input: 3000, output: 300, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1, runs: 1, elapsedMs: 0 },
    });
    const report = buildStatusReport(input({ usageLedger: usage, lastCompactionLedger: null }));
    const block = report.slice(report.indexOf("Usage since session start"));
    expect(block).toContain("observe");
    expect(block).toContain("build");
    expect(block).toContain("select");
  });
});

describe("gatherStatusInput", () => {
  it("reads live store: nodes, observations, ledgers, levels, root counts, view tokens", () => {
    resetForNewSession();
    const graph = getGraphStore().graph;
    graph.nodes.set("n1", node({ id: "n1", summary: "root", parentNode: null, summaryTokens: 8 }));
    graph.observations.set("o1", {
      id: "o1",
      content: "x",
      summaryTokens: 40,
      importance: "med",
      sourceEntryIds: [],
      timestamps: {
        createdAt: "2026-07-28T09:00:00.000Z",
        updatedAt: "2026-07-28T09:00:00.000Z",
        rangeStart: "2026-07-28T09:00:00.000Z",
        rangeEnd: "2026-07-28T09:00:00.000Z",
      },
    } as unknown as Observation);
    getGraphStore().usageLedger = ledger({
      observe: { input: 500, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1, runs: 1, elapsedMs: 0 },
    });

    const gathered = gatherStatusInput(settings({}), { sessionStartMs: 1000, compactionCount: 2 });
    expect(gathered.nodes.length).toBe(1);
    expect(gathered.observations.length).toBe(1);
    expect(gathered.compactionCount).toBe(2);
    expect(gathered.sessionStartMs).toBe(1000);
    expect(gathered.levels).toBe(1); // single root, no children
    expect(gathered.rootsCount).toBe(1);
    expect(gathered.rootsViewTokens).toBeGreaterThan(0);
    expect(gathered.selectedView).toBeNull(); // no persisted selected tree
    expect(gathered.usageLedger.observe.input).toBe(500);
    expect(gathered.lastCompactionLedger).toBeNull();
  });

  it("measureSelectedView drops obsolete roots from the persisted tree", () => {
    // the selected tree normally never holds obsolete roots (the Selector's working
    // copy excludes obsolete before persisting), but the filter must enforce it
    // explicitly rather than relying on the upstream invariant.
    resetForNewSession();
    const graph = getGraphStore().graph;
    graph.nodes.set("n1", node({ id: "n1", summary: "active root", parentNode: null, summaryTokens: 40 }));
    graph.nodes.set(
      "n2",
      node({ id: "n2", summary: "obsolete root", parentNode: null, state: "obsolete", summaryTokens: 40 }),
    );
    getGraphStore().selectedTree = encodeSelection(graph, null, null);

    const gathered = gatherStatusInput(settings({ renderMode: "selected-root" }), {
      sessionStartMs: 1000,
      compactionCount: 0,
    });
    // only n1's render counts; n2 (obsolete) is dropped → the view is the single
    // active root line, NOT both.
    expect(gathered.selectedView).not.toBeNull();
    expect(gathered.selectedView?.rootsCount).toBe(1); // obsolete n2 excluded from the count
    const withObsolete = estimateContentTokens(
      renderRootViewFromRoots(
        [
          node({ id: "n1", summary: "active root", summaryTokens: 40 }),
          node({ id: "n2", summary: "obsolete root", summaryTokens: 40 }),
        ],
        "nonBuilder",
        EMPTY_SIZE_HINTS,
      ),
    );
    expect(gathered.selectedView?.viewTokens).toBeLessThan(withObsolete);
  });
});

describe("runMkStatus (handler)", () => {
  it("builds the report from live state + notifies via ui.notify", async () => {
    resetForNewSession();
    const notified: { text: string; level: string }[] = [];
    const ctx = {
      ui: {
        notify: async (text: string, level: string) => {
          notified.push({ text, level });
        },
      },
      sessionManager: {
        getLeafId: () => "leaf-1",
        getBranch: () => [
          { type: "message", timestamp: new Date(Date.now() - 2000).toISOString() },
          { type: "compaction", timestamp: new Date().toISOString() },
        ],
      },
    } as unknown as ExtensionCommandContext;
    await runMkStatus("", ctx);
    expect(notified).toHaveLength(1);
    expect(notified[0].level).toBe("info");
    expect(notified[0].text).toContain("🦉 memkeeper — status");
    expect(notified[0].text).toContain("1 compaction");
  });

  it("empty branch → sessionStartMs falls back to Date.now() (no NaN duration)", async () => {
    resetForNewSession();
    const notified: { text: string; level: string }[] = [];
    const ctx = {
      ui: { notify: async (text: string, level: string) => notified.push({ text, level }) },
      sessionManager: { getLeafId: () => "leaf-1", getBranch: () => [] },
    } as unknown as ExtensionCommandContext;
    await runMkStatus("", ctx);
    expect(notified[0].level).toBe("info");
    // duration must be a finite number (NaN would render as “NaN” in the Session line)
    expect(notified[0].text).toContain("Session");
    expect(notified[0].text).not.toContain("NaN");
  });

  it("malformed (non-numeric) timestamp → sessionStartMs falls back to Date.now() (no NaN duration)", async () => {
    resetForNewSession();
    const notified: { text: string; level: string }[] = [];
    const ctx = {
      ui: { notify: async (text: string, level: string) => notified.push({ text, level }) },
      sessionManager: {
        getLeafId: () => "leaf-1",
        getBranch: () => [{ type: "message", timestamp: "not-a-date" }],
      },
    } as unknown as ExtensionCommandContext;
    await runMkStatus("", ctx);
    expect(notified[0].level).toBe("info");
    expect(notified[0].text).toContain("Session");
    expect(notified[0].text).not.toContain("NaN");
  });

  it("error path → notifies at error level with the reason", async () => {
    const notified: { text: string; level: string }[] = [];
    const ctx = {
      ui: {
        notify: async (text: string, level: string) => {
          notified.push({ text, level });
        },
      },
      // a sessionManager that throws → the handler's catch → error notify.
      sessionManager: {
        getLeafId: () => {
          throw new Error("boom");
        },
        getBranch: () => [],
      },
    } as unknown as ExtensionCommandContext;
    await runMkStatus("", ctx);
    expect(notified).toHaveLength(1);
    expect(notified[0].level).toBe("error");
    expect(notified[0].text).toContain("boom");
  });
});
