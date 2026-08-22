// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

/**
 * Global test setup, registered via `setupFiles` in vitest.config.ts.
 *
 * The suite runs with `isolate: false` for speed, which shares ONE module
 * registry and ONE `globalThis` across every test file (the sibling-repo
 * convention — avtc-pi-portrait / avtc-pi-featyard). This file owns the
 * cross-file invariants that makes safe:
 *
 * 1. Tests must NEVER write to the real production log file (~/.pi/logs/...).
 *    The real avtc-pi-logger is created at log.ts module load (shared under
 *    isolate:false), so it is redirected to a no-op sink here and re-asserted
 *    in beforeEach (a test that swaps in its own sink can't leave the real
 *    logger re-enabled for later files).
 * 2. Real timers before every test — a fake-timer leak from one file would
 *    freeze real-timer waits and time tests out.
 * 3. Module singletons (settings handle/override, session affinity, GraphStore)
 *    reset after each test FILE — the isolate:false leak boundary.
 *
 * Module MOCKING follows the sibling-repo convention too: a per-file hoisted
 * `vi.mock` of a shared src module is racy under isolate:false (whichever file
 * loads first decides for the whole process), so files that need a module
 * stubbed use the resetModules + vi.doMock + dynamic-import pattern instead —
 * see tests/index.test.ts and tests/integration.test.ts (the avtc-pi-portrait
 * extension-idempotency / cache-refresh pattern): vi.resetModules() drops the
 * shared cache, vi.doMock registers file-scoped mocks for the freshly
 * re-evaluated graph, and a dynamic `await import(...)` binds that graph
 * deterministically; vi.doUnmock in afterEach releases the registrations.
 */

import { afterAll, beforeEach, vi } from "vitest";
import { _resetMemkeeperSettingsHandle, _setRegisterSettingsCommand } from "../src/config/schema.js";
import { _setBaseLoggerForTest } from "../src/log.js";
import { _resetSessionAffinity } from "../src/runtime/session-affinity.js";
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

// ---- hooks ----------------------------------------------------------------

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
  _resetSessionAffinity();
  resetForNewSession();
});
