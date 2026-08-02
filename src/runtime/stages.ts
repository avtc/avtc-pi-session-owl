// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// Stage wiring: adapt each stage's run function (Observer/Builder/Selector)
// into the shared `RunFn` contract the trigger layer calls, and register them
// via `setStageRuns`. All three stages are wired here (the background trigger
// layer + the compaction hook both reach them).

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { type BuilderRunInput, runBuilder } from "../builder/run.js";
import { type ObserverRunInput, runObserver } from "../observer/run.js";
import { runSelector, type SelectorRunInput } from "../selector/run.js";
import type { TodoWiring } from "../todo/wiring.js";
import type { RunFn } from "../triggers.js";
import type { WidgetController } from "../widget/tracker.js";

/** A seam over the real runObserver (tests pass a fake; production passes runObserver). */
type RunObserverFn = (input: ObserverRunInput) => Promise<void>;

/** Re-export so production callers pass it explicitly (no default param). */
export { runObserver };

/** A seam over the real runBuilder (tests pass a fake; production passes runBuilder). */
type RunBuilderFn = (input: BuilderRunInput) => Promise<void>;

/** Re-export so production callers pass it explicitly (no default param). */
export { runBuilder };

/** A seam over the real runSelector (tests pass a fake; production passes runSelector). */
type RunSelectorFn = (input: SelectorRunInput) => Promise<void>;

/** Re-export so production callers pass it explicitly (no default param). */
export { runSelector };

/**
 * Build the Observer's `RunFn`: forwards the trigger's `{ctx, settings, signal,
 * unobserved}` into the run function. The Observer's only input is the unobserved
 * slice; it honors `signal` and owns no run-lock (the caller owns the lifecycle).
 */
export function makeObserverRun(pi: ExtensionAPI, widget: WidgetController, runObserverFn: RunObserverFn): RunFn {
  return async (args) => {
    if (args.unobserved === null) return;
    await runObserverFn({
      ctx: args.ctx,
      pi,
      settings: args.settings,
      unobserved: args.unobserved,
      signal: args.signal,
      widget,
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

/**
 * Build the Selector's `RunFn`: forwards the trigger's `{ctx, settings, signal,
 *  scope}` into the run function along with the widget controller and the
 *  avtc-pi-todo context/bridge (read LIVE at each call, so a todo extension
 *  appearing mid-session is picked up). The Selector honors `signal` and owns
 *  no run-lock (the caller owns the lifecycle). `unobserved` is unused
 *  (Observer-only). The background trigger path passes `scope: null`
 *  (mid-session); the compaction path passes the compaction cut. */
export function makeSelectorRun(
  pi: ExtensionAPI,
  widget: WidgetController,
  runSelectorFn: RunSelectorFn,
  todo: TodoWiring,
): RunFn {
  return async (args) => {
    await runSelectorFn({
      ctx: args.ctx,
      pi,
      settings: args.settings,
      signal: args.signal,
      scope: args.scope,
      widget,
      todo: todo.getContext(),
      todoBridge: todo.getBridge(),
    });
  };
}
