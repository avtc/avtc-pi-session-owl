// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// The memkeeper extension activate entry point: register the settings command,
// the widget, and the four session hooks. Hooks read `getMemkeeperSettings()`
// live at each trigger (live-toggle guarantee); `enabled=false` is the master
// off-path (every entry early-returns; compaction returns undefined so Pi runs
// its native summary).

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerUserCommands } from "./commands/user.js";
import { compactionHook } from "./compaction/hook.js";
import { getMemkeeperSettings, initMemkeeperSettings, reloadMemkeeperConfig } from "./config/schema.js";
import { captureInitialPromptAndExtract, onSessionShutdown, onSessionStart } from "./lifecycle.js";
import { log } from "./log.js";
import { makeMkRecallTool } from "./recall/mk-recall.js";
import {
  makeBuilderRun,
  makeObserverRun,
  makeSelectorRun,
  runBuilder,
  runObserver,
  runSelector,
} from "./runtime/stages.js";
import { registerStatusCommand } from "./status/command.js";
import { createTodoWiring } from "./todo/wiring.js";
import { onTurnEnd, setStageRuns } from "./triggers.js";
import { initWidget } from "./widget/tracker.js";

export default function memkeeperExtension(pi: ExtensionAPI): void {
  initMemkeeperSettings(pi);
  const widget = initWidget();
  // Optional avtc-pi-todo companion: getContext/getBridge return null until
  // pi-todo:ready fires (avtc-pi-todo installed) — graceful degrade otherwise.
  const todo = createTodoWiring(pi);

  // The agent's read-only memory drill-down tool. Registered unconditionally
  // (it is read-only and harmless even when memkeeper is disabled — it just
  // reads whatever graph state exists).
  pi.registerTool(makeMkRecallTool());

  // The user's `/mk:*` browse commands (roots / cat / find / find-all / rescan).
  // They render via ui.notify (zero agent-context cost) and read the source graph
  // directly, so they are harmless even when memkeeper is disabled — except
  // /mk:rescan, which gates on enabled itself. Registered AFTER the Builder
  // stage run exists (the rescan reuse-rebuild drives it).

  // /mk:status — the user-facing status report (memory stats + per-phase usage).
  registerStatusCommand(pi);

  // Wire the stage run functions (Observer + Builder + Selector). The
  // Selector reads the avtc-pi-todo wiring LIVE (a todo extension appearing
  // mid-session is picked up at the next trigger).
  const runBuilderFn = makeBuilderRun(pi, widget, runBuilder);
  registerUserCommands(pi, { pi, widget, runBuilderStage: runBuilderFn, runObserver });
  setStageRuns({
    runObserver: makeObserverRun(pi, widget, runObserver, runBuilderFn),
    runBuilder: runBuilderFn,
    runSelector: makeSelectorRun(pi, widget, runSelector, todo),
  });

  pi.on("session_start", (event, ctx) => onSessionStart(event, ctx, pi, widget));
  pi.on("session_shutdown", (_event, _ctx) => onSessionShutdown(_event, widget));

  pi.on("turn_end", (_event, ctx) => {
    const settings = getMemkeeperSettings();
    // enabled=false off-path: no work, no capture, no background run.
    if (!settings.enabled) return;
    // Capture the verbatim initial user message SYNCHRONOUSLY before the
    // fire-and-forget trigger: the capture's graph mutations commit before the
    // Observer reads the graph, so the first user message is exclusively
    // oInitialPrompt (never re-observed). On a fresh capture this also fires the
    // one-shot goal extraction (fire-and-forget) for nGoal.summary. Isolated so
    // a capture failure (a real invariant bug, surfaced via the logger) does not
    // suppress this turn's background trigger — the Observer still runs.
    try {
      captureInitialPromptAndExtract(ctx, pi, widget);
    } catch (err) {
      log.error("turn_end: initial-prompt capture failed", err);
    }
    // Fire-and-forget the background trigger evaluation (Observer + Builder +
    // Selector); the handler returns immediately and never blocks the agent.
    // Wrapped so a throw from the synchronous trigger evaluation is logged via
    // memkeeper's own logger (Pi's emit() also catches it, but this surfaces it
    // in the memkeeper log alongside the stage traces).
    try {
      onTurnEnd({ ctx, settings });
    } catch (err) {
      log.error("turn_end: trigger evaluation failed", err);
    }
  });

  pi.on("session_before_compact", (event, ctx) => {
    const settings = getMemkeeperSettings();
    // enabled=false off-path: return undefined so Pi runs its native compaction.
    if (!settings.enabled) return undefined;
    return compactionHook(event, ctx, pi, widget, {
      context: todo.getContext(),
      bridge: todo.getBridge(),
    });
  });

  // --- memkeeper:ready extensibility API (for avtc-pi-bench-compact) ---
  // Lets a host reconfigure memkeeper LIVE (reload the in-memory settings cache from
  // PI_SETTINGS_MEMKEEPER env / files) without ctx.reload() (which invalidates the
  // command ctx). Deferred to session_start (reload-safe: memkeeper re-activates each
  // reload; consumers clean their own listener on session_shutdown — see the snippet).
  const api = {
    reloadConfig: () => reloadMemkeeperConfig(),
    getConfig: () => getMemkeeperSettings(),
  };
  pi.on("session_start", () => {
    pi.events.emit("memkeeper:ready", api);
  });
}
