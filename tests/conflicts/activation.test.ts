// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// Conflict-mode activation wiring: when detectConflicts() reports another
// compaction-handling extension, memkeeperExtension must register ONLY the
// warning surface (widget, /mk:status) and the memkeeper:ready API — no
// session hooks, no stage runs, no tools, no browse commands. Mirrors the
// index.test.ts harness (same doMock pattern; detect is mocked to return the
// wiring-controlled hits so the real home dir never leaks in).

const wiring = vi.hoisted(() => ({
  onSessionStart: vi.fn(async () => {}),
  onSessionShutdown: vi.fn(() => {}),
  captureInitialPromptAndExtract: vi.fn(() => {}),
  onTurnEnd: vi.fn(() => {}),
  setStageRuns: vi.fn(() => {}),
  compactionHook: vi.fn(async () => undefined),
  initWidget: vi.fn(() => ({
    setConflict: () => {},
    setCtx: () => {},
    clearCtx: () => {},
    render: () => {},
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
  ignoreConflicts: null as boolean | null,
  conflicts: [] as Array<{ entry: string; matched: string }>,
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

describe("memkeeperExtension (conflict-pause wiring)", () => {
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

  it("registers NO session hooks beyond the ready-API session_start", () => {
    const pi = makeFakePi();
    memkeeperExtension(pi);
    expect([...pi._handlers.keys()]).toEqual(["session_start"]);
    expect(pi._handlers.get("session_start")).toHaveLength(1);
  });

  it("registers no tool, no stage runs, no todo wiring, no browse commands", () => {
    const pi = makeFakePi();
    memkeeperExtension(pi);
    expect(pi.registerTool).not.toHaveBeenCalled();
    expect(pi.registerCommand).toHaveBeenCalledTimes(1);
    expect(pi.registerCommand.mock.calls[0]?.[0]).toBe("mk:status");
    expect(wiring.setStageRuns).not.toHaveBeenCalled();
    expect(wiring.makeObserverRun).not.toHaveBeenCalled();
    expect(wiring.makeBuilderRun).not.toHaveBeenCalled();
    expect(wiring.makeSelectorRun).not.toHaveBeenCalled();
    expect(wiring.createTodoWiring).not.toHaveBeenCalled();
  });

  it("still initializes the widget (the warning channel)", () => {
    memkeeperExtension(makeFakePi());
    expect(wiring.initWidget).toHaveBeenCalledTimes(1);
  });

  it("still emits memkeeper:ready at session_start (bench host API) — with the conflict pause exposed", async () => {
    const pi = makeFakePi();
    memkeeperExtension(pi);
    const handler = pi._handlers.get("session_start")?.[0];
    expect(handler).toBeDefined();
    await handler?.({}, {} as ExtensionContext);
    expect(pi.events.emit).toHaveBeenCalledWith("memkeeper:ready", expect.anything());
    // the api exposes the pause state so a host can assert memkeeper is actually live
    const api = pi.events.emit.mock.calls[0]?.[1] as { getConflictPause: () => unknown };
    expect(typeof api.getConflictPause).toBe("function");
    expect(api.getConflictPause()).toEqual([{ entry: "npm:pi-blackhole", matched: "pi-blackhole" }]);
  });

  it("clean mode registers the full surface (all hooks, tool, commands, stages)", () => {
    wiring.conflicts = [];
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
  it("ignoreConflicts=true registers the full surface despite detected conflicts", () => {
    // deliberate co-run (e.g. benchmarking): the user takes the last-wins fight knowingly
    wiring.ignoreConflicts = true;
    const pi = makeFakePi();
    memkeeperExtension(pi);
    // ready api still fires — and reports NO pause (registered despite conflicts)
    const handler = pi._handlers.get("session_start")?.at(-1);
    handler?.({}, {} as ExtensionContext);
    const api = pi.events.emit.mock.calls.at(-1)?.[1] as { getConflictPause: () => unknown };
    expect(api.getConflictPause()).toBeNull();
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
});
