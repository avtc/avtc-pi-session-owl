// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// The owl_recall tool.call body — the mapping onto the Claude surface:
// the gate order (conflict-paused SERVES; disabled-only REJECTS by
// answering {deny: the reason}), the check-then-serve seam awaited BEFORE
// the serve, the calling loop's key resolution, and the vendored
// executeRecall reuse — success maps to {result: text}, error results
// answer {deny: the exact error text} (the engine delivers it to the model
// as an error result — identical to pi's in-band error result).
import { beforeEach, describe, expect, test } from "vitest";
import { clearDetailsCache } from "../../core/src/format/details.js";
import { getGraphStore, resetForNewSession } from "../../core/src/store/graph-store.js";
import { makeNode, nowStoredTimestamp } from "../../core/src/types.js";
import { _resetCoreInstances } from "../../host/core-instances.js";
import {
  handleOwlRecallCall,
  OWL_RECALL_DISABLED_REASON,
  OWL_RECALL_SUBAGENT_DISABLED_REASON,
  type RecallHandlerDeps,
} from "../../host/recall/handler.js";
import * as state from "../../host/state.js";

/** The disabled-only reject reason — pi's own user-facing phrasing the
 *  reject delivers (commands say it as a notification; recall delivers it
 *  as the deny text). */
const PI_DISABLED_TEXT = "session-owl is disabled (enable it first).";

function seedGraph(): void {
  const g = getGraphStore().graph;
  const node = makeNode({
    id: "n-1" as never,
    summary: "the root with a detail line",
    importance: "med",
    parentNode: null,
    state: "active",
    createdAt: nowStoredTimestamp(),
  });
  node.observationIds = ["o-1"];
  g.nodes.set(node.id as never, node);
  const ts = nowStoredTimestamp();
  g.observations.set("o-1", {
    id: "o-1",
    parentNode: "n-1",
    summary: "an observation about the work",
    sourceEntryIds: ["e1"],
    importance: "med",
    createdAt: ts,
    state: "active",
    timestamp: ts,
    timestamps: { start: ts, end: ts },
  } as never);
}

interface Harness {
  order: string[];
  deps: RecallHandlerDeps;
}

function makeHarness(over: Partial<RecallHandlerDeps> = {}): Harness {
  const order: string[] = [];
  const deps: RecallHandlerDeps = {
    resolveKey: (agentId) => {
      order.push(`resolve:${agentId ?? "main"}`);
      return agentId === null ? "sess-r" : `sess-r|${agentId}`;
    },
    isDisabled: () => false,
    subagentsDisabled: () => false,
    isConflictPaused: () => false,
    checkThenServe: async (key) => {
      order.push(`check:${key}`);
      void key;
    },
    pinCore: async (key) => {
      order.push(`pin:${key}`);
    },
    ...over,
  };
  return { order, deps };
}

const CALL = { tool: "mcp__session-owl__owl_recall", input: {} };

beforeEach(() => {
  _resetCoreInstances();
  resetForNewSession();
  clearDetailsCache();
  state._resetForTest();
});

describe("owl_recall handler — the gate order", () => {
  test("conflict-paused AND disabled ⇒ still SERVES (pause wins over disable — pi parity)", async () => {
    seedGraph();
    const h = makeHarness({ isConflictPaused: () => true, isDisabled: () => true });
    const answer = await handleOwlRecallCall({ ...CALL, input: { ids: ["n-1"] } }, h.deps);
    expect(answer).toEqual({ result: expect.stringContaining("the root with a detail line") });
  });

  test("disabled (and not paused) ⇒ DENIES the reason, nothing served, no core pin", async () => {
    seedGraph();
    const h = makeHarness({ isDisabled: () => true });
    const answer = await handleOwlRecallCall({ ...CALL, input: { ids: ["n-1"] } }, h.deps);
    expect(answer).toEqual({ deny: OWL_RECALL_DISABLED_REASON });
    expect(h.order).toEqual(["resolve:main"]); // no check, no pin, no serve
  });

  test("the reject reason is pi's own user-facing phrasing", () => {
    expect(OWL_RECALL_DISABLED_REASON).toBe(PI_DISABLED_TEXT);
  });
});

describe("owl_recall handler — subagentMode disabled rejects SUBAGENT calls", () => {
  // Under subagentMode "disabled" session-owl is
  // off for subagents — their owl_recall calls are rejected with a simple
  // clear reason (the deny text is the model's error result). The MAIN
  // conversation is unaffected; inherited/on-compaction still serve subs.
  test("an agentId-bearing call under subagentsDisabled ⇒ DENIES the subagent reason, nothing served", async () => {
    seedGraph();
    const h = makeHarness({ subagentsDisabled: () => true });
    const answer = await handleOwlRecallCall({ ...CALL, agentId: "ag-7", input: { ids: ["n-1"] } }, h.deps);
    expect(answer).toEqual({ deny: OWL_RECALL_SUBAGENT_DISABLED_REASON });
    expect(h.order).toEqual(["resolve:ag-7"]); // no check, no pin, no serve
  });

  test("the MAIN conversation still serves under subagentsDisabled (the axis is who asks)", async () => {
    seedGraph();
    const h = makeHarness({ subagentsDisabled: () => true });
    const answer = await handleOwlRecallCall({ ...CALL, input: { ids: ["n-1"] } }, h.deps);
    expect(answer).toEqual({ result: expect.stringContaining("the root with a detail line") });
  });

  test("inherited/on-compaction (subagentsDisabled false) still serve the subagent loop", async () => {
    seedGraph();
    const h = makeHarness({ subagentsDisabled: () => false });
    const answer = await handleOwlRecallCall({ ...CALL, agentId: "ag-7", input: { ids: ["n-1"] } }, h.deps);
    expect(answer).toEqual({ result: expect.stringContaining("the root with a detail line") });
  });
});

describe("owl_recall handler — check-then-serve and the loop key", () => {
  test("the canonical-view check runs BEFORE the pin + serve", async () => {
    seedGraph();
    const h = makeHarness();
    await handleOwlRecallCall({ ...CALL, input: { ids: ["n-1"] } }, h.deps);
    expect(h.order).toEqual(["resolve:main", "check:sess-r", "pin:sess-r"]);
  });

  test("a subagent loop call resolves THAT loop's key (its own graph)", async () => {
    seedGraph();
    const h = makeHarness();
    await handleOwlRecallCall({ ...CALL, agentId: "ag-9", input: { ids: ["n-1"] } }, h.deps);
    expect(h.order).toEqual(["resolve:ag-9", "check:sess-r|ag-9", "pin:sess-r|ag-9"]);
  });
});

describe("owl_recall handler — the serve mapping", () => {
  test("success ⇒ {result: text} with the vendored renderer's text verbatim (ids drill)", async () => {
    seedGraph();
    const h = makeHarness();
    const answer = await handleOwlRecallCall({ ...CALL, input: { ids: ["n-1"] } }, h.deps);
    expect(answer).toEqual({ result: expect.stringContaining("the root with a detail line") });
    expect(answer).toEqual({ result: expect.not.stringContaining("error") });
  });

  test("an error result ⇒ answers {deny} with the exact error text (the model's error row)", async () => {
    seedGraph();
    const h = makeHarness();
    // lines without an ids target is pi's in-band validation error
    const answer = await handleOwlRecallCall({ ...CALL, input: { lines: "1-2" } }, h.deps);
    expect(answer).toEqual({ deny: expect.stringMatching(/lines/) });
  });

  test("an unknown id ⇒ pi's not-found text as a normal RESULT (not an error row)", async () => {
    seedGraph();
    const h = makeHarness();
    const answer = await handleOwlRecallCall({ ...CALL, input: { ids: ["n-missing"] } }, h.deps);
    expect(answer).toEqual({ result: expect.stringMatching(/No node or observation/i) });
  });
});
