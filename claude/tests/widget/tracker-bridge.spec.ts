// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// The tracker bridge's contract: the StageWidget protocol state machine, the
// snapshot math (baselines/deltas/selected), the pause-line swap, and the
// publish dispatch (band store + invalidate / status fallback / neither →
// logger degrade) at the transition points.
import { describe, expect, test, vi } from "vitest";
import { DEFAULT_CONFIG } from "../../core/src/config/schema.js";
import type { SessionOwlGraph } from "../../core/src/types.js";
import { makeNode, nowStoredTimestamp } from "../../core/src/types.js";
import { _resetWidgetLine, idleSegments, widgetLine, widgetSegments } from "../../host/widget/line-store.js";
import { createWidgetBridge, type TrackerBridgeDeps } from "../../host/widget/tracker-bridge.js";
import { entries, rigUp } from "../runs/helpers.js";

interface Dispatch {
  invalidate: number;
  status: Array<string | undefined>;
  logged: string[];
}

interface Rig {
  bridge: ReturnType<typeof createWidgetBridge>;
  dispatch: Dispatch;
  setSurfaces: (s: readonly string[]) => void;
  setPaused: (v: boolean) => void;
  setBlocked: (c: string | null) => void;
  /** The bridge rig's own graph (seed fixtures through THIS one). */
  graph: SessionOwlGraph;
}

const THEME = { fg: (_c: string, t: string) => t };

async function makeBridge(
  sessionId: string,
  rows = 2,
  settings: typeof DEFAULT_CONFIG = DEFAULT_CONFIG,
  scope?: "main" | "agent",
): Promise<Rig> {
  _resetWidgetLine();
  const rig = await rigUp(sessionId, entries(rows), true);
  const graph = rig.core.store.getGraphStore().graph;
  // a couple of roots so the roots section has content
  graph.nodes.set(
    "n1" as never,
    makeNode({
      id: "n1" as never,
      summary: "root one",
      importance: "med",
      parentNode: null,
      state: "active",
      createdAt: nowStoredTimestamp(),
    }) as never,
  );
  const dispatch: Dispatch = { invalidate: 0, status: [], logged: [] };
  let surfaces: readonly string[] = ["terminal"];
  let paused = false;
  let blockedCommand: string | null = null;
  const deps: TrackerBridgeDeps = {
    getSettings: () => ({ ...settings }),
    getGraph: () => rig.core.store.getGraphStore().graph,
    resolveContextWindow: () => 200000,
    theme: THEME,
    width: () => 100,
    getSurfaces: () => Promise.resolve(surfaces),
    uiInvalidate: () => {
      dispatch.invalidate += 1;
    },
    uiStatus: (text) => {
      dispatch.status.push(text);
    },
    isConflictPaused: () => paused,
    bootstrapBlockedCommand: () => blockedCommand,
    log: (m) => {
      dispatch.logged.push(m);
    },
    scope: scope ?? "main",
  };
  const bridge = createWidgetBridge(deps);
  // let any publish microtask settle between actions
  const flush = async () => {
    await Promise.resolve();
    await Promise.resolve();
  };
  (bridge as unknown as { flush: typeof flush }).flush = flush;
  // drain any PRIOR test's pending trailing throttle render before this rig
  // publishes (the line store is process-global under isolate:false — a
  // stale trailing render would overwrite this rig's line mid-assertion)
  await new Promise((r) => setTimeout(r, 210));
  return {
    bridge,
    dispatch,
    setSurfaces: (s) => (surfaces = s),
    setPaused: (v) => (paused = v),
    setBlocked: (c) => (blockedCommand = c),
    graph,
  };
}

describe("the idle line's seat — MAIN-only (an in-process subagent bridge never takes it)", () => {
  test("an agent-scope bridge does not register the idle provider; main does", async () => {
    _resetWidgetLine();
    await makeBridge("seat-agent", 2, DEFAULT_CONFIG, "agent");
    expect(idleSegments()).toBeNull(); // no provider from the agent bridge
    await makeBridge("seat-main", 2, DEFAULT_CONFIG, "main");
    expect(idleSegments()).not.toBeNull();
  });
});

describe("the band channel — MAIN-only publishing (never mixed)", () => {
  test("an agent-scoped bridge writes no shared line/status/invalidate; the main bridge still does", async () => {
    const mainRig = await makeBridge("w-scope-main");
    const agentRig = await makeBridge("w-scope-agent", 2, DEFAULT_CONFIG, "agent");
    const agentFlush = (agentRig.bridge as unknown as { flush: () => Promise<void> }).flush;
    const mainFlush = (mainRig.bridge as unknown as { flush: () => Promise<void> }).flush;

    // the agent loop runs a full stage publish — nothing may reach the
    // shared band line, the status pin, or a redraw request
    agentRig.bridge.startStage("observe", { pass: 1 });
    agentRig.bridge.renderNow();
    await agentFlush();
    expect(widgetLine()).toBeNull();
    expect(agentRig.dispatch.invalidate).toBe(0);
    expect(agentRig.dispatch.status).toEqual([]);
    expect(agentRig.dispatch.logged.join(" ")).toContain("suppressed");

    // the main conversation's own publish is untouched
    mainRig.bridge.startStage("build", { pass: 1 });
    mainRig.bridge.renderNow();
    await mainFlush();
    expect(widgetLine()).not.toBeNull();
    expect(mainRig.dispatch.invalidate).toBeGreaterThan(0);
  });
});

describe("the StageWidget protocol → the line store", () => {
  test("the bootstrap pause line: idle AND active both show the pause notice; unblocked hides it", async () => {
    const r = await makeBridge("w-blocked-idle");
    await (r.bridge as unknown as { flush: () => Promise<void> }).flush();
    // idle + blocked: the pause line alone (the exact pinned text)
    r.setBlocked('node "P/helpers/bootstrap.mjs" "T/s.jsonl" --config-dir "C"');
    r.bridge.renderNow();
    await (r.bridge as unknown as { flush: () => Promise<void> }).flush();
    expect(widgetLine()).toBe("🦉 ⚠ paused — see /owl-status for session-owl bootstrap");
    // active stage + blocked: pause-first — the notice REPLACES the stage line
    r.bridge.startStage("observe", { pass: 1 });
    r.bridge.renderNow();
    await (r.bridge as unknown as { flush: () => Promise<void> }).flush();
    const stageLine = widgetLine() ?? "";
    expect(stageLine).toContain("paused");
    expect(stageLine).not.toContain("→");
    r.bridge.endStage();
    await (r.bridge as unknown as { flush: () => Promise<void> }).flush();
    // unblocked: normal idle hides the line again
    r.setBlocked(null);
    r.bridge.renderNow();
    await (r.bridge as unknown as { flush: () => Promise<void> }).flush();
    expect(widgetLine()).toBeNull();
  });

  test("idle: nothing issued (the band composes nothing)", async () => {
    const { bridge, dispatch } = await makeBridge("w-idle");
    bridge.render();
    await (bridge as unknown as { flush: () => Promise<void> }).flush();
    expect(widgetLine()).toBeNull();
    // the null issue still re-asks the band (a prior line must drop) and
    // clears any stale pin; no STRING status call for a hidden line
    expect(dispatch.invalidate).toBe(1);
    expect(dispatch.status).toEqual([undefined]);
  });

  test("bridge creation registers the idle provider: live counts, no accent", async () => {
    const { graph } = await makeBridge("w-idle-provider");
    graph.nodes.set(
      "nIdle" as never,
      makeNode({
        id: "nIdle" as never,
        summary: "idle root",
        importance: "med",
        parentNode: null,
        state: "active",
        createdAt: nowStoredTimestamp(),
      }) as never,
    );
    const segs = idleSegments();
    expect(segs).not.toBeNull();
    expect(segs?.some((s) => s.color === "accent")).toBe(false);
    expect(segs?.map((s) => s.text).join("")).toContain(" roots ");
  });

  test("startStage renders the observe line into the store + invalidates the band", async () => {
    const { bridge, dispatch } = await makeBridge("w-start");
    bridge.startStage("observe", { batch: { done: 0, total: 3 } });
    bridge.render();
    await (bridge as unknown as { flush: () => Promise<void> }).flush();
    const line = widgetLine();
    expect(line).toContain("🦉");
    expect(line).toContain("obs");
    expect(line).toContain("roots");
    expect(dispatch.invalidate).toBe(1); // band surface
    expect(dispatch.status).toEqual([undefined]); // the pin-clear only (no fallback surface)
  });

  test("endStage hides the line everywhere (store null, status cleared)", async () => {
    const { bridge, dispatch } = await makeBridge("w-end");
    bridge.startStage("build", { pass: 1 });
    bridge.render();
    await (bridge as unknown as { flush: () => Promise<void> }).flush();
    expect(widgetLine()).not.toBeNull();
    bridge.endStage();
    await (bridge as unknown as { flush: () => Promise<void> }).flush();
    expect(widgetLine()).toBeNull();
    expect(dispatch.invalidate).toBe(2); // shown + hidden
  });
});

describe("the painted publish (band spans)", () => {
  test("a stage line publishes its segments alongside the text", async () => {
    const { bridge } = await makeBridge("w-spans");
    bridge.startStage("observe", { batch: { done: 0, total: 3 } });
    bridge.render();
    await (bridge as unknown as { flush: () => Promise<void> }).flush();
    const line = widgetLine();
    const segs = widgetSegments();
    expect(line).not.toBeNull();
    expect(segs).not.toBeNull();
    expect((segs ?? []).map((s) => s.text).join("")).toBe(line);
    // the ACTIVE section's count carries the accent (pi parity)
    expect((segs ?? []).filter((s) => s.color === "accent").length).toBeGreaterThan(0);
  });

  test("the conflict-pause line publishes TEXT ONLY (no stage spans survive a pause)", async () => {
    const { bridge, setPaused } = await makeBridge("w-spanspause");
    setPaused(true);
    bridge.startStage("observe");
    bridge.setConflict(["other-memory"]);
    await (bridge as unknown as { flush: () => Promise<void> }).flush();
    expect(widgetLine()).toContain("⚠ paused");
    expect(widgetSegments()).toBeNull();
  });

  test("endStage drops the spans with the line", async () => {
    const { bridge } = await makeBridge("w-spansend");
    bridge.startStage("observe");
    bridge.render();
    await (bridge as unknown as { flush: () => Promise<void> }).flush();
    expect(widgetSegments()).not.toBeNull();
    bridge.endStage();
    await (bridge as unknown as { flush: () => Promise<void> }).flush();
    expect(widgetLine()).toBeNull();
    expect(widgetSegments()).toBeNull();
  });
});

describe("the publish dispatch", () => {
  test("fallback surface (mobile): the SAME text re-issues via the status capsule; no invalidate", async () => {
    const { bridge, dispatch, setSurfaces } = await makeBridge("w-mobile");
    setSurfaces(["mobile"]);
    bridge.startStage("observe");
    bridge.render();
    await (bridge as unknown as { flush: () => Promise<void> }).flush();
    expect(dispatch.invalidate).toBe(0);
    expect(dispatch.status).toHaveLength(1);
    expect(dispatch.status[0]).toBe(widgetLine());
  });

  test("mixed surfaces (terminal + mobile): the band WINS — no status pin (never both on one surface)", async () => {
    const { bridge, dispatch, setSurfaces } = await makeBridge("w-mixed");
    setSurfaces(["terminal", "mobile"]);
    bridge.startStage("observe");
    bridge.render();
    await (bridge as unknown as { flush: () => Promise<void> }).flush();
    expect(dispatch.invalidate).toBe(1);
    expect(dispatch.status).toEqual([undefined]); // the pin cleared; no string re-issue
  });

  test("neither surface: the logger-only degrade, exactly once per shown line", async () => {
    const { bridge, dispatch, setSurfaces } = await makeBridge("w-none");
    setSurfaces([]);
    bridge.startStage("observe");
    bridge.render();
    await (bridge as unknown as { flush: () => Promise<void> }).flush();
    expect(dispatch.invalidate).toBe(0);
    expect(dispatch.status).toEqual([]);
    expect(dispatch.logged).toHaveLength(1);
    expect(dispatch.logged[0]).toContain("widget: no band or status surface — ");
    expect(dispatch.logged[0]).toContain("🦉");
    // hiding (null line) does not log again
    bridge.endStage();
    await (bridge as unknown as { flush: () => Promise<void> }).flush();
    expect(dispatch.logged).toHaveLength(1);
  });

  test("the fallback hide transition re-issues undefined (the pin clears itself)", async () => {
    const { bridge, dispatch, setSurfaces } = await makeBridge("w-mobilehide");
    setSurfaces(["mobile"]);
    bridge.startStage("observe");
    bridge.render();
    await (bridge as unknown as { flush: () => Promise<void> }).flush();
    expect(dispatch.status).toHaveLength(1);
    expect(typeof dispatch.status[0]).toBe("string");
    bridge.endStage();
    await (bridge as unknown as { flush: () => Promise<void> }).flush();
    expect(dispatch.status).toEqual([dispatch.status[0], undefined]); // replaced with undefined
  });

  test("a band surface arriving mid-session clears the already-pinned status line", async () => {
    const { bridge, dispatch, setSurfaces } = await makeBridge("w-pin-clear");
    setSurfaces(["mobile"]);
    bridge.startStage("observe");
    bridge.render();
    await (bridge as unknown as { flush: () => Promise<void> }).flush();
    expect(dispatch.status).toEqual([expect.any(String)]);
    setSurfaces(["mobile", "terminal"]);
    bridge.setPass(2); // any transition re-publishes
    bridge.render();
    await (bridge as unknown as { flush: () => Promise<void> }).flush();
    // the band took over: the pin cleared, the band invalidated
    expect(dispatch.status).toEqual([expect.any(String), undefined]);
    expect(dispatch.invalidate).toBe(1);
  });

  test("the neither-surface degrade log carries the line text", async () => {
    const { bridge, dispatch, setSurfaces } = await makeBridge("w-logline");
    setSurfaces([]);
    bridge.startStage("observe");
    bridge.render();
    await (bridge as unknown as { flush: () => Promise<void> }).flush();
    expect(dispatch.logged[0]).toContain("🦉");
    expect(dispatch.logged[0]).toContain("obs");
  });

  test("a surface-dispatch failure is contained (logged, no throw)", async () => {
    await makeBridge("w-dispatchfail");
    // re-create with a failing getSurfaces
    _resetWidgetLine();
    const base = await rigUp("w-dispatchfail2", entries(1), true);
    const dispatch: Dispatch = { invalidate: 0, status: [], logged: [] };
    const bridge = createWidgetBridge({
      getSettings: () => DEFAULT_CONFIG,
      getGraph: () => base.core.store.getGraphStore().graph,
      resolveContextWindow: () => null,
      theme: THEME,
      width: () => 100,
      getSurfaces: () => Promise.reject(new Error("rpc down")),
      uiInvalidate: () => {
        dispatch.invalidate += 1;
      },
      uiStatus: (t) => {
        dispatch.status.push(t);
      },
      isConflictPaused: () => false,
      bootstrapBlockedCommand: () => null,
      scope: "main",
      log: (m) => {
        dispatch.logged.push(m);
      },
    });
    bridge.startStage("observe");
    bridge.render();
    await Promise.resolve();
    await Promise.resolve();
    expect(dispatch.logged.some((l) => l.includes("surface dispatch failed"))).toBe(true);
  });
});

describe("the pause swap", () => {
  test("setConflict swaps the stage line for pi's conflict line; clearing restores", async () => {
    const { bridge, setPaused } = await makeBridge("w-pause");
    setPaused(true);
    bridge.startStage("observe");
    bridge.setConflict(["other-memory"]);
    await (bridge as unknown as { flush: () => Promise<void> }).flush();
    expect(widgetLine()).toContain("⚠ paused — other-memory");
    expect(widgetLine()).toContain("(/owl-status)");
    bridge.setConflict([]);
    await (bridge as unknown as { flush: () => Promise<void> }).flush();
    expect(widgetLine()).toContain("obs"); // stage line back
  });

  test("the pause gate reads live: unpause drops the line at the next render", async () => {
    const { bridge, setPaused } = await makeBridge("w-unpause");
    bridge.startStage("observe");
    setPaused(true);
    bridge.setConflict(["other-memory"]);
    await (bridge as unknown as { flush: () => Promise<void> }).flush();
    expect(widgetLine()).toContain("paused");
    setPaused(false);
    bridge.render();
    await (bridge as unknown as { flush: () => Promise<void> }).flush();
    expect(widgetLine()).toContain("obs"); // the stage line — pause gone
  });

  test("narrow width degrades the conflict line (the ladder)", async () => {
    const _rig = await makeBridge("w-narrow");
    // width seam is fixed at 100 in the helper — rebuild with width 30
    _resetWidgetLine();
    const base = await rigUp("w-narrow2", entries(1), true);
    const bridge = createWidgetBridge({
      getSettings: () => DEFAULT_CONFIG,
      getGraph: () => base.core.store.getGraphStore().graph,
      resolveContextWindow: () => null,
      theme: THEME,
      width: () => 60,
      getSurfaces: () => Promise.resolve(["terminal"]),
      uiInvalidate: () => {},
      uiStatus: () => {},
      isConflictPaused: () => true,
      bootstrapBlockedCommand: () => null,
      scope: "main",
      log: () => {},
    });
    bridge.setConflict(["alpha-memory", "beta-memory", "gamma-memory"]);
    await Promise.resolve();
    const line = widgetLine() ?? "";
    expect(line).toContain("+2 more");
    expect(line).toContain("(/owl-status)");
  });
});

describe("the snapshot math", () => {
  test("deltas measure from the stage-start baseline; events accumulate", async () => {
    const { bridge } = await makeBridge("w-math");
    bridge.startStage("observe");
    bridge.onEvent({ type: "message_start" } as never);
    bridge.onEvent({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: "x".repeat(40) },
    } as never);
    bridge.onEvent({
      type: "message_end",
      message: {
        model: "prov/mid",
        usage: { input: 5, output: 7, totalTokens: 900 },
      },
    } as never);
    bridge.render();
    await (bridge as unknown as { flush: () => Promise<void> }).flush();
    const line = widgetLine() ?? "";
    expect(line).toContain("900/200k"); // agent context over the resolved window
    expect(line).toContain("10 tok"); // 40 chars / 4 = 10 streaming
    // baseline deltas: one more observation appears mid-run
    expect(line).not.toContain("(+1)"); // nothing added yet
  });

  test("record_observations acceptances surface as +N obs until the chunk boundary", async () => {
    const { bridge } = await makeBridge("w-inflight");
    bridge.startStage("observe", { batch: { done: 0, total: 2 } });
    bridge.onEvent({
      type: "tool_execution_end",
      toolName: "record_observations",
      isError: false,
      result: { details: { accepted: 3 } },
    } as never);
    bridge.render();
    await (bridge as unknown as { flush: () => Promise<void> }).flush();
    expect(widgetLine()).toContain("+3 obs");
    bridge.setBatch(1, 2); // chunk boundary — the counter resets
    bridge.render();
    await (bridge as unknown as { flush: () => Promise<void> }).flush();
    expect(widgetLine()).not.toContain("+3 obs");
  });

  test("the selected section renders only in select + selected-root mode", async () => {
    const { bridge } = await makeBridge("w-selected", 2, {
      ...DEFAULT_CONFIG,
      renderMode: "selected-root",
    });
    let copy = { count: 5, viewTokens: 4000 };
    bridge.startStage("select", { selectedCounts: () => copy });
    bridge.render();
    await (bridge as unknown as { flush: () => Promise<void> }).flush();
    expect(widgetLine()).toContain("selected");
    // a mutate shrinks the copy → deltas from the pristine baseline
    copy = { count: 3, viewTokens: 2500 };
    bridge.onEvent({ type: "tool_execution_end", toolName: "archive_root" } as never);
    bridge.render();
    await (bridge as unknown as { flush: () => Promise<void> }).flush();
    expect(widgetLine()).toContain("(-2)");
  });
});

describe("the remaining protocol paths", () => {
  test("setPass updates the pass marker on the build line", async () => {
    const { bridge } = await makeBridge("w-pass");
    bridge.startStage("build", { pass: 1 });
    bridge.setPass(3);
    bridge.render();
    await (bridge as unknown as { flush: () => Promise<void> }).flush();
    expect(widgetLine()).toContain("#3");
  });

  test("invalidateRoots recomputes after an out-of-band graph write", async () => {
    const { bridge, graph } = await makeBridge("w-inval");
    bridge.startStage("build", { pass: 1 });
    bridge.render();
    await (bridge as unknown as { flush: () => Promise<void> }).flush();
    const before = widgetLine();
    // add a root OUTSIDE any tool call — the cache must drop
    graph.nodes.set(
      "nNew" as never,
      makeNode({
        id: "nNew" as never,
        summary: "fresh root",
        importance: "med",
        parentNode: null,
        state: "active",
        createdAt: nowStoredTimestamp(),
      }) as never,
    );
    bridge.invalidateRoots();
    await new Promise((r) => setTimeout(r, 230)); // the throttled trailing render
    expect(widgetLine()).not.toBe(before);
    expect(widgetLine()).toContain("(+1)");
  });

  test("the primary streaming tier wins while larger (the max rule)", async () => {
    const { bridge } = await makeBridge("w-primary");
    bridge.startStage("observe");
    bridge.onEvent({
      type: "message_update",
      message: { usage: { output: 900 } },
    } as never);
    bridge.onEvent({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: "z".repeat(40) }, // 10 fallback
    } as never);
    bridge.render();
    await (bridge as unknown as { flush: () => Promise<void> }).flush();
    expect(widgetLine()).toContain("900 tok");
  });

  test("turn_end increments the usage turns; message_end usage accumulates (snapshot seam)", async () => {
    const { bridge } = await makeBridge("w-turns");
    bridge.startStage("observe");
    bridge.onEvent({
      type: "message_end",
      message: { model: "p/m", usage: { input: 3, output: 4, totalTokens: 50 } },
    } as never);
    bridge.onEvent({ type: "turn_end" } as never);
    bridge.onEvent({ type: "message_end", message: { usage: { input: 5, output: 6, totalTokens: 80 } } } as never);
    bridge.onEvent({ type: "turn_end" } as never);
    const snap = bridge._snapshotForTest();
    expect(snap.usage.turns).toBe(2);
    expect(snap.usage.input).toBe(8); // 3 + 5 — accumulation, not last-wins
    expect(snap.usage.output).toBe(10);
    expect(snap.contextTokens).toBe(80); // the context IS last-wins (pi's rule)
  });
});

describe("the throttle", () => {
  test("a burst of stream events coalesces: one leading render + one trailing", async () => {
    // rig first (its timer-drain wait needs REAL timers), then fake them
    const { bridge, dispatch } = await makeBridge("w-throttle");
    vi.useFakeTimers();
    try {
      bridge.startStage("observe");
      bridge.render(); // leading
      await (bridge as unknown as { flush: () => Promise<void> }).flush();
      for (let i = 0; i < 50; i += 1) {
        bridge.onEvent({
          type: "message_update",
          assistantMessageEvent: { type: "text_delta", delta: "y".repeat(4) },
        } as never);
      }
      await (bridge as unknown as { flush: () => Promise<void> }).flush();
      // pi's exact schedule: the manual render + the FIRST stream event
      // render immediately (the throttle's leading branch — pi's render()
      // never updates lastRenderMs), the remaining burst coalesces into one
      // trailing render at the interval boundary
      expect(dispatch.invalidate).toBe(2);
      vi.advanceTimersByTime(250);
      await (bridge as unknown as { flush: () => Promise<void> }).flush();
      expect(dispatch.invalidate).toBe(3); // + the trailing coalesced render
    } finally {
      vi.useRealTimers();
    }
  });
});
