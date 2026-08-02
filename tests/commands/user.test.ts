// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { formatList, runMkCat, runMkFind, runMkFindAll, runMkLs } from "../../src/commands/user.js";
import { _resetGetMemkeeperSettings, _setGetMemkeeperSettings, DEFAULT_CONFIG } from "../../src/config/schema.js";
import {
  applyCreateNode,
  applyRecordObservation,
  applySetMeta,
  applySupersede,
  MUTATE_SOURCE,
  setClock,
} from "../../src/graph/mutations.js";
import { getGraphStore, resetForNewSession } from "../../src/store/graph-store.js";
import { MemkeeperGraph, makeObservation, N_GOAL } from "../../src/types.js";

const T0 = "2026-07-17T09:00:00.000Z";
const T1 = "2026-07-17T14:30:00.000Z";
const T3 = "2026-07-19T10:00:00.000Z";

/** Build a source graph with roots including obsolete + archived + new.
 *  Roots: nGoal (critical) · n7 (high, "Auth migration to JWT", child n8 + obs o5)
 *  · n12 (new state — renders active to non-Builder · "Build failed") · n20
 *  (archived, "Old YAML config") · n99 (obsolete, superseded by n7, obs o9). */
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
      content: "Chose JWT for stateless auth\nwith RS256 signing",
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

function seedSource(): MemkeeperGraph {
  resetForNewSession();
  const graph = buildGraph();
  getGraphStore().graph = graph;
  return graph;
}

/** A fake command context that captures the last notify call. */
interface Captured {
  lastMessage: string | null;
  lastType: string | null;
  calls: { message: string; type: string }[];
}
function makeCtx(captured: Captured): ExtensionCommandContext {
  const ui = {
    notify: (message: string, type?: string) => {
      captured.lastMessage = message;
      captured.lastType = type ?? "info";
      captured.calls.push({ message, type: type ?? "info" });
    },
  };
  return { ui } as unknown as ExtensionCommandContext;
}

/** Run a command handler against a seeded source graph + captured ctx. */
async function run(
  handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>,
  args: string,
): Promise<{ message: string | null; type: string | null }> {
  const captured: Captured = { lastMessage: null, lastType: null, calls: [] };
  await handler(args, makeCtx(captured));
  return { message: captured.lastMessage, type: captured.lastType };
}

describe("/mk:* user commands", () => {
  beforeEach(() => {
    resetForNewSession();
    _resetGetMemkeeperSettings();
  });
  afterEach(() => {
    _resetGetMemkeeperSettings();
  });

  describe("/mk:ls", () => {
    it("replies 'memkeeper is disabled.' when enabled=false (master-switch off-path)", async () => {
      seedSource();
      _setGetMemkeeperSettings(() => ({ ...DEFAULT_CONFIG, enabled: false }));
      const { message, type } = await run(runMkLs, "");
      expect(message).toBe("memkeeper is disabled.");
      expect(type).toBe("info");
    });

    it("no arg → non-obsolete roots, indented, nGoal first by importance", async () => {
      seedSource();
      const { message, type } = await run(runMkLs, "");
      expect(type).toBe("info");
      const text = message ?? "";
      // non-obsolete roots only: nGoal, n7, n12(new→active render), n20(archived)
      expect(text).toContain("nGoal");
      expect(text).toContain("n7");
      expect(text).toContain("n12");
      expect(text).toContain("n20");
      // obsolete n99 EXCLUDED from default ls
      expect(text).not.toContain("n99");
      // nGoal (critical) appears before n7 (high)
      expect(text.indexOf("nGoal")).toBeLessThan(text.indexOf("n7"));
    });

    it("nodeId arg → that node's children indented under the parent header", async () => {
      seedSource();
      const { message, type } = await run(runMkLs, "n7");
      expect(type).toBe("info");
      const text = message ?? "";
      // parent header present (n7)
      expect(text).toContain("n7");
      // child node n8 + observation o5 present
      expect(text).toContain("n8");
      expect(text).toContain("o5");
      // n8/o5 indented under the parent (leading spaces)
      expect(text).toMatch(/^\s*📁 n8/m);
    });

    it("unknown nodeId → error notify naming the id", async () => {
      seedSource();
      const { message, type } = await run(runMkLs, "nDoesNotExist");
      expect(type).toBe("error");
      expect(message ?? "").toContain("nDoesNotExist");
    });

    it("respects commandResultCap with a drill footer when over", async () => {
      seedSource();
      _setGetMemkeeperSettings(() => ({ ...DEFAULT_CONFIG, commandResultCap: 1 }));
      const { message } = await run(runMkLs, "");
      const text = message ?? "";
      // capped to 1 root line + footer
      expect(text).toMatch(/\+\d+ more/);
      expect(text).toContain("/mk:ls");
      _setGetMemkeeperSettings(() => ({ ...DEFAULT_CONFIG, commandResultCap: null }));
    });

    it("commandResultCap null → no cap, no footer", async () => {
      seedSource();
      _setGetMemkeeperSettings(() => ({ ...DEFAULT_CONFIG, commandResultCap: null }));
      const { message } = await run(runMkLs, "");
      const text = message ?? "";
      expect(text).not.toMatch(/\+\d+ more/);
    });
  });

  describe("/mk:cat", () => {
    it("node id → header + direct observations full text (child nodes NOT expanded)", async () => {
      seedSource();
      const { message, type } = await run(runMkCat, "n7");
      expect(type).toBe("info");
      const text = message ?? "";
      // node header present
      expect(text).toContain("n7");
      // direct observation o5 full multi-line content (NOT single-lined)
      expect(text).toContain("with RS256 signing");
      // child node n8 NOT expanded (no child-node header beyond the parent n7)
      expect(text).not.toContain("Pick a JWT library");
    });

    it("observation id → full content + header (NO sourceEntryIds)", async () => {
      seedSource();
      const { message, type } = await run(runMkCat, "o5");
      expect(type).toBe("info");
      const text = message ?? "";
      // full multi-line content preserved
      expect(text).toContain("Chose JWT for stateless auth");
      expect(text).toContain("with RS256 signing");
      // header present (id + importance + timestamp), NO sourceEntryIds
      expect(text).toContain("o5");
      expect(text).not.toContain("sourceEntryIds");
      expect(text).not.toMatch(/\[.*e\d.*\]/);
    });

    it("unknown id → error notify naming the id", async () => {
      seedSource();
      const { message, type } = await run(runMkCat, "nDoesNotExist");
      expect(type).toBe("error");
      expect(message ?? "").toContain("nDoesNotExist");
    });

    it("node with zero direct observations → header only (no content body)", async () => {
      seedSource();
      // n8 has no direct observations (it is a child of n7 with no obs of its own)
      const { message, type } = await run(runMkCat, "n8");
      expect(type).toBe("info");
      const text = message ?? "";
      // node header present
      expect(text).toContain("📁 n8");
      // no observation expanded (header-only unit — single line, no obs content)
      expect(text).not.toContain("\n");
      expect(text).not.toMatch(/📄 o\d/);
    });

    it("missing arg → usage error", async () => {
      seedSource();
      const { message, type } = await run(runMkCat, "");
      expect(type).toBe("error");
      expect(message ?? "").toMatch(/usage/i);
    });
  });

  describe("/mk:find", () => {
    it("matches across node summaries + obs content, non-obsolete, with in <parent>", async () => {
      seedSource();
      // "JWT" matches the n7 NODE summary ("Auth migration to JWT") AND the o5
      // observation content ("Chose JWT for stateless auth") — so both a node
      // line and an obs line appear, the obs showing `in n7`.
      const { message, type } = await run(runMkFind, "JWT");
      expect(type).toBe("info");
      const text = message ?? "";
      // n7 node line genuinely matches its summary (not just via `in n7`)
      expect(text).toContain("📁 n7");
      // o5 content matches → shows `in n7`
      expect(text).toContain("o5");
      expect(text).toContain("in n7");
      // obsolete n99 EXCLUDED (non-obsolete default)
      expect(text).not.toContain("n99");
      expect(text).not.toContain("o9");
    });

    it("invalid regex → error notify", async () => {
      seedSource();
      const { message, type } = await run(runMkFind, "(unclosed");
      expect(type).toBe("error");
      expect(message ?? "").toMatch(/regex|invalid/i);
    });

    it("empty query → usage error", async () => {
      seedSource();
      const { message, type } = await run(runMkFind, "");
      expect(type).toBe("error");
      expect(message ?? "").toMatch(/usage/i);
    });

    it("no matches → info notify saying no matches", async () => {
      seedSource();
      const { message, type } = await run(runMkFind, "zzzznomatch");
      expect(type).toBe("info");
      expect(message ?? "").toMatch(/no matches/i);
    });

    it("respects commandResultCap with footer when over", async () => {
      seedSource();
      _setGetMemkeeperSettings(() => ({ ...DEFAULT_CONFIG, commandResultCap: 1 }));
      // JWT matches n7 + n8 summaries and o5 content (>1 match) → cap=1 truncates
      const { message } = await run(runMkFind, "JWT");
      expect(message ?? "").toMatch(/\+\d+ more/);
      _setGetMemkeeperSettings(() => ({ ...DEFAULT_CONFIG, commandResultCap: null }));
    });
  });

  describe("/mk:find-all", () => {
    it("includes obsolete nodes (🪦 + → supersededBy)", async () => {
      seedSource();
      // "sessions" matches the obsolete NODE n99 ("Auth via sessions") so its
      // node line renders with 🪦 + → supersededBy (glyphs are node-only).
      const { message, type } = await run(runMkFindAll, "sessions");
      expect(type).toBe("info");
      const text = message ?? "";
      // obsolete n99 now included
      expect(text).toContain("n99");
      expect(text).toContain("🪦");
      expect(text).toContain("→ n7");
    });
  });

  describe("output channel", () => {
    it("results go to ui.notify, not a tool result", async () => {
      seedSource();
      const captured: Captured = { lastMessage: null, lastType: null, calls: [] };
      const ctx = makeCtx(captured);
      await runMkLs("", ctx);
      // exactly one notify call, type info
      expect(captured.calls).toHaveLength(1);
      expect(captured.calls[0]?.type).toBe("info");
      expect(typeof captured.calls[0]?.message).toBe("string");
    });
  });
});

describe("formatList (cap helper)", () => {
  it("cap null → no cap, no footer, all lines", () => {
    const out = formatList(["a", "b", "c"], null);
    expect(out.text).toBe("a\nb\nc");
    expect(out.truncated).toBe(0);
  });

  it("cap N ≥ length → no truncation, no footer", () => {
    const out = formatList(["a", "b"], 50);
    expect(out.text).toBe("a\nb");
    expect(out.truncated).toBe(0);
  });

  it("cap N < length → first N lines + footer with the drill hint", () => {
    const out = formatList(["a", "b", "c", "d"], 2);
    expect(out.truncated).toBe(2);
    expect(out.text.startsWith("a\nb")).toBe(true);
    expect(out.text).toContain("+2 more");
    expect(out.text).toContain("/mk:ls");
    expect(out.text).toContain("/mk:find");
  });

  it("empty input → empty text, no footer", () => {
    const out = formatList([], 50);
    expect(out.text).toBe("");
    expect(out.truncated).toBe(0);
  });

  it("cap 0 → everything truncated, footer only", () => {
    // cap 0 is not a reachable config value (min preset 10) but formatList must
    // behave sanely: keep nothing, report all as truncated, show the drill footer.
    const out = formatList(["a", "b", "c"], 0);
    expect(out.truncated).toBe(3);
    expect(out.text).toContain("+3 more");
    expect(out.text).not.toContain("\na");
  });
});
