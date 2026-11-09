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
//
// The boundary first ENDS every session the file left resident (the real
// session-end teardown, minus its flush): the lifecycle generations move
// on, so work the file left in flight (a start between its awaits, a pin
// still loading, the timer-lane warm) reads stale at its next check and
// never rebuilds what the resets below clear; parked stage launches are
// rejected and the bridge is disarmed. Then each module's own state goes.
export async function resetClaudeHostSingletons(): Promise<void> {
  const wiring = await import("../../hooks/register.js");
  await wiring._resetRegisterBoundaryForTest();
  const state = await import("../../host/state.js");
  state._resetForTest();
  const pause = await import("../../host/conflicts/pause.js");
  pause._resetConflictStateForTest();
  const consumer = await import("../../host/settings/consumer.js");
  consumer._resetSettingsConsumerForTest();
  const pane = await import("../../host/settings/pane.js");
  pane._resetSettingsPaneForTest();
  const capture = await import("../../host/capture/append-handler.js");
  capture._resetCapture();
  const remat = await import("../../host/compaction/remat.js");
  remat._resetRematExpectations();
  const storage = await import("../../host/storage/session-storage.js");
  storage._resetSessionStorage();
  const logBackend = await import("../../host/log/backend.js");
  logBackend._resetLogConsumerForTest();
  const readiness = await import("../../host/start/readiness.js");
  readiness._resetReadinessForTest();
  const cores = await import("../../host/core-instances.js");
  cores._resetCoreInstances();
  const bindings = await import("../../host/runs/bind.js");
  bindings._resetBindings();
  const goalRun = await import("../../host/runs/goal-extract.js");
  goalRun._resetGoalExtractRun();
  const goalLauncher = await import("../../host/start/goal-extract.js");
  goalLauncher._resetGoalExtractLauncher();
  const context = await import("../../host/triggers/context.js");
  context._resetMeasureSnapshots();
  const runLocks = await import("../../host/triggers/run-locks.js");
  runLocks._resetRunLocks();
  const recall = await import("../../host/recall/register.js");
  recall._resetRecallRegistration();
  const widgetLine = await import("../../host/widget/line-store.js");
  widgetLine._resetWidgetLine();
  const viewer = await import("../../host/commands/viewer.js");
  viewer.clearViewerContent();
  const coreSchema = await import("../../core/src/config/schema.js");
  coreSchema._resetSessionOwlSettingsHandle();
  coreSchema._setRegisterSettingsCommand(null);
  // the session-model slot: a start-time `$.session.model()` seed (or a
  // turn.step refresh) is per-FILE state the next spec must not inherit
  state.setSessionModel(null);
}
