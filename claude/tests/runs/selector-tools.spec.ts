// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// The Selector toolset host port: the graph tools bound to the WORKING COPY
// (the vendored factories composed pi's selector/tools.ts way), the
// working-copy mutate policy (no persist), and the mutation-name set the
// run's no-op detection reads.
import { describe, expect, test } from "vitest";
import { MERGE_TOOL, MKDIR_TOOL, MV_TOOL, SELECTOR_SET_META_TOOL } from "../../core/src/graph/mutate-tools.js";
import { TRY_FINISH_TOOL } from "../../core/src/graph/read-tools.js";
import { makeNode, nowStoredTimestamp, SessionOwlGraph } from "../../core/src/types.js";
import { buildWorkingCopy } from "../../host/runs/selector-input-view.js";
import {
  makeSelectorGraphTools,
  SELECTOR_MUTATE_TOOL_NAMES,
  workingCopyMutateContext,
} from "../../host/runs/selector-tools.js";

function emptyGraph(): SessionOwlGraph {
  return new SessionOwlGraph({ nodes: new Map(), observations: new Map(), nextObsId: 1, nextNodeId: 1 });
}

describe("SELECTOR_MUTATE_TOOL_NAMES", () => {
  test("the four-tool mutation subset (no supersede, the restricted set_meta)", () => {
    expect([...SELECTOR_MUTATE_TOOL_NAMES].sort()).toEqual(
      [MKDIR_TOOL, MV_TOOL, MERGE_TOOL, SELECTOR_SET_META_TOOL].sort(),
    );
    expect(SELECTOR_MUTATE_TOOL_NAMES.has("supersede")).toBe(false);
  });
});

describe("workingCopyMutateContext", () => {
  test("policy is workingCopy; a real mutate tool over the working copy leaves the SOURCE graph untouched (the copy is transient)", async () => {
    const ctx = workingCopyMutateContext();
    expect(ctx.policy).toBe("workingCopy");
    expect(typeof ctx.persist).toBe("function");
    expect(() => ctx.persist(null as never)).not.toThrow(); // the persist seam is a drop

    // the real contract: driving a graph mutate through the toolset mutates
    // ONLY the working copy — the source graph (and any store behind it) sees
    // nothing, because the tools hold no store seam at all
    const source = new SessionOwlGraph({ nodes: new Map(), observations: new Map(), nextObsId: 1, nextNodeId: 1 });
    source.nodes.set(
      "nGoal" as never,
      makeNode({
        id: "nGoal" as never,
        summary: "g",
        importance: "crit",
        parentNode: null,
        state: "active",
        createdAt: nowStoredTimestamp(),
      }),
    );
    const working = buildWorkingCopy(source);
    const tools = makeSelectorGraphTools(working, { selectorRootViewThreshold: 999_999 } as never);
    const mkdir = tools.find((t) => t.name === MKDIR_TOOL);
    if (mkdir === undefined) throw new Error("no mkdir tool");
    const result = (await mkdir.execute("tc-1", {
      summary: "working child",
      importance: "low",
    } as never)) as { details?: { ok?: boolean } };
    expect(result.details?.ok).toBe(true); // the mutate APPLIED on the copy
    const workingIds = [...working.graph.nodes.keys()].map(String).sort();
    const sourceIds = [...source.nodes.keys()].map(String).sort();
    expect(workingIds).toContain("n1"); // the new node lives in the copy
    expect(sourceIds).toEqual(["nGoal"]); // the source graph is UNTOUCHED
  });
});

describe("makeSelectorGraphTools", () => {
  test("builds the eight graph tools over the working copy (reads + 4 mutates + try_finish)", async () => {
    const graph = emptyGraph();
    const settings = {
      selectorRootViewThreshold: 2000,
    } as never;
    const tools = makeSelectorGraphTools({ graph, nIrrelevantId: "nIrrelevant" }, settings);
    expect(tools.map((t) => t.name).sort()).toEqual(
      ["ls", "cat", "find", MKDIR_TOOL, MV_TOOL, MERGE_TOOL, SELECTOR_SET_META_TOOL, TRY_FINISH_TOOL].sort(),
    );
    // try_finish is BOUND to the working graph: on an empty graph it is within
    // budget → ok:true (pi's gate semantics, no LLM)
    const gate = tools.find((t) => t.name === TRY_FINISH_TOOL);
    expect(gate).toBeDefined();
    const res =
      gate === undefined
        ? null
        : await (gate as { execute: (id: string, p: unknown) => Promise<{ details: { ok: boolean } }> }).execute(
            "tc1",
            {},
          );
    expect((res as { details: { ok: boolean } } | null)?.details.ok).toBe(true);
  });
});
