// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import { afterEach, describe, expect, it } from "vitest";
import { makeBuilderReadTools } from "../../src/builder/tools.js";
import { _resetGetMemkeeperSettings, _setGetMemkeeperSettings, DEFAULT_CONFIG } from "../../src/config/schema.js";
import {
  applyCreateNode,
  applyRecordObservation,
  applySetMeta,
  applySupersede,
  MUTATE_SOURCE,
  setClock,
} from "../../src/graph/mutations.js";
import {
  countConnectedObservations,
  makeReadTools,
  nonObsoleteRootsOf,
  orderActiveSetRoots,
} from "../../src/graph/read-tools.js";
import { MemkeeperGraph, makeObservation, N_GOAL, N_IRRELEVANT, type NodeId, type ObsId } from "../../src/types.js";

const NOW = "2026-07-29T09:00:00.000Z";

// --- test graph ------------------------------------------------------------
// roots: nGoal (crit) + n7 (active, JWT auth) + n12 (active, build failed) +
//        n20 (archived, old config) + nOld (obsolete, superseded by n7).
// n7 has children: n8 (active, JWT lib pick) + observation o5 (chose JWT).
// nOld has observation oOld (obsolete's retained evidence).

function buildGraph(): MemkeeperGraph {
  setClock(() => NOW);
  const g = new MemkeeperGraph({ nodes: new Map(), observations: new Map(), nextObsId: 1, nextNodeId: 1 });

  // nGoal with oInitialPrompt
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
      summary: "build a memory extension",
      importance: "crit",
      sourceEntryIds: ["1"],
      timestamp: NOW,
      parentNode: N_GOAL,
    }),
  });

  // active root n7 (JWT auth) with child n8 + observation o5
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
      summary: "Chose JWT for stateless auth",
      importance: "high",
      sourceEntryIds: ["2"],
      timestamp: NOW,
      parentNode: "n7",
    }),
  });

  // active root n12 (build failed)
  applyCreateNode(g, {
    id: "n12",
    summary: "Build failed: TS2322 at router.ts:88",
    importance: "med",
    parentNode: null,
    state: "new",
  });

  // archived root n20 (old config)
  applyCreateNode(g, {
    id: "n20",
    summary: "Old YAML config notes",
    importance: "low",
    parentNode: null,
    state: "active",
  });
  applySetMeta(g, { nodeId: "n20", importance: null, archived: true, obsolete: null, summary: null }, MUTATE_SOURCE);

  // obsolete root nOld, superseded by n7, retaining an observation
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
      summary: "Sessions were the prior auth approach",
      importance: "med",
      sourceEntryIds: ["3"],
      timestamp: NOW,
      parentNode: "n99",
    }),
  });
  applySupersede(g, { nodeId: "n7", supersededNodeIds: ["n99"] }, MUTATE_SOURCE);

  setClock(null);
  return g;
}

function textOf(result: { content: { text?: string }[] }): string {
  return result.content.map((c) => c.text ?? "").join("\n");
}

type ToolResult = { content: { text?: string }[]; details: unknown };

async function callTool(
  tools: ReturnType<typeof makeBuilderReadTools>,
  name: string,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const tool = tools.find((t) => t.name === name);
  if (tool === undefined) throw new Error(`tool ${name} not found`);
  const result = await tool.execute("call-1", args as unknown as Parameters<typeof tool.execute>[1]);
  return result as unknown as ToolResult;
}

describe("Builder read tools", () => {
  const tools = () => makeBuilderReadTools(buildGraph());

  describe("ls — roots", () => {
    it("lists non-obsolete roots (nGoal, active, archived), excludes obsolete", async () => {
      const out = textOf(await callTool(tools(), "ls", {}));
      const lines = out.split("\n").filter((l) => l.trim() !== "");
      // nGoal, n7, n12, n20 present; nOld absent.
      expect(out).toContain("nGoal");
      expect(out).toContain("n7");
      expect(out).toContain("n12");
      expect(out).toContain("n20");
      expect(out).toContain("📦"); // archived glyph on n20
      expect(out).not.toContain("n99");
      // no o.. at root level in a roots listing (observations are always under a node)
      expect(lines.some((l) => l.includes("n12"))).toBe(true);
    });

    it("paginates roots with an afterId footer when more remain", async () => {
      const out = textOf(await callTool(tools(), "ls", { page: { take: 2 } }));
      expect(out).toContain("afterId=");
      expect(out).toMatch(/\+\d+ more/);
    });

    it("take=0 returns all non-obsolete roots with no pagination footer", async () => {
      const out = textOf(await callTool(tools(), "ls", { page: { take: 0 } }));
      expect(out).not.toContain("afterId=");
    });
  });

  describe("ls — children", () => {
    it("lists a node's direct children indented (nodes-first then observations)", async () => {
      const out = textOf(await callTool(tools(), "ls", { nodeId: "n7" }));
      // header is n7 itself, then children n8 + o5 indented.
      expect(out).toContain("n7");
      expect(out).toContain("n8");
      expect(out).toContain("o5");
      // child lines are indented (2-space) relative to the header
      const lines = out.split("\n").filter((l) => l.trim() !== "");
      const n8Line = lines.find((l) => l.includes("n8"));
      expect(n8Line?.startsWith("  ")).toBe(true);
    });
  });

  describe("cat", () => {
    it("shows a node's header + direct observations' full content (no child-node expansion)", async () => {
      const out = textOf(await callTool(tools(), "cat", { ids: ["n7"] }));
      expect(out).toContain("Auth migration to JWT"); // n7 summary
      expect(out).toContain("Chose JWT for stateless auth"); // o5 full content
      // child node n8 is NOT expanded as full content (its summary may appear in counts only)
      expect(out).not.toContain("Pick a JWT library");
    });

    it("shows an observation's full content + header WITHOUT sourceEntryIds", async () => {
      const out = textOf(await callTool(tools(), "cat", { ids: ["o5"] }));
      expect(out).toContain("Chose JWT for stateless auth");
      expect(out).toContain("o5");
      // header is exactly `id · importance · size · timestamp` (· separators,
      // matching the shared one-line render format); no sourceEntryIds provenance
      // rendered. The size (1line 7tokens) is the full content's line + token
      // count; cat omits the content snippet in the header (content follows).
      expect(out).toContain("o5 · high · 1line 7tokens · Jul 29 09:00");
      expect(out).not.toContain("sourceEntryIds");
      // content appears EXACTLY ONCE — the header is content-free (id·importance·timestamp).
      const occurrences = out.split("Chose JWT for stateless auth").length - 1;
      expect(occurrences).toBe(1);
    });

    it("paginates over the aggregated observation full-texts, not the requested ids", async () => {
      // a node with three observations: cat(node) page must window the OBSERVATIONS.
      const g = buildGraph();
      applyRecordObservation(g, {
        obs: makeObservation({
          id: "o6",
          summary: "Second JWT note",
          importance: "high",
          sourceEntryIds: ["4"],
          timestamp: NOW,
          parentNode: "n7",
        }),
      });
      applyRecordObservation(g, {
        obs: makeObservation({
          id: "o7",
          summary: "Third JWT note",
          importance: "high",
          sourceEntryIds: ["5"],
          timestamp: NOW,
          parentNode: "n7",
        }),
      });
      const localTools = makeBuilderReadTools(g);

      // page size 1 over the node's three observations → header (preamble) + first obs only.
      const page1 = textOf(await callTool(localTools, "cat", { ids: ["n7"], page: { take: 1 } }));
      expect(page1).toContain("Auth migration to JWT"); // n7 header (preamble, once)
      expect(page1).toMatch(/afterId=(\S+)/);
      // page1 carries exactly ONE observation full-text (o5) — the page-1 unit.
      expect(page1).toContain("o5");
      expect(page1).not.toContain("Second JWT note");

      // page 2 via the real afterId cursor yields the NEXT observation, no header repeat.
      const m = page1.match(/afterId=(\S+)/);
      const afterId = m !== null ? m[1] : "";
      expect(afterId).toBe("o5");
      const page2 = textOf(await callTool(localTools, "cat", { ids: ["n7"], page: { take: 1, afterId } }));
      // the n7 header must NOT repeat on page 2 (it rode page 1 as a preamble).
      const headerOccurrences = page2.split("Auth migration to JWT").length - 1;
      expect(headerOccurrences).toBe(0);
      // page2 carries the NEXT observation full-text (o6), not the stale-cursor message.
      expect(page2).toContain("Second JWT note");
      expect(page2).not.toContain("Cursor");
    });
  });

  describe("find", () => {
    it("matches across node summaries + observation content (non-obsolete only)", async () => {
      const out = textOf(await callTool(tools(), "find", { query: "JWT" }));
      // n7 (summary "Auth migration to JWT"), n8 ("Pick a JWT library"), o5 ("Chose JWT ...")
      expect(out).toContain("n7");
      expect(out).toContain("n8");
      expect(out).toContain("o5");
    });

    it("parent-state rule: excludes observations under an obsolete node by default", async () => {
      // oOld content "Sessions were the prior auth approach" — its parent nOld is obsolete.
      const out = textOf(await callTool(tools(), "find", { query: "Sessions" }));
      expect(out).not.toContain("o9");
      expect(out).not.toContain("n99");
    });

    it("includeSuperseded=true surfaces obsolete nodes + their evidence with 🪦 + → supersededBy", async () => {
      const out = textOf(await callTool(tools(), "find", { query: "Sessions|sessions", includeSuperseded: true }));
      expect(out).toContain("n99");
      expect(out).toContain("🪦");
      expect(out).toContain("→ n7");
    });

    it("flat results carry 'in <parent>' context", async () => {
      const out = textOf(await callTool(tools(), "find", { query: "JWT" }));
      // o5 lives under n7; n8 lives under n7.
      expect(out).toMatch(/in n7/);
    });

    it("malformed regex returns an error string, not a thrown crash", async () => {
      const out = textOf(await callTool(tools(), "find", { query: "(*invalid" }));
      expect(out.length).toBeGreaterThan(0);
      // it's an error message, not a thrown rejection — the call resolved.
      expect(out.toLowerCase()).toContain("regex");
    });

    it("rejects an overlong query with an error string", async () => {
      const out = textOf(await callTool(tools(), "find", { query: "a".repeat(600) }));
      expect(out.toLowerCase()).toContain("too long");
    });

    it("rejects a catastrophic-backtracking regex with an error string (ReDoS guard)", async () => {
      const out = textOf(await callTool(tools(), "find", { query: "(a+)+" }));
      expect(out.toLowerCase()).toContain("backtrack");
    });

    it("rejects a non-capturing-group ReDoS bypass", async () => {
      const out = textOf(await callTool(tools(), "find", { query: "(?:a+)+" }));
      expect(out.toLowerCase()).toContain("backtrack");
    });

    it("returns 'No matches.' when nothing matches", async () => {
      const out = textOf(await callTool(tools(), "find", { query: "zzznomatch" }));
      expect(out).toContain("No matches");
    });

    it("kills a slow regex past the timeout and surfaces a timeout error (worker-thread backstop)", async () => {
      // A guard-slipping polynomial shape (each .+ greedily splits on a long
      // run of 'a's) over a large observation content — slow enough to exceed a
      // short timeout. This exercises the worker-thread kill path end-to-end.
      _setGetMemkeeperSettings(() => ({ ...DEFAULT_CONFIG, findTimeoutMs: 300 }));
      const g = buildGraph();
      applyRecordObservation(g, {
        obs: makeObservation({
          id: "o100",
          summary: "a".repeat(4000).concat("!"),
          importance: "med",
          sourceEntryIds: [],
          timestamp: NOW,
          parentNode: "n7",
        }),
      });
      const localTools = makeBuilderReadTools(g);
      const out = textOf(await callTool(localTools, "find", { query: "(.+a)(.+a)b" }));
      expect(out.toLowerCase()).toContain("timed out");
    });

    afterEach(() => _resetGetMemkeeperSettings());
  });

  describe("find has no `lines` param (incompatible with required query)", () => {
    it("the find schema omits lines", () => {
      const tools = makeBuilderReadTools(buildGraph());
      const find = tools.find((t) => t.name === "find");
      if (find === undefined) throw new Error("find tool not found");
      const props = (find.parameters as { properties: Record<string, unknown> }).properties;
      expect("lines" in props).toBe(false);
      // contentPattern remains (grep within query matches).
      expect("contentPattern" in props).toBe(true);
    });
  });

  describe("cat `lines` is a single-observation slice", () => {
    it("cat lines + contentPattern errors (mutually exclusive)", async () => {
      const out = textOf(await callTool(tools(), "cat", { ids: ["o5"], lines: "1-1", contentPattern: "JWT" }));
      expect(out).toContain("can't be combined");
    });

    it("cat lines on a multi-observation node errors", async () => {
      // n7 has one obs (o5) here; use two observation ids for a multi-obs target.
      const out = textOf(await callTool(tools(), "cat", { ids: ["o5", "oInitialPrompt"], lines: "1-1" }));
      expect(out).toContain("single observation");
    });

    it("cat lines on a single observation works", async () => {
      const out = textOf(await callTool(tools(), "cat", { ids: ["o5"], lines: "1-1" }));
      expect(out).toContain("1: Chose JWT for stateless auth");
    });
  });

  describe("cursor pagination round-trip", () => {
    it("a second page using the prior afterId yields the NEXT items, no duplicates", async () => {
      const page1 = textOf(await callTool(tools(), "ls", { page: { take: 2 } }));
      // extract the afterId from the footer
      const match = page1.match(/afterId=(\S+)/);
      expect(match).not.toBeNull();
      const afterId = match !== null ? match[1] : "";
      const page2 = textOf(await callTool(tools(), "ls", { page: { take: 2, afterId } }));
      // page2 returns real next content (at least one root line, not the stale-cursor message)
      expect(page2).not.toContain("Cursor");
      const page2RootLines = page2.split("\n").filter((l) => /^n\S+/.test(l));
      expect(page2RootLines.length).toBeGreaterThan(0);
      // page1 roots must NOT reappear on page2 (no duplicate re-delivery)
      const page1Ids = page1
        .split("\n")
        .map((l) => l.match(/^(n\S+)/))
        .filter((m): m is RegExpMatchArray => m !== null)
        .map((m) => m[1]);
      for (const id of page1Ids) {
        const asLine = page2.split("\n").some((l) => l.startsWith(`${id} `));
        expect(asLine).toBe(false);
      }
    });

    it("a negative take is clamped to 'all' (no fabricated +N more count)", async () => {
      const out = textOf(await callTool(tools(), "ls", { page: { take: -3 } }));
      // all non-obsolete roots returned, no pagination footer.
      expect(out).not.toContain("afterId=");
      expect(out).not.toContain("+0 more");
      expect(out).toContain("nGoal");
    });

    it("a stale afterId (cursor removed) yields an actionable re-query message, not duplicates", async () => {
      // 'nX' is not a root in this graph → cursor-not-found → actionable message.
      const out = textOf(await callTool(tools(), "ls", { page: { take: 2, afterId: "nX-not-present" } }));
      expect(out.toLowerCase()).toContain("cursor");
      expect(out.toLowerCase()).toContain("afterid");
    });

    it("take:0 (all) with a valid afterId returns everything from the cursor onward", async () => {
      // take:0 means 'no limit' but still respects the afterId cursor — returns
      // the whole cursor-shifted tail, not the whole list from the start.
      const page1 = textOf(await callTool(tools(), "ls", { page: { take: 2 } }));
      const match = page1.match(/afterId=(\S+)/);
      expect(match).not.toBeNull();
      const afterId = match !== null ? match[1] : "";
      const all = textOf(await callTool(tools(), "ls", { page: { take: 0, afterId } }));
      // the first page's roots must NOT reappear (cursor shifted past them)
      const page1Ids = page1
        .split("\n")
        .map((l) => l.match(/^(n\S+)/))
        .filter((m): m is RegExpMatchArray => m !== null)
        .map((m) => m[1]);
      for (const id of page1Ids) {
        expect(all.split("\n").some((l) => l.startsWith(`${id} `))).toBe(false);
      }
    });

    it("take:0 (all) with a stale afterId reports the stale cursor, not everything", async () => {
      const out = textOf(await callTool(tools(), "ls", { page: { take: 0, afterId: "nX-not-present" } }));
      expect(out.toLowerCase()).toContain("cursor");
    });
  });

  describe("error + empty paths", () => {
    it("ls of an unknown nodeId returns a not-found error", async () => {
      const out = textOf(await callTool(tools(), "ls", { nodeId: "nX" }));
      expect(out).toContain("No node");
    });

    it("cat of an unknown id returns a not-found block", async () => {
      const out = textOf(await callTool(tools(), "cat", { ids: ["nX"] }));
      expect(out).toContain("No node or observation");
    });
  });
});

describe("read-tool viewer parameterization (Builder vs nonBuilder)", () => {
  // n12 is a `new` root in buildGraph(). The 🆕 glyph is Builder-only; every
  // other consumer (Selector, mk_recall, commands, compaction summary) renders
  // `new` as `active` (no glyph) per the viewer-dependent render rule.
  it("builder viewer renders a new node with the 🆕 glyph", async () => {
    const builderTools = makeReadTools(buildGraph(), "builder");
    const out = textOf(await callTool(builderTools, "ls", {}));
    expect(out).toContain("n12");
    expect(out).toContain("🆕");
  });

  it("nonBuilder viewer renders a new node as active (no 🆕 glyph)", async () => {
    const nonBuilderTools = makeReadTools(buildGraph(), "nonBuilder");
    const out = textOf(await callTool(nonBuilderTools, "ls", {}));
    expect(out).toContain("n12");
    expect(out).not.toContain("🆕");
  });
});

describe("nonObsoleteRootsOf (shared root filter)", () => {
  it("returns root nodes (parentNode null) and drops obsolete, unsorted", () => {
    const graph = buildGraph();
    const roots = nonObsoleteRootsOf([...graph.nodes.values()]);
    const ids = roots.map((n) => n.id).toSorted();
    // buildGraph has nGoal, n7, n12(new), n20(archived) as non-obsolete roots;
    // n99 is obsolete → dropped.
    expect(ids).toContain("nGoal");
    expect(ids).toContain("n7");
    expect(ids).toContain("n12");
    expect(ids).toContain("n20");
    expect(ids).not.toContain("n99");
  });

  it("works on any iterable of renderable nodes (no graph required)", () => {
    const arbitrary = [
      { id: "a", parentNode: null, state: "active" },
      { id: "b", parentNode: null, state: "obsolete" },
      { id: "c", parentNode: "a", state: "active" }, // not a root
    ] as unknown as import("../../src/format/render.js").RenderableNode[];
    const roots = nonObsoleteRootsOf(arbitrary);
    expect(roots.map((n) => n.id)).toEqual(["a"]);
  });
});

describe("orderActiveSetRoots — canonical active-set ordering", () => {
  // Renders directly the contract loop-7 routed /mk:ls and mk_recall browse
  // through (nGoal first, nIrrelevant last, the rest by importance then
  // recency) — a partition regression would otherwise pass the whole suite.
  const R = (over: Partial<Record<string, unknown>> & { id: string }) =>
    over as unknown as import("../../src/format/render.js").RenderableNode;
  const HIGH_RECENT = R({ id: "n7", importance: "high", timestamps: { rangeEnd: "2026-07-29T09:00:00Z" } });
  const HIGH_OLDER = R({ id: "n8", importance: "high", timestamps: { rangeEnd: "2026-07-28T09:00:00Z" } });
  const MED = R({ id: "n12", importance: "med", timestamps: { rangeEnd: "2026-07-29T10:00:00Z" } });
  const GOAL = R({ id: N_GOAL, importance: "crit", timestamps: { rangeEnd: "2026-07-28T08:00:00Z" } });
  const IRRELEVANT = R({ id: N_IRRELEVANT, importance: "med", timestamps: { rangeEnd: "2026-07-29T11:00:00Z" } });

  it("places nGoal first and nIrrelevant last regardless of importance/recency", () => {
    // feed them out of order: irrelevant + med first, goal last
    const ordered = orderActiveSetRoots([IRRELEVANT, MED, HIGH_RECENT, GOAL, HIGH_OLDER]);
    const ids = ordered.map((n) => n.id);
    expect(ids[0]).toBe(N_GOAL);
    expect(ids[ids.length - 1]).toBe(N_IRRELEVANT);
  });

  it("orders the rest by importance desc then recency desc", () => {
    const ordered = orderActiveSetRoots([MED, HIGH_OLDER, HIGH_RECENT, GOAL, IRRELEVANT]);
    // nGoal → high(recent) → high(older) → med → nIrrelevant
    expect(ordered.map((n) => n.id)).toEqual([N_GOAL, "n7", "n8", "n12", N_IRRELEVANT]);
  });

  it("works with neither special node present (plain importance/recency)", () => {
    const ordered = orderActiveSetRoots([MED, HIGH_OLDER, HIGH_RECENT]);
    expect(ordered.map((n) => n.id)).toEqual(["n7", "n8", "n12"]);
  });
});

// --- result token budget + targeted extraction (contentPattern / lines) --

describe("result token budget + extraction", () => {
  /** Build a graph whose o5 observation has multi-line grep-able content. */
  function grepGraph(): MemkeeperGraph {
    setClock(() => NOW);
    const g = new MemkeeperGraph({ nodes: new Map(), observations: new Map(), nextObsId: 1, nextNodeId: 1 });
    applyCreateNode(g, { id: N_GOAL, summary: "Goal", importance: "crit", parentNode: null, state: "active" });
    applyCreateNode(g, {
      id: "n7" as NodeId,
      summary: "Auth migration to JWT",
      importance: "high",
      parentNode: null,
      state: "active",
    });
    applyRecordObservation(g, {
      obs: makeObservation({
        id: "o5" as ObsId,
        summary: "line one\nthe token is secret\nline three\ntoken refresh logic\nline five",
        importance: "high",
        timestamp: NOW,
        sourceEntryIds: ["e5"],
        parentNode: "n7" as NodeId,
      }),
    });
    setClock(null);
    return g;
  }

  afterEach(() => _resetGetMemkeeperSettings());

  it("cat budget truncates multi-observation output with a footer", async () => {
    // two nodes, each with a big-content observation; tight budget keeps headers
    // + stops expanding.
    _setGetMemkeeperSettings(() => ({ ...DEFAULT_CONFIG, toolResultTokenBudget: 10 }));
    const g = grepGraph();
    applyCreateNode(g, {
      id: "n8" as NodeId,
      summary: "other",
      importance: "med",
      parentNode: null,
      state: "active",
    });
    applyRecordObservation(g, {
      obs: makeObservation({
        id: "o9" as ObsId,
        summary: "x".repeat(200),
        importance: "med",
        timestamp: NOW,
        sourceEntryIds: ["e9"],
        parentNode: "n8" as NodeId,
      }),
    });
    const out = textOf(await callTool(makeBuilderReadTools(g), "cat", { ids: ["n7", "n8"] }));
    expect(out).toContain("budget reached");
  });

  it("cat single observation is returned whole (uncapped)", async () => {
    _setGetMemkeeperSettings(() => ({ ...DEFAULT_CONFIG, toolResultTokenBudget: 1 }));
    const out = textOf(await callTool(makeBuilderReadTools(grepGraph()), "cat", { ids: ["o5"] }));
    // the full multi-line content is present despite the 1-token budget.
    expect(out).toContain("the token is secret");
    expect(out).toContain("line five");
    expect(out).not.toContain("budget reached");
  });

  it("cat multi-observation node with a small take is NOT uncapped (counts target, not window)", async () => {
    // a node with TWO observations, requested with take:1 so the window holds a
    // single content-bearing unit. The single-obs exception must count the
    // TARGET's connected observations (2), not the paginated window (1), so the
    // budget cap still applies.
    _setGetMemkeeperSettings(() => ({ ...DEFAULT_CONFIG, toolResultTokenBudget: 1 }));
    const g = buildGraph();
    applyRecordObservation(g, {
      obs: makeObservation({
        id: "o200",
        summary: "second observation under n7",
        importance: "med",
        sourceEntryIds: [],
        timestamp: NOW,
        parentNode: "n7",
      }),
    });
    const out = textOf(await callTool(makeBuilderReadTools(g), "cat", { ids: ["n7"], page: { take: 1 } }));
    expect(out).toContain("budget reached");
  });

  it("cat single observation + lines is uncapped (any mode)", async () => {
    // a single-observation target is uncapped regardless of mode — even lines.
    _setGetMemkeeperSettings(() => ({ ...DEFAULT_CONFIG, toolResultTokenBudget: 1 }));
    const out = textOf(await callTool(makeBuilderReadTools(grepGraph()), "cat", { ids: ["o5"], lines: "2-4" }));
    expect(out).toContain("2: the token is secret");
    expect(out).toContain("4: token refresh logic");
    expect(out).not.toContain("budget reached");
  });

  it("cat single observation + contentPattern is uncapped (any mode)", async () => {
    _setGetMemkeeperSettings(() => ({ ...DEFAULT_CONFIG, toolResultTokenBudget: 1 }));
    const out = textOf(
      await callTool(makeBuilderReadTools(grepGraph()), "cat", { ids: ["o5"], contentPattern: "token" }),
    );
    // both token matches are present despite the 1-token budget (single-obs grep uncapped).
    expect(out).toContain("2: the token is secret");
    expect(out).toContain("4: token refresh logic");
    expect(out).not.toContain("budget reached");
  });

  it("cat contentPattern returns grep excerpts with line numbers", async () => {
    const out = textOf(
      await callTool(makeBuilderReadTools(grepGraph()), "cat", { ids: ["o5"], contentPattern: "token" }),
    );
    expect(out).toContain("2: the token is secret");
    expect(out).toContain("4: token refresh logic");
    // the obs header (content-free) leads the block.
    expect(out).toContain("o5");
  });

  it("cat contentPattern on a node keeps it as a structural header when a child obs matches", async () => {
    // #51: n7's summary has no 'secret', but its child o5 content does → n7 is
    // kept as the structural parent header and o5 shows its excerpt.
    const out = textOf(
      await callTool(makeBuilderReadTools(grepGraph()), "cat", { ids: ["n7"], contentPattern: "secret" }),
    );
    expect(out).toContain("n7"); // structural header kept (descendant matches)
    expect(out).toContain("2: the token is secret"); // o5 excerpt
  });

  it("cat contentPattern drops a node with no summary or child match", async () => {
    // #51: nothing under n7 matches 'XYZ' → the whole node is dropped → empty.
    const out = textOf(
      await callTool(makeBuilderReadTools(grepGraph()), "cat", { ids: ["n7"], contentPattern: "XYZ" }),
    );
    expect(out).not.toContain("n7");
    expect(out).not.toContain("o5");
  });

  it("cat contentPattern timeout surfaces the partial-excerpts note", async () => {
    // a catastrophic contentPattern over a large observation must surface the
    // grep-timeout note (renderGrepBudgeted), not a silent partial result.
    _setGetMemkeeperSettings(() => ({ ...DEFAULT_CONFIG, findTimeoutMs: 300 }));
    const g = buildGraph();
    applyRecordObservation(g, {
      obs: makeObservation({
        id: "o100",
        summary: "a".repeat(4000).concat("!"),
        importance: "med",
        sourceEntryIds: [],
        timestamp: NOW,
        parentNode: "n7",
      }),
    });
    const localTools = makeBuilderReadTools(g);
    const out = textOf(await callTool(localTools, "cat", { ids: ["o100"], contentPattern: "(.+a)(.+a)b" }));
    expect(out.toLowerCase()).toContain("grep timed out");
    _resetGetMemkeeperSettings();
  });

  it("cat rejects a malformed contentPattern with the compiler error", async () => {
    // resolveGrepSpec → tryCompileFindRegex error branch (unclosed paren) must
    // surface to the caller, not be swallowed.
    const out = textOf(await callTool(makeBuilderReadTools(grepGraph()), "cat", { ids: ["o5"], contentPattern: "a(" }));
    expect(out.toLowerCase()).toContain("invalid regex");
    expect(out).toContain("a(");
  });

  it("cat lines returns the requested 1-indexed range, clamped", async () => {
    const out = textOf(await callTool(makeBuilderReadTools(grepGraph()), "cat", { ids: ["o5"], lines: "2-3" }));
    expect(out).toContain("2: the token is secret");
    expect(out).toContain("3: line three");
    expect(out).not.toContain("line five");
  });

  it("find contentPattern extracts excerpts from matched observations", async () => {
    const out = textOf(
      await callTool(makeBuilderReadTools(grepGraph()), "find", { query: "token", contentPattern: "secret" }),
    );
    expect(out).toContain("2: the token is secret");
  });

  it("find rejects a malformed contentPattern with the compiler error", async () => {
    // resolveGrepSpec → tryCompileFindRegex error branch (unclosed paren) must
    // surface to the find caller too.
    const out = textOf(
      await callTool(makeBuilderReadTools(grepGraph()), "find", { query: "token", contentPattern: "a(" }),
    );
    expect(out.toLowerCase()).toContain("invalid regex");
    expect(out).toContain("a(");
  });

  it("find with no query and no contentPattern returns a prompt error", async () => {
    const out = textOf(await callTool(makeBuilderReadTools(grepGraph()), "find", {}));
    expect(out.toLowerCase()).toContain("query");
    expect(out.toLowerCase()).toContain("contentpattern");
  });

  it("find contentPattern-alone matches node summaries too (not obs-only)", async () => {
    // #51: contentPattern filters over node summaries + observation content.
    // 'JWT|token' matches n7's summary (JWT) AND o5's content (token) → both
    // appear (n7 as a header, o5 with grep excerpts).
    const out = textOf(await callTool(makeBuilderReadTools(grepGraph()), "find", { contentPattern: "JWT|token" }));
    expect(out).toContain("n7"); // node summary match → header
    expect(out).toContain("o5"); // obs content match → excerpts
  });

  it("find contentPattern-alone drops non-matching items (filter, not browse)", async () => {
    // add a second observation whose content does NOT contain 'secret' and a
    // node whose summary doesn't — both must be filtered out.
    const g = grepGraph();
    applyRecordObservation(g, {
      obs: makeObservation({
        id: "o99" as ObsId,
        summary: "nothing relevant here",
        importance: "med",
        timestamp: NOW,
        sourceEntryIds: ["e99"],
        parentNode: "n7" as NodeId,
      }),
    });
    const out = textOf(await callTool(makeBuilderReadTools(g), "find", { contentPattern: "secret" }));
    expect(out).toContain("o5"); // matches 'secret'
    expect(out).not.toContain("o99"); // filtered out (no 'secret')
    expect(out).not.toContain("nGoal"); // summary 'the public API...' has no 'secret'
  });

  it("find query + contentPattern intersects (both filter — non-matches dropped)", async () => {
    // #51: both query and contentPattern filter over summaries+content. n7 matches
    // query 'JWT|token' (summary) but NOT contentPattern 'secret' → DROPPED.
    // o5 matches BOTH (content has 'token' AND 'secret') → kept with excerpts.
    // (o5's line carries 'in n7' as parent context — that's expected; n7 itself
    // is not a result.)
    const out = textOf(
      await callTool(makeBuilderReadTools(grepGraph()), "find", { query: "JWT|token", contentPattern: "secret" }),
    );
    // no result line is a node header (n7 dropped — query match but no contentPattern hit)
    expect(out.split("\n").some((l) => /^n7\b/.test(l))).toBe(false);
    expect(out).toContain("o5"); // matches both → kept
    expect(out).toContain("secret");
  });

  it("ls budget truncates the root list with a footer", async () => {
    _setGetMemkeeperSettings(() => ({ ...DEFAULT_CONFIG, toolResultTokenBudget: 2 }));
    const out = textOf(await callTool(makeBuilderReadTools(grepGraph()), "ls", {}));
    expect(out).toContain("budget reached");
  });

  it("rejects a malformed lines range with an error string", async () => {
    const out = textOf(await callTool(makeBuilderReadTools(grepGraph()), "cat", { ids: ["o5"], lines: "bad" }));
    expect(out).toContain("Invalid line range");
  });
});

describe("countConnectedObservations", () => {
  const nodes = new Map<string, { observationIds: readonly string[] }>([
    ["n1", { observationIds: ["o1", "o2"] }],
    ["n2", { observationIds: [] }],
  ]);
  const observations = new Map<string, unknown>([
    ["o1", {}],
    ["o2", {}],
    ["o9", {}],
  ]);

  it("returns the node's connected-observation count for a node id", () => {
    expect(countConnectedObservations(nodes, observations, "n1")).toBe(2);
  });

  it("returns 0 for an empty-container node", () => {
    expect(countConnectedObservations(nodes, observations, "n2")).toBe(0);
  });

  it("returns 1 for an observation id", () => {
    expect(countConnectedObservations(nodes, observations, "o1")).toBe(1);
    expect(countConnectedObservations(nodes, observations, "o9")).toBe(1);
  });

  it("returns 0 for an unknown id", () => {
    expect(countConnectedObservations(nodes, observations, "nope")).toBe(0);
  });
});
