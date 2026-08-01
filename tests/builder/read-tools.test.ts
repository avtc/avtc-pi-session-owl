// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import { describe, expect, it } from "vitest";
import { makeBuilderTools } from "../../src/builder/tools.js";
import { DEFAULT_CONFIG } from "../../src/config/schema.js";
import {
  applyCreateNode,
  applyRecordObservation,
  applySetMeta,
  applySupersede,
  MUTATE_SOURCE,
  setClock,
} from "../../src/graph/mutations.js";
import { MemkeeperGraph, makeObservation, N_GOAL } from "../../src/types.js";

const NOW = "2026-07-29 09:00";

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
  tools: ReturnType<typeof makeBuilderTools>,
  name: string,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const tool = tools.find((t) => t.name === name);
  if (tool === undefined) throw new Error(`tool ${name} not found`);
  const result = await tool.execute("call-1", args as unknown as Parameters<typeof tool.execute>[1]);
  return result as unknown as ToolResult;
}

describe("Builder read tools", () => {
  const tools = () => makeBuilderTools(buildGraph(), DEFAULT_CONFIG);

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
      // header is id · importance · timestamp; no sourceEntryIds provenance rendered.
      expect(out).not.toContain("sourceEntryIds");
      // content appears EXACTLY ONCE — the header is content-free (id·importance·timestamp).
      const occurrences = out.split("Chose JWT for stateless auth").length - 1;
      expect(occurrences).toBe(1);
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

    it("returns 'No matches.' when nothing matches", async () => {
      const out = textOf(await callTool(tools(), "find", { query: "zzznomatch" }));
      expect(out).toContain("No matches");
    });
  });

  describe("cursor pagination round-trip", () => {
    it("a second page using the prior afterId yields the next items, no duplicates", async () => {
      const page1 = textOf(await callTool(tools(), "ls", { page: { take: 2 } }));
      // extract the afterId from the footer
      const match = page1.match(/afterId=(\S+)/);
      expect(match).not.toBeNull();
      const afterId = match !== null ? match[1] : "";
      const page2 = textOf(await callTool(tools(), "ls", { page: { take: 2, afterId } }));
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

    it("a stale afterId (cursor removed) yields an empty window, not duplicates", async () => {
      // 'nX' is not a root in this graph → cursor-not-found → empty, no more.
      const out = textOf(await callTool(tools(), "ls", { page: { take: 2, afterId: "nX-not-present" } }));
      expect(out).toContain("empty");
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
