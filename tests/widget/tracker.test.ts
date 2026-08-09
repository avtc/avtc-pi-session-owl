// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// Unit tests for the real ProgressTracker (widget state object).
// The tracker is pure state — startStage/endStage/onEvent/setPass/setBatch — and
// exposes a snapshot() the render formats. No ctx/ui coupling here (that lives on
// the WidgetController wrapper, tested via the wiring smoke test).

import type { AgentEvent } from "@earendil-works/pi-agent-core";
import { beforeEach, describe, expect, it } from "vitest";
import { applyCreateNode, applyRecordObservation } from "../../src/graph/mutations.js";
import { getGraphStore, resetForNewSession } from "../../src/store/graph-store.js";
import type { NodeId, ObsId } from "../../src/types.js";
import { makeObservation } from "../../src/types.js";
import { createTracker, type ProgressTracker } from "../../src/widget/tracker.js";

// Apply a root node to the live store so snapshot() sees non-zero counts.
function seedRoot(id: NodeId, summary: string): void {
  applyCreateNode(getGraphStore().graph, { id, summary, importance: "high", parentNode: null, state: "active" });
}
function seedObs(id: ObsId, parentNode: NodeId): void {
  applyRecordObservation(getGraphStore().graph, {
    obs: makeObservation({
      id,
      summary: "x".repeat(NUM_FORTY),
      importance: "med",
      sourceEntryIds: [],
      timestamp: "2026-07-30T00:00:00Z",
      parentNode,
    }),
  });
}

const NUM_FORTY = 40;

function messageEndEvent(usage: {
  input?: number;
  output?: number;
  cacheRead?: number;
  cost?: { total?: number };
}): AgentEvent {
  return {
    type: "message_end",
    message: { role: "assistant", content: [{ type: "text", text: "ok" }], usage },
  } as unknown as AgentEvent;
}

function textDeltaEvent(delta: string): AgentEvent {
  return {
    type: "message_update",
    assistantMessageEvent: { type: "text_delta", delta },
  } as unknown as AgentEvent;
}

function thinkingDeltaEvent(delta: string): AgentEvent {
  return {
    type: "message_update",
    assistantMessageEvent: { type: "thinking_delta", delta },
  } as unknown as AgentEvent;
}

describe("ProgressTracker state", () => {
  let tracker: ProgressTracker;

  beforeEach(() => {
    resetForNewSession();
    tracker = createTracker();
  });

  describe("startStage / endStage", () => {
    it("startStage sets the stage and snapshots a baseline of current graph counts", () => {
      seedRoot("n1" as NodeId, "goal");
      seedObs("o1" as ObsId, "n1" as NodeId);
      tracker.startStage("observe");
      expect(tracker.stage).toBe("observe");
      // baseline captured the counts AT stage start (1 obs, 1 root).
      expect(tracker.baseline?.obsCount).toBe(1);
      expect(tracker.baseline?.rootsCount).toBe(1);
    });

    it("startStage seeds pass=1 and clears batch when only pass given", () => {
      tracker.startStage("build", { pass: 1 });
      expect(tracker.pass).toBe(1);
      expect(tracker.batch).toBeNull();
    });

    it("startStage seeds batch when given (observe multi-chunk)", () => {
      tracker.startStage("observe", { batch: { done: 0, total: 7 } });
      expect(tracker.batch).toEqual({ done: 0, total: 7 });
    });

    it("endStage resets stage to null (next snapshot is idle)", () => {
      tracker.startStage("observe");
      tracker.endStage();
      expect(tracker.stage).toBeNull();
    });
  });

  describe("setPass / setBatch / setSelectedCounts", () => {
    it("setPass updates the pass number", () => {
      tracker.startStage("build", { pass: 1 });
      tracker.setPass(3);
      expect(tracker.pass).toBe(3);
    });

    it("setBatch updates the batch progress", () => {
      tracker.startStage("observe", { batch: { done: 0, total: 7 } });
      tracker.setBatch(3, 7);
      expect(tracker.batch).toEqual({ done: 3, total: 7 });
    });

    it("setSelectedCounts stores working-copy selected counts (Select-only push)", () => {
      tracker.setSelectedCounts(20, 15_000);
      expect(tracker.selectedCount).toBe(20);
      expect(tracker.selectedViewTokens).toBe(15_000);
    });

    it("startStage(select) clears any prior selected baseline so the first push re-anchors", () => {
      tracker.startStage("select");
      tracker.setSelectedCounts(95, 35_000); // first push → baseline
      tracker.setSelectedCounts(20, 15_000); // second push
      // the selected baseline is the first push after the select stage start
      expect(tracker.selectedBaseline).toEqual({ count: 95, viewTokens: 35_000 });
      expect(tracker.selectedCount).toBe(20);
      expect(tracker.selectedViewTokens).toBe(15_000);
    });

    it("startStage(reset) on a non-select stage clears the selected counts + baseline", () => {
      tracker.startStage("select");
      tracker.setSelectedCounts(95, 35_000);
      tracker.startStage("build", { pass: 1 });
      expect(tracker.selectedCount).toBeNull();
      expect(tracker.selectedViewTokens).toBeNull();
      expect(tracker.selectedBaseline).toBeNull();
    });
  });

  describe("onEvent — usage accumulation", () => {
    it("accumulates usage across message_end events (input/output/cacheRead/cost/turns)", () => {
      tracker.startStage("build", { pass: 1 });
      tracker.onEvent(messageEndEvent({ input: 100, output: 50, cacheRead: 10, cost: { total: 0.01 } }));
      tracker.onEvent(messageEndEvent({ input: 200, output: 60, cacheRead: 20, cost: { total: 0.02 } }));
      tracker.onEvent({ type: "turn_end" } as unknown as AgentEvent);
      expect(tracker.usage).toEqual({ input: 300, output: 110, cacheRead: 30, cost: 0.03, turns: 1, elapsedMs: 0 });
    });

    it("ignores message_end events with no usage (steering/toolResult messages)", () => {
      tracker.startStage("build", { pass: 1 });
      tracker.onEvent(messageEndEvent({}));
      expect(tracker.usage).toEqual({ input: 0, output: 0, cacheRead: 0, cost: 0, turns: 0, elapsedMs: 0 });
    });
  });

  describe("onEvent — two-tier streamingOutputTokens", () => {
    it("primary tier: uses usage.output from message_update when the provider streams usage", () => {
      tracker.startStage("build", { pass: 1 });
      // simulate a provider that streams cumulative output usage via message_update
      const ev = {
        type: "message_update",
        message: { usage: { output: 250 } },
      } as unknown as AgentEvent;
      tracker.onEvent(ev);
      expect(tracker.streamingOutputTokens).toBe(250);
    });

    it("primary tier is guarded > tokensSoFar (never goes backwards on a smaller value)", () => {
      tracker.startStage("build", { pass: 1 });
      tracker.onEvent({ type: "message_update", message: { usage: { output: 300 } } } as unknown as AgentEvent);
      // a later smaller value (new message resets its own usage) does not decrease
      tracker.onEvent({ type: "message_update", message: { usage: { output: 50 } } } as unknown as AgentEvent);
      expect(tracker.streamingOutputTokens).toBe(300);
    });

    it("fallback tier: estimates chars/4 over text_delta when no usage is streamed", () => {
      tracker.startStage("build", { pass: 1 });
      // 40 chars of delta text → ceil(40/4) = 10 tokens
      tracker.onEvent(textDeltaEvent("a".repeat(NUM_FORTY)));
      expect(tracker.streamingOutputTokens).toBe(10);
    });

    it("fallback accumulates across multiple deltas", () => {
      tracker.startStage("build", { pass: 1 });
      tracker.onEvent(textDeltaEvent("a".repeat(NUM_FORTY)));
      tracker.onEvent(textDeltaEvent("b".repeat(NUM_FORTY)));
      expect(tracker.streamingOutputTokens).toBe(20);
    });

    it("uses max(primary, fallback): a larger primary is shown, a smaller one does not mask the rising fallback", () => {
      tracker.startStage("build", { pass: 1 });
      tracker.onEvent(textDeltaEvent("a".repeat(NUM_FORTY))); // fallback +10
      tracker.onEvent({ type: "message_update", message: { usage: { output: 99 } } } as unknown as AgentEvent);
      // primary (99) > fallback (10) → 99 shown
      expect(tracker.streamingOutputTokens).toBe(99);
    });

    it("progresses during thinking: a stale primary does not freeze the counter (the fallback rises and max shows it)", () => {
      // Reproduces the freeze: provider reports output=1 once early, then goes
      // silent during extended thinking while thinking deltas stream. Under the
      // old primary-wins rule the counter stuck at 1; max shows the rising fallback.
      tracker.startStage("build", { pass: 1 });
      tracker.onEvent({ type: "message_update", message: { usage: { output: 1 } } } as unknown as AgentEvent);
      expect(tracker.streamingOutputTokens).toBe(1);
      // thinking streams — no more usage.output, but thinking deltas arrive
      tracker.onEvent(thinkingDeltaEvent("a".repeat(NUM_FORTY))); // fallback +10
      tracker.onEvent(thinkingDeltaEvent("b".repeat(NUM_FORTY))); // fallback +20
      expect(tracker.streamingOutputTokens).toBe(20); // max(1, 20)
      tracker.onEvent(thinkingDeltaEvent("c".repeat(NUM_FORTY))); // fallback +30
      expect(tracker.streamingOutputTokens).toBe(30); // progresses, no freeze
    });
  });
});

describe("onEvent — message_start resets the streaming counter per prompt", () => {
  let tracker: ProgressTracker;

  beforeEach(() => {
    resetForNewSession();
    tracker = createTracker();
  });

  it("resets primary/fallback/streaming to 0 on message_start (each prompt is fresh)", () => {
    tracker.startStage("build", { pass: 1 });
    tracker.onEvent(textDeltaEvent("a".repeat(NUM_FORTY))); // fallback +10
    tracker.onEvent({ type: "message_update", message: { usage: { output: 250 } } } as unknown as AgentEvent);
    expect(tracker.streamingOutputTokens).toBe(250);
    // a new prompt (next turn/chunk) resets the counter so it reflects the CURRENT
    // generation, not a stage-wide cumulative that grows too large to see move
    tracker.onEvent({ type: "message_start", message: {} } as unknown as AgentEvent);
    expect(tracker.streamingOutputTokens).toBe(0);
    tracker.onEvent(textDeltaEvent("b".repeat(NUM_FORTY))); // fresh fallback +10
    expect(tracker.streamingOutputTokens).toBe(10);
  });
});
