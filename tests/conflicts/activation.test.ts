// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// Dormant conflict-pause wiring: when detectConflicts() reports another
// compaction-handling extension, memkeeper still registers its FULL surface
// (hooks, tools, commands, stages) but stays dormant — every hook early-returns
// and compaction returns undefined, which pi's runner treats as fully
// transparent (the other extension's compaction result wins). The pause is
// therefore live-toggleable: reloadConfig() with ignoreConflicts=true resumes
// mid-session, which is what the bench harness relies on. Mirrors the
// index.test.ts harness (same doMock pattern; detect is mocked to return the
// wiring-controlled hits so the real home dir never leaks in).

const wiring = vi.hoisted(() => ({
  onSessionStart: vi.fn(async () => {}),
  onSessionShutdown: vi.fn(() => {}),
  captureInitialPromptAndExtract: vi.fn(() => {}),
  onTurnEnd: vi.fn(() => {}),
  setStageRuns: vi.fn(() => {}),
  compactionHook: vi.fn(async () => undefined),
  widgetSetConflict: vi.fn(),
  widgetSetCtx: vi.fn(),
  widgetRender: vi.fn(),
  initWidget: vi.fn(() => ({
    setConflict: (names: string[]) => wiring.widgetSetConflict(names),
    setCtx: (ctx: unknown) => wiring.widgetSetCtx(ctx),
    render: () => wiring.widgetRender(),
    clearCtx: () => {},
    startStage: () => {},
    setPass: () => {},
    setBatch: () => {},
    endStage: () => {},
    onEvent: () => {},
    invalidateRoots: () => {},
  })),
  makeObserverRun: vi.fn(() => async () => {}),
  makeBuilderRun: vi.fn(() => async () => {}),
  makeSelectorRun: vi.fn(() => async () => {}),
  createTodoWiring: vi.fn(() => ({
    getContext: () => ({ getInProgress: () => null, getPending: () => [] }),
    getBridge: () => ({ getItems: (): unknown[] => [] }),
  })),
  registerSettingsCommand: vi.fn(() => ({
    getSettings: (): { enabled: boolean; ignoreConflicts?: boolean } => ({
      enabled: true,
      ...(wiring.ignoreConflicts === null ? {} : { ignoreConflicts: wiring.ignoreConflicts }),
    }),
    updateSetting: () => {},
    loadSettingsIntoMemory: () => {},
  })),
  conflicts: [] as Array<{ entry: string; matched: string }>,
  ignoreConflicts: null as boolean | null,
}));

const MOCKED_PATHS = [
  "../../src/lifecycle.js",
  "../../src/triggers.js",
  "../../src/compaction/hook.js",
  "../../src/widget/tracker.js",
  "../../src/runtime/stages.js",
  "../../src/todo/wiring.js",
  "../../src/conflicts/detect.js",
  "avtc-pi-settings-ui",
] as const;

async function importMockedExtension(): Promise<typeof import("../../src/index.js")> {
  vi.resetModules();
  vi.doMock("../../src/lifecycle.js", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../../src/lifecycle.js")>()),
    onSessionStart: wiring.onSessionStart,
    onSessionShutdown: wiring.onSessionShutdown,
    captureInitialPromptAndExtract: wiring.captureInitialPromptAndExtract,
  }));
  vi.doMock("../../src/triggers.js", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../../src/triggers.js")>()),
    onTurnEnd: wiring.onTurnEnd,
    setStageRuns: wiring.setStageRuns,
  }));
  vi.doMock("../../src/compaction/hook.js", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../../src/compaction/hook.js")>()),
    compactionHook: wiring.compactionHook,
  }));
  vi.doMock("../../src/widget/tracker.js", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../../src/widget/tracker.js")>()),
    initWidget: wiring.initWidget,
  }));
  vi.doMock("../../src/runtime/stages.js", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../../src/runtime/stages.js")>()),
    makeObserverRun: wiring.makeObserverRun,
    makeBuilderRun: wiring.makeBuilderRun,
    makeSelectorRun: wiring.makeSelectorRun,
  }));
  vi.doMock("../../src/todo/wiring.js", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../../src/todo/wiring.js")>()),
    createTodoWiring: wiring.createTodoWiring,
  }));
  vi.doMock("../../src/conflicts/detect.js", () => ({
    detectConflicts: () => wiring.conflicts,
    CONFLICT_PACKAGE_MARKERS: [] as string[],
  }));
  vi.doMock("avtc-pi-settings-ui", async (importOriginal) => ({
    ...(await importOriginal<typeof import("avtc-pi-settings-ui")>()),
    registerSettingsCommand: wiring.registerSettingsCommand,
  }));
  return import("../../src/index.js");
}

function makeFakePi() {
  const handlers = new Map<string, ((event: unknown, ctx: ExtensionContext) => unknown)[]>();
  const pi = {
    on: (event: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) => {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
    appendEntry: () => {},
    registerTool: vi.fn(),
    registerCommand: vi.fn(),
    events: { emit: vi.fn() },
  };
  return { ...pi, _handlers: handlers } as unknown as ExtensionAPI & {
    _handlers: Map<string, ((event: unknown, ctx: ExtensionContext) => unknown)[]>;
    registerTool: ReturnType<typeof vi.fn>;
    registerCommand: ReturnType<typeof vi.fn>;
    events: { emit: ReturnType<typeof vi.fn> };
  };
}

function makeCtx(): ExtensionContext {
  return { sessionManager: { getLeafId: () => null, getBranch: () => [] } } as unknown as ExtensionContext;
}

describe("memkeeperExtension (dormant conflict pause)", () => {
  let memkeeperExtension: typeof import("../../src/index.js").default;

  beforeAll(async () => {
    memkeeperExtension = (await importMockedExtension()).default;
  });
  afterAll(() => {
    for (const path of MOCKED_PATHS) vi.doUnmock(path);
  });
  beforeEach(() => {
    vi.clearAllMocks();
    wiring.conflicts = [{ entry: "npm:pi-blackhole", matched: "pi-blackhole" }];
    wiring.ignoreConflicts = null;
  });

  it("registers the FULL surface even when conflict-paused (dormant, not absent)", () => {
    const pi = makeFakePi();
    memkeeperExtension(pi);
    expect([...pi._handlers.keys()].sort()).toEqual([
      "session_before_compact",
      "session_shutdown",
      "session_start",
      "turn_end",
    ]);
    expect(pi.registerTool).toHaveBeenCalledTimes(1);
    expect(pi.registerCommand).toHaveBeenCalledTimes(7);
    expect(wiring.setStageRuns).toHaveBeenCalledTimes(1);
  });

  it("dormant hooks: turn_end does no capture and no trigger work while paused", async () => {
    const pi = makeFakePi();
    memkeeperExtension(pi);
    const turnEnd = pi._handlers.get("turn_end")?.[0];
    expect(turnEnd).toBeDefined();
    await turnEnd?.({}, makeCtx());
    expect(wiring.captureInitialPromptAndExtract).not.toHaveBeenCalled();
    expect(wiring.onTurnEnd).not.toHaveBeenCalled();
  });

  it("dormant hooks: compaction returns undefined (transparent) and never calls compactionHook", async () => {
    const pi = makeFakePi();
    memkeeperExtension(pi);
    const compact = pi._handlers.get("session_before_compact")?.[0];
    expect(compact).toBeDefined();
    const result = await compact?.({}, makeCtx());
    expect(result).toBeUndefined();
    expect(wiring.compactionHook).not.toHaveBeenCalled();
  });

  it("while paused, session_start still wires the widget (pause line must publish)", async () => {
    const pi = makeFakePi();
    memkeeperExtension(pi);
    // the LIFECYCLE session_start handler is gated on pause (no observer work) —
    // but it is also what calls widget.setCtx; the pause line must still get a
    // ctx + a render, so the gated branch wires the widget itself.
    const lifecycleStart = pi._handlers.get("session_start")?.[0];
    expect(lifecycleStart).toBeDefined();
    await lifecycleStart?.({}, makeCtx());
    expect(wiring.widgetSetCtx).toHaveBeenCalledTimes(1);
    expect(wiring.widgetRender).toHaveBeenCalledTimes(1);
    expect(wiring.onSessionStart).not.toHaveBeenCalled(); // no observer work
  });

  it("ready API reports the ACTIVE pause (hits) for hosts to assert on", async () => {
    const pi = makeFakePi();
    memkeeperExtension(pi);
    const ready = pi._handlers.get("session_start")?.at(-1);
    await ready?.({}, makeCtx());
    const api = pi.events.emit.mock.calls.at(-1)?.[1] as { getConflictPause: () => unknown };
    expect(api.getConflictPause()).toEqual([{ entry: "npm:pi-blackhole", matched: "pi-blackhole" }]);
  });

  it("ignoreConflicts=true: same conflicts, hooks fully live (compactionHook runs)", async () => {
    wiring.ignoreConflicts = true;
    const pi = makeFakePi();
    memkeeperExtension(pi);
    const compact = pi._handlers.get("session_before_compact")?.[0];
    await compact?.({}, makeCtx());
    expect(wiring.compactionHook).toHaveBeenCalledTimes(1);

    const turnEnd = pi._handlers.get("turn_end")?.[0];
    await turnEnd?.({}, makeCtx());
    expect(wiring.captureInitialPromptAndExtract).toHaveBeenCalledTimes(1);
    expect(wiring.onTurnEnd).toHaveBeenCalledTimes(1);
  });

  it("ignoreConflicts=true: ready API reports no active pause", async () => {
    wiring.ignoreConflicts = true;
    const pi = makeFakePi();
    memkeeperExtension(pi);
    const ready = pi._handlers.get("session_start")?.at(-1);
    await ready?.({}, makeCtx());
    const api = pi.events.emit.mock.calls.at(-1)?.[1] as { getConflictPause: () => unknown };
    expect(api.getConflictPause()).toBeNull();
  });

  it("the widget gets the paused line when actively paused; not when ignoreConflicts is set", () => {
    memkeeperExtension(makeFakePi());
    expect(wiring.widgetSetConflict).toHaveBeenCalledWith(["pi-blackhole"]);

    wiring.ignoreConflicts = true;
    memkeeperExtension(makeFakePi());
    expect(wiring.widgetSetConflict).toHaveBeenCalledTimes(1); // no second call
  });

  it("a clean activation clears any pause a previous (re)activation recorded", async () => {
    wiring.conflicts = [];
    const pi = makeFakePi();
    memkeeperExtension(pi);
    const ready = pi._handlers.get("session_start")?.at(-1);
    await ready?.({}, makeCtx());
    const api = pi.events.emit.mock.calls.at(-1)?.[1] as { getConflictPause: () => unknown };
    expect(api.getConflictPause()).toBeNull();
  });
});
