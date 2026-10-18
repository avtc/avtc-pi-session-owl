// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// Engine-kit twin of the runs suite: a representative slice of the run
// orchestrations loaded from the plugin's own tree under the hooks-environment
// import rules. The full behavior tables live in the Node suite (tests/runs);
// this twin pins the load + the load-bearing contracts that are loadable
// under the kit loader: the seams, the stage-error classes, and the
// goal-extract profile over a FAKE core handle (the observer/builder/selector
// runs transitively reach the core's log.ts bare edge (a bare package
// import the kit loader refuses) — so their kit-side coverage rides the
// Node suite + the stage twin).
import { describe, expect, test } from "claude-code/testing";
import { makeNode, N_GOAL, nowStoredTimestamp, SessionOwlGraph } from "../core/src/types.js";
import { abortGoalExtract, runGoalExtract } from "../host/runs/goal-extract.js";
import { loggerNotify, NO_OP_WIDGET } from "../host/runs/seams.js";
import { StageTimeoutError } from "../host/runs/stage-errors.js";

describe("stage runs — engine-run twin", () => {
  test("the seams load under the kit (notify default + NO_OP widget)", () => {
    const lines: string[] = [];
    const notify = loggerNotify((m) => lines.push(m));
    notify("Observer returned no observations", "warning");
    expect(lines).toEqual(["session-owl: Observer returned no observations"]);
    expect(() => NO_OP_WIDGET.startStage("observe", { batch: { done: 0, total: 1 } })).not.toThrow();
  });

  test("the stage error classes carry pi's exact messages", () => {
    expect(new StageTimeoutError("Observer", 30_000).message).toBe(
      "Observer stopped: an LLM call exceeded the 30s time limit",
    );
  });

  test("goal-extract: the clobber guard fires before any completer call (fake core)", async () => {
    const graph = new SessionOwlGraph({ nodes: new Map(), observations: new Map(), nextObsId: 1, nextNodeId: 1 });
    graph.nodes.set(
      N_GOAL,
      makeNode({
        id: N_GOAL,
        summary: "already set",
        importance: "crit",
        parentNode: null,
        state: "active",
        createdAt: nowStoredTimestamp(),
      }),
    );
    const appended: unknown[] = [];
    const fakeCore = {
      key: "twin-goal-clobber",
      store: {
        getGraphStore: () => ({ graph }),
        appendGraphDelta: (_store: unknown, delta: unknown) => {
          appended.push(delta);
        },
      },
    };
    let completerCalls = 0;
    await runGoalExtract({
      core: fakeCore as never,
      store: {} as never,
      settings: { llmCallTimeoutMs: 30_000, observerMaxTokens: 4096, observerThinkingLevel: "high" } as never,
      widget: NO_OP_WIDGET,
      verbatimText: "the ask",
      completer: async (input) => {
        completerCalls += 1;
        expect(input.maxTokens).toBe(4096); // the observer tokens knob (owner ruling)
        expect(input.effort).toBe("high"); // the observer thinking ladder
        return "a goal";
      },
    });
    expect(completerCalls).toBe(0); // guard first — never clobber
    expect(graph.nodes.get(N_GOAL)?.summary).toBe("already set");
    expect(appended).toHaveLength(0);
    abortGoalExtract(); // the per-conversation abort seam loads + is callable
  });

  test("goal-extract over an empty summary writes the distilled goal + persists the delta", async () => {
    const graph = new SessionOwlGraph({ nodes: new Map(), observations: new Map(), nextObsId: 1, nextNodeId: 1 });
    graph.nodes.set(
      N_GOAL,
      makeNode({
        id: N_GOAL,
        summary: "",
        importance: "crit",
        parentNode: null,
        state: "active",
        createdAt: nowStoredTimestamp(),
      }),
    );
    const appended: unknown[] = [];
    const fakeCore = {
      key: "twin-goal-write",
      store: {
        getGraphStore: () => ({ graph }),
        appendGraphDelta: (_store: unknown, delta: unknown) => {
          appended.push(delta);
        },
      },
    };
    await runGoalExtract({
      core: fakeCore as never,
      store: {} as never,
      settings: { llmCallTimeoutMs: 30_000 } as never,
      widget: NO_OP_WIDGET,
      verbatimText: "the ask",
      completer: async () => "Distilled goal line",
    });
    expect(graph.nodes.get(N_GOAL)?.summary).toBe("Distilled goal line");
    expect(appended).toHaveLength(1); // the atomic set_meta delta
    expect((appended[0] as { type?: string }).type).toBe("set_meta");
  });
});
