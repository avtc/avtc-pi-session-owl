// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// Stage wiring: adapt each stage's run function (Observer/Builder/Selector)
// into the shared `RunFn` contract the trigger layer calls, and register them
// via `setStageRuns`. The Observer and Builder are wired here; the Selector is
// wired in its own task.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { type BuilderRunInput, runBuilder } from "../builder/run.js";
import { type ObserverRunInput, runObserver } from "../observer/run.js";
import type { RunFn } from "../triggers.js";
import type { WidgetController } from "../widget/tracker.js";
import { NO_EVENT_SINK } from "./agent-loop.js";

/** A seam over the real runObserver (tests pass a fake; production passes runObserver). */
type RunObserverFn = (input: ObserverRunInput) => Promise<void>;

/** Re-export so production callers pass it explicitly (no default param). */
export { runObserver };

/** A seam over the real runBuilder (tests pass a fake; production passes runBuilder). */
type RunBuilderFn = (input: BuilderRunInput) => Promise<void>;

/** Re-export so production callers pass it explicitly (no default param). */
export { runBuilder };

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

/**
 * Build the Builder's `RunFn`: forwards the trigger's `{ctx, settings, signal,
 * scope}` into the run function along with the widget controller
 * (startStage/setPass/endStage + onEvent). The Builder honors `signal` and owns
 * no run-lock (the caller owns the lifecycle). `scope` carries the compaction
 * cut (reserved — the Builder processes all current `new` nodes; the Observer's
 * gap-driven catch-up scopes them to the compacted block in the default
 * profile). `unobserved` is unused (Observer-only).
 */
export function makeBuilderRun(pi: ExtensionAPI, widget: WidgetController, runBuilderFn: RunBuilderFn): RunFn {
  return async (args) => {
    await runBuilderFn({
      ctx: args.ctx,
      pi,
      settings: args.settings,
      signal: args.signal,
      scope: args.scope,
      widget,
    });
  };
}
