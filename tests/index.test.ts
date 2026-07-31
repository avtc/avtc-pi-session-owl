// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import type {
  ExtensionAPI,
  ExtensionContext,
  SessionBeforeCompactEvent,
  SessionStartEvent,
} from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock the dependencies index.ts wires (isolate the activate WIRING from their
// real implementations, which have their own tests).
vi.mock("avtc-pi-settings-ui", () => ({
  registerSettingsCommand: vi.fn(() => ({ getSettings: () => ({ enabled: true }), updateSetting: () => {} })),
  settingsFilePaths: () => ({
    globalPath: () => "global.json",
    projectPath: () => "project.json",
  }),
}));

vi.mock("../src/lifecycle.js", () => ({
  // track capture calls without running the real graph mutation logic
  captureInitialPromptIfAbsent: vi.fn(),
  onSessionStart: vi.fn().mockResolvedValue(undefined),
  onSessionShutdown: vi.fn(),
  toStoreContext: vi.fn(),
  isUnstuckAutoContinue: vi.fn().mockReturnValue(false),
  extractMessageText: vi.fn(),
}));

vi.mock("../src/triggers.js", () => ({
  onTurnEnd: vi.fn(),
}));

vi.mock("../src/compaction/hook.js", () => ({
  compactionHook: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../src/widget/tracker.js", () => ({
  initWidget: vi.fn(() => ({
    setCtx: vi.fn(),
    clearCtx: vi.fn(),
    render: vi.fn(),
    startStage: vi.fn(),
    setPass: vi.fn(),
    setBatch: vi.fn(),
    endStage: vi.fn(),
    onEvent: vi.fn(),
  })),
}));

import { compactionHook } from "../src/compaction/hook.js";
import { _resetGetMemkeeperSettings, _setGetMemkeeperSettings, DEFAULT_CONFIG } from "../src/config/schema.js";
import memkeeperExtension from "../src/index.js";
import { captureInitialPromptIfAbsent, onSessionShutdown, onSessionStart } from "../src/lifecycle.js";
import { resetForNewSession } from "../src/store/graph-store.js";
import { onTurnEnd } from "../src/triggers.js";

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
  };
  return { ...pi, _handlers: handlers } as unknown as ExtensionAPI;
}

interface FakePiWithHandlers extends ExtensionAPI {
  _handlers: Map<string, ((event: unknown, ctx: ExtensionContext) => unknown)[]>;
}

function makeCtx(): ExtensionContext {
  return { sessionManager: { getLeafId: () => null, getBranch: () => [] } } as unknown as ExtensionContext;
}

describe("memkeeperExtension (activate wiring)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetForNewSession();
    _resetGetMemkeeperSettings();
    memkeeperExtension(makeFakePi());
  });
  afterEach(() => _resetGetMemkeeperSettings());

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

  it("session_before_compact delegates to compactionHook", async () => {
    const pi = makeFakePi() as FakePiWithHandlers;
    memkeeperExtension(pi);
    const handler = pi._handlers.get("session_before_compact")?.[0];
    const event = { type: "session_before_compact" } as unknown as SessionBeforeCompactEvent;
    await handler?.(event, makeCtx());
    expect(compactionHook).toHaveBeenCalledTimes(1);
  });
});
