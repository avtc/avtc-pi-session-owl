// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { _setGetMemkeeperSettings, type MemkeeperConfig } from "../../src/config/schema.js";
import {
  applyCreateNode,
  applyRecordObservation,
  applySetMeta,
  applySupersede,
  MUTATE_SOURCE,
  setClock,
} from "../../src/graph/mutations.js";
import { createMkRecallTool } from "../../src/recall/mk-recall.js";
import { encodeSelection } from "../../src/store/codecs.js";
import { getGraphStore, persistSelectedTree, resetForNewSession } from "../../src/store/graph-store.js";
import { MemkeeperGraph, makeObservation, N_GOAL, type Node, type ObsId } from "../../src/types.js";

const T0 = "2026-07-17 09:00";
const T1 = "2026-07-17 14:30";
const T3 = "2026-07-19 10:00";

const NO_OP_CTX = {
  appendEntry: () => {},
  getLeafId: () => "leaf-1",
  getBranch: () => [],
} as const;

// --- test graph ------------------------------------------------------------
// Roots: nGoal (critical, oInitialPrompt) · n7 (high, "Auth migration to JWT",
//   child n8 + obs o5) · n12 (new state — renders active to non-Builder ·
//   "Build failed") · n20 (archived, "Old YAML config") · n99 (obsolete,
//   superseded by n7, obs o9). Observations carry distinct timestamps for
//   range testing.

function buildGraph(): MemkeeperGraph {
  setClock(() => T0);
  const g = new MemkeeperGraph({ nodes: new Map(), observations: new Map(), nextObsId: 1, nextNodeId: 1 });

  applyCreateNode(g, {
    id: N_GOAL,
    summary: "the public API must stay stable",
    importance: "critical",
    parentNode: null,
    state: "active",
  });
  applyRecordObservation(g, {
    obs: makeObservation({
      id: "oInitialPrompt",
      content: "build a memory extension",
      importance: "critical",
      sourceEntryIds: ["1"],
      timestamp: T0,
      parentNode: N_GOAL,
    }),
  });

  applyCreateNode(g, {
    id: "n7",
    summary: "Auth migration to JWT",
    importance: "high",
    parentNode: null,
    state: "active",
  });
  applyCreateNode(g, {
    id: "n8",
    summary: "Pick a JWT library",
    importance: "high",
    parentNode: "n7",
    state: "active",
  });
  applyRecordObservation(g, {
    obs: makeObservation({
      id: "o5",
      content: "Chose JWT for stateless auth",
      importance: "high",
      sourceEntryIds: ["2"],
      timestamp: T1,
      parentNode: "n7",
    }),
  });

  applyCreateNode(g, {
    id: "n12",
    summary: "Build failed: TS2322 at router.ts",
    importance: "medium",
    parentNode: null,
    state: "new",
  });

  applyCreateNode(g, {
    id: "n20",
    summary: "Old YAML config notes",
    importance: "low",
    parentNode: null,
    state: "active",
  });
  applySetMeta(g, { nodeId: "n20", importance: null, archived: true, obsolete: null, summary: null }, MUTATE_SOURCE);

  applyCreateNode(g, {
    id: "n99",
    summary: "Auth via sessions (old approach)",
    importance: "medium",
    parentNode: null,
    state: "active",
  });
  applyRecordObservation(g, {
    obs: makeObservation({
      id: "o9",
      content: "Sessions were the prior auth approach",
      importance: "medium",
      sourceEntryIds: ["3"],
      timestamp: T3,
      parentNode: "n99",
    }),
  });
  applySupersede(g, { nodeId: "n7", supersededNodeIds: ["n99"] }, MUTATE_SOURCE);

  setClock(null);
  return g;
}

/** Seed the store singleton with a fresh graph (source-graph mode). */
function seedSource(): MemkeeperGraph {
  resetForNewSession();
  const graph = buildGraph();
  const store = getGraphStore();
  store.graph = graph;
  store.selectedTree = null;
  return graph;
}

/** Seed the store with a source graph AND a persisted selected tree built from a
 *  SMALLER curated graph (so selected-root reads distinct ids/summaries). */
function seedSelected(): { source: MemkeeperGraph; curated: MemkeeperGraph } {
  resetForNewSession();
  const source = buildGraph();
  // curated tree: only n7 + n8 + o5 + oInitialPrompt (a Selector's pick)
  setClock(() => T0);
  const curated = new MemkeeperGraph({ nodes: new Map(), observations: new Map(), nextObsId: 1, nextNodeId: 1 });
  applyCreateNode(curated, {
    id: N_GOAL,
    summary: "CURATED goal: stable public API",
    importance: "critical",
    parentNode: null,
    state: "active",
  });
  applyRecordObservation(curated, {
    obs: makeObservation({
      id: "oInitialPrompt",
      content: "build a memory extension",
      importance: "critical",
      sourceEntryIds: ["1"],
      timestamp: T0,
      parentNode: N_GOAL,
    }),
  });
  applyCreateNode(curated, {
    id: "n7",
    summary: "CURATED Auth to JWT",
    importance: "high",
    parentNode: null,
    state: "active",
  });
  applyRecordObservation(curated, {
    obs: makeObservation({
      id: "o5",
      content: "Chose JWT for stateless auth",
      importance: "high",
      sourceEntryIds: ["2"],
      timestamp: T1,
      parentNode: "n7",
    }),
  });
  setClock(null);

  const store = getGraphStore();
  store.graph = source;
  const snapshot = encodeSelection(curated, "oInitialPrompt", store.observerFrontier);
  persistSelectedTree(NO_OP_CTX, snapshot);
  return { source, curated };
}

function setRenderMode(renderMode: MemkeeperConfig["renderMode"]): void {
  _setGetMemkeeperSettings(() => ({ ...({ renderMode } as Partial<MemkeeperConfig>) }) as MemkeeperConfig);
}

function clearRenderMode(): void {
  _setGetMemkeeperSettings(null);
}

type ToolResult = { content: { type: string; text?: string }[]; details: unknown };

async function recall(tool: ToolDefinition, args: Record<string, unknown>): Promise<ToolResult> {
  const result = await tool.execute(
    "call-1",
    args as unknown as Parameters<typeof tool.execute>[1],
    new AbortController().signal,
    undefined,
    undefined as unknown as Parameters<typeof tool.execute>[4],
  );
  return result as unknown as ToolResult;
}

function text(result: ToolResult): string {
  return result.content.map((c) => c.text ?? "").join("\n");
}

describe("mk_recall", () => {
  const tool = () => createMkRecallTool();

  describe("ids — exact lookup", () => {
    it("returns a node and its children (ls-style, indented)", async () => {
      seedSource();
      const out = text(await recall(tool(), { ids: ["n7"] }));
      const lines = out.split("\n");
      // header at depth 0
      expect(lines[0]).toContain("📁 n7");
      expect(lines[0]).toContain("Auth migration to JWT");
      // children indented
      expect(out).toContain("n8");
      expect(out).toContain("o5");
      // child n8 + o5 are indented (2-space) under the header
      expect(lines.some((l) => l.startsWith("  📁 n8"))).toBe(true);
      expect(lines.some((l) => l.startsWith("  📄 o5"))).toBe(true);
    });

    it("returns an observation's full content", async () => {
      seedSource();
      const out = text(await recall(tool(), { ids: ["o5"] }));
      expect(out).toContain("o5");
      expect(out).toContain("Chose JWT for stateless auth");
    });

    it("bypasses includeSuperseded — a superseded node still returns with its replacement", async () => {
      seedSource();
      const out = text(await recall(tool(), { ids: ["n99"] }));
      expect(out).toContain("n99");
      expect(out).toContain("🪦");
      expect(out).toContain("→ n7");
    });

    it("missing id → error string", async () => {
      seedSource();
      const out = text(await recall(tool(), { ids: ["nDoesNotExist"] }));
      expect(out).toContain("nDoesNotExist");
      // an error message, not a crash
      expect(out.toLowerCase()).toMatch(/no node|not found|unknown/);
    });
  });

  describe("query — regex search + ranking", () => {
    it("ranks by importance-then-recency, non-obsolete only (parent-state rule), flat with in <parent>", async () => {
      seedSource();
      const out = text(await recall(tool(), { query: "[Jj]wt|auth" }));
      // n7 (high, Auth...JWT) and o5 (high, ...auth) match; n99 is obsolete
      // (excluded by default parent-state rule)
      expect(out).toContain("n7");
      expect(out).toContain("o5");
      expect(out).toContain("in n7"); // o5 carries its parent
      expect(out).not.toContain("n99"); // obsolete, excluded
    });

    it("invalid regex → error string", async () => {
      seedSource();
      const out = text(await recall(tool(), { query: "(" }));
      expect(out.toLowerCase()).toMatch(/invalid|regex|pattern/);
    });

    it("obs ranking importance = max(obs, parent node) — a low obs under a critical node ranks as critical", async () => {
      resetForNewSession();
      setClock(() => T0);
      const g = new MemkeeperGraph({ nodes: new Map(), observations: new Map(), nextObsId: 1, nextNodeId: 1 });
      applyCreateNode(g, {
        id: "n1",
        summary: "Critical constraint area",
        importance: "critical",
        parentNode: null,
        state: "active",
      });
      applyCreateNode(g, {
        id: "n2",
        summary: "Low area",
        importance: "low",
        parentNode: null,
        state: "active",
      });
      // a LOW obs under the CRITICAL node, matching the same query as a low-obs
      // under the low node — the critical-parented one must rank first.
      applyRecordObservation(g, {
        obs: makeObservation({
          id: "o1",
          content: "shared detail marker",
          importance: "low",
          sourceEntryIds: ["x1"],
          timestamp: T1,
          parentNode: "n1",
        }),
      });
      applyRecordObservation(g, {
        obs: makeObservation({
          id: "o2",
          content: "shared detail marker",
          importance: "low",
          sourceEntryIds: ["x2"],
          timestamp: T1,
          parentNode: "n2",
        }),
      });
      setClock(null);
      getGraphStore().graph = g;

      const out = text(await recall(tool(), { query: "shared detail marker" }));
      const idxCrit = out.indexOf("o1");
      const idxLow = out.indexOf("o2");
      expect(idxCrit).toBeGreaterThan(-1);
      expect(idxLow).toBeGreaterThan(-1);
      expect(idxCrit).toBeLessThan(idxLow); // critical-parented ranks first
    });
  });

  describe("from/to — time range", () => {
    it("filters observations by timestamp range", async () => {
      seedSource();
      // only T1 (o5 at Jul 17 14:30) — exclude T3 (o9 under obsolete anyway)
      const out = text(await recall(tool(), { from: "2026-07-17T00:00:00Z", to: "2026-07-17T23:59:59Z" }));
      expect(out).toContain("o5"); // T1 within range
      // oInitialPrompt at T0 is also in range — both are Jul 17
      expect(out).toContain("oInitialPrompt");
      // n12/n20/n7 are nodes (not time-filtered) but only returned via query,
      // so a from/to-only search returns observations only
      expect(out).not.toMatch(/^\s*📁 n7\b/m);
    });
  });

  describe("includeSuperseded", () => {
    it("true includes obsolete (🪦 + → supersededBy)", async () => {
      seedSource();
      const out = text(await recall(tool(), { query: "[Ss]ession", includeSuperseded: true }));
      expect(out).toContain("n99");
      expect(out).toContain("🪦");
      expect(out).toContain("→ n7");
    });
  });

  describe("fullDetails", () => {
    it("shows full content; terse truncates; no sourceEntryIds in either", async () => {
      resetForNewSession();
      setClock(() => T0);
      const g = new MemkeeperGraph({ nodes: new Map(), observations: new Map(), nextObsId: 1, nextNodeId: 1 });
      applyCreateNode(g, {
        id: "n1",
        summary: "Node one",
        importance: "high",
        parentNode: null,
        state: "active",
      });
      const longBody = `First line of a long observation that continues at considerable length with enough words to push well past the terse one-line cap on its own before any continuation.
Second line with more detail that elaborates the point further and beyond.
Third line that concludes the lengthy multi-line observation body fully.`;
      applyRecordObservation(g, {
        obs: makeObservation({
          id: "oLong" as ObsId,
          content: longBody,
          importance: "high",
          sourceEntryIds: ["e1", "e2"],
          timestamp: T1,
          parentNode: "n1",
        }),
      });
      setClock(null);
      getGraphStore().graph = g;

      const terse = text(await recall(tool(), { ids: ["oLong"] }));
      const full = text(await recall(tool(), { ids: ["oLong"], fullDetails: true }));

      // terse collapses to a single line and truncates (first line exceeds the
      // terse cap on its own, so the second line never appears)
      expect(terse).not.toContain("Second line with more detail");
      // fullDetails shows the full multi-line content (all three lines intact)
      expect(full).toContain("First line of a long observation that continues");
      expect(full).toContain("Second line with more detail that elaborates");
      expect(full).toContain("Third line that concludes");
      // neither leaks sourceEntryIds (provenance is internal)
      expect(terse).not.toContain("e1");
      expect(terse).not.toContain("sourceEntryIds");
      expect(full).not.toContain("e2");
      expect(full).not.toContain("sourceEntryIds");
    });
  });

  describe("pagination", () => {
    it("take/afterId paginate + footer; take:0 returns all", async () => {
      resetForNewSession();
      setClock(() => T0);
      const g = new MemkeeperGraph({ nodes: new Map(), observations: new Map(), nextObsId: 1, nextNodeId: 1 });
      // 3 roots matching a query, all active
      for (let i = 1; i <= 3; i += 1) {
        applyCreateNode(g, {
          id: `n${i}` as Node["id"],
          summary: `alpha item ${i}`,
          importance: "medium",
          parentNode: null,
          state: "active",
        });
      }
      setClock(null);
      getGraphStore().graph = g;

      const page1 = text(await recall(tool(), { query: "alpha", take: 2 }));
      expect(page1).toContain("afterId=");
      expect(page1).toContain("n1");
      expect(page1).toContain("n2");
      expect(page1).not.toContain("n3");

      // take:0 returns all
      const all = text(await recall(tool(), { query: "alpha", take: 0 }));
      expect(all).toContain("n1");
      expect(all).toContain("n2");
      expect(all).toContain("n3");
    });
  });

  describe("renderMode retarget", () => {
    it("observations-root reads the source graph", async () => {
      seedSource();
      setRenderMode("observations-root");
      try {
        const out = text(await recall(tool(), { ids: ["n7"] }));
        expect(out).toContain("Auth migration to JWT");
      } finally {
        clearRenderMode();
      }
    });

    it("selected-root reads the persisted selected tree (its own summaries)", async () => {
      seedSelected();
      setRenderMode("selected-root");
      try {
        const out = text(await recall(tool(), { ids: ["n7"] }));
        // the curated tree's n7 has a DISTINCT summary ("CURATED Auth to JWT")
        expect(out).toContain("CURATED Auth to JWT");
        expect(out).not.toContain("Auth migration to JWT");
      } finally {
        clearRenderMode();
      }
    });

    it("selected-root with NO tree → falls back to the source graph", async () => {
      seedSource(); // selectedTree is null
      setRenderMode("selected-root");
      try {
        const out = text(await recall(tool(), { ids: ["n7"] }));
        expect(out).toContain("Auth migration to JWT");
      } finally {
        clearRenderMode();
      }
    });
  });

  describe("render identity (agent == user)", () => {
    it("returns one text content block (one render, seen by both agent and user)", async () => {
      seedSource();
      const result = await recall(tool(), { query: "[Jj]wt" });
      // single text content block
      expect(result.content).toHaveLength(1);
      expect(result.content[0]?.type).toBe("text");
    });
  });
});
