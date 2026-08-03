// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import { describe, expect, it } from "vitest";
import { makeBuilderReadTools } from "../../src/builder/tools.js";
import {
  applyCreateNode,
  applyRecordObservation,
  applySetMeta,
  applySupersede,
  MUTATE_SOURCE,
  setClock,
} from "../../src/graph/mutations.js";
import { makeReadTools, nonObsoleteRootsOf } from "../../src/graph/read-tools.js";
import { MemkeeperGraph, makeObservation, N_GOAL } from "../../src/types.js";

const NOW = "2026-07-29T09:00:00.000Z";

// --- test graph ------------------------------------------------------------
// roots: nGoal (critical) + n7 (active, JWT auth) + n12 (active, build failed) +
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
      content: "Chose JWT for stateless auth",
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
    importance: "medium",
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
      // no 📄 at root level in a roots listing
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
      // header is exactly `📄 id · importance · timestamp` (· separators, matching
      // the shared one-line render format); no sourceEntryIds provenance rendered.
      expect(out).toContain("📄 o5 · high · Jul 29 09:00");
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
          content: "Second JWT note",
          importance: "high",
          sourceEntryIds: ["4"],
          timestamp: NOW,
          parentNode: "n7",
        }),
      });
      applyRecordObservation(g, {
        obs: makeObservation({
          id: "o7",
          content: "Third JWT note",
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
      const page2RootLines = page2.split("\n").filter((l) => l.startsWith("📁 "));
      expect(page2RootLines.length).toBeGreaterThan(0);
      // page1 roots must NOT reappear on page2 (no duplicate re-delivery)
      const page1Ids = page1
        .split("\n")
        .map((l) => l.match(/^📁 (n\S+)/))
        .filter((m): m is RegExpMatchArray => m !== null)
        .map((m) => m[1]);
      for (const id of page1Ids) {
        const asLine = page2.split("\n").some((l) => l.includes(`📁 ${id} `));
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
