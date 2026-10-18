// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <taresenkov@gmail.com>

// The Builder run host port: the compaction-only fast-path, the multi-pass
// convergence loop (one spawn per pass, fresh messages), mutate counting +
// try_finish convergence through the REAL vendored tool bodies, the
// flush-new-on-consolidation rule, and the timeout classification.
import { beforeEach, describe, expect, test } from "vitest";
import type { SessionOwlConfig } from "../../core/src/config/schema.js";
import { clearDetailsCache } from "../../core/src/format/details.js";
import { getGraphStore, resetForNewSession } from "../../core/src/store/graph-store.js";
import { _resetCoreInstances } from "../../host/core-instances.js";
import { runBuilder } from "../../host/runs/builder.js";
import { NO_OP_WIDGET } from "../../host/runs/seams.js";
import { clearAllStageRuns } from "../../host/stage/runs.js";
import {
  branchCustoms,
  entries,
  makeMemoryDumpFs,
  makeRunner,
  mem,
  type Rig,
  rigUp,
  SETTINGS,
  seedNode,
  useTool,
} from "./helpers.js";

const B_SETTINGS: SessionOwlConfig = {
  ...SETTINGS,
  builderRootViewThreshold: 999_999, // try_finish always within budget
  maxBuilderPasses: 4,
  builderSkipWithinBudget: false,
};
const FAST_SETTINGS: SessionOwlConfig = {
  ...B_SETTINGS,
  builderSkipWithinBudget: true,
  builderRootViewThreshold: 999_999,
};

// behaviors
const mkNode = (summary: string) => async (_i: unknown, ag: string) => {
  await useTool(ag, "mkdir", { summary, importance: "med" });
  return {};
};
const finish = async (_i: unknown, ag: string) => {
  await useTool(ag, "try_finish", {});
  return {};
};
const noop = async () => ({});

async function run(
  rig: Rig,
  settings: SessionOwlConfig,
  script: Parameters<typeof makeRunner>[0],
  over: Partial<Parameters<typeof runBuilder>[0]> = {},
) {
  const fx = makeRunner(script, false);
  await runBuilder({
    core: rig.core,
    store: rig.store,
    settings,
    signal: new AbortController().signal,
    widget: NO_OP_WIDGET,
    scope: null,
    compactionCount: 0,
    runStageFn: fx.runner,
    ...over,
  } as Parameters<typeof runBuilder>[0]);
  return fx;
}

beforeEach(() => {
  // real isolation for the shared fixtures (memory fs, core instances,
  // session store, details cache, stage-run registry); store state rides the
  // unique per-test session dirs
  mem.files.clear();
  _resetCoreInstances();
  resetForNewSession();
  clearDetailsCache();
  clearAllStageRuns();
});

describe("runBuilder — the stage dump", () => {
  test("debugDumpLimit > 0 flushes the archived passes as ONE ring-slot dump", async () => {
    const rig = await rigUp("bld-dump-1", entries(4));
    const dump = makeMemoryDumpFs();
    const fx = await run(rig, { ...B_SETTINGS, debugDumpLimit: 1 }, [finish], {
      dumps: { fs: dump.fs, baseDir: "/owl-data", cwd: "E:\\bld" },
    });
    const text = dump.files.get("/owl-data/dumps/E-bld/builder-0.txt") ?? "";
    expect(text).toContain('<dump stage="builder" started="');
    expect(text).toContain('<pass n="1">');
    expect(text.endsWith("</dump>\n")).toBe(true);
    const rates = fx.calls[0]?.modelRates;
    expect(rates?.("claude-opus-4-7")).toEqual({ inputPerM: 15, outputPerM: 75 });
  });
});

describe("runBuilder — unit-commit flush", () => {
  test("the run flushes its buffered deltas exactly once at run end (success)", async () => {
    const rig = await rigUp("bld-unit", entries(4));
    let flushes = 0;
    await run(rig, B_SETTINGS, [finish], {
      flushLedger: async () => {
        flushes += 1;
      },
    });
    expect(flushes).toBe(1);
  });

  test("a run that throws still flushes exactly once (finally-bounded crash window)", async () => {
    const rig = await rigUp("bld-unit-throws", entries(4));
    let flushes = 0;
    const boom = async () => {
      throw new Error("model exploded");
    };
    await run(rig, B_SETTINGS, [boom], {
      flushLedger: async () => {
        flushes += 1;
      },
    }).catch(() => undefined); // the error path may either propagate or classify — the FLUSH must happen either way
    expect(flushes).toBe(1);
  });
});

describe("runBuilder — fast-path (compaction scope only)", () => {
  test("the compaction count derives from the session branch (pi's internal fold, not an input)", async () => {
    const rig = await rigUp("b-ccount", entries(2));
    // a snapshot ledger record: the branch replay renders the NEWEST snapshot
    // as the compaction entry after its marker row (flush + re-fold)
    await rig.ledger.append("snapshot", { type: "session-owl", version: "v1", nodes: [] }, "e2");
    await rig.ledger.flush();
    await rig.prepared.refresh();
    const fx = makeRunner([async () => ({})], true);
    await runBuilder({
      core: rig.core,
      store: rig.store,
      settings: B_SETTINGS,
      signal: new AbortController().signal,
      widget: NO_OP_WIDGET,
      scope: null,
      runStageFn: fx.runner,
    } as Parameters<typeof runBuilder>[0]);
    expect(fx.calls.length).toBeGreaterThanOrEqual(1);
    const prompt = String(fx.calls[0].messages[0]?.content ?? "");
    expect(prompt).toContain("1 compaction");
  });

  test("each pass's dump section closes (balanced forensics: <pass> … </pass>)", async () => {
    const rig = await rigUp("b-close");
    const fx = makeRunner([async () => ({})], true);
    await runBuilder({
      core: rig.core,
      store: rig.store,
      settings: B_SETTINGS,
      signal: new AbortController().signal,
      widget: NO_OP_WIDGET,
      scope: null,
      runStageFn: fx.runner,
    } as Parameters<typeof runBuilder>[0]);
    expect(fx.agents.length).toBeGreaterThanOrEqual(1);
    for (const ag of fx.agents) {
      const sections = ag.dump.sections;
      expect(sections.filter((x: string) => x.startsWith("<pass ")).length).toBe(1);
      expect(sections.filter((x: string) => x === "</pass>\n").length).toBe(1);
    }
  });

  test("under budget + builderSkipWithinBudget + scope ⇒ no spawn, `new` preserved", async () => {
    const rig = await rigUp("b-fast");
    seedNode(rig, "n9", "new");
    const fx = await run(rig, FAST_SETTINGS, [mkNode("x")], { scope: { firstKeptEntryId: "e1" } });
    expect(fx.calls).toHaveLength(0); // no LLM pass
    expect(getGraphStore().graph.nodes.get("n9" as never)?.state).toBe("new"); // preserved
  });

  test("turn_end scope NEVER takes the skip (the trigger already decided)", async () => {
    const rig = await rigUp("b-fast2");
    const fx = await run(rig, FAST_SETTINGS, [finish]);
    expect(fx.calls).toHaveLength(1);
  });

  test("builderSkipWithinBudget off ⇒ the pass runs even under budget", async () => {
    const rig = await rigUp("b-fast3");
    const fx = await run(rig, B_SETTINGS, [finish], { scope: { firstKeptEntryId: "e1" } });
    expect(fx.calls).toHaveLength(1);
  });
});

describe("runBuilder — convergence loop", () => {
  test("two passes: pass 1 mutates (mkdir), pass 2 try_finish ⇒ converged; fresh prompts each pass; flush new→active", async () => {
    const rig = await rigUp("b-conv", entries(2));
    seedNode(rig, "n9", "new");
    const fx = await run(rig, B_SETTINGS, [mkNode("made by builder"), finish]);
    expect(fx.calls).toHaveLength(2);
    // fresh messages: pass numbers embedded
    const p1 = String((fx.calls[0].messages[0] as { content: unknown }).content);
    const p2 = String((fx.calls[1].messages[0] as { content: unknown }).content);
    expect(p1).toContain("pass 1");
    expect(p2).toContain("pass 2");
    // the run's spawn stages are builder
    expect(fx.calls.every((c) => c.stage === "builder")).toBe(true);
    const graph = getGraphStore().graph;
    // flush: n1 (seeded new) + the mkdir'd node land active, one flush delta persisted
    expect(graph.nodes.get("n9" as never)?.state).toBe("active");
    const deltas = branchCustoms(rig, "session-owl.graph_delta");
    const flush = deltas.filter(
      (d) => ((d as { delta?: { type?: string } }).delta?.type ?? (d as { type?: string }).type) === "flush_new",
    );
    expect(flush).toHaveLength(1);
    expect(
      ((flush[0] as { delta?: { nodeIds?: string[] } }).delta ?? (flush[0] as { nodeIds?: string[] })).nodeIds,
    ).toContain("n9");
  });

  test("a no-op pass (0 mutates, not converged) stops the loop and does NOT flush", async () => {
    const rig = await rigUp("b-noop", entries(2));
    seedNode(rig, "n9", "new");
    await run(rig, B_SETTINGS, [noop]);
    const graph = getGraphStore().graph;
    expect(graph.nodes.get("n9" as never)?.state).toBe("new"); // preserved
    expect(
      branchCustoms(rig, "session-owl.graph_delta").filter(
        (d) => ((d as { delta?: { type?: string } }).delta?.type ?? (d as { type?: string }).type) === "flush_new",
      ),
    ).toHaveLength(0);
  });

  test("a signal abort ends the run abnormally — `new` preserved even after mutates", async () => {
    const rig = await rigUp("b-abort", entries(2));
    seedNode(rig, "n9", "new");
    const controller = new AbortController();
    const fx = makeRunner([mkNode("m1"), async () => ({})], false);
    await runBuilder({
      core: rig.core,
      store: rig.store,
      settings: B_SETTINGS,
      signal: controller.signal,
      widget: NO_OP_WIDGET,
      scope: null,
      compactionCount: 0,
      runStageFn: async (input) => {
        const out = await fx.runner(input);
        controller.abort(); // abort lands after pass 1 (which mutated)
        return out;
      },
    } as Parameters<typeof runBuilder>[0]);
    expect(fx.calls).toHaveLength(1); // the loop broke
    expect(getGraphStore().graph.nodes.get("n9" as never)?.state).toBe("new"); // NOT flushed
  });

  test("a pass error propagates (pi rethrows even after ≥1 mutate — the tool bodies already persisted)", async () => {
    const rig = await rigUp("b-err", entries(2));
    const boom = new Error("stage engine failure (error): upstream down");
    await expect(
      run(rig, B_SETTINGS, [
        mkNode("partial"),
        async () => {
          throw boom;
        },
      ]),
    ).rejects.toThrow("stage engine failure (error)");
  });

  test("a relay timeout-class abort throws StageTimeoutError", async () => {
    const rig = await rigUp("b-to", entries(2));
    await expect(run(rig, B_SETTINGS, [async () => ({ timedOut: true })])).rejects.toThrow(
      "Builder stopped: an LLM call exceeded",
    );
  });

  test("max passes: mutating without converging stops at maxBuilderPasses and still flushes (work was done)", async () => {
    const rig = await rigUp("b-max", entries(2));
    seedNode(rig, "n9", "new");
    const fx = await run(rig, B_SETTINGS, [mkNode("a"), mkNode("b"), mkNode("c"), mkNode("d"), mkNode("e")]);
    expect(fx.calls).toHaveLength(4); // maxBuilderPasses
    expect(getGraphStore().graph.nodes.get("n9" as never)?.state).toBe("active"); // flushed (≥1 mutate)
  });

  test("per-pass usage persists to the ledger", async () => {
    const rig = await rigUp("b-usage", entries(2));
    const fx = makeRunner([finish], false);
    await runBuilder({
      core: rig.core,
      store: rig.store,
      settings: B_SETTINGS,
      signal: new AbortController().signal,
      widget: NO_OP_WIDGET,
      scope: null,
      compactionCount: 0,
      runStageFn: async (input) => {
        input.onStageEnd?.({ input: 7, output: 3, cacheRead: 0, cacheWrite: 0, cost: 0.002, turns: 1, elapsedMs: 4 });
        return fx.runner(input);
      },
    } as Parameters<typeof runBuilder>[0]);
    expect(getGraphStore().usageLedger.build.turns).toBeGreaterThanOrEqual(1);
    expect(branchCustoms(rig, "session-owl.usage").length).toBeGreaterThanOrEqual(1);
  });

  test("the pass prompt carries the root view + budget + tree total", async () => {
    const rig = await rigUp("b-prompt", entries(2));
    seedNode(rig, "nView", "active", "viewable root");
    const fx = await run(rig, B_SETTINGS, [finish]);
    const text = String((fx.calls[0].messages[0] as { content: unknown }).content);
    expect(text).toContain("viewable root");
    expect(text).toContain("/1000k tokens"); // formatTokens(999_999) = 1000k
    expect(text).toContain("2 nodes"); // roots count (nGoal + nView)
    expect(text).toContain("Source tree total:"); // the tree-total block
  });
});
