// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import type { SessionEntry } from "@earendil-works/pi-coding-agent";
// The Selector run host port: cached-tree reuse (branch-position cover
// check), the working-copy convergence loop (one spawn per pass over the
// input-view port), persist-once-at-completion (partial kept on every end
// once a stage opened), and the live selected-counts provider.
import { beforeEach, describe, expect, test } from "vitest";
import type { SessionOwlConfig } from "../../core/src/config/schema.js";
import { clearDetailsCache } from "../../core/src/format/details.js";
import { nonObsoleteRoots, renderRootViewFromRoots } from "../../core/src/graph/read-tools.js";
import { getGraphStore, resetForNewSession } from "../../core/src/store/graph-store.js";
import { estimateContentTokens, makeNode, nowStoredTimestamp } from "../../core/src/types.js";
import { _resetCoreInstances } from "../../host/core-instances.js";
import { NO_OP_WIDGET } from "../../host/runs/seams.js";
import { runSelector } from "../../host/runs/selector.js";
import { clearAllStageRuns } from "../../host/stage/runs.js";
import {
  branchCustoms,
  entries,
  makeRunner,
  mem,
  msgEntry,
  type Rig,
  rigUp,
  SETTINGS,
  seedNode,
  useTool,
} from "./helpers.js";

const S_SETTINGS: SessionOwlConfig = {
  ...SETTINGS,
  selectorRootViewThreshold: 999_999, // try_finish always within budget
  maxSelectorPasses: 3,
  observerThresholdTokens: 60,
  observerToolBlockCapTokens: 1200,
  observerIncludeThinking: false,
};

const mvToIrrelevant = async (_i: unknown, ag: string) => {
  await useTool(ag, "mv", { sourceIds: ["n9"], destId: "nIrrelevant" });
  return {};
};
const finish = async (_i: unknown, ag: string) => {
  await useTool(ag, "try_finish", {});
  return {};
};
const noop = async () => ({});

interface SelectorRig extends Rig {
  unobservedTail: SessionEntry[];
}

async function selectorRig(
  sessionId: string,
  opts: { cache?: { coveredFrontier: string | null }; branch?: SessionEntry[] } = {},
): Promise<SelectorRig> {
  const branchRows = opts.branch ?? entries(2);
  const rig = await rigUp(sessionId, branchRows);
  seedNode(rig, "n9", "active", "demote me");
  if (opts.cache !== undefined) {
    getGraphStore().selectedTree = {
      oInitialPrompt: null,
      coveredFrontier: opts.cache.coveredFrontier,
      nodes: [],
      obsRefs: [],
    } as never;
  }
  return { ...rig, unobservedTail: branchRows };
}

async function run(
  rig: SelectorRig,
  script: Parameters<typeof makeRunner>[0],
  over: Partial<Parameters<typeof runSelector>[0]> = {},
) {
  const fx = makeRunner(script, false);
  await runSelector({
    core: rig.core,
    store: rig.store,
    settings: S_SETTINGS,
    signal: new AbortController().signal,
    widget: NO_OP_WIDGET,
    scope: null,
    todo: null,
    readBranch: () => rig.unobservedTail,
    runStageFn: fx.runner,
    ...over,
  } as Parameters<typeof runSelector>[0]);
  return fx;
}

beforeEach(() => {
  // real isolation for the shared fixtures (memory fs, core instances,
  // session store, details cache, stage-run registry) — the suites rely on
  // unique session dirs for store state; this resets the shared globals
  mem.files.clear();
  _resetCoreInstances();
  resetForNewSession();
  clearDetailsCache();
  clearAllStageRuns();
});

describe("runSelector — unit-commit flush", () => {
  test("the run flushes its buffered selection exactly once at run end", async () => {
    const rig = await selectorRig("sel-unit");
    let flushes = 0;
    await run(rig, [finish], {
      flushLedger: async () => {
        flushes += 1;
      },
    });
    expect(flushes).toBe(1);
  });

  test("a reused-tree fast-path run flushes once too (uniform boundary)", async () => {
    const rig = await selectorRig("sel-unit-fast", { cache: { coveredFrontier: "e2" } });
    getGraphStore().observerFrontier = "e2";
    let flushes = 0;
    await run(rig, [finish], {
      flushLedger: async () => {
        flushes += 1;
      },
    });
    expect(flushes).toBe(1);
  });
});

describe("runSelector — cached-tree fast-path", () => {
  test("no cached tree ⇒ the run builds (a pass runs)", async () => {
    const rig = await selectorRig("s-fresh");
    const fx = await run(rig, [finish]);
    expect(fx.calls).toHaveLength(1);
    expect(fx.calls[0].stage).toBe("selector");
  });

  test("a cached tree covering the CURRENT frontier (mid-session, no cut) is reused — no pass", async () => {
    const rig = await selectorRig("s-cache", {
      cache: { coveredFrontier: "e2" },
    });
    getGraphStore().observerFrontier = "e2"; // coveredFrontier === frontier
    const fx = await run(rig, [finish]);
    expect(fx.calls).toHaveLength(0);
  });

  test("a stale cache (frontier moved past coveredFrontier, no cut) rebuilds", async () => {
    const rig = await selectorRig("s-stale", {
      cache: { coveredFrontier: "e1" },
    });
    getGraphStore().observerFrontier = "e2"; // new observations since
    const fx = await run(rig, [finish]);
    expect(fx.calls).toHaveLength(1);
  });

  test("a compaction cut the cache must COVER: covered ≥ cut-1 position reuses", async () => {
    const rig = await selectorRig("s-cut-ok", {
      cache: { coveredFrontier: "e2" },
      branch: [msgEntry("e1", "a"), msgEntry("e2", "b"), msgEntry("e3", "c")],
    });
    const fx = await run(rig, [finish], { scope: { firstKeptEntryId: "e3" } });
    // compacted block = [,); its last =; covered ≥ that ⇒ reuse
    expect(fx.calls).toHaveLength(0);
  });

  test("a cache that does NOT reach the compacted block rebuilds", async () => {
    const rig = await selectorRig("s-cut-bad", {
      cache: { coveredFrontier: "e1" },
      branch: [msgEntry("e1", "a"), msgEntry("e2", "b"), msgEntry("e3", "c")],
    });
    const fx = await run(rig, [finish], { scope: { firstKeptEntryId: "e3" } });
    expect(fx.calls).toHaveLength(1);
  });
});

describe("runSelector — dump durability pins", () => {
  test("the input lands PRE-CALL; pass 1's content is on disk during pass 2", async () => {
    const rig = await selectorRig("sel-dur-1");
    const dumpFiles = new Map<string, string>();
    const dumpFs = {
      readText: async (p: string) => {
        const t = dumpFiles.get(p);
        if (t === undefined) throw new Error(`ENOENT: ${p}`);
        return t;
      },
      writeText: async (p: string, t: string) => {
        dumpFiles.set(p, t);
      },
      listDir: async () => [],
      statMtime: async () => null,
    };
    const path = "/owl-data/dumps/E-dur/selector-0.txt";
    let passOneOnDisk = false;
    let inputPreCall = false;
    const mkNode1 = async (_i: unknown, ag: string) => {
      await useTool(ag, "mkdir", { summary: "m1", importance: "med" });
      return {};
    };
    const probe = async (_i: unknown, _ag: string) => {
      const mid = dumpFiles.get(path) ?? "";
      passOneOnDisk = mid.includes("<system-prompt>") && mid.includes("<input>");
      inputPreCall = mid.includes("<input>");
      return {};
    };
    await run(rig, [mkNode1, probe], {
      settings: { ...S_SETTINGS, debugDumpLimit: 2 },
      dumps: { fs: dumpFs, baseDir: "/owl-data", cwd: "E:\\dur" },
    });
    expect(inputPreCall).toBe(true); // the input block landed BEFORE the call returned
    expect(passOneOnDisk).toBe(true); // pass 1's header+input survived into pass 2
  });

  test("a run that ends BEFORE its first call writes NOTHING (no footer-only slot evict)", async () => {
    const rig = await selectorRig("sel-dur-2");
    const dumpFiles = new Map<string, string>();
    const controller = new AbortController();
    controller.abort(); // the run returns at the first loop check — no call, no header
    await run(rig, [noop], {
      settings: { ...S_SETTINGS, debugDumpLimit: 1 },
      signal: controller.signal,
      dumps: {
        fs: {
          readText: async (p: string) => dumpFiles.get(p) ?? "",
          writeText: async (p: string, t: string) => {
            dumpFiles.set(p, t);
          },
          listDir: async () => [],
          statMtime: async () => null,
        },
        baseDir: "/owl-data",
        cwd: "E:\\dur",
      },
    });
    expect(dumpFiles.size).toBe(0);
  });
});

describe("runSelector — the todo_list tool (the optional bridge)", () => {
  test("a live bridge binds todo_list; the model reads the list through the executor layer", async () => {
    const rig = await selectorRig("sel-todo-1");
    let seen: unknown = null;
    const readTodos = async (_i: unknown, ag: string) => {
      seen = await useTool(ag, "todo_list", {});
      return {};
    };
    await run(rig, [readTodos], {
      todoBridge: {
        getItems: () => [{ id: "t1", name: "the task", status: "in_progress", details: "d1" }],
      },
    });
    // the counted executor stringifies the pi tool result for the engine's
    // output-shape validation (string | blocks | undefined — objects reject)
    expect(seen).toMatchObject({
      result: "in_progress · the task\nd1",
    });
  });

  test("no bridge ⇒ no todo_list tool (the call misses — graceful)", async () => {
    const rig = await selectorRig("sel-todo-2");
    let missed = false;
    const probe = async (_i: unknown, ag: string) => {
      const r = (await useTool(ag, "todo_list", {})) as { content?: { text?: string }[] };
      missed = r?.content?.[0]?.text === undefined;
      return {};
    };
    await run(rig, [probe]);
    expect(missed).toBe(true);
  });
});

describe("runSelector — the stage dump", () => {
  test("debugDumpLimit > 0 flushes the archived buffer as ONE ring-slot dump", async () => {
    const rig = await selectorRig("sel-dump-1");
    const dumpFiles = new Map<string, string>();
    const dumpFs = {
      readText: async (p: string) => {
        const t = dumpFiles.get(p);
        if (t === undefined) throw new Error(`ENOENT: ${p}`);
        return t;
      },
      writeText: async (p: string, t: string) => {
        dumpFiles.set(p, t);
      },
      listDir: async () => [],
      statMtime: async () => null,
    };
    const fx = await run(rig, [noop], {
      settings: { ...S_SETTINGS, debugDumpLimit: 2 },
      dumps: { fs: dumpFs, baseDir: "/owl-data", cwd: "E:\\proj" },
    });
    const path = "/owl-data/dumps/E-proj/selector-0.txt";
    const text = dumpFiles.get(path) ?? "";
    expect(text).toContain('<dump stage="selector" started="');
    expect(text).toContain("<system-prompt>");
    expect(text.endsWith("</dump>\n")).toBe(true);
    // the disabled default writes nothing
    const rig2 = await selectorRig("sel-dump-2");
    const files2 = new Map<string, string>();
    await run(rig2, [noop], {
      dumps: {
        fs: {
          readText: async (p: string) => files2.get(p) ?? "",
          writeText: async (p: string, t: string) => {
            files2.set(p, t);
          },
          listDir: async () => [],
          statMtime: async () => null,
        },
        baseDir: "/owl-data",
        cwd: "E:\\proj",
      },
    });
    expect(files2.size).toBe(0); // debugDumpLimit 0 — nothing written
    const rates = fx.calls[0]?.modelRates;
    expect(rates?.("claude-haiku-4-5")).toEqual({ inputPerM: 1, outputPerM: 5 });
  });
});

describe("runSelector — the convergence loop", () => {
  test("pass 1 mutates, pass 2 try_finish ⇒ converged; the working tree is persisted once at completion", async () => {
    const rig = await selectorRig("s-conv");
    const fx = await run(rig, [mvToIrrelevant, finish]);
    expect(fx.calls).toHaveLength(2);
    // the pass prompt re-renders the WORKING tree (pass 2 sees the moved node)
    const p1 = String((fx.calls[0].messages[0] as { content: unknown }).content);
    const p2 = String((fx.calls[1].messages[0] as { content: unknown }).content);
    expect(p1).toContain("demote me");
    expect(p2).toContain("pass 2");
    // the selected tree persisted (session-owl.selection on the branch)
    const selections = branchCustoms(rig, "session-owl.selection");
    expect(selections).toHaveLength(1);
    // the SOURCE graph is untouched by the working copy's mv
    expect(getGraphStore().graph.nodes.get("n9" as never)?.parentNode).toBeNull();
  });

  test("the context view rides every pass (tail + legend, no entry ids)", async () => {
    const rig = await selectorRig("s-ctx", {
      branch: [msgEntry("e1", "the user asked for a port"), msgEntry("e2", "reply", "assistant")],
    });
    const fx = await run(rig, [finish], { scope: { firstKeptEntryId: "e1" } }); // a compaction cut makes the tail render
    const p1 = String((fx.calls[0].messages[0] as { content: unknown }).content);
    expect(p1).toContain("the user asked for a port"); // the tail rides
    expect(p1).toContain("Current task");
  });

  test("a no-op pass stops the loop; the tree still persists", async () => {
    const rig = await selectorRig("s-noop");
    const fx = await run(rig, [noop]);
    expect(fx.calls).toHaveLength(1);
    expect(branchCustoms(rig, "session-owl.selection")).toHaveLength(1);
  });

  test("an ABORT mid-run still commits the working copy (partial work kept)", async () => {
    const rig = await selectorRig("s-abort");
    const controller = new AbortController();
    const fx = makeRunner([mvToIrrelevant, finish], false);
    await runSelector({
      core: rig.core,
      store: rig.store,
      settings: S_SETTINGS,
      signal: controller.signal,
      widget: NO_OP_WIDGET,
      scope: null,
      todo: null,
      readBranch: () => rig.unobservedTail,
      runStageFn: async (input) => {
        const out = await fx.runner(input);
        controller.abort(); // abort after pass 1 (which mutated the copy)
        return out;
      },
    } as Parameters<typeof runSelector>[0]);
    expect(fx.calls).toHaveLength(1);
    expect(branchCustoms(rig, "session-owl.selection")).toHaveLength(1); // committed
  });

  test("aborted BEFORE start persists nothing (no working copy exists)", async () => {
    const rig = await selectorRig("s-abort0");
    const controller = new AbortController();
    controller.abort();
    await run(rig, [finish], { signal: controller.signal });
    expect(branchCustoms(rig, "session-owl.selection")).toHaveLength(0);
  });

  test("a relay timeout-class abort throws StageTimeoutError but the tree still commits", async () => {
    const rig = await selectorRig("s-to");
    await expect(run(rig, [async () => ({ timedOut: true })])).rejects.toThrow(
      "Selector stopped: an LLM call exceeded",
    );
    expect(branchCustoms(rig, "session-owl.selection")).toHaveLength(1);
  });

  test("max passes: mutating without converging stops at maxSelectorPasses", async () => {
    const rig = await selectorRig("s-max");
    seedNode(rig, "n8", "active", "another");
    const mv8 = async (_i: unknown, ag: string) => {
      await useTool(ag, "set_meta", { nodeId: "n8", summary: `renamed ${Date.now()}` });
      return {};
    };
    const fx = await run(rig, [mv8, mv8, mv8, mv8]);
    expect(fx.calls).toHaveLength(3); // maxSelectorPasses
  });

  test("the selectedCounts provider is pi's render: estimateContentTokens over renderRootViewFromRoots", async () => {
    const rig = await selectorRig("s-counts-render");
    // expected from the working copy's START state = the source clone + the
    // injected nIrrelevant bin (the provider is pulled at startStage, before
    // any mutate lands)
    const source = rig.core.store.getGraphStore().graph;
    const binNode = makeNode({
      id: "nIrrelevant" as never,
      summary: "Irrelevant",
      importance: "med",
      parentNode: null,
      state: "active",
      createdAt: nowStoredTimestamp(),
    });
    const expected = estimateContentTokens(
      renderRootViewFromRoots([...nonObsoleteRoots(source), binNode], source.observations),
    );
    let pulled: { count: number; viewTokens: number } | null = null;
    const widget = {
      ...NO_OP_WIDGET,
      startStage: (_s: string, init?: { selectedCounts?: () => { count: number; viewTokens: number } }) => {
        if (init?.selectedCounts) pulled = init.selectedCounts();
      },
    };
    await run(rig, [noop], { widget: widget as never });
    expect(pulled).not.toBeNull();
    expect((pulled as unknown as { viewTokens: number }).viewTokens).toBe(expected);
  });

  test("the selectedCounts provider pulls live from the working copy", async () => {
    const rig = await selectorRig("s-counts");
    let pulled: { count: number; viewTokens: number } | null = null;
    const widget = {
      ...NO_OP_WIDGET,
      startStage: (_s: string, init?: { selectedCounts?: () => { count: number; viewTokens: number } }) => {
        if (init?.selectedCounts) pulled = init.selectedCounts();
      },
    };
    await run(rig, [mvToIrrelevant, finish], { widget: widget as never });
    expect(pulled).not.toBeNull();
    expect((pulled as unknown as { count: number }).count).toBeGreaterThanOrEqual(1);
  });
});
