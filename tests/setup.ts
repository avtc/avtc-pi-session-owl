// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

/**
 * Global test setup, registered via `setupFiles` in vitest.config.ts.
 *
 * The suite runs with `isolate: false` for speed, which shares ONE module
 * registry across every test file. That turns two ordinary patterns into
 * deterministic killers:
 *
 * 1. `vi.mock(module)` collisions. index.test.ts `vi.mock`s several modules
 *    (lifecycle, triggers, compaction/hook, widget/tracker, runtime/stages,
 *    todo/wiring) to assert activate WIRING without running real graph work.
 *    Other files import those SAME modules for REAL (lifecycle.test.ts,
 *    triggers.test.ts, etc.). Under isolate:false whichever loads first wins
 *    for the whole process — when a real-importing file loads first, the
 *    per-file vi.mock factory never applies, so index.test.ts asserts against
 *    fns the SUT never calls → "called 0 times" / double-registration flakes.
 *    Fix (mirrors avtc-pi-portrait/tests/setup.ts): mock each shared module
 *    ONCE here, preserving its REAL exports via `importOriginal`, and gate the
 *    stubs behind a per-file flag. A file opts into stubs via `useStubs({...})`
 *    in its beforeEach; while a flag is off the call forwards to the REAL impl,
 *    so real-behavior files are unaffected.
 * 2. The settings module singletons (override/handle/registerFn seam) leak
 *    across files; reset them in `afterAll`.
 */

import { afterAll, beforeEach, vi } from "vitest";
import { _resetMemkeeperSettingsHandle, _setRegisterSettingsCommand } from "../src/config/schema.js";
import { _setBaseLoggerForTest } from "../src/log.js";
import { resetForNewSession } from "../src/store/graph-store.js";

// Tests must NEVER write to the real production log file (~/.pi/logs/...). The
// real avtc-pi-logger is created at log.ts module load (shared under
// isolate:false), so redirect it to a no-op sink here. Re-asserted in beforeEach
// so a test that swaps in its own sink (tests/log.test.ts) can't leave the real
// logger re-enabled for later files via its afterAll restore.
const NO_OP_LOG_SINK = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
};
_setBaseLoggerForTest(NO_OP_LOG_SINK);

// ---- per-file stub flags --------------------------------------------------

/** The stub flags a test file can opt into via {@link useStubs}. Each key names a
 *  shared module whose stubbed exports should be active for the current test.
 *  Unset/off ⇒ real implementation (forwarded via importOriginal). */
export interface MxStubFlags {
  lifecycle?: boolean;
  triggers?: boolean;
  compactionHook?: boolean;
  widget?: boolean;
  stages?: boolean;
  todoWiring?: boolean;
}

const NO_STUBS: MxStubFlags = {
  lifecycle: false,
  triggers: false,
  compactionHook: false,
  widget: false,
  stages: false,
  todoWiring: false,
};

/** Declare which module stubs the current test wants active. Replaces the whole
 *  flag set, so a file that needs no stubs is implicitly all-real without calling
 *  this. Call from a test file's `beforeEach` (flags are reset after each file by
 *  {@link afterAll}). */
export function useStubs(flags: MxStubFlags): MxStubFlags {
  globalThis.__mxStubFlags = { ...NO_STUBS, ...flags };
  return globalThis.__mxStubFlags;
}

function stubOn(key: keyof MxStubFlags): boolean {
  return globalThis.__mxStubFlags?.[key] === true;
}

// ---- plain stub implementations -------------------------------------------
// NOT vi.fns (the gated forwarder itself is the vi.fn tests assert on); they
// just provide stubbed return values when a file's flag is on. Return values are
// baked in (not via mockResolvedValue) so a test's `vi.clearAllMocks()` cannot
// wipe them.

const STUB_NO_OP_WIDGET = Object.freeze({
  setCtx: () => {},
  clearCtx: () => {},
  render: () => {},
  startStage: () => {},
  setPass: () => {},
  setBatch: () => {},
  endStage: () => {},
  onEvent: () => {},
});

const STUB_RUN_FN = (): unknown => undefined;

const stubs = {
  captureInitialPromptIfAbsent: (): unknown => undefined,
  captureInitialPromptAndExtract: (): unknown => undefined,
  onSessionStart: (): unknown => Promise.resolve(undefined),
  onSessionShutdown: (): unknown => undefined,
  toStoreContext: (): unknown => undefined,
  isUnstuckAutoContinue: (): boolean => false,
  extractMessageText: (): string => "",
  onTurnEnd: (): unknown => undefined,
  setStageRuns: (): unknown => undefined,
  compactionHook: (): unknown => Promise.resolve(undefined),
  initWidget: (): unknown => STUB_NO_OP_WIDGET,
  makeObserverRun: (): unknown => STUB_RUN_FN,
  runObserver: (): unknown => undefined,
  makeBuilderRun: (): unknown => STUB_RUN_FN,
  runBuilder: (): unknown => undefined,
  makeSelectorRun: (): unknown => STUB_RUN_FN,
  runSelector: (): unknown => undefined,
  createTodoWiring: (): unknown => ({
    getContext: () => ({ getInProgress: () => null, getPending: () => [] }),
    getBridge: () => ({ getItems: (): unknown[] => [] }),
  }),
} as const;

// ---- flag-gated forwarder registry ----------------------------------------

type ForwarderImpl = (...args: never[]) => unknown;
const forwarders: Array<{ fn: ReturnType<typeof vi.fn>; impl: ForwarderImpl }> = [];

/** Build a flag-gated forwarder: a `vi.fn` whose impl routes to the stub when
 *  the flag is on and the real impl when off. The returned fn IS the module
 *  export, so `import { fn } from "../src/x.js"` + `.toHaveBeenCalledTimes` /
 *  `.mock` keep working in tests. */
function gated(flag: keyof MxStubFlags, realImpl: ForwarderImpl, stubImpl: ForwarderImpl): ReturnType<typeof vi.fn> {
  const impl = (...args: never[]): unknown => (stubOn(flag) ? stubImpl(...args) : realImpl(...args));
  const fn = vi.fn(impl);
  forwarders.push({ fn, impl });
  return fn;
}

// ---- the ONE mock per shared module (real exports preserved) ---------------

vi.mock("../src/lifecycle.js", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../src/lifecycle.js")>();
  return {
    ...orig,
    captureInitialPromptIfAbsent: gated(
      "lifecycle",
      orig.captureInitialPromptIfAbsent as ForwarderImpl,
      stubs.captureInitialPromptIfAbsent,
    ),
    captureInitialPromptAndExtract: gated(
      "lifecycle",
      orig.captureInitialPromptAndExtract as ForwarderImpl,
      stubs.captureInitialPromptAndExtract,
    ),
    onSessionStart: gated("lifecycle", orig.onSessionStart as ForwarderImpl, stubs.onSessionStart),
    onSessionShutdown: gated("lifecycle", orig.onSessionShutdown as ForwarderImpl, stubs.onSessionShutdown),
    toStoreContext: gated("lifecycle", orig.toStoreContext as ForwarderImpl, stubs.toStoreContext),
    isUnstuckAutoContinue: gated("lifecycle", orig.isUnstuckAutoContinue as ForwarderImpl, stubs.isUnstuckAutoContinue),
    extractMessageText: gated("lifecycle", orig.extractMessageText as ForwarderImpl, stubs.extractMessageText),
  };
});

vi.mock("../src/triggers.js", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../src/triggers.js")>();
  return {
    ...orig,
    onTurnEnd: gated("triggers", orig.onTurnEnd as ForwarderImpl, stubs.onTurnEnd),
    setStageRuns: gated("triggers", orig.setStageRuns as ForwarderImpl, stubs.setStageRuns),
  };
});

vi.mock("../src/compaction/hook.js", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../src/compaction/hook.js")>();
  return {
    ...orig,
    compactionHook: gated("compactionHook", orig.compactionHook as ForwarderImpl, stubs.compactionHook),
  };
});

vi.mock("../src/widget/tracker.js", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../src/widget/tracker.js")>();
  return {
    ...orig,
    initWidget: gated("widget", orig.initWidget as ForwarderImpl, stubs.initWidget),
  };
});

vi.mock("../src/runtime/stages.js", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../src/runtime/stages.js")>();
  return {
    ...orig,
    makeObserverRun: gated("stages", orig.makeObserverRun as ForwarderImpl, stubs.makeObserverRun),
    runObserver: gated("stages", orig.runObserver as ForwarderImpl, stubs.runObserver),
    makeBuilderRun: gated("stages", orig.makeBuilderRun as ForwarderImpl, stubs.makeBuilderRun),
    runBuilder: gated("stages", orig.runBuilder as ForwarderImpl, stubs.runBuilder),
    makeSelectorRun: gated("stages", orig.makeSelectorRun as ForwarderImpl, stubs.makeSelectorRun),
    runSelector: gated("stages", orig.runSelector as ForwarderImpl, stubs.runSelector),
  };
});

vi.mock("../src/todo/wiring.js", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../src/todo/wiring.js")>();
  return {
    ...orig,
    createTodoWiring: gated("todoWiring", orig.createTodoWiring as ForwarderImpl, stubs.createTodoWiring),
  };
});

// ---- hooks ----------------------------------------------------------------

// Real timers before every test: a fake-timer leak from a prior test would
// freeze real-timer waits and time tests out.
beforeEach(() => {
  vi.useRealTimers();
  _setBaseLoggerForTest(NO_OP_LOG_SINK);
});

// Reset module singletons + stub state after each test FILE (the isolate:false
// leak boundary). Runs after the file's own afterAll.
afterAll(() => {
  vi.useRealTimers();
  _resetMemkeeperSettingsHandle();
  _setRegisterSettingsCommand(null);
  resetForNewSession();
  globalThis.__mxStubFlags = undefined;
  // Clear every flag-gated forwarder's call log AND queued mock returns, then
  // re-arm the flag-gating impl (so it keeps delegating to real or stub).
  for (const { fn, impl } of forwarders) {
    fn.mockReset();
    fn.mockImplementation(impl);
  }
});

declare global {
  // eslint-disable-next-line no-var
  var __mxStubFlags: MxStubFlags | undefined;
}
