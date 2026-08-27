// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import type {
  ExtensionAPI,
  ExtensionContext,
  SessionBeforeCompactEvent,
  SessionStartEvent,
} from "@earendil-works/pi-coding-agent";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_CONFIG, type MemkeeperConfig } from "../src/config/schema.js";

// Activate-wiring tests: assert what memkeeperExtension(pi) registers and which
// stage/hook functions it wires — without running real graph/LLM work (those
// have their own files). The wiring targets (lifecycle, triggers,
// compaction/hook, widget/tracker, runtime/stages, todo/wiring) are stubbed via
// the sibling-repo pattern (avtc-pi-portrait extension-idempotency /
// cache-refresh): vi.resetModules() drops the shared module cache,
// vi.doMock registers file-scoped module mocks for the freshly re-evaluated
// graph, and a dynamic `await import("../src/index.js")` binds that graph —
// deterministic deep application, no per-file hoisted vi.mock (which is racy
// under isolate:false: whichever file loads first decides for the whole
// process). avtc-pi-settings-ui is doMock'd the same way (importOriginal
// preserved for settingsFilePaths) so initMemkeeperSettings gets a fake handle
// reading the hoisted settings holder — no /mk:settings command or reload
// handler registered against the fake pi.

// The wiring fns the doMock factories install (the extension graph binds THESE
// vi.fns, so call/recording assertions below are identity-stable).
const wiring = vi.hoisted(() => {
  const marker = (name: string): (() => Promise<void>) => {
    const run = async (): Promise<void> => {};
    Object.defineProperty(run, "name", { value: name });
    return run;
  };
  return {
    onSessionStart: vi.fn(async () => {}),
    onSessionShutdown: vi.fn(() => {}),
    captureInitialPromptAndExtract: vi.fn(() => {}),
    onTurnEnd: vi.fn(() => {}),
    setStageRuns: vi.fn((_runs: { runObserver: unknown; runBuilder: unknown; runSelector: unknown }) => {}),
    compactionHook: vi.fn(
      async (
        _event: unknown,
        _ctx: unknown,
        _pi: unknown,
        _widget: unknown,
        _todo: { context: unknown; bridge: unknown },
      ): Promise<undefined> => undefined,
    ),
    initWidget: vi.fn(() => ({
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
    makeObserverRun: vi.fn(() => marker("observer-run")),
    makeBuilderRun: vi.fn(() => marker("builder-run")),
    makeSelectorRun: vi.fn(() => marker("selector-run")),
    createTodoWiring: vi.fn(() => ({
      getContext: () => ({ getInProgress: () => null, getPending: () => [] }),
      getBridge: () => ({ getItems: (): unknown[] => [] }),
    })),
    // The live settings the fresh graph's getMemkeeperSettings() reads (the
    // fake registerSettingsCommand handle returns this — the doMock stand-in
    // for the _setGetMemkeeperSettings seam, scoped to the fresh graph).
    // Seeded from DEFAULT_CONFIG in beforeEach (vi.hoisted runs before imports,
    // so the frozen defaults are not referenceable here).
    settings: { config: undefined as MemkeeperConfig | undefined },
    // The conflict-detection result the fresh graph's detectConflicts() returns
    // (default: no conflicts — the real detector has its own tests and MUST NOT
    // run here: a developer machine with a real conflicting package installed
    // would otherwise flip these wiring tests into conflict mode).
    conflicts: [] as Array<{ entry: string; matched: string }>,
  };
});

/** A fake pi that records `on` registrations by event name. */
function makeFakePi(): ExtensionAPI {
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
  return { ...pi, _handlers: handlers } as unknown as ExtensionAPI;
}

interface FakePiWithHandlers extends ExtensionAPI {
  _handlers: Map<string, ((event: unknown, ctx: ExtensionContext) => unknown)[]>;
}

function makeCtx(): ExtensionContext {
  return {
    sessionManager: {
      getLeafId: () => null,
      getBranch: () => [],
      getEntry: () => undefined,
      getSessionId: () => "a1b2c3d4-0000-0000-0000-000000000000",
    },
  } as unknown as ExtensionContext;
}

/** The mocked module paths the doMock block registers (doUnmock'd in afterAll). */
const MOCKED_PATHS = [
  "../src/lifecycle.js",
  "../src/triggers.js",
  "../src/compaction/hook.js",
  "../src/widget/tracker.js",
  "../src/runtime/stages.js",
  "../src/todo/wiring.js",
  "../src/conflicts/detect.js",
  "avtc-pi-settings-ui",
] as const;

/** Drop the shared cache, register the file-scoped mocks, re-evaluate the
 *  extension graph against them. Called once per describe (beforeAll) — the
 *  tests share the mocked graph, matching the one-graph-per-process runtime. */
async function importMockedExtension(): Promise<typeof import("../src/index.js")> {
  vi.resetModules();
  vi.doMock("../src/lifecycle.js", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../src/lifecycle.js")>()),
    onSessionStart: wiring.onSessionStart,
    onSessionShutdown: wiring.onSessionShutdown,
    captureInitialPromptAndExtract: wiring.captureInitialPromptAndExtract,
  }));
  vi.doMock("../src/triggers.js", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../src/triggers.js")>()),
    onTurnEnd: wiring.onTurnEnd,
    setStageRuns: wiring.setStageRuns,
  }));
  vi.doMock("../src/compaction/hook.js", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../src/compaction/hook.js")>()),
    compactionHook: wiring.compactionHook,
  }));
  vi.doMock("../src/widget/tracker.js", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../src/widget/tracker.js")>()),
    initWidget: wiring.initWidget,
  }));
  vi.doMock("../src/runtime/stages.js", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../src/runtime/stages.js")>()),
    makeObserverRun: wiring.makeObserverRun,
    makeBuilderRun: wiring.makeBuilderRun,
    makeSelectorRun: wiring.makeSelectorRun,
  }));
  vi.doMock("../src/todo/wiring.js", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../src/todo/wiring.js")>()),
    createTodoWiring: wiring.createTodoWiring,
  }));
  vi.doMock("../src/conflicts/detect.js", () => ({
    detectConflicts: () => wiring.conflicts,
    CONFLICT_PACKAGE_MARKERS: [] as string[],
  }));
  vi.doMock("avtc-pi-settings-ui", async (importOriginal) => ({
    ...(await importOriginal<typeof import("avtc-pi-settings-ui")>()),
    registerSettingsCommand: (() => ({
      getSettings: (): MemkeeperConfig => ({ ...(wiring.settings.config ?? { ...DEFAULT_CONFIG, enabled: true }) }),
      updateSetting: () => {},
      loadSettingsIntoMemory: () => {},
    })) as unknown as typeof import("avtc-pi-settings-ui").registerSettingsCommand,
  }));
  return import("../src/index.js");
}

describe("memkeeperExtension (activate wiring)", () => {
  let memkeeperExtension: typeof import("../src/index.js").default;

  beforeAll(async () => {
    memkeeperExtension = (await importMockedExtension()).default;
  });
  afterAll(() => {
    for (const path of MOCKED_PATHS) vi.doUnmock(path);
  });
  beforeEach(() => {
    vi.clearAllMocks();
    wiring.settings.config = { ...DEFAULT_CONFIG, enabled: true };
    wiring.conflicts = [];
    memkeeperExtension(makeFakePi());
  });

  it("registers all four lifecycle hooks", () => {
    const pi = makeFakePi() as FakePiWithHandlers;
    memkeeperExtension(pi);
    const events = [...pi._handlers.keys()];
    expect(events).toContain("session_start");
    expect(events).toContain("session_shutdown");
    expect(events).toContain("turn_end");
    expect(events).toContain("session_before_compact");
  });

  it("registers the mk_recall tool (read-only memory drill-down)", () => {
    const pi = makeFakePi() as unknown as ExtensionAPI & { registerTool: ReturnType<typeof vi.fn> };
    memkeeperExtension(pi);
    expect(pi.registerTool).toHaveBeenCalledTimes(1);
    const tool = pi.registerTool.mock.calls[0]?.[0] as { name: string };
    expect(tool.name).toBe("mk_recall");
  });

  it("registers the /mk:* user commands (browse + rescan + reobserve + status)", () => {
    const pi = makeFakePi() as unknown as ExtensionAPI & { registerCommand: ReturnType<typeof vi.fn> };
    memkeeperExtension(pi);
    const names = pi.registerCommand.mock.calls.map((c) => c[0] as string);
    expect(names).toEqual(
      expect.arrayContaining([
        "mk:ls",
        "mk:cat",
        "mk:find",
        "mk:find-all",
        "mk:rescan",
        "mk:reobserve-0-obs-chunks",
        "mk:status",
      ]),
    );
    expect(pi.registerCommand).toHaveBeenCalledTimes(7);
  });

  it("wires all three stage runs (Observer + Builder + Selector) into the background trigger layer — no Selector stub", () => {
    // Every background stage must be reachable from activate. A bare
    // `runSelector: async () => {}` stub (the “built but never wired” gap) must
    // not survive: setStageRuns receives each factory's real return.
    memkeeperExtension(makeFakePi());
    expect(wiring.makeObserverRun).toHaveBeenCalled();
    expect(wiring.makeBuilderRun).toHaveBeenCalled();
    expect(wiring.makeSelectorRun).toHaveBeenCalled();
    expect(wiring.setStageRuns).toHaveBeenCalled();
    // The LAST setStageRuns call is THIS activate's wiring; each run is the
    // return value (a vi.fn) of its make*Run factory — never a bare
    // `async () => {}` stub.
    const lastRuns = wiring.setStageRuns.mock.calls.at(-1)?.[0] as {
      runObserver: unknown;
      runBuilder: unknown;
      runSelector: unknown;
    };
    const lastObserver = wiring.makeObserverRun.mock.results.at(-1)?.value;
    const lastBuilder = wiring.makeBuilderRun.mock.results.at(-1)?.value;
    const lastSelector = wiring.makeSelectorRun.mock.results.at(-1)?.value;
    expect(lastRuns.runObserver).toBe(lastObserver);
    expect(lastRuns.runBuilder).toBe(lastBuilder);
    expect(lastRuns.runSelector).toBe(lastSelector);
  });

  it("session_start handler calls onSessionStart", async () => {
    const pi = makeFakePi() as FakePiWithHandlers;
    memkeeperExtension(pi);
    const handler = pi._handlers.get("session_start")?.[0];
    expect(handler).toBeDefined();
    await handler?.({ type: "session_start", reason: "startup" } as SessionStartEvent, makeCtx());
    expect(wiring.onSessionStart).toHaveBeenCalledTimes(1);
  });

  it("session_shutdown handler calls onSessionShutdown", () => {
    const pi = makeFakePi() as FakePiWithHandlers;
    memkeeperExtension(pi);
    const handler = pi._handlers.get("session_shutdown")?.[0];
    handler?.({ type: "session_shutdown", reason: "quit" }, makeCtx());
    expect(wiring.onSessionShutdown).toHaveBeenCalledTimes(1);
  });

  it("turn_end early-returns when enabled=false (no capture, no onTurnEnd)", () => {
    wiring.settings.config = { ...DEFAULT_CONFIG, enabled: false };
    const pi = makeFakePi() as FakePiWithHandlers;
    memkeeperExtension(pi);
    const handler = pi._handlers.get("turn_end")?.[0];
    handler?.({ type: "turn_end", turnIndex: 0, message: {}, toolResults: [] }, makeCtx());
    expect(wiring.captureInitialPromptAndExtract).not.toHaveBeenCalled();
    expect(wiring.onTurnEnd).not.toHaveBeenCalled();
  });

  it("turn_end captures the initial prompt then fires onTurnEnd (enabled)", () => {
    const pi = makeFakePi() as FakePiWithHandlers;
    memkeeperExtension(pi);
    const handler = pi._handlers.get("turn_end")?.[0];
    handler?.({ type: "turn_end", turnIndex: 0, message: {}, toolResults: [] }, makeCtx());
    expect(wiring.captureInitialPromptAndExtract).toHaveBeenCalledTimes(1);
    expect(wiring.onTurnEnd).toHaveBeenCalledTimes(1);
  });

  it("turn_end still fires onTurnEnd when capture throws (error isolation)", () => {
    wiring.captureInitialPromptAndExtract.mockImplementationOnce(() => {
      throw new Error("boom");
    });
    const pi = makeFakePi() as FakePiWithHandlers;
    memkeeperExtension(pi);
    const handler = pi._handlers.get("turn_end")?.[0];
    expect(() => handler?.({ type: "turn_end", turnIndex: 0, message: {}, toolResults: [] }, makeCtx())).not.toThrow();
    expect(wiring.onTurnEnd).toHaveBeenCalledTimes(1);
  });

  it("turn_end does not crash when onTurnEnd itself throws (trigger-eval isolation)", () => {
    wiring.onTurnEnd.mockImplementationOnce(() => {
      throw new Error("trigger boom");
    });
    const pi = makeFakePi() as FakePiWithHandlers;
    memkeeperExtension(pi);
    const handler = pi._handlers.get("turn_end")?.[0];
    // The turn_end handler must not propagate the throw — Pi's emit() catches it,
    // but the index.ts try/catch surfaces it in the memkeeper log and keeps the
    // handler returning normally.
    expect(() => handler?.({ type: "turn_end", turnIndex: 0, message: {}, toolResults: [] }, makeCtx())).not.toThrow();
    expect(wiring.captureInitialPromptAndExtract).toHaveBeenCalledTimes(1);
    expect(wiring.onTurnEnd).toHaveBeenCalledTimes(1);
  });

  it("session_before_compact delegates to compactionHook", async () => {
    const pi = makeFakePi() as FakePiWithHandlers;
    memkeeperExtension(pi);
    const handler = pi._handlers.get("session_before_compact")?.[0];
    const event = { type: "session_before_compact" } as unknown as SessionBeforeCompactEvent;
    await handler?.(event, makeCtx());
    expect(wiring.compactionHook).toHaveBeenCalledTimes(1);
    // the todo wiring (context + bridge from createTodoWiring) is threaded through
    const callArgs = wiring.compactionHook.mock.calls[0];
    const todoArg = callArgs?.[4] as { context: unknown; bridge: unknown };
    expect(todoArg).toBeDefined();
    expect(todoArg.context).toBeDefined();
    expect(todoArg.bridge).toBeDefined();
  });

  it("session_before_compact early-returns undefined when enabled=false (Pi native compaction)", async () => {
    wiring.settings.config = { ...DEFAULT_CONFIG, enabled: false };
    const pi = makeFakePi() as FakePiWithHandlers;
    memkeeperExtension(pi);
    const handler = pi._handlers.get("session_before_compact")?.[0];
    const event = { type: "session_before_compact" } as unknown as SessionBeforeCompactEvent;
    const result = await handler?.(event, makeCtx());
    expect(result).toBeUndefined();
    expect(wiring.compactionHook).not.toHaveBeenCalled();
  });
});

describe("memkeeperExtension :ready API (memkeeper:ready)", () => {
  let memkeeperExtension: typeof import("../src/index.js").default;

  beforeAll(async () => {
    memkeeperExtension = (await importMockedExtension()).default;
  });
  afterAll(() => {
    for (const path of MOCKED_PATHS) vi.doUnmock(path);
  });
  beforeEach(() => {
    vi.clearAllMocks();
    wiring.settings.config = { ...DEFAULT_CONFIG, enabled: true };
  });

  it("does NOT emit :ready at activate time (deferred to session_start)", () => {
    const pi = makeFakePi() as FakePiWithHandlers;
    memkeeperExtension(pi);
    const eventsEmit = (pi as unknown as { events: { emit: ReturnType<typeof vi.fn> } }).events.emit;
    expect(eventsEmit).not.toHaveBeenCalled();
  });

  it("emits memkeeper:ready on session_start with the api", async () => {
    const pi = makeFakePi() as FakePiWithHandlers;
    memkeeperExtension(pi);
    // The :ready emitter is the SECOND session_start handler (after onSessionStart).
    const readyHandler = pi._handlers.get("session_start")?.[1];
    expect(readyHandler).toBeDefined();
    await readyHandler?.({ type: "session_start", reason: "startup" } as SessionStartEvent, makeCtx());

    const eventsEmit = (pi as unknown as { events: { emit: ReturnType<typeof vi.fn> } }).events.emit;
    expect(eventsEmit).toHaveBeenCalledTimes(1);
    const [event, api] = eventsEmit.mock.calls[0] ?? [];
    expect(event).toBe("memkeeper:ready");
    expect(api).toBeDefined();
    expect(typeof (api as { reloadConfig: unknown }).reloadConfig).toBe("function");
    expect(typeof (api as { getConfig: unknown }).getConfig).toBe("function");
  });

  it("api.getConfig returns getMemkeeperSettings()", async () => {
    const pi = makeFakePi() as FakePiWithHandlers;
    memkeeperExtension(pi);
    await pi._handlers.get("session_start")?.[1]?.({ reason: "startup" } as SessionStartEvent, makeCtx());

    const api = ((pi as unknown as { events: { emit: ReturnType<typeof vi.fn> } }).events.emit.mock.calls[0] ??
      [])[1] as {
      getConfig: () => MemkeeperConfig;
    };
    // The fake settings handle (beforeEach) pins the read to DEFAULT_CONFIG.
    expect(api.getConfig()).toEqual(DEFAULT_CONFIG);
  });
});
