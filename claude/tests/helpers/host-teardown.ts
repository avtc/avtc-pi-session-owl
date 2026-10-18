// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// The claude-host singleton boundary reset. Specs share one module
// registry (isolate: false), so state a file leaves behind is state the
// NEXT file reads: conflict hits gate every pause-checked branch, an
// installed settings handle keeps the first harness's fs/env closures,
// armed bridge services keep the last dispatch's `$` capsules, and the
// capture/storage/log singletons hold per-conversation accumulators.
// Every import is DYNAMIC — the reset must reach the module instance the
// registry currently serves, not one bound at this file's load.
export async function resetClaudeHostSingletons(): Promise<void> {
  const pause = await import("../../host/conflicts/pause.js");
  pause._resetConflictStateForTest();
  const consumer = await import("../../host/settings/consumer.js");
  consumer._resetSettingsConsumerForTest();
  const bridge = await import("../../host/engine-bridge.js");
  bridge.clearAllForSessionEnd();
  const capture = await import("../../host/capture/append-handler.js");
  capture._resetCapture();
  const storage = await import("../../host/storage/session-storage.js");
  storage._resetSessionStorage();
  const logBackend = await import("../../host/log/backend.js");
  logBackend._resetLogConsumerForTest();
  const coreSchema = await import("../../core/src/config/schema.js");
  coreSchema._resetSessionOwlSettingsHandle();
  coreSchema._setRegisterSettingsCommand(null);
  // the session-model slot: a start-time `$.session.model()` seed (or a
  // turn.step refresh) is per-FILE state the next spec must not inherit
  const state = await import("../../host/state.js");
  state.setSessionModel(null);
}
