// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import {
  _resetGetMemkeeperSettings,
  _setGetMemkeeperSettings,
  DEFAULT_CONFIG,
  type MemkeeperConfig,
} from "../../src/config/schema.js";
import {
  applyCreateNode,
  applyRecordObservation,
  applySetMeta,
  applySupersede,
  MUTATE_SOURCE,
  setClock,
} from "../../src/graph/mutations.js";
import { makeMkRecallTool } from "../../src/recall/mk-recall.js";
import { encodeSelection } from "../../src/store/codecs.js";
import { getGraphStore, persistSelectedTree, resetForNewSession } from "../../src/store/graph-store.js";
import { MemkeeperGraph, makeObservation, N_GOAL, type Node, type ObsId } from "../../src/types.js";

const T0 = "2026-07-17T09:00:00.000Z";
const T1 = "2026-07-17T14:30:00.000Z";
const T3 = "2026-07-19T10:00:00.000Z";

const NO_OP_CTX = {
  appendEntry: () => {},
  getLeafId: () => "leaf-1",
  getBranch: () => [],
} as const;

// --- test graph ------------------------------------------------------------
// Roots: nGoal (crit, oInitialPrompt) · n7 (high, "Auth migration to JWT",
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
    importance: "crit",
    parentNode: null,
    state: "active",
  });
  applyRecordObservation(g, {
    obs: makeObservation({
      id: "oInitialPrompt",
      content: "build a memory extension",
      importance: "crit",
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
    importance: "med",
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
    importance: "med",
    parentNode: null,
    state: "active",
  });
  applyRecordObservation(g, {
    obs: makeObservation({
      id: "o9",
      content: "Sessions were the prior auth approach",
      importance: "med",
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
    importance: "crit",
    parentNode: null,
    state: "active",
  });
  applyRecordObservation(curated, {
    obs: makeObservation({
      id: "oInitialPrompt",
      content: "build a memory extension",
      importance: "crit",
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
  applyCreateNode(curated, {
    id: "n8",
    summary: "CURATED JWT library pick",
    importance: "high",
    parentNode: "n7",
    state: "active",
  });
  // NOTE: in the curated tree o5 is regrouped under n8 (a child of n7), but in
  // the SOURCE graph o5 sits directly under n7. This divergence is what the
  // selected-root-search-parent test asserts (tree parent, not source).
  applyRecordObservation(curated, {
    obs: makeObservation({
      id: "o5",
      content: "Chose JWT for stateless auth",
      importance: "high",
      sourceEntryIds: ["2"],
      timestamp: T1,
      parentNode: "n8",
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
  _setGetMemkeeperSettings(() => ({ ...DEFAULT_CONFIG, renderMode }));
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
  const tool = () => makeMkRecallTool();

  /** Build a fresh store whose graph holds one node n1 with a single large
   *  observation o1 (4000 `a`s + `!`) — a payload that makes a catastrophic
   *  polynomial regex hang so the timeout path can be exercised. Returns the
   *  live graph for assertion. */
  function slowGrepTarget(): MemkeeperGraph {
    resetForNewSession();
    setClock(() => T0);
    const g = new MemkeeperGraph({ nodes: new Map(), observations: new Map(), nextObsId: 1, nextNodeId: 1 });
    applyCreateNode(g, {
      id: "n1",
      summary: "slow target",
      importance: "med",
      parentNode: null,
      state: "active",
    });
    applyRecordObservation(g, {
      obs: makeObservation({
        id: "o1",
        content: "a".repeat(4000).concat("!"),
        importance: "med",
        sourceEntryIds: [],
        timestamp: T0,
        parentNode: "n1",
      }),
    });
    getGraphStore().graph = g;
    return g;
  }

  describe("ids — exact lookup", () => {
    it("returns a node and its children (ls-style, indented)", async () => {
      seedSource();
      const out = text(await recall(tool(), { ids: ["n7"] }));
      const lines = out.split("\n");
      // header at depth 0
      expect(lines[0]).toContain("n7");
      expect(lines[0]).toContain("Auth migration to JWT");
      // children indented
      expect(out).toContain("n8");
      expect(out).toContain("o5");
      // child n8 + o5 are indented (2-space) under the header
      expect(lines.some((l) => l.startsWith("  n8"))).toBe(true);
      expect(lines.some((l) => l.startsWith("  o5"))).toBe(true);
    });

    it("returns an observation's full content", async () => {
      seedSource();
      const out = text(await recall(tool(), { ids: ["o5"] }));
      expect(out).toContain("o5");
      expect(out).toContain("Chose JWT for stateless auth");
      // observation line uses the shared ·-delimited format (no stale space between
      // id and importance); the default terse path carries content + timestamp.
      expect(out).toContain("o5 · high · Chose JWT for stateless auth · 1line 7tokens · Jul 17 14:30");
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

    it("missing id does NOT flag details.error (conveyed by text, like cat)", async () => {
      seedSource();
      // fully missing
      const fullyMissing = await recall(tool(), { ids: ["nDoesNotExist"] });
      expect(fullyMissing.details).not.toMatchObject({ error: true });
      // partial missing (one good + one bad) — still no whole-result error
      const partial = await recall(tool(), { ids: ["n7", "nDoesNotExist"] });
      expect(partial.details).not.toMatchObject({ error: true });
      expect(text(partial)).toContain("Auth migration to JWT");
    });
  });

  describe("query — regex search + ranking", () => {
    afterEach(() => _resetGetMemkeeperSettings());
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

    it("kills a slow regex past the timeout and surfaces a timeout error (worker-thread backstop)", async () => {
      _setGetMemkeeperSettings(() => ({ ...DEFAULT_CONFIG, findTimeoutMs: 300 }));
      seedSource();
      // a guard-slipping polynomial shape over a large observation content
      slowGrepTarget();
      const out = text(await recall(tool(), { query: "(.+a)(.+a)b" }));
      expect(out.toLowerCase()).toContain("timed out");
      _setGetMemkeeperSettings(null);
    });

    it("obs ranking importance = max(obs, parent node) — a low obs under a crit node ranks as crit", async () => {
      resetForNewSession();
      setClock(() => T0);
      const g = new MemkeeperGraph({ nodes: new Map(), observations: new Map(), nextObsId: 1, nextNodeId: 1 });
      applyCreateNode(g, {
        id: "n1",
        summary: "Critical constraint area",
        importance: "crit",
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
      // under the low node — the crit-parented one must rank first.
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
      expect(idxCrit).toBeLessThan(idxLow); // crit-parented ranks first
    });
  });

  describe("from/to — time range", () => {
    it("filters observations by timestamp range (from inclusive, to exclusive)", async () => {
      seedSource();
      // T1 (o5 at Jul 17 14:30) within [00:00, 23:59:59); oInitialPrompt (T0 09:00) too.
      const out = text(await recall(tool(), { from: "2026-07-17 00:00", to: "2026-07-17 23:59:59" }));
      expect(out).toContain("o5");
      expect(out).toContain("oInitialPrompt");
      // nodes are not time-filtered but only surface via query, so a from/to-only
      // search returns observations only
      expect(out).not.toMatch(/^\s*n7\b/m);
    });

    it("to is exclusive: an observation at the exact to bound is dropped", async () => {
      seedSource();
      // o5 is at Jul 17 14:30; a `to` of 14:30 (exclusive) drops it, a `to` of 14:31 keeps it
      expect(text(await recall(tool(), { to: "2026-07-17 14:30" }))).not.toContain("o5");
      expect(text(await recall(tool(), { to: "2026-07-17 14:31" }))).toContain("o5");
    });

    it("from is inclusive: an observation at the exact from bound is kept", async () => {
      seedSource();
      // o5 at 14:30; `from` 14:30 keeps it (inclusive)
      expect(text(await recall(tool(), { from: "2026-07-17 14:30" }))).toContain("o5");
    });

    it("invalid `from` datetime → error string", async () => {
      seedSource();
      const out = text(await recall(tool(), { from: "not-a-date" }));
      expect(out.toLowerCase()).toMatch(/invalid.*from/);
    });

    it("invalid `to` datetime → error string", async () => {
      seedSource();
      const out = text(await recall(tool(), { to: "2026-13-45 99:99" }));
      expect(out.toLowerCase()).toMatch(/invalid.*to/);
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

    it("true with no query/from/to surfaces obsolete roots in the browse (not silently dropped)", async () => {
      seedSource();
      // no filters + includeSuperseded → browse includes obsolete root n99
      const out = text(await recall(tool(), { includeSuperseded: true }));
      expect(out).toContain("n99");
      expect(out).toContain("🪦");
    });
  });

  describe("query cap", () => {
    it("an over-long regex returns an error string (not a crash)", async () => {
      seedSource();
      const huge = `${"a|".repeat(300)}`;
      const out = text(await recall(tool(), { query: huge }));
      expect(out.toLowerCase()).toMatch(/too long|shorter|max|chars/);
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
          importance: "med",
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

    it("footer total counts ALL matches (not just the tail from the cursor)", async () => {
      resetForNewSession();
      setClock(() => T0);
      const g = new MemkeeperGraph({ nodes: new Map(), observations: new Map(), nextObsId: 1, nextNodeId: 1 });
      for (let i = 1; i <= 3; i += 1) {
        applyCreateNode(g, {
          id: `n${i}` as Node["id"],
          summary: `beta item ${i}`,
          importance: "med",
          parentNode: null,
          state: "active",
        });
      }
      setClock(null);
      getGraphStore().graph = g;

      // page 1: take 2 → footer shows total 3 + afterId=n1 (first item's id)
      const page1 = text(await recall(tool(), { query: "beta", take: 2 }));
      expect(page1).toContain("· 3 results");
      const afterMatch = page1.match(/afterId=(\S+)/);
      expect(afterMatch).not.toBeNull();
      const cursor = afterMatch?.[1] ?? "";

      // page 2: from the cursor → footer STILL shows total 3 (not 1)
      const page2 = text(await recall(tool(), { query: "beta", take: 2, afterId: cursor }));
      expect(page2).toContain("· 3 results");
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

    it("selected-root SEARCH shows the TREE parent (not the stale source parent) for a regrouped obs", async () => {
      // in seedSelected, o5 is under n8 in the curated tree but under n7 in the
      // source graph — search must render `in n8` (the tree parent).
      seedSelected();
      setRenderMode("selected-root");
      try {
        const out = text(await recall(tool(), { query: "Chose JWT" }));
        expect(out).toContain("o5");
        expect(out).toContain("in n8");
        expect(out).not.toMatch(/o5.*in n7/);
      } finally {
        clearRenderMode();
      }
    });

    it("selected-root skips a tree obsRef absent from the source store (defense-in-depth, no crash)", async () => {
      // fork#3 makes a dangling obsRef impossible by construction (the snapshot
      // is self-contained), but the guard exists as defense-in-depth — pin it:
      // a tree referencing an obs id NOT in the source graph is skipped gracefully.
      resetForNewSession();
      const source = buildGraph();
      setClock(() => T0);
      const curated = new MemkeeperGraph({ nodes: new Map(), observations: new Map(), nextObsId: 1, nextNodeId: 1 });
      applyCreateNode(curated, {
        id: "n50",
        summary: "node carrying a real + a phantom obs",
        importance: "high",
        parentNode: null,
        state: "active",
      });
      // o5 exists in the source graph (kept); o50 does NOT (skipped).
      applyRecordObservation(curated, {
        obs: makeObservation({
          id: "o5",
          content: "Chose JWT for stateless auth",
          importance: "high",
          sourceEntryIds: ["2"],
          timestamp: T1,
          parentNode: "n50",
        }),
      });
      applyRecordObservation(curated, {
        obs: makeObservation({
          id: "o50",
          content: "ghost observation with no source",
          importance: "low",
          sourceEntryIds: ["99"],
          timestamp: T1,
          parentNode: "n50",
        }),
      });
      setClock(null);
      const store = getGraphStore();
      store.graph = source;
      persistSelectedTree(NO_OP_CTX, encodeSelection(curated, null, store.observerFrontier));
      setRenderMode("selected-root");
      try {
        // ids lookup of the phantom resolves nothing; the real o5 still resolves.
        const idsOut = text(await recall(tool(), { ids: ["o50"] }));
        expect(idsOut.toLowerCase()).toMatch(/no node|not found|unknown|empty/);
        const realOut = text(await recall(tool(), { ids: ["o5"] }));
        expect(realOut).toContain("Chose JWT for stateless auth");
        // a search does not surface the phantom (no crash, no orphan line).
        const searchOut = text(await recall(tool(), { query: "ghost|JWT" }));
        expect(searchOut).not.toContain("o50");
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

    it("flags errors in details (invalid regex → details.error)", async () => {
      seedSource();
      const result = await recall(tool(), { query: "(" });
      expect(result.details).toMatchObject({ error: true });
    });

    it("successful lookups do not flag error in details", async () => {
      seedSource();
      const result = await recall(tool(), { ids: ["n7"] });
      expect(result.details).not.toMatchObject({ error: true });
    });
  });

  describe("stale cursor", () => {
    it("search: an afterId not in the results → stale-cursor error", async () => {
      seedSource();
      const out = text(await recall(tool(), { query: "[Jj]wt", afterId: "gone-id" }));
      expect(out.toLowerCase()).toMatch(/cursor|stale|not found|re-query/);
    });

    it("ids: an afterId pointing past the units → stale-cursor error", async () => {
      seedSource();
      const out = text(await recall(tool(), { ids: ["n7"], afterId: "gone-id" }));
      expect(out.toLowerCase()).toMatch(/cursor|stale|not found|re-query/);
    });
  });

  describe("search fullDetails", () => {
    it("fullDetails in a search shows the full multi-line observation content", async () => {
      resetForNewSession();
      setClock(() => T0);
      const g = new MemkeeperGraph({ nodes: new Map(), observations: new Map(), nextObsId: 1, nextNodeId: 1 });
      applyCreateNode(g, {
        id: "n1",
        summary: "Search target",
        importance: "high",
        parentNode: null,
        state: "active",
      });
      applyRecordObservation(g, {
        obs: makeObservation({
          id: "oLong" as ObsId,
          content: "alpha first.\nbeta second line.\ngamma third.",
          importance: "high",
          sourceEntryIds: ["e1"],
          timestamp: T1,
          parentNode: "n1",
        }),
      });
      setClock(null);
      getGraphStore().graph = g;

      const terse = text(await recall(tool(), { query: "alpha" }));
      const full = text(await recall(tool(), { query: "alpha", fullDetails: true }));
      // terse collapses the content to a single line (space-joined, no raw newline)
      expect(terse).toContain("alpha first. beta");
      expect(terse).not.toContain("alpha first.\nbeta");
      // fullDetails preserves the raw multi-line content (newline before beta)
      expect(full).toContain("alpha first.\nbeta second line");
      expect(full).toContain("gamma third.");
      // both carry the parent (flat search)
      expect(terse).toContain("in n1");
    });
  });

  // --- result token budget + targeted extraction (contentPattern / lines) --

  describe("result token budget + extraction", () => {
    it("fullDetails single observation is returned whole (uncapped)", async () => {
      seedSource();
      _setGetMemkeeperSettings(() => ({ ...DEFAULT_CONFIG, toolResultTokenBudget: 1 }));
      try {
        const out = text(await recall(tool(), { ids: ["o5"], fullDetails: true }));
        expect(out).toContain("Chose JWT for stateless auth");
        expect(out).not.toContain("budget reached");
      } finally {
        _setGetMemkeeperSettings(null);
      }
    });

    it("single observation + lines is uncapped (any mode)", async () => {
      seedSource();
      _setGetMemkeeperSettings(() => ({ ...DEFAULT_CONFIG, toolResultTokenBudget: 1 }));
      try {
        const out = text(await recall(tool(), { ids: ["o5"], lines: "1-1" }));
        expect(out).toContain("1: Chose JWT for stateless auth");
        expect(out).not.toContain("budget reached");
      } finally {
        _setGetMemkeeperSettings(null);
      }
    });

    it("a node with exactly one observation is uncapped (single-obs target)", async () => {
      // n7 has exactly one direct observation (o5); ids:["n7"] is a
      // single-observation target and must be uncapped regardless of mode.
      seedSource();
      _setGetMemkeeperSettings(() => ({ ...DEFAULT_CONFIG, toolResultTokenBudget: 1 }));
      try {
        const out = text(await recall(tool(), { ids: ["n7"], fullDetails: true }));
        expect(out).toContain("Chose JWT for stateless auth");
        expect(out).not.toContain("budget reached");
      } finally {
        _setGetMemkeeperSettings(null);
      }
    });

    it("single observation + contentPattern is uncapped (any mode)", async () => {
      seedSource();
      _setGetMemkeeperSettings(() => ({ ...DEFAULT_CONFIG, toolResultTokenBudget: 1 }));
      try {
        const out = text(await recall(tool(), { ids: ["o5"], contentPattern: "JWT" }));
        // the grep excerpt is present despite the 1-token budget (single-obs grep uncapped).
        expect(out).toContain("Chose JWT for stateless auth");
        expect(out).not.toContain("budget reached");
      } finally {
        _setGetMemkeeperSettings(null);
      }
    });

    it("a node with exactly one observation + lines is uncapped (any mode)", async () => {
      // n7 has exactly one direct observation (o5); the single-obs exception
      // applies even when the target is a node and the mode is lines.
      seedSource();
      _setGetMemkeeperSettings(() => ({ ...DEFAULT_CONFIG, toolResultTokenBudget: 1 }));
      try {
        const out = text(await recall(tool(), { ids: ["n7"], lines: "1-1" }));
        expect(out).toContain("1: Chose JWT for stateless auth");
        expect(out).not.toContain("budget reached");
      } finally {
        _setGetMemkeeperSettings(null);
      }
    });

    it("contentPattern extracts grep excerpts with line numbers", async () => {
      seedSource();
      const out = text(await recall(tool(), { ids: ["o5"], contentPattern: "JWT" }));
      expect(out).toContain("JWT");
      expect(out).toContain("o5");
    });

    it("rejects a malformed contentPattern with the compiler error", async () => {
      // resolveGrepSpec → tryCompileFindRegex error branch (unclosed paren) must
      // surface to the mk_recall caller (resolveRecallMode consumer).
      seedSource();
      const out = text(await recall(tool(), { ids: ["o5"], contentPattern: "a(" }));
      expect(out.toLowerCase()).toContain("invalid regex");
      expect(out).toContain("a(");
    });

    it("contentPattern on a NODE id re-renders its child observations with excerpts", async () => {
      // ids:[nodeId] + contentPattern → executeIds re-renders the node payload so
      // its child observations carry the grep excerpts (the node-payload + grep
      // branch that the obs-only test above does not cover).
      seedSource();
      const out = text(await recall(tool(), { ids: ["n7"], contentPattern: "JWT" }));
      // the node header is present.
      expect(out).toContain("n7");
      // the child observation o5 shows its grep excerpt line under the node.
      expect(out).toContain("1: Chose JWT for stateless auth");
    });

    it("lines returns a 1-indexed range", async () => {
      seedSource();
      const out = text(await recall(tool(), { ids: ["o5"], lines: "1-1" }));
      expect(out).toContain("1: Chose JWT for stateless auth");
    });

    it("contentPattern grep timeout surfaces a partial-excerpts note (not silent)", async () => {
      // a catastrophic contentPattern over a large observation must surface the
      // timeout note — not silently return partial excerpts with no signal.
      _setGetMemkeeperSettings(() => ({ ...DEFAULT_CONFIG, findTimeoutMs: 300 }));
      seedSource();
      slowGrepTarget();
      const out = text(await recall(tool(), { ids: ["o1"], contentPattern: "(.+a)(.+a)b" }));
      expect(out.toLowerCase()).toContain("grep timed out");
      _setGetMemkeeperSettings(null);
    });

    it("search-path contentPattern timeout surfaces the grep-timeout note", async () => {
      // The search path (query, not ids) has its OWN note plumbing
      // (mk-recall.ts:761). A contentPattern grep timeout over a large
      // observation found via search must surface the note too — not just the
      // ids path (covered above).
      _setGetMemkeeperSettings(() => ({ ...DEFAULT_CONFIG, findTimeoutMs: 300 }));
      seedSource();
      slowGrepTarget();
      // A time bound (from) makes this the search path (noFilters=false) with
      // no query (regex===null → every observation is a candidate); the
      // contentPattern then runs the catastrophic grep over o1's content.
      const out = text(await recall(tool(), { from: "2020-01-01 00:00", contentPattern: "(.+a)(.+a)b" }));
      expect(out.toLowerCase()).toContain("grep timed out");
      _setGetMemkeeperSettings(null);
    });

    it("search results bounded by toolResultTokenBudget", async () => {
      seedSource();
      _setGetMemkeeperSettings(() => ({ ...DEFAULT_CONFIG, toolResultTokenBudget: 2 }));
      try {
        const out = text(await recall(tool(), { query: "." }));
        expect(out).toContain("budget reached");
      } finally {
        _setGetMemkeeperSettings(null);
      }
    });

    it("rejects a malformed lines range with an error string", async () => {
      seedSource();
      const out = text(await recall(tool(), { ids: ["o5"], lines: "bad" }));
      expect(out).toContain("Invalid line range");
    });

    // --- contentPattern-alone greps every observation (not a root-browse no-op) ---

    it("contentPattern alone greps every observation (not root browse)", async () => {
      // No ids, no query, no bounds: contentPattern must grep all observations,
      // not silently fall back to the root-node browse view.
      seedSource();
      const out = text(await recall(tool(), { contentPattern: "JWT" }));
      expect(out).toContain("Chose JWT for stateless auth");
      expect(out).toContain("o5");
      // root-browse would show node one-liners (summaries), not a grep excerpt.
      expect(out).not.toContain("the public API must stay stable");
    });

    // --- lines is a single-observation slice ---

    it("lines without ids errors (no target)", async () => {
      seedSource();
      const out = text(await recall(tool(), { lines: "1-1" }));
      expect(out).toContain("single observation");
    });

    it("lines + query errors (query yields many)", async () => {
      seedSource();
      const out = text(await recall(tool(), { query: "auth", lines: "1-1" }));
      expect(out).toContain("single observation");
    });

    it("lines + contentPattern errors (mutually exclusive)", async () => {
      seedSource();
      const out = text(await recall(tool(), { ids: ["o5"], lines: "1-1", contentPattern: "JWT" }));
      expect(out).toContain("can't be combined");
    });

    it("lines on a multi-observation target errors", async () => {
      // two observation ids -> not a single-observation target.
      seedSource();
      const out = text(await recall(tool(), { ids: ["o5", "oInitialPrompt"], lines: "1-1" }));
      expect(out).toContain("single observation");
    });
  });
});
