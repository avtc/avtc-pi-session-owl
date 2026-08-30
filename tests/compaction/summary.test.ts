// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// renderSummary: the mechanical compaction-summary renderer. Preamble +
// legend, the verbatim initial prompt, the active-set root one-liners (nGoal
// first; nIrrelevant last in selected-root), and recently-touched files. Non-Builder
// viewer (new→active, no 🆕); obsolete roots excluded; never truncated.

import { describe, expect, it } from "vitest";
import { renderSummary } from "../../src/compaction/summary.js";
import type { TouchedFile } from "../../src/compaction/touched-files.js";
import { RENDER_LEGEND } from "../../src/format/render.js";
import type { SerializedNode, SerializedObservation, SerializedSelection } from "../../src/store/codecs.js";
import { N_GOAL, N_IRRELEVANT } from "../../src/types.js";

// --- fixtures ---------------------------------------------------------------

function sNode(id: string, over: Partial<SerializedNode> & { summary: string }): SerializedNode {
  return {
    id,
    summary: over.summary,
    summaryTokens: over.summaryTokens ?? 4,
    state: over.state ?? "active",
    importance: over.importance ?? "med",
    parentNode: over.parentNode ?? null,
    observationIds: over.observationIds ?? [],
    childNodeIds: over.childNodeIds ?? [],
    supersededBy: over.supersededBy ?? null,
    timestamps: over.timestamps ?? {
      createdAt: "2026-07-28T09:00:00.000Z",
      updatedAt: "2026-07-28T14:30:00.000Z",
      rangeStart: "2026-07-28T09:00:00.000Z",
      rangeEnd: "2026-07-28T14:30:00.000Z",
    },
  };
}

function sObs(id: string, summary: string, over: Partial<SerializedObservation>): SerializedObservation {
  return {
    id,
    summary,
    importance: over.importance ?? "crit",
    sourceEntryIds: over.sourceEntryIds ?? [],
    timestamp: over.timestamp ?? "2026-07-28T09:00:00.000Z",
    parentNode: over.parentNode ?? N_GOAL,
  };
}

function selection(nodes: SerializedNode[], oInitialPrompt: SerializedObservation | null): SerializedSelection {
  const obsRefs: string[] = [];
  for (const n of nodes) for (const o of n.observationIds) if (!obsRefs.includes(o)) obsRefs.push(o);
  return { nodes, oInitialPrompt, obsRefs, coveredFrontier: null, nextObsId: 1, nextNodeId: 1 };
}

const TOUCHED: TouchedFile[] = [
  { path: "designs/x.md", timestamp: "2026-07-28T14:30:00.000Z", op: "write" },
  { path: "src/y.ts", timestamp: "2026-07-28T14:28:00.000Z", op: "edit" },
  { path: "src/z.ts", timestamp: "2026-07-28T14:25:00.000Z", op: "read", lineRanges: [{ start: 10, end: 40 }] },
];

const PROMPT = sObs("oInitialPrompt", "Design the session-owl extension. Brand-new; no 3rd-party reuse.", {});

function emptyGraph(): { nodes: Map<string, SerializedNode> } {
  return { nodes: new Map() };
}

function nodeGraph(nodes: SerializedNode[]): { nodes: Map<string, SerializedNode> } {
  const m = new Map<string, SerializedNode>();
  for (const n of nodes) m.set(n.id, n);
  return { nodes: m };
}

describe("renderSummary — preamble + legend + initial prompt + touched", () => {
  it("renders the # Memory header, legend, owl_recall hint", () => {
    const out = renderSummary({
      graph: emptyGraph(),
      selectedTree: null,
      oInitialPrompt: PROMPT,
      renderMode: "observations-root",
      touchedFiles: [],
      compactionCount: 0,
    });
    expect(out).toContain("# Memory");
    expect(out).toContain(RENDER_LEGEND);
    expect(out).toContain("owl_recall");
  });

  it("renders the verbatim initial prompt in its own ## Initial prompt section", () => {
    const out = renderSummary({
      graph: emptyGraph(),
      selectedTree: null,
      oInitialPrompt: PROMPT,
      renderMode: "observations-root",
      touchedFiles: [],
      compactionCount: 0,
    });
    expect(out).toContain("## Initial prompt");
    expect(out).toContain("Design the session-owl extension. Brand-new; no 3rd-party reuse.");
  });

  it("renders the '(none captured yet)' placeholder when oInitialPrompt is null (compaction before first user message)", () => {
    const out = renderSummary({
      graph: emptyGraph(),
      selectedTree: null,
      oInitialPrompt: null,
      renderMode: "observations-root",
      touchedFiles: [],
      compactionCount: 0,
    });
    expect(out).toContain("## Initial prompt");
    expect(out).toContain("(none captured yet)");
  });

  it("renders the ## Recently touched section with the touched-file lines", () => {
    const out = renderSummary({
      graph: emptyGraph(),
      selectedTree: null,
      oInitialPrompt: PROMPT,
      renderMode: "observations-root",
      touchedFiles: TOUCHED,
      compactionCount: 0,
    });
    expect(out).toContain("## Recently touched");
    expect(out).toContain("28 14:30 write designs/x.md");
    expect(out).toContain("28 14:28 edit src/y.ts");
    expect(out).toContain("28 14:25 read src/z.ts:10-40");
  });

  it("orders sections: header → initial prompt → active set → recently touched", () => {
    const out = renderSummary({
      graph: emptyGraph(),
      selectedTree: null,
      oInitialPrompt: PROMPT,
      renderMode: "observations-root",
      touchedFiles: TOUCHED,
      compactionCount: 0,
    });
    const headerIdx = out.indexOf("# Memory");
    const promptIdx = out.indexOf("## Initial prompt");
    const activeIdx = out.indexOf("## Active set");
    const touchedIdx = out.indexOf("## Recently touched");
    expect(headerIdx).toBeLessThan(promptIdx);
    expect(promptIdx).toBeLessThan(activeIdx);
    expect(activeIdx).toBeLessThan(touchedIdx);
  });
});

describe("renderSummary — active-set line format", () => {
  it("active-set lines carry the node kind icon, one line per root (no list markers)", () => {
    const out = renderSummary({
      graph: nodeGraph([
        sNode(N_GOAL, { id: N_GOAL, summary: "Build the extension", importance: "crit" }),
        sNode("n7", { summary: "Selector spec", importance: "high" }),
      ]),
      selectedTree: null,
      oInitialPrompt: PROMPT,
      renderMode: "observations-root",
      touchedFiles: TOUCHED,
      compactionCount: 1,
    });
    const activeBlock = out
      .split("## Active set")[1]
      .split("---")[0]
      .split("\n")
      .filter((l) => l.trim() !== "");
    expect(activeBlock.length).toBe(2);
    for (const line of activeBlock) {
      expect(line.startsWith("📁 ")).toBe(true);
    }
    const touchedBlock = out
      .split("## Recently touched")[1]
      .split("\n")
      .filter((l) => l.trim() !== "");
    expect(touchedBlock.length).toBe(3);
    for (const line of touchedBlock) {
      expect(line.startsWith("📁 ")).toBe(false);
    }
  });
});

describe("renderSummary — observations-root", () => {
  function graphWith(nodes: SerializedNode[]) {
    return nodeGraph(nodes);
  }

  it("renders all non-obsolete source roots (nGoal first even when a newer crit root exists)", () => {
    const out = renderSummary({
      graph: graphWith([
        sNode("nGoal", {
          id: N_GOAL,
          summary: "Build the extension",
          importance: "crit",
          childNodeIds: ["o1"],
          observationIds: ["o1"],
          // nGoal OLDER than n3 — a pure importance/recency sort would put n3 first.
          timestamps: {
            createdAt: "2026-07-28T09:00:00.000Z",
            updatedAt: "2026-07-28T09:00:00.000Z",
            rangeStart: "2026-07-28T09:00:00.000Z",
            rangeEnd: "2026-07-28T09:00:00.000Z",
          },
        }),
        sNode("n7", { summary: "Selector spec", importance: "high" }),
        sNode("n3", {
          summary: "Mechanical render",
          importance: "crit",
          timestamps: {
            createdAt: "2026-07-28T14:00:00.000Z",
            updatedAt: "2026-07-28T14:30:00.000Z",
            rangeStart: "2026-07-28T14:00:00.000Z",
            rangeEnd: "2026-07-28T14:30:00.000Z",
          },
        }),
        sNode("n9", { summary: "old idea", importance: "low", state: "obsolete", supersededBy: "n7" }),
      ]),
      selectedTree: null,
      oInitialPrompt: PROMPT,
      renderMode: "observations-root",
      touchedFiles: [],
      compactionCount: 0,
    });
    const activeSet = out.split("## Active set")[1];
    expect(activeSet).toContain("nGoal");
    expect(activeSet).toContain("n7 ·");
    expect(activeSet).toContain("n3 ·");
    // obsolete excluded by default
    expect(activeSet).not.toContain("n9 ·");
    // nGoal appears before the other roots
    expect(activeSet.indexOf("nGoal")).toBeLessThan(activeSet.indexOf("n3 ·"));
  });

  it("renders archived roots with 📦 and new nodes as active (no 🆕)", () => {
    const out = renderSummary({
      graph: graphWith([
        sNode("nGoal", { id: N_GOAL, summary: "g", importance: "crit" }),
        sNode("nArch", { summary: "cold", importance: "low", state: "archived" }),
        sNode("nNew", { summary: "fresh", importance: "med", state: "new" }),
      ]),
      selectedTree: null,
      oInitialPrompt: PROMPT,
      renderMode: "observations-root",
      touchedFiles: [],
      compactionCount: 0,
    });
    const activeSet = out.split("## Active set")[1];
    expect(activeSet).toContain("📦"); // archived glyph
    expect(activeSet).not.toContain("🆕"); // new renders as active (non-Builder)
  });
});

describe("renderSummary — selected-root", () => {
  it("renders selected tree roots (nGoal first, nIrrelevant last)", () => {
    const tree = selection(
      [
        sNode("nGoal", { id: N_GOAL, summary: "Build the extension", importance: "crit" }),
        sNode("n7", { summary: "Selector spec", importance: "high" }),
        sNode("n3", { summary: "Mechanical render", importance: "crit" }),
        sNode(N_IRRELEVANT, { id: N_IRRELEVANT, summary: "Irrelevant", importance: "low" }),
      ],
      PROMPT,
    );
    const out = renderSummary({
      graph: emptyGraph(),
      selectedTree: tree,
      oInitialPrompt: PROMPT,
      renderMode: "selected-root",
      touchedFiles: [],
      compactionCount: 0,
    });
    const activeSet = out.split("## Active set")[1];
    expect(activeSet).toContain("nGoal");
    expect(activeSet).toContain("n7 ·");
    expect(activeSet).toContain("n3 ·");
    expect(activeSet).toContain(`${N_IRRELEVANT} ·`);
    // nGoal first, nIrrelevant last
    const goalIdx = activeSet.indexOf("nGoal");
    const n7Idx = activeSet.indexOf("n7 ·");
    const irrIdx = activeSet.indexOf(`${N_IRRELEVANT} ·`);
    expect(goalIdx).toBeLessThan(n7Idx);
    expect(n7Idx).toBeLessThan(irrIdx);
  });

  it("falls back to source roots when selectedTree is null (no selected tree yet)", () => {
    const out = renderSummary({
      graph: nodeGraph([
        sNode("nGoal", { id: N_GOAL, summary: "g", importance: "crit" }),
        sNode("n5", { summary: "other", importance: "med" }),
      ]),
      selectedTree: null,
      oInitialPrompt: PROMPT,
      renderMode: "selected-root",
      touchedFiles: [],
      compactionCount: 0,
    });
    const activeSet = out.split("## Active set")[1];
    expect(activeSet).toContain("nGoal");
    expect(activeSet).toContain("n5 ·");
  });

  it("carries a root's summed direct-obs size on its line, resolving tree refs against the source observations", () => {
    // the selected tree carries structure only; the roots' observations live in
    // the source graph — the line qualifies the Nobs count with the summed size
    // (n7: one obs; nDec: two, summed — the fullDetails drill cost).
    const tree = selection(
      [
        sNode("nGoal", { id: N_GOAL, summary: "Build the extension", importance: "crit" }),
        sNode("n7", { summary: "Selector spec", importance: "high", observationIds: ["o5"] }),
        sNode("nDec", { summary: "Decisions", importance: "med", observationIds: ["o1", "o2"] }),
      ],
      PROMPT,
    );
    const out = renderSummary({
      graph: {
        nodes: new Map(),
        observations: new Map([
          ["o5", { detailsLines: 2, detailsTokens: 15 }],
          ["o1", { detailsLines: 3, detailsTokens: 40 }],
          ["o2", { detailsLines: 10, detailsTokens: 211 }],
        ]),
      },
      selectedTree: tree,
      oInitialPrompt: PROMPT,
      renderMode: "selected-root",
      touchedFiles: [],
      compactionCount: 0,
    });
    const activeSet = out.split("## Active set")[1];
    expect(activeSet).toContain("n7 · high · Selector spec · 1obs · 2lines 15tokens · ");
    expect(activeSet).toContain("nDec · med · Decisions · 2obs · 13lines 251tokens · ");
    // 0-obs root shows no size segment
    expect(activeSet).toMatch(/nGoal · crit · Build the extension · 0obs · /);
  });

  it("renders the tree-total footer after the roots, skipped for an empty tree", () => {
    const out = renderSummary({
      graph: {
        nodes: nodeGraph([
          sNode("nGoal", { id: N_GOAL, summary: "Build the extension", importance: "crit", observationIds: ["o5"] }),
          sNode("n7", { summary: "Selector spec", importance: "high", observationIds: ["o1", "o2"] }),
        ]).nodes,
        observations: new Map([
          ["o5", { detailsLines: 2, detailsTokens: 15 }],
          ["o1", { detailsLines: 3, detailsTokens: 40 }],
          ["o2", { detailsLines: 10, detailsTokens: 211 }],
        ]),
      },
      selectedTree: null,
      oInitialPrompt: PROMPT,
      renderMode: "observations-root",
      touchedFiles: [],
      compactionCount: 2,
    });
    // after the last root, before the touched section; totals over the source graph.
    // the blank line before --- keeps it a thematic break, not a setext heading underline
    const footer =
      "Source tree total: 2 nodes (1 level) · 3 observations · 15 lines 266 tokens of details · 2 compactions";
    expect(out).toContain(`\n\n---\n${footer}`);
    expect(out.indexOf(footer)).toBeGreaterThan(out.lastIndexOf("n7 · high · Selector spec"));
    expect(out.indexOf(footer)).toBeLessThan(out.indexOf("## Recently touched"));

    const empty = renderSummary({
      graph: emptyGraph(),
      selectedTree: null,
      oInitialPrompt: PROMPT,
      renderMode: "observations-root",
      touchedFiles: [],
      compactionCount: 0,
    });
    expect(empty).not.toContain("Source tree total");
  });
});

describe("renderSummary — ## Memory use section (recall-before-relying guidance)", () => {
  it("renders the memory-use guidance between the legend and the initial prompt", () => {
    const out = renderSummary({
      graph: emptyGraph(),
      selectedTree: null,
      oInitialPrompt: PROMPT,
      renderMode: "observations-root",
      touchedFiles: [],
      compactionCount: 0,
    });
    expect(out).toContain("## Memory use");
    expect(out).toContain("navigation index into retained session memory");
    expect(out).toContain("Recall before relying on session-derived understanding");
    expect(out).toContain('"fullDetails":true');
    const legendIdx = out.indexOf(RENDER_LEGEND);
    const useIdx = out.indexOf("## Memory use");
    const promptIdx = out.indexOf("## Initial prompt");
    expect(legendIdx).toBeLessThan(useIdx);
    expect(useIdx).toBeLessThan(promptIdx);
  });

  it("the preamble keeps only the tree sentence — the old redo/assume sentence is gone (subsumed)", () => {
    const out = renderSummary({
      graph: emptyGraph(),
      selectedTree: null,
      oInitialPrompt: PROMPT,
      renderMode: "observations-root",
      touchedFiles: [],
      compactionCount: 0,
    });
    expect(out).toContain("Your session memory — the top level of a tree");
    expect(out).not.toContain("Before redoing or assuming");
  });
});
