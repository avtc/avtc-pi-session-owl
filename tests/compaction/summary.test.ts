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
    importance: over.importance ?? "medium",
    parentNode: over.parentNode ?? null,
    observationIds: over.observationIds ?? [],
    childNodeIds: over.childNodeIds ?? [],
    supersededBy: over.supersededBy ?? null,
    timestamps: over.timestamps ?? {
      createdAt: "2026-07-28 09:00",
      updatedAt: "2026-07-28 14:30",
      rangeStart: "2026-07-28 09:00",
      rangeEnd: "2026-07-28 14:30",
    },
  };
}

function sObs(id: string, content: string, over: Partial<SerializedObservation>): SerializedObservation {
  return {
    id,
    content,
    importance: over.importance ?? "critical",
    sourceEntryIds: over.sourceEntryIds ?? [],
    timestamp: over.timestamp ?? "2026-07-28 09:00",
    parentNode: over.parentNode ?? N_GOAL,
  };
}

function selection(nodes: SerializedNode[], oInitialPrompt: SerializedObservation | null): SerializedSelection {
  const obsRefs: string[] = [];
  for (const n of nodes) for (const o of n.observationIds) if (!obsRefs.includes(o)) obsRefs.push(o);
  return { nodes, oInitialPrompt, obsRefs, coveredFrontier: null, nextObsId: 1, nextNodeId: 1 };
}

const TOUCHED: TouchedFile[] = [
  { path: "designs/x.md", timestamp: "2026-07-28 14:30", op: "write" },
  { path: "src/y.ts", timestamp: "2026-07-28 14:28", op: "read" },
];

const PROMPT = sObs("oInitialPrompt", "Design the memkeeper extension. Brand-new; no 3rd-party reuse.", {});

function emptyGraph(): { nodes: Map<string, SerializedNode> } {
  return { nodes: new Map() };
}

function nodeGraph(nodes: SerializedNode[]): { nodes: Map<string, SerializedNode> } {
  const m = new Map<string, SerializedNode>();
  for (const n of nodes) m.set(n.id, n);
  return { nodes: m };
}

describe("renderSummary — preamble + legend + initial prompt + touched", () => {
  it("renders the # Memory header, legend, mk_recall hint", () => {
    const out = renderSummary({
      graph: emptyGraph(),
      selectedTree: null,
      oInitialPrompt: PROMPT,
      renderMode: "observations-root",
      touchedFiles: [],
    });
    expect(out).toContain("# Memory");
    expect(out).toContain(RENDER_LEGEND);
    expect(out).toContain("mk_recall");
  });

  it("renders the verbatim initial prompt in its own ## Initial prompt section", () => {
    const out = renderSummary({
      graph: emptyGraph(),
      selectedTree: null,
      oInitialPrompt: PROMPT,
      renderMode: "observations-root",
      touchedFiles: [],
    });
    expect(out).toContain("## Initial prompt");
    expect(out).toContain("Design the memkeeper extension. Brand-new; no 3rd-party reuse.");
  });

  it("renders the ## Recently touched section with the touched-file lines", () => {
    const out = renderSummary({
      graph: emptyGraph(),
      selectedTree: null,
      oInitialPrompt: PROMPT,
      renderMode: "observations-root",
      touchedFiles: TOUCHED,
    });
    expect(out).toContain("## Recently touched");
    expect(out).toContain("28 14:30 ✎ designs/x.md");
    expect(out).toContain("28 14:28 👁 src/y.ts");
  });

  it("orders sections: header → initial prompt → active set → recently touched", () => {
    const out = renderSummary({
      graph: emptyGraph(),
      selectedTree: null,
      oInitialPrompt: PROMPT,
      renderMode: "observations-root",
      touchedFiles: TOUCHED,
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

describe("renderSummary — observations-root", () => {
  function graphWith(nodes: SerializedNode[]) {
    return nodeGraph(nodes);
  }

  it("renders all non-obsolete source roots (nGoal first even when a newer critical root exists)", () => {
    const out = renderSummary({
      graph: graphWith([
        sNode("nGoal", {
          id: N_GOAL,
          summary: "Build the extension",
          importance: "critical",
          childNodeIds: ["o1"],
          observationIds: ["o1"],
          // nGoal OLDER than n3 — a pure importance/recency sort would put n3 first.
          timestamps: {
            createdAt: "2026-07-28 09:00",
            updatedAt: "2026-07-28 09:00",
            rangeStart: "2026-07-28 09:00",
            rangeEnd: "2026-07-28 09:00",
          },
        }),
        sNode("n7", { summary: "Selector spec", importance: "high" }),
        sNode("n3", {
          summary: "Mechanical render",
          importance: "critical",
          timestamps: {
            createdAt: "2026-07-28 14:00",
            updatedAt: "2026-07-28 14:30",
            rangeStart: "2026-07-28 14:00",
            rangeEnd: "2026-07-28 14:30",
          },
        }),
        sNode("n9", { summary: "old idea", importance: "low", state: "obsolete", supersededBy: "n7" }),
      ]),
      selectedTree: null,
      oInitialPrompt: PROMPT,
      renderMode: "observations-root",
      touchedFiles: [],
    });
    const activeSet = out.split("## Active set")[1];
    expect(activeSet).toContain("📁 nGoal");
    expect(activeSet).toContain("📁 n7");
    expect(activeSet).toContain("📁 n3");
    // obsolete excluded by default
    expect(activeSet).not.toContain("📁 n9");
    // nGoal appears before the other roots
    expect(activeSet.indexOf("📁 nGoal")).toBeLessThan(activeSet.indexOf("📁 n3"));
  });

  it("renders archived roots with 📦 and new nodes as active (no 🆕)", () => {
    const out = renderSummary({
      graph: graphWith([
        sNode("nGoal", { id: N_GOAL, summary: "g", importance: "critical" }),
        sNode("nArch", { summary: "cold", importance: "low", state: "archived" }),
        sNode("nNew", { summary: "fresh", importance: "medium", state: "new" }),
      ]),
      selectedTree: null,
      oInitialPrompt: PROMPT,
      renderMode: "observations-root",
      touchedFiles: [],
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
        sNode("nGoal", { id: N_GOAL, summary: "Build the extension", importance: "critical" }),
        sNode("n7", { summary: "Selector spec", importance: "high" }),
        sNode("n3", { summary: "Mechanical render", importance: "critical" }),
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
    });
    const activeSet = out.split("## Active set")[1];
    expect(activeSet).toContain("📁 nGoal");
    expect(activeSet).toContain("📁 n7");
    expect(activeSet).toContain("📁 n3");
    expect(activeSet).toContain(`📁 ${N_IRRELEVANT}`);
    // nGoal first, nIrrelevant last
    const goalIdx = activeSet.indexOf("📁 nGoal");
    const n7Idx = activeSet.indexOf("📁 n7");
    const irrIdx = activeSet.indexOf(`📁 ${N_IRRELEVANT}`);
    expect(goalIdx).toBeLessThan(n7Idx);
    expect(n7Idx).toBeLessThan(irrIdx);
  });

  it("falls back to source roots when selectedTree is null (no selected tree yet)", () => {
    const out = renderSummary({
      graph: nodeGraph([
        sNode("nGoal", { id: N_GOAL, summary: "g", importance: "critical" }),
        sNode("n5", { summary: "other", importance: "medium" }),
      ]),
      selectedTree: null,
      oInitialPrompt: PROMPT,
      renderMode: "selected-root",
      touchedFiles: [],
    });
    const activeSet = out.split("## Active set")[1];
    expect(activeSet).toContain("📁 nGoal");
    expect(activeSet).toContain("📁 n5");
  });
});
