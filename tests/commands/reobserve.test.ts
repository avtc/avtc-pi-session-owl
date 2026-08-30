// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type ReobserveDeps, runOwlReobserve } from "../../src/commands/reobserve.js";
import { _resetGetSessionOwlSettings, _setGetSessionOwlSettings, DEFAULT_CONFIG } from "../../src/config/schema.js";
import { _resetRunLock, acquireOrSkip } from "../../src/runtime/run-lock.js";
import { getGraphStore, resetForNewSession } from "../../src/store/graph-store.js";
import { makeObservation } from "../../src/types.js";
import { NO_OP_WIDGET } from "../../src/widget/tracker.js";

// --- fakes -----------------------------------------------------------------

interface FakeEntry {
  id: string;
  type: string;
  parentId: string | null;
  timestamp: string;
  message?: unknown;
  customType?: string;
  data?: unknown;
}

function userEntry(id: string): FakeEntry {
  return { id, type: "message", parentId: null, timestamp: "t", message: { role: "user", content: "task" } };
}

function assistantEntry(id: string): FakeEntry {
  return {
    id,
    type: "message",
    parentId: null,
    timestamp: "t",
    message: {
      role: "assistant",
      content: [{ type: "text", text: "text" }],
      stopReason: "stop",
    },
  };
}

/** A `session-owl.observation` entry covering `from..to` and citing `from`. */
function obsEntry(id: string, from: string, to: string): FakeEntry {
  return {
    id,
    type: "custom",
    customType: "session-owl.observation",
    parentId: null,
    timestamp: "t",
    data: { coversFromId: from, coversUpToId: to, records: [{ sourceEntryIds: [from] }], tokenCount: 1 },
  };
}

/** A command ctx whose sessionManager serves the given branch + captured notify
 *  (+ a controllable getContextUsage for the mid-repair Builder trigger). */
function makeCtx(
  branch: FakeEntry[],
  ctxTokens: number | null,
): { ctx: ExtensionCommandContext; messages: { message: string; type: string }[] } {
  const messages: { message: string; type: string }[] = [];
  const ctx = {
    sessionManager: {
      getLeafId: () => null,
      getBranch: () => branch,
    },
    getContextUsage: () => (ctxTokens === null ? undefined : { tokens: ctxTokens }),
    ui: {
      notify: (message: string, type?: string) => {
        messages.push({ message, type: type ?? "info" });
      },
    },
  } as unknown as ExtensionCommandContext;
  return { ctx, messages };
}

/** Deps with a scripted runObserver that records its unobserved inputs and
 *  optionally lands `recordsPerRange` observation(s) per call into the store. */
function makeDeps(opts: { recordsPerRange?: number; fail?: boolean } = {}): {
  deps: ReobserveDeps;
  calls: string[][];
  builderCalls: number;
  launched: Promise<void>[];
} {
  const calls: string[][] = [];
  const launched: Promise<void>[] = [];
  let builderCalls = 0;
  const deps: ReobserveDeps = {
    pi: {} as ReobserveDeps["pi"],
    widget: NO_OP_WIDGET,
    runObserver: async (input) => {
      calls.push(input.unobserved.map((e) => e.id));
      if (input.maybeBuild !== undefined) await input.maybeBuild();
      if (opts.fail === true) throw new Error("model down");
      const { graph } = getGraphStore();
      for (let i = 0; i < (opts.recordsPerRange ?? 0); i += 1) {
        const id = `o${graph.nextObsId}` as ReturnType<typeof makeObservation>["id"];
        graph.nextObsId += 1;
        graph.observations.set(
          id,
          makeObservation({
            id,
            summary: "recovered fact",
            importance: "med",
            sourceEntryIds: [input.unobserved[0]?.id ?? "x"],
            timestamp: "t",
            parentNode: "n1",
          }),
        );
      }
    },
    runBuilderStage: async () => {
      builderCalls += 1;
    },
    onLaunched: (promise) => {
      launched.push(promise);
    },
  };
  return {
    deps,
    calls,
    get builderCalls() {
      return builderCalls;
    },
    launched,
  };
}

// ---------------------------------------------------------------------------

describe("/owl:reobserve-0-obs-chunks", () => {
  beforeEach(() => {
    resetForNewSession();
    _resetRunLock();
    _resetGetSessionOwlSettings();
    _setGetSessionOwlSettings(() => ({ ...DEFAULT_CONFIG, enabled: true }));
  });
  afterEach(() => {
    _resetRunLock();
    _resetGetSessionOwlSettings();
  });

  it("gates on enabled (master-switch off-path)", async () => {
    _setGetSessionOwlSettings(() => ({ ...DEFAULT_CONFIG, enabled: false }));
    const { deps } = makeDeps();
    const { ctx, messages } = makeCtx([userEntry("u1"), assistantEntry("a1")], null);
    await runOwlReobserve("", ctx, deps);
    expect(messages).toEqual([{ message: "session-owl is disabled (enable it first).", type: "warning" }]);
  });

  it("notifies and runs nothing when every range is covered", async () => {
    const { deps, calls, launched } = makeDeps();
    const branch = [userEntry("u1"), assistantEntry("a1"), assistantEntry("a2"), obsEntry("o1", "a1", "a2")];
    const { ctx, messages } = makeCtx(branch, null);
    await runOwlReobserve("", ctx, deps);
    await Promise.all(launched);
    expect(messages).toEqual([{ message: "No skipped or unobserved ranges — nothing to re-observe.", type: "info" }]);
    expect(calls).toEqual([]);
  });

  it("skips with a busy notice when a maintenance run holds the lock", async () => {
    getGraphStore().observerFrontier = "a1"; // a closed hole exists
    const lockHandle = acquireOrSkip("observe"); // hold the lock
    if (lockHandle === null) throw new Error("lock should be free");
    const { deps, calls } = makeDeps();
    const { ctx, messages } = makeCtx([userEntry("u1"), assistantEntry("a1")], null);
    await runOwlReobserve("", ctx, deps);
    expect(messages).toEqual([
      { message: "A maintenance run is in flight — try again once it finishes.", type: "warning" },
    ]);
    expect(calls).toEqual([]);
    lockHandle.release();
  });

  it("re-observes each closed hole oldest-first; the open tail is excluded", async () => {
    // hole: a2 was jumped over (covered ranges a1 + a3 sit around it); a4 is the
    // open tail after the frontier (a3) — the normal triggers own it
    getGraphStore().observerFrontier = "a3";
    const branch = [
      userEntry("u1"),
      assistantEntry("a1"),
      assistantEntry("a2"),
      assistantEntry("a3"),
      assistantEntry("a4"),
      obsEntry("o1", "a1", "a1"),
      obsEntry("o2", "a3", "a3"),
    ];
    const harness = makeDeps({ recordsPerRange: 2 });
    const { ctx, messages } = makeCtx(branch, null);
    await runOwlReobserve("", ctx, harness.deps);
    await Promise.all(harness.launched);
    // start notice + done summary
    expect(messages[0]).toEqual({ message: "Re-observing 1 skipped range(s) (1 entries)…", type: "info" });
    expect(messages[messages.length - 1]).toEqual({
      message: "Re-observe done — 2 observation(s) recovered into new roots.",
      type: "info",
    });
    expect(harness.calls).toEqual([["a2"]]); // only the closed hole, not the tail
    // the lock was released (a fresh acquire succeeds)
    expect(acquireOrSkip("observe") !== null).toBe(true);
  });

  it("reports zero recovered when the holes yield nothing", async () => {
    getGraphStore().observerFrontier = "a2"; // a1 is a closed hole behind the frontier
    const branch = [userEntry("u1"), assistantEntry("a1"), assistantEntry("a2"), obsEntry("o1", "a2", "a2")];
    const { deps, launched } = makeDeps({ recordsPerRange: 0 });
    const { ctx, messages } = makeCtx(branch, null);
    await runOwlReobserve("", ctx, deps);
    await Promise.all(launched);
    expect(messages[messages.length - 1]).toEqual({
      message: "Re-observe done — 0 observation(s) recovered into new roots.",
      type: "info",
    });
  });

  it("pipelines the mid-repair Builder fold (mode-aware cadence per settings)", async () => {
    _setGetSessionOwlSettings(() => ({
      ...DEFAULT_CONFIG,
      enabled: true,
      builderMode: "on-session-context-threshold",
      builderSessionContextThresholdTokens: 1000,
    }));
    getGraphStore().observerFrontier = "a1"; // a1 is a closed hole
    const branch = [userEntry("u1"), assistantEntry("a1")];
    const harness = makeDeps({ recordsPerRange: 1 });
    const { ctx } = makeCtx(branch, 999_999); // context above the threshold
    await runOwlReobserve("", ctx, harness.deps);
    await Promise.all(harness.launched);
    // the fake runObserver awaits maybeBuild per range — the trigger fires per
    // the on-context mode and routes to runBuilderStage
    expect(harness.builderCalls).toBe(1);
  });

  it("notifies failure and releases the lock when the observer run throws", async () => {
    getGraphStore().observerFrontier = "a1"; // a1 is a closed hole
    const branch = [userEntry("u1"), assistantEntry("a1")];
    const { deps, launched } = makeDeps({ fail: true });
    const { ctx, messages } = makeCtx(branch, null);
    await runOwlReobserve("", ctx, deps);
    await Promise.all(launched);
    expect(messages[messages.length - 1]).toEqual({
      message: "Re-observe failed — see the session-owl log for the error.",
      type: "error",
    });
    expect(acquireOrSkip("observe") !== null).toBe(true);
  });
});
