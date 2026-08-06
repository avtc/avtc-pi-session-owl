// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import type {
  ExtensionAPI,
  ExtensionContext,
  SessionBeforeCompactEvent,
  SessionStartEvent,
} from "@earendil-works/pi-coding-agent";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock the dependencies index.ts wires (isolate the activate WIRING from their
// real implementations, which have their own tests).
// avtc-pi-settings-ui is NOT vi.mock'd here. Under isolate:false that module
// mock races against the many files that import schema.ts (loading the REAL
// module), so the mock intermittently fails to apply → the real
// registerSettingsCommand runs → it registers /mk:settings via pi.registerCommand
// (a 6th command) AND a session_start reload handler (displacing [0]). Instead
// schema.ts exposes the _setRegisterSettingsCommand seam; beforeEach injects a
// fake that returns a handle yielding enabled:true WITHOUT touching
// pi.registerCommand. settingsFilePaths is left real (the test ignores its paths).

// The shared-module mocks (lifecycle, triggers, compaction/hook, widget/tracker,
// runtime/stages, todo/wiring) live in tests/setup.ts as flag-gated forwarders
// (avtc-pi-portrait pattern): under isolate:false a per-file vi.mock here would
// race against the real imports in lifecycle.test.ts / triggers.test.ts / etc.
// (whichever loads first wins for the process), surfacing as intermittent
// "called 0 times" / double-registration flakes. This file opts into the stubs
// via useStubs({...}) in beforeEach; the module exports it imports ARE the
// gated vi.fns, so `.toHaveBeenCalledTimes` / `.mock` keep working.

import { compactionHook } from "../src/compaction/hook.js";
import {
  _resetGetMemkeeperSettings,
  _resetMemkeeperSettingsHandle,
  _setGetMemkeeperSettings,
  _setRegisterSettingsCommand,
  DEFAULT_CONFIG,
} from "../src/config/schema.js";
import memkeeperExtension from "../src/index.js";
import { captureInitialPromptIfAbsent, onSessionShutdown, onSessionStart } from "../src/lifecycle.js";
import { makeBuilderRun, makeObserverRun, makeSelectorRun } from "../src/runtime/stages.js";
import { resetForNewSession } from "../src/store/graph-store.js";
import { onTurnEnd, setStageRuns } from "../src/triggers.js";
import { useStubs } from "./setup.js";

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
  };
  return { ...pi, _handlers: handlers } as unknown as ExtensionAPI;
}

interface FakePiWithHandlers extends ExtensionAPI {
  _handlers: Map<string, ((event: unknown, ctx: ExtensionContext) => unknown)[]>;
}

function makeCtx(): ExtensionContext {
  return {
    sessionManager: { getLeafId: () => null, getBranch: () => [], getEntry: () => undefined },
  } as unknown as ExtensionContext;
}

describe("memkeeperExtension (activate wiring)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetForNewSession();
    _resetGetMemkeeperSettings();
    // Opt into ALL shared-module stubs for this file (activate-wiring tests
    // assert call wiring, never real graph/LLM behavior).
    useStubs({
      lifecycle: true,
      triggers: true,
      compactionHook: true,
      widget: true,
      stages: true,
      todoWiring: true,
    });
    // Pin the settings read to DEFAULT_CONFIG (override takes precedence over the
    // real handle, so the default-path tests get enabled=true without depending on
    // the real settings-ui storage read against the fake pi).
    _setGetMemkeeperSettings(() => ({ ...DEFAULT_CONFIG }));
    // Inject a fake registerSettingsCommand via the schema.ts seam (NOT vi.mock of
    // avtc-pi-settings-ui — see the file header) so initMemkeeperSettings returns
    // a handle without the real settings-ui registering /mk:settings or a reload
    // handler against the fake pi.
    _setRegisterSettingsCommand((() => ({
      getSettings: () => ({ ...DEFAULT_CONFIG, enabled: true }),
      updateSetting: () => {},
    })) as unknown as typeof import("avtc-pi-settings-ui").registerSettingsCommand);
    memkeeperExtension(makeFakePi());
  });
  afterEach(() => _resetGetMemkeeperSettings());

  // activate sets the module `handle` via initMemkeeperSettings; clear it so it
  // does not leak to later test files under isolate:false (same leak class as
  // schema.test.ts / integration.test.ts).
  afterAll(() => _resetMemkeeperSettingsHandle());

  it("registers all four lifecycle hooks", () => {
    // activate ran in beforeEach via a fresh pi; re-run to capture the handlers
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

  it("registers the four /mk:* user browse commands + /mk:status", () => {
    const pi = makeFakePi() as unknown as ExtensionAPI & { registerCommand: ReturnType<typeof vi.fn> };
    memkeeperExtension(pi);
    const names = pi.registerCommand.mock.calls.map((c) => c[0] as string);
    expect(names).toEqual(expect.arrayContaining(["mk:ls", "mk:cat", "mk:find", "mk:find-all", "mk:status"]));
    expect(pi.registerCommand).toHaveBeenCalledTimes(5);
  });

  it("wires all three stage runs (Observer + Builder + Selector) into the background trigger layer — no Selector stub", () => {
    // Every background stage must be reachable from activate. A bare
    // `runSelector: async () => {}` stub (the “built but never wired” gap) must
    // not survive: setStageRuns receives each factory's real return.
    memkeeperExtension(makeFakePi());
    expect(makeObserverRun).toHaveBeenCalled();
    expect(makeBuilderRun).toHaveBeenCalled();
    expect(makeSelectorRun).toHaveBeenCalled();
    expect(setStageRuns).toHaveBeenCalled();
    // The LAST setStageRuns call is THIS activate's wiring; each run is the
    // return value (a vi.fn) of its make*Run factory — never a bare
    // `async () => {}` stub.
    const lastRuns = vi.mocked(setStageRuns).mock.calls.at(-1)?.[0] as {
      runObserver: unknown;
      runBuilder: unknown;
      runSelector: unknown;
    };
    const lastObserver = vi.mocked(makeObserverRun).mock.results.at(-1)?.value;
    const lastBuilder = vi.mocked(makeBuilderRun).mock.results.at(-1)?.value;
    const lastSelector = vi.mocked(makeSelectorRun).mock.results.at(-1)?.value;
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
    expect(onSessionStart).toHaveBeenCalledTimes(1);
  });

  it("session_shutdown handler calls onSessionShutdown", () => {
    const pi = makeFakePi() as FakePiWithHandlers;
    memkeeperExtension(pi);
    const handler = pi._handlers.get("session_shutdown")?.[0];
    handler?.({ type: "session_shutdown", reason: "quit" }, makeCtx());
    expect(onSessionShutdown).toHaveBeenCalledTimes(1);
  });

  it("turn_end early-returns when enabled=false (no capture, no onTurnEnd)", () => {
    _setGetMemkeeperSettings(() => ({ ...DEFAULT_CONFIG, enabled: false }));
    const pi = makeFakePi() as FakePiWithHandlers;
    memkeeperExtension(pi);
    const handler = pi._handlers.get("turn_end")?.[0];
    handler?.({ type: "turn_end", turnIndex: 0, message: {}, toolResults: [] }, makeCtx());
    expect(captureInitialPromptIfAbsent).not.toHaveBeenCalled();
    expect(onTurnEnd).not.toHaveBeenCalled();
  });

  it("turn_end captures the initial prompt then fires onTurnEnd (enabled)", () => {
    const pi = makeFakePi() as FakePiWithHandlers;
    memkeeperExtension(pi);
    const handler = pi._handlers.get("turn_end")?.[0];
    handler?.({ type: "turn_end", turnIndex: 0, message: {}, toolResults: [] }, makeCtx());
    expect(captureInitialPromptIfAbsent).toHaveBeenCalledTimes(1);
    expect(onTurnEnd).toHaveBeenCalledTimes(1);
  });

  it("turn_end still fires onTurnEnd when capture throws (error isolation)", () => {
    vi.mocked(captureInitialPromptIfAbsent).mockImplementationOnce(() => {
      throw new Error("boom");
    });
    const pi = makeFakePi() as FakePiWithHandlers;
    memkeeperExtension(pi);
    const handler = pi._handlers.get("turn_end")?.[0];
    expect(() => handler?.({ type: "turn_end", turnIndex: 0, message: {}, toolResults: [] }, makeCtx())).not.toThrow();
    expect(onTurnEnd).toHaveBeenCalledTimes(1);
  });

  it("turn_end does not crash when onTurnEnd itself throws (trigger-eval isolation)", () => {
    vi.mocked(onTurnEnd).mockImplementationOnce(() => {
      throw new Error("trigger boom");
    });
    const pi = makeFakePi() as FakePiWithHandlers;
    memkeeperExtension(pi);
    const handler = pi._handlers.get("turn_end")?.[0];
    // The turn_end handler must not propagate the throw — Pi's emit() catches it,
    // but the index.ts try/catch surfaces it in the memkeeper log and keeps the
    // handler returning normally.
    expect(() => handler?.({ type: "turn_end", turnIndex: 0, message: {}, toolResults: [] }, makeCtx())).not.toThrow();
    expect(captureInitialPromptIfAbsent).toHaveBeenCalledTimes(1);
    expect(onTurnEnd).toHaveBeenCalledTimes(1);
  });

  it("session_before_compact delegates to compactionHook", async () => {
    const pi = makeFakePi() as FakePiWithHandlers;
    memkeeperExtension(pi);
    const handler = pi._handlers.get("session_before_compact")?.[0];
    const event = { type: "session_before_compact" } as unknown as SessionBeforeCompactEvent;
    await handler?.(event, makeCtx());
    expect(compactionHook).toHaveBeenCalledTimes(1);
    // the todo wiring (context + bridge from createTodoWiring) is threaded through
    const callArgs = (compactionHook as unknown as { mock: { calls: unknown[][] } }).mock.calls[0];
    const todoArg = callArgs?.[4] as { context: unknown; bridge: unknown };
    expect(todoArg).toBeDefined();
    expect(todoArg.context).toBeDefined();
    expect(todoArg.bridge).toBeDefined();
  });

  it("session_before_compact early-returns undefined when enabled=false (Pi native compaction)", async () => {
    _setGetMemkeeperSettings(() => ({ ...DEFAULT_CONFIG, enabled: false }));
    const pi = makeFakePi() as FakePiWithHandlers;
    memkeeperExtension(pi);
    const handler = pi._handlers.get("session_before_compact")?.[0];
    const event = { type: "session_before_compact" } as unknown as SessionBeforeCompactEvent;
    const result = await handler?.(event, makeCtx());
    expect(result).toBeUndefined();
    expect(compactionHook).not.toHaveBeenCalled();
  });
});
