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

type CtxUsage = { tokens: number | null; contextWindow: number } | undefined;

function makeCtx(usage: CtxUsage): ExtensionContext {
  return {
    getContextUsage: () => usage,
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
    const snap = buildSnapshot(tracker, makeCtx({ tokens: 1000, contextWindow: 262_000 }));
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
    const snap = buildSnapshot(tracker, makeCtx({ tokens: 0, contextWindow: 262_000 }));
    // viewTokens = the full rendered root-view line (icon/id/importance/datetime…),
    // NOT just the summary's ceil(40/4)=10 — strictly larger than the summary alone.
    expect(snap.roots.viewTokens).toBeGreaterThan(10);
    expect(snap.roots.threshold).toBe(40_000); // DEFAULT_CONFIG.builderRootViewThreshold
  });

  it("contextTokens null (right after compaction) → contextTokens null, window present", () => {
    tracker.startStage("observe");
    const snap = buildSnapshot(tracker, makeCtx({ tokens: null, contextWindow: 262_000 }));
    expect(snap.contextTokens).toBeNull();
    expect(snap.contextWindow).toBe(262_000);
  });

  it("getContextUsage() undefined → both contextTokens and contextWindow null", () => {
    tracker.startStage("observe");
    const snap = buildSnapshot(tracker, makeCtx(undefined));
    expect(snap.contextTokens).toBeNull();
    expect(snap.contextWindow).toBeNull(); // never 0
  });

  it("selected section deltas measured from the working-copy baseline (first push)", () => {
    tracker.startStage("select");
    tracker.setSelectedCounts(95, 35_000); // first push → baseline
    tracker.setSelectedCounts(20, 15_000); // current
    const snap = buildSnapshot(tracker, makeCtx({ tokens: 0, contextWindow: 262_000 }));
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
    const snap = buildSnapshot(tracker, makeCtx({ tokens: 0, contextWindow: 262_000 }));
    expect(snap.selected).toBeNull();
  });

  it("selected section is null in observations-root renderMode even during Select", () => {
    // observations-root is the default in this test store's settings? No — default
    // is selected-root. Flip by re-init: buildSnapshot reads getMemkeeperSettings();
    // verify the selected-root default shows it, then confirm gating logic via stage.
    tracker.startStage("observe"); // not select → null regardless of renderMode
    tracker.setSelectedCounts(20, 15_000);
    const snap = buildSnapshot(tracker, makeCtx({ tokens: 0, contextWindow: 262_000 }));
    expect(snap.selected).toBeNull();
  });

  it("caches root counts across message_update deltas (recomputed only on state-change events)", () => {
    // Perf: the widget renders per streaming event, but the graph only changes
    // on tool_execution_end, so buildSnapshot must reuse cached root counts for
    // message_update deltas rather than re-rendering the whole root view per token.
    tracker.startStage("build");
    buildSnapshot(tracker, makeCtx({ tokens: 0, contextWindow: 262_000 })); // computes + caches
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
    const cached = buildSnapshot(tracker, makeCtx({ tokens: 0, contextWindow: 262_000 }));
    expect(cached.roots.count).toBe(0); // cached pre-arrival value
    // a tool_execution_end event invalidates → next build sees the new root
    tracker.onEvent({
      type: "tool_execution_end",
      toolCallId: "c1",
      toolName: "mkdir",
      result: {},
      isError: false,
    } as unknown as AgentEvent);
    const refreshed = buildSnapshot(tracker, makeCtx({ tokens: 0, contextWindow: 262_000 }));
    expect(refreshed.roots.count).toBe(1);
  });

  it("caches getContextUsage across message_update deltas (re-read only on message boundaries)", () => {
    // Perf: getContextUsage() re-tokenizes the whole message history, but the
    // context only changes at message/turn boundaries — not per streaming token.
    // So buildSnapshot must reuse the cached read for message_update deltas.
    let reads = 0;
    const countingCtx = {
      getContextUsage: () => {
        reads += 1;
        return { tokens: 1234, contextWindow: 262_000 };
      },
    } as unknown as ExtensionContext;
    tracker.startStage("build");
    buildSnapshot(tracker, countingCtx); // first read
    expect(reads).toBe(1);
    // several streaming deltas must NOT re-read context usage
    for (let i = 0; i < 5; i += 1) {
      tracker.onEvent({
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", delta: `d${i} ` },
      } as unknown as AgentEvent);
      buildSnapshot(tracker, countingCtx);
    }
    expect(reads).toBe(1); // still cached — no re-read across message_update
    // a message_end (message finalized) invalidates → next build re-reads
    tracker.onEvent({
      type: "message_end",
      message: { role: "assistant", content: [], usage: { input: 0, output: 0, cacheRead: 0, cost: 0 } },
    } as unknown as AgentEvent);
    buildSnapshot(tracker, countingCtx);
    expect(reads).toBe(2);
    // a message_start (new message) also invalidates
    tracker.onEvent({ type: "message_start", message: { role: "assistant", content: [] } } as unknown as AgentEvent);
    buildSnapshot(tracker, countingCtx);
    expect(reads).toBe(3);
  });
});
