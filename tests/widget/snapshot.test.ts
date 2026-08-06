// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// Unit tests for buildSnapshot — the core delta-computation + context-fallback
// + selected-delta-guard (exercises it directly rather than via the wiring smoke).

import type { AgentEvent } from "@earendil-works/pi-agent-core";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { _resetGetMemkeeperSettings, _setGetMemkeeperSettings, DEFAULT_CONFIG } from "../../src/config/schema.js";
import { applyCreateNode } from "../../src/graph/mutations.js";
import { getGraphStore, resetForNewSession } from "../../src/store/graph-store.js";
import type { NodeId } from "../../src/types.js";
import { buildSnapshot, createTracker, type ProgressTracker } from "../../src/widget/tracker.js";

function makeCtx(): ExtensionContext {
  // contextTokens/window now come from the background agent's message_end usage
  // + model registry (NOT the main session's getContextUsage).
  return {
    modelRegistry: {
      find: () => ({ contextWindow: 262_000 }),
    },
  } as unknown as ExtensionContext;
}

describe("buildSnapshot", () => {
  let tracker: ProgressTracker;

  beforeEach(() => {
    resetForNewSession();
    // Pin the settings read to DEFAULT_CONFIG so buildSnapshot is order-independent
    // under isolate:false (other files leak the module handle via initMemkeeperSettings).
    _setGetMemkeeperSettings(() => DEFAULT_CONFIG);
    tracker = createTracker();
  });

  afterEach(() => _resetGetMemkeeperSettings());

  it("obs/roots deltas are current − baseline (captured at stage start)", () => {
    tracker.startStage("observe"); // baseline: 0 obs, 0 roots
    // seed a root AFTER stage start → it counts as a delta
    applyCreateNode(getGraphStore().graph, {
      id: "n1" as NodeId,
      summary: "goal",
      importance: "high",
      parentNode: null,
      state: "active",
    });
    const snap = buildSnapshot(tracker, makeCtx());
    expect(snap.obs.count).toBe(0);
    expect(snap.obs.delta).toBe(0);
    expect(snap.roots.count).toBe(1);
    expect(snap.roots.countDelta).toBe(1); // 1 − 0 baseline
  });

  it("roots viewTokens is the full root-view render (not Σ summaryTokens), threshold from config", () => {
    applyCreateNode(getGraphStore().graph, {
      id: "n1" as NodeId,
      summary: "x".repeat(40),
      importance: "high",
      parentNode: null,
      state: "active",
    });
    tracker.startStage("build", { pass: 1 });
    const snap = buildSnapshot(tracker, makeCtx());
    // viewTokens = the full rendered root-view line (icon/id/importance/datetime…),
    // NOT just the summary's ceil(40/4)=10 — strictly larger than the summary alone.
    expect(snap.roots.viewTokens).toBeGreaterThan(10);
    expect(snap.roots.threshold).toBe(40_000); // DEFAULT_CONFIG.builderRootViewThreshold
  });

  it("contextTokens + window track the BACKGROUND agent's message_end usage (not the main session)", () => {
    tracker.startStage("observe");
    // before any message_end → both null (no context figure yet)
    let snap = buildSnapshot(tracker, makeCtx());
    expect(snap.contextTokens).toBeNull();
    expect(snap.contextWindow).toBeNull();
    // a message_end carries the agent's totalTokens + model id → both surface
    tracker.onEvent({
      type: "message_end",
      message: {
        role: "assistant",
        content: [],
        model: "anthropic/claude",
        usage: { input: 0, output: 0, cacheRead: 0, totalTokens: 66_000, cost: 0 },
      },
    } as unknown as AgentEvent);
    snap = buildSnapshot(tracker, makeCtx());
    expect(snap.contextTokens).toBe(66_000);
    expect(snap.contextWindow).toBe(262_000);
  });

  it("getContextUsage() undefined → both contextTokens and contextWindow null", () => {
    tracker.startStage("observe");
    const snap = buildSnapshot(tracker, makeCtx());
    expect(snap.contextTokens).toBeNull();
    expect(snap.contextWindow).toBeNull(); // never 0
  });

  it("contextWindow is null when the agent model id has no slash (carried R23-7)", () => {
    tracker.startStage("observe");
    const ctxMiss = { modelRegistry: { find: () => undefined } } as unknown as ExtensionContext;
    tracker.onEvent({
      type: "message_end",
      message: {
        role: "assistant",
        content: [],
        model: "bare-model-name", // no provider/id slash
        usage: { input: 0, output: 0, cacheRead: 0, totalTokens: 5000, cost: 0 },
      },
    } as unknown as AgentEvent);
    const snap = buildSnapshot(tracker, ctxMiss);
    expect(snap.contextTokens).toBe(5000); // tokens still surface
    expect(snap.contextWindow).toBeNull(); // no slash → can't resolve the window
  });

  it("contextWindow is null when the model registry has no entry (carried R23-7)", () => {
    tracker.startStage("observe");
    const ctxMiss = { modelRegistry: { find: () => undefined } } as unknown as ExtensionContext;
    tracker.onEvent({
      type: "message_end",
      message: {
        role: "assistant",
        content: [],
        model: "anthropic/unknown-model",
        usage: { input: 0, output: 0, cacheRead: 0, totalTokens: 5000, cost: 0 },
      },
    } as unknown as AgentEvent);
    const snap = buildSnapshot(tracker, ctxMiss);
    expect(snap.contextTokens).toBe(5000);
    expect(snap.contextWindow).toBeNull(); // registry miss → null, never 0
  });

  it("selected section deltas measured from the working-copy baseline (first push)", () => {
    tracker.startStage("select");
    tracker.setSelectedCounts(95, 35_000); // first push → baseline
    tracker.setSelectedCounts(20, 15_000); // current
    const snap = buildSnapshot(tracker, makeCtx());
    expect(snap.selected).not.toBeNull();
    expect(snap.selected?.count).toBe(20);
    expect(snap.selected?.countDelta).toBe(-75); // 20 − 95 baseline
    expect(snap.selected?.viewTokens).toBe(15_000);
    expect(snap.selected?.tokenDelta).toBe(-20_000); // 15000 − 35000
    expect(snap.selected?.threshold).toBe(20_000); // DEFAULT_CONFIG.selectorRootViewThreshold
  });

  it("selected section is null outside a Select stage", () => {
    tracker.startStage("build", { pass: 1 });
    tracker.setSelectedCounts(20, 15_000);
    const snap = buildSnapshot(tracker, makeCtx());
    expect(snap.selected).toBeNull();
  });

  it("selected section is null in observations-root renderMode even during Select", () => {
    // Exercises the renderMode arm of the gate: stage IS select and counts ARE
    // pushed, but renderMode is observations-root → the selected section is
    // suppressed (observations-root has no curated selected tree).
    _setGetMemkeeperSettings(() => ({ ...DEFAULT_CONFIG, renderMode: "observations-root" }));
    tracker.startStage("select");
    tracker.setSelectedCounts(20, 15_000);
    const snap = buildSnapshot(tracker, makeCtx());
    expect(snap.selected).toBeNull();
  });

  it("caches root counts across message_update deltas (recomputed only on state-change events)", () => {
    // Perf: the widget renders per streaming event, but the graph only changes
    // on tool_execution_end, so buildSnapshot must reuse cached root counts for
    // message_update deltas rather than re-rendering the whole root view per token.
    tracker.startStage("build");
    buildSnapshot(tracker, makeCtx()); // computes + caches
    // add a root AFTER the snapshot, with no tool_execution_end reaching the widget
    applyCreateNode(getGraphStore().graph, {
      id: "n1" as NodeId,
      summary: "arrived mid-stream",
      importance: "high",
      parentNode: null,
      state: "active",
    });
    // several streaming deltas must NOT invalidate the cache
    for (let i = 0; i < 5; i += 1) {
      tracker.onEvent({
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", delta: `delta${i} ` },
      } as unknown as AgentEvent);
    }
    const cached = buildSnapshot(tracker, makeCtx());
    expect(cached.roots.count).toBe(0); // cached pre-arrival value
    // a tool_execution_end event invalidates → next build sees the new root
    tracker.onEvent({
      type: "tool_execution_end",
      toolCallId: "c1",
      toolName: "mkdir",
      result: {},
      isError: false,
    } as unknown as AgentEvent);
    const refreshed = buildSnapshot(tracker, makeCtx());
    expect(refreshed.roots.count).toBe(1);
  });

  it("getContextUsage() is never read (context tracks the background agent, not the main session)", () => {
    // The widget's context figure is the background agent's message_end
    // usage.totalTokens, NOT the main session's getContextUsage(). So
    // message_update deltas + message_end do NOT call getContextUsage at all.
    let reads = 0;
    const countingCtx = {
      getContextUsage: () => {
        reads += 1;
        return { tokens: 1234, contextWindow: 262_000 };
      },
      modelRegistry: { find: () => ({ contextWindow: 262_000 }) },
    } as unknown as ExtensionContext;
    tracker.startStage("build");
    buildSnapshot(tracker, countingCtx);
    for (let i = 0; i < 5; i += 1) {
      tracker.onEvent({
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", delta: `d${i} ` },
      } as unknown as AgentEvent);
      buildSnapshot(tracker, countingCtx);
    }
    tracker.onEvent({
      type: "message_end",
      message: {
        role: "assistant",
        content: [],
        model: "anthropic/claude",
        usage: { input: 0, output: 0, cacheRead: 0, totalTokens: 5000, cost: 0 },
      },
    } as unknown as AgentEvent);
    buildSnapshot(tracker, countingCtx);
    expect(reads).toBe(0); // the main session's getContextUsage is never consulted
  });
});
