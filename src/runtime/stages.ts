// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// Stage wiring: adapt each stage's run function (Observer/Builder/Selector)
// into the shared `RunFn` contract the trigger layer calls, and register them
// via `setStageRuns`. The Observer is wired here; the Builder and Selector are
// wired in their own tasks.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { type ObserverRunInput, runObserver } from "../observer/run.js";
import type { RunFn } from "../triggers.js";
import { NO_EVENT_SINK } from "./agent-loop.js";

/** A seam over the real runObserver (tests pass a fake; production passes runObserver). */
type RunObserverFn = (input: ObserverRunInput) => Promise<void>;

/** Re-export so production callers pass it explicitly (no default param). */
export { runObserver };

/**
 * Build the Observer's `RunFn`: forwards the trigger's `{ctx, settings, signal,
 * unobserved}` into the run function. The Observer's only input is the unobserved
 * slice; it honors `signal` and owns no run-lock (the caller owns the lifecycle).
 */
export function makeObserverRun(pi: ExtensionAPI, runObserverFn: RunObserverFn): RunFn {
  return async (args) => {
    if (args.unobserved === null) return;
    await runObserverFn({
      ctx: args.ctx,
      pi,
      settings: args.settings,
      unobserved: args.unobserved,
      signal: args.signal,
      onEvent: NO_EVENT_SINK,
    });
  };
}
