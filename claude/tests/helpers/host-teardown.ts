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
// The reset SETTLES FIRST: the wiring arms fire-and-forget continuations
// (the details warm on the clock lane, the binding prime, queued serves)
// whose real timers fire after the spec's last await. Draining a few
// macrotask turns lets them land while the ending file's state is still
// coherent — a continuation landing AFTER the resets re-populates cleared
// singletons mid-next-file (the resurrected registry entry, a warm latch
// stuck pending, mirror writes racing the next file's waits).
export async function resetClaudeHostSingletons(): Promise<void> {
  // drain order: immediate lanes first, then the short debounce lanes
  // (the tracker's trailing publish, the checkpoint retries) — a leftover
  // running during the resets re-populates cleared singletons mid-next-file
  for (let i = 0; i < 3; i += 1) {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  for (let i = 0; i < 2; i += 1) {
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
  }
  await new Promise<void>((resolve) => setTimeout(resolve, 60));
  const pause = await import("../../host/conflicts/pause.js");
  pause._resetConflictStateForTest();
  const consumer = await import("../../host/settings/consumer.js");
  consumer._resetSettingsConsumerForTest();
  const bridge = await import("../../host/engine-bridge.js");
  bridge.clearAllForSessionEnd();
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
  const context = await import("../../host/triggers/context.js");
  context.pruneMeasures();
  const runLocks = await import("../../host/triggers/run-locks.js");
  runLocks.pruneIdleLocks();
  const coreSchema = await import("../../core/src/config/schema.js");
  coreSchema._resetSessionOwlSettingsHandle();
  coreSchema._setRegisterSettingsCommand(null);
  // the session-model slot: a start-time `$.session.model()` seed (or a
  // turn.step refresh) is per-FILE state the next spec must not inherit
  const state = await import("../../host/state.js");
  state.setSessionModel(null);
  // the wiring's own module state (the live-chain, the conflict once-latch,
  // compaction claims, the fired-assistant index) — a leftover arms the
  // next file's dispatches with the previous file's verdicts
  const wiring = await import("../../hooks/register.js");
  wiring._resetRegisterBoundaryForTest();
}
