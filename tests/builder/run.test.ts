// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import type { AgentEvent } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { makePassTracker, runBuilder } from "../../src/builder/run.js";
import {
  CAT_TOOL,
  FIND_TOOL,
  LS_TOOL,
  MERGE_TOOL,
  MKDIR_TOOL,
  MV_TOOL,
  SET_META_TOOL,
  SUPERSEDE_TOOL,
  TRY_FINISH_TOOL,
} from "../../src/builder/tools.js";
import { DEFAULT_CONFIG } from "../../src/config/schema.js";
import { applyCreateNode, applyRecordObservation, setClock } from "../../src/graph/mutations.js";
import type { StageRunInput, StageRunResult } from "../../src/runtime/agent-loop.js";
import { getGraphStore, resetForNewSession } from "../../src/store/graph-store.js";
import type { MemkeeperGraph } from "../../src/types.js";
import { makeObservation, N_GOAL, type NodeId } from "../../src/types.js";
import { NO_OP_WIDGET, recordingWidget, scriptRunStage, scriptRunStageWithError } from "./run-helpers.js";

const NOW = "2026-07-29 09:00";

// --- pass tracker ----------------------------------------------------------

// toolEndEvent two-arg form (isError defaults false) and three-arg form.
function toolEndEvent(toolName: string, ok: boolean): AgentEvent {
  return endEvent(toolName, ok, false);
}
function endEvent(toolName: string, ok: boolean, isError: boolean): AgentEvent {
  return {
    type: "tool_execution_end",
    toolCallId: `c-${toolName}`,
    toolName,
    result: { content: [], details: { ok } },
    isError,
  } as unknown as AgentEvent;
}

describe("makePassTracker", () => {
  it("counts applied mutates (ok, not error) for all five mutate tools", () => {
    const { outcome, onEvent } = makePassTracker(() => {});
    onEvent(toolEndEvent(MKDIR_TOOL, true));
    onEvent(toolEndEvent(MV_TOOL, true));
    onEvent(toolEndEvent(MERGE_TOOL, true));
    onEvent(toolEndEvent(SUPERSEDE_TOOL, true));
    onEvent(toolEndEvent(SET_META_TOOL, true));
    expect(outcome.mutates).toBe(5);
    expect(outcome.converged).toBe(false);
  });

  it("ignores a rejected mutate (isError)", () => {
    const { outcome, onEvent } = makePassTracker(() => {});
    onEvent(endEvent(MV_TOOL, true, true));
    expect(outcome.mutates).toBe(0);
  });

  it("ignores a mutate whose result lacks ok (an error result)", () => {
    const { outcome, onEvent } = makePassTracker(() => {});
    onEvent({
      type: "tool_execution_end",
      toolCallId: "c1",
      toolName: MV_TOOL,
      result: { content: [], details: { error: true } },
      isError: false,
    } as unknown as AgentEvent);
    expect(outcome.mutates).toBe(0);
  });

  it("marks converged on try_finish success", () => {
    const { outcome, onEvent } = makePassTracker(() => {});
    onEvent(toolEndEvent(TRY_FINISH_TOOL, true));
    expect(outcome.converged).toBe(true);
    expect(outcome.mutates).toBe(0);
  });

  it("does not mark converged on try_finish reject", () => {
    const { outcome, onEvent } = makePassTracker(() => {});
    onEvent(toolEndEvent(TRY_FINISH_TOOL, false));
    expect(outcome.converged).toBe(false);
  });

  it("ignores read tools", () => {
    const { outcome, onEvent } = makePassTracker(() => {});
    onEvent(toolEndEvent(LS_TOOL, true));
    onEvent(toolEndEvent(CAT_TOOL, true));
    onEvent(toolEndEvent(FIND_TOOL, true));
    expect(outcome.mutates).toBe(0);
    expect(outcome.converged).toBe(false);
  });

  it("forwards every event to the downstream sink", () => {
    const forwarded: unknown[] = [];
    const { onEvent } = makePassTracker((e) => forwarded.push(e));
    const a = { type: "message_end", message: {} } as unknown as AgentEvent;
    const b = toolEndEvent(MKDIR_TOOL, true);
    onEvent(a);
    onEvent(b);
    expect(forwarded).toEqual([a, b]);
  });

  it("ignores non-tool_execution_end events", () => {
    const { outcome, onEvent } = makePassTracker(() => {});
    onEvent({ type: "turn_end" } as unknown as AgentEvent);
    onEvent({ type: "message_update" } as unknown as AgentEvent);
    expect(outcome.mutates).toBe(0);
    expect(outcome.converged).toBe(false);
  });
});

// --- runBuilder fixture ----------------------------------------------------

/** Seed the singleton graph with nGoal (+oInitialPrompt) and optional `new`
 *  roots. Returns the singleton's graph. */
function seedGraph(newRoots: Array<{ id: NodeId; summary: string }>): MemkeeperGraph {
  resetForNewSession();
  const g = getGraphStore().graph;
  applyCreateNode(g, {
    id: N_GOAL,
    summary: "goal",
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
  for (const root of newRoots) {
    applyCreateNode(g, {
      id: root.id,
      summary: root.summary,
      importance: "medium",
      parentNode: null,
      state: "new",
    });
  }
  return g;
}

/** A fake pi that records appended entries (to inspect flush_new deltas). */
function makeFakePi(): { pi: ExtensionAPI; appended: { type: string; data: unknown }[] } {
  const appended: { type: string; data: unknown }[] = [];
  const pi = {
    appendEntry: (customType: string, data: unknown) => {
      appended.push({ type: customType, data });
    },
  } as unknown as ExtensionAPI;
  return { pi, appended };
}

function makeFakeCtx(): ExtensionContext {
  const fakeModel = { provider: "test", id: "builder-model" } as unknown as ExtensionContext["model"];
  return {
    sessionManager: { getLeafId: () => "leaf-1", getBranch: () => [] },
    modelRegistry: {
      find: () => fakeModel,
      getApiKeyAndHeaders: async () => ({ ok: true as const, apiKey: "key" }),
    } as unknown as ExtensionContext["modelRegistry"],
    model: fakeModel,
    ui: { notify: () => {} },
  } as unknown as ExtensionContext;
}

/** Settings copy with optional overrides. */
function settings(overrides: Partial<typeof DEFAULT_CONFIG>): typeof DEFAULT_CONFIG {
  return { ...DEFAULT_CONFIG, ...overrides };
}

function graphDeltas(appended: { type: string; data: unknown }[]): unknown[] {
  return appended
    .filter((e) => e.type === "memkeeper.graph_delta")
    .map((e) => (e.data as { delta: { type: string } }).delta);
}

function flushNewCount(appended: { type: string; data: unknown }[]): number {
  return graphDeltas(appended).filter((d) => (d as { type: string }).type === "flush_new").length;
}

// --- runBuilder ------------------------------------------------------------

describe("runBuilder", () => {
  beforeEach(() => {
    resetForNewSession();
    setClock(() => NOW);
  });
  afterAll(() => setClock(null));

  it("fast-path: skips passes when under threshold but still flushes new nodes (no stage)", async () => {
    const g = seedGraph([{ id: "n3", summary: "fresh arrival" }]);
    expect(g.nodes.get("n3")?.state).toBe("new");
    const cap = makeFakePi();
    const widget = recordingWidget();
    await runBuilder({
      pi: cap.pi,
      ctx: makeFakeCtx(),
      settings: settings({ builderRootViewThreshold: 1_000_000 }),
      signal: new AbortController().signal,
      widget,
      scope: null,
      runStageFn: scriptRunStage({ passes: [] }),
    });
    // new node flushed to active even though no pass ran
    expect(g.nodes.get("n3")?.state).toBe("active");
    expect(flushNewCount(cap.appended)).toBeGreaterThanOrEqual(1);
    // fast-path opens NO stage (no startStage/endStage) — balanced widget contract
    expect(widget.calls).toEqual([]);
  });

  it("runs multiple passes until try_finish succeeds (convergence)", async () => {
    const g = seedGraph([
      { id: "n3", summary: "a" },
      { id: "n4", summary: "b" },
    ]);
    const widget = recordingWidget();
    let passCount = 0;
    const scripted = scriptRunStage({
      passes: [
        {
          tools: [
            { name: MKDIR_TOOL, ok: true },
            { name: MV_TOOL, ok: true },
            { name: TRY_FINISH_TOOL, ok: false },
          ],
        },
        {
          tools: [
            { name: MERGE_TOOL, ok: true },
            { name: TRY_FINISH_TOOL, ok: true },
          ],
        },
      ],
    });
    const countingRunStage = (input: StageRunInput): Promise<StageRunResult> => {
      passCount += 1;
      return scripted(input);
    };
    await runBuilder({
      pi: makeFakePi().pi,
      ctx: makeFakeCtx(),
      settings: settings({ builderRootViewThreshold: 0, maxBuilderPasses: 5 }),
      signal: new AbortController().signal,
      widget,
      scope: null,
      runStageFn: countingRunStage,
    });
    expect(passCount).toBe(2);
    // convergence is a NORMAL stage-end → new nodes flush to active
    expect(g.nodes.get("n3")?.state).toBe("active");
    expect(g.nodes.get("n4")?.state).toBe("active");
    expect(widget.calls[0]).toBe("start:build:1");
    expect(widget.calls).toContain("pass:2");
    expect(widget.calls[widget.calls.length - 1]).toBe("end");
  });

  it("stops after a no-op pass (0 mutates)", async () => {
    seedGraph([{ id: "n3", summary: "a" }]);
    let passCount = 0;
    const scripted = scriptRunStage({
      passes: [{ tools: [{ name: TRY_FINISH_TOOL, ok: false }] }],
    });
    const countingRunStage = (input: StageRunInput): Promise<StageRunResult> => {
      passCount += 1;
      return scripted(input);
    };
    await runBuilder({
      pi: makeFakePi().pi,
      ctx: makeFakeCtx(),
      settings: settings({ builderRootViewThreshold: 0, maxBuilderPasses: 5 }),
      signal: new AbortController().signal,
      widget: NO_OP_WIDGET,
      scope: null,
      runStageFn: countingRunStage,
    });
    expect(passCount).toBe(1); // no-op → stop after pass 1
  });

  it("keeps partial work and continues when error hits AFTER a mutate", async () => {
    seedGraph([{ id: "n3", summary: "a" }]);
    let passCount = 0;
    const errorScript = scriptRunStageWithError(
      { passes: [{ tools: [{ name: TRY_FINISH_TOOL, ok: true }] }] },
      { toolsBeforeError: [{ name: MKDIR_TOOL, ok: true }], errorPassIndex: 0 },
    );
    const countingRunStage = (input: StageRunInput): Promise<StageRunResult> => {
      passCount += 1;
      return errorScript(input);
    };
    await runBuilder({
      pi: makeFakePi().pi,
      ctx: makeFakeCtx(),
      settings: settings({ builderRootViewThreshold: 0, maxBuilderPasses: 5 }),
      signal: new AbortController().signal,
      widget: NO_OP_WIDGET,
      scope: null,
      runStageFn: countingRunStage,
    });
    // pass 1 errored after 1 mutate → counts as finished; pass 2 converges.
    expect(passCount).toBe(2);
  });

  it("ends the run when error hits BEFORE any mutate (0 applied), new preserved", async () => {
    const g = seedGraph([{ id: "n3", summary: "a" }]);
    let passCount = 0;
    const errorScript = scriptRunStageWithError(
      { passes: [{ tools: [{ name: TRY_FINISH_TOOL, ok: true }] }] },
      { toolsBeforeError: [], errorPassIndex: 0 },
    );
    const countingRunStage = (input: StageRunInput): Promise<StageRunResult> => {
      passCount += 1;
      return errorScript(input);
    };
    const cap = makeFakePi();
    await runBuilder({
      pi: cap.pi,
      ctx: makeFakeCtx(),
      settings: settings({ builderRootViewThreshold: 0, maxBuilderPasses: 5 }),
      signal: new AbortController().signal,
      widget: NO_OP_WIDGET,
      scope: null,
      runStageFn: countingRunStage,
    });
    expect(passCount).toBe(1); // error with 0 mutates → end run
    // run-ending error → new preserved
    expect(g.nodes.get("n3")?.state).toBe("new");
    expect(flushNewCount(cap.appended)).toBe(0);
  });

  it("stops at maxBuilderPasses without convergence", async () => {
    seedGraph([{ id: "n3", summary: "a" }]);
    let passCount = 0;
    const aPass = {
      tools: [
        { name: MKDIR_TOOL, ok: true },
        { name: TRY_FINISH_TOOL, ok: false },
      ],
    };
    // script has a pass for EVERY run (so none throw); the loop stops via the
    // `pass > maxBuilderPasses` break, NOT via a script-out-of-bounds throw.
    const scripted = scriptRunStage({ passes: [aPass, aPass, aPass, aPass] });
    const countingRunStage = (input: StageRunInput): Promise<StageRunResult> => {
      passCount += 1;
      return scripted(input);
    };
    await runBuilder({
      pi: makeFakePi().pi,
      ctx: makeFakeCtx(),
      settings: settings({ builderRootViewThreshold: 0, maxBuilderPasses: 2 }),
      signal: new AbortController().signal,
      widget: NO_OP_WIDGET,
      scope: null,
      runStageFn: countingRunStage,
    });
    expect(passCount).toBe(2); // never converged, hit max
  });

  it("aborts before start: preserves new nodes (run ended early)", async () => {
    const g = seedGraph([{ id: "n3", summary: "a" }]);
    const ac = new AbortController();
    ac.abort(); // abort before the run starts
    const scripted = scriptRunStage({ passes: [{ tools: [{ name: MKDIR_TOOL, ok: true }] }] });
    const countingRunStage = (input: StageRunInput): Promise<StageRunResult> => scripted(input);
    const cap = makeFakePi();
    await runBuilder({
      pi: cap.pi,
      ctx: makeFakeCtx(),
      settings: settings({ builderRootViewThreshold: 0 }),
      signal: ac.signal,
      widget: NO_OP_WIDGET,
      scope: null,
      runStageFn: countingRunStage,
    });
    // aborted before start → new nodes stay new (no stage, no flush); the
    // ensure-ready gate / next run re-processes them.
    expect(g.nodes.get("n3")?.state).toBe("new");
    expect(flushNewCount(cap.appended)).toBe(0);
  });

  it("aborts between passes: applied mutates kept, run stops, new preserved", async () => {
    const g = seedGraph([{ id: "n3", summary: "a" }]);
    const ac = new AbortController();
    let passCount = 0;
    // pass 1 applies a mutate then aborts the signal (simulating compaction
    // canceling an in-flight run at a tool-call boundary); the loop stops after
    // pass 1 (the next iteration's signal check breaks).
    const scripted = scriptRunStage({ passes: [{ tools: [{ name: MKDIR_TOOL, ok: true }] }] });
    const countingRunStage = (input: StageRunInput): Promise<StageRunResult> => {
      passCount += 1;
      // abort partway through: after the scripted pass resolves, signal aborts.
      const p = scripted(input);
      ac.abort();
      return p;
    };
    const cap = makeFakePi();
    await runBuilder({
      pi: cap.pi,
      ctx: makeFakeCtx(),
      settings: settings({ builderRootViewThreshold: 0, maxBuilderPasses: 5 }),
      signal: ac.signal,
      widget: NO_OP_WIDGET,
      scope: null,
      runStageFn: countingRunStage,
    });
    // only pass 1 ran (the signal-abort break stopped the loop before pass 2)
    expect(passCount).toBe(1);
    // abort → run ended early → new nodes preserved (no flush)
    expect(g.nodes.get("n3")?.state).toBe("new");
    expect(flushNewCount(cap.appended)).toBe(0);
  });
});
