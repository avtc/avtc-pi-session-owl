// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// The session-owl extension activate entry point: register the settings command,
// the widget, and the four session hooks. Hooks read `getSessionOwlSettings()`
// live at each trigger (live-toggle guarantee); `enabled=false` is the master
// off-path (every entry early-returns; compaction returns undefined so Pi runs
// its native summary).

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerUserCommands } from "./commands/user.js";
import { compactionHook } from "./compaction/hook.js";
import { getSessionOwlSettings, initSessionOwlSettings, reloadSessionOwlConfig } from "./config/schema.js";
import { detectConflicts } from "./conflicts/detect.js";
import { getConflictHits, isConflictPaused, setConflictHits } from "./conflicts/pause.js";
import { captureInitialPromptAndExtract, onSessionShutdown, onSessionStart, onSessionTree } from "./lifecycle.js";
import { log } from "./log.js";
import { makeOwlRecallTool } from "./recall/owl-recall.js";
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

/** detectConflicts with no overrides — scan the real home + cwd + self root. */
const NO_CONFLICT_SCAN_OPTIONS = null;

export default function sessionOwlExtension(pi: ExtensionAPI): void {
  // Widget first so settings registration can already refresh it: every panel
  // edit re-renders, keeping the pause line in step with live gate flips
  // (render-time liveness decides show/hide — see tracker.ts).
  const widget = initWidget();
  initSessionOwlSettings(pi, () => widget.render());

  // --- session-owl:ready extensibility API (for avtc-pi-bench-compact) ---
  // Lets a host reconfigure session-owl LIVE (reload the in-memory settings cache from
  // PI_SETTINGS_SESSION_OWL env / files) without ctx.reload() (which invalidates the
  // command ctx). Deferred to session_start (reload-safe: session-owl re-activates each
  // reload; consumers clean their own listener on session_shutdown — see the snippet).
  const api = {
    reloadConfig: () => reloadSessionOwlConfig(),
    getConfig: () => getSessionOwlSettings(),
    // The ACTIVE conflict pause (what paused session-owl + why), or null: lets a
    // host (e.g. the bench harness co-running other memory extensions via
    // ignoreConflicts) assert session-owl is actually live, not just configured.
    getConflictPause: (): ReturnType<typeof getConflictHits> => (isConflictPaused() ? getConflictHits() : null),
  };
  const emitReady = (): void => {
    pi.events.emit("session-owl:ready", api);
  };

  // Conflict pause: another compaction-handling extension is installed. pi's
  // runner treats a session_before_compact handler returning undefined as
  // fully transparent (the other extension's compaction result wins), so
  // session-owl registers its FULL surface and stays DORMANT while paused —
  // every hook early-returns, compaction returns undefined. The gate reads
  // settings live at each hook call, so ignoreConflicts (e.g. via the bench
  // harness's reloadConfig) resumes session-owl mid-session; removing the other
  // package recovers at the next pi start. The widget line + /owl:status keep
  // the pause visible. (Also clears any pause a previous (re)activation
  // recorded, so state never goes stale.)
  const conflicts = detectConflicts(NO_CONFLICT_SCAN_OPTIONS);
  setConflictHits(conflicts.length > 0 ? conflicts : null);
  const activationSettings = getSessionOwlSettings();
  if (conflicts.length > 0 && !activationSettings.enabled) {
    // Detect + record only. enabled=false is the operator's explicit choice —
    // a conflict warning would claim a pause that is not why session-owl is off.
  } else if (conflicts.length > 0 && !activationSettings.ignoreConflicts) {
    log.info(
      `conflict pause: ${conflicts.map((h) => h.matched).join(", ")} also handles compaction — ` +
        "session-owl stays dormant; remove it, or set ignoreConflicts (see README → Conflicts), to resume",
    );
    widget.setConflict(conflicts.map((h) => h.matched));
  } else if (conflicts.length > 0) {
    log.warn(
      `conflict detected (${conflicts.map((h) => h.matched).join(", ")}) but ignoreConflicts=true — ` +
        "running anyway; pi compaction is last-return-wins",
    );
  }

  // Optional avtc-pi-todo companion: getContext/getBridge return null until
  // pi-todo:ready fires (avtc-pi-todo installed) — graceful degrade otherwise.
  const todo = createTodoWiring(pi);

  // The agent's read-only memory drill-down tool. Registered unconditionally
  // (it is read-only and harmless even when session-owl is disabled — it just
  // reads whatever graph state exists).
  pi.registerTool(makeOwlRecallTool());

  // The user's `/owl:*` browse commands (roots / cat / find / find-all / rescan).
  // They render via ui.notify (zero agent-context cost) and read the source graph
  // directly, so they are harmless even when session-owl is disabled — except
  // /owl:rescan, which gates on enabled itself. Registered AFTER the Builder
  // stage run exists (the rescan reuse-rebuild drives it).

  // /owl:status — the user-facing status report (memory stats + per-phase usage).
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

  pi.on("session_start", (event, ctx) => {
    // Dormant while conflict-paused — but the pause LINE is the warning
    // channel: it needs a ctx + a render even when no observer work runs
    // (normally onSessionStart wires the widget; the gated branch must too).
    if (isConflictPaused()) {
      widget.setCtx(ctx);
      widget.render();
      return;
    }
    onSessionStart(event, ctx, pi, widget);
  });
  pi.on("session_shutdown", (_event, _ctx) => onSessionShutdown(_event, widget));

  // `/tree` branch navigation: re-derive the store (graph + frontier +
  // resolver) for the new branch and stop any in-flight stage run whose chunk
  // ranges belong to the old one. Awaited so the healed frontier is in place
  // before the next turn's triggers evaluate.
  pi.on("session_tree", async (event, ctx) => {
    // Dormant while conflict-paused — keep the pause line honest (mirrors
    // session_start), but no store re-derivation.
    if (isConflictPaused()) {
      widget.setCtx(ctx);
      widget.render();
      return;
    }
    try {
      await onSessionTree(event, ctx, pi, widget);
    } catch (err) {
      log.error("session_tree: store re-derivation failed", err);
    }
  });

  pi.on("turn_end", (_event, ctx) => {
    const settings = getSessionOwlSettings();
    // enabled=false / conflict-pause off-path: no work, no capture, no background
    // run — but still render the widget once so the pause LINE stays honest
    // across mid-session flips (render-time liveness shows it when a pause has
    // started, hides it when session-owl was disabled — no next-session_start lag).
    if (!settings.enabled || isConflictPaused()) {
      widget.setCtx(ctx);
      widget.render();
      return;
    }
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
    // session-owl's own logger (Pi's emit() also catches it, but this surfaces it
    // in the session-owl log alongside the stage traces).
    try {
      onTurnEnd({ ctx, settings });
    } catch (err) {
      log.error("turn_end: trigger evaluation failed", err);
    }
  });

  pi.on("session_before_compact", (event, ctx) => {
    const settings = getSessionOwlSettings();
    // enabled=false / conflict-pause off-path: return undefined so Pi runs its
    // native compaction — or, with another compaction handler registered, so
    // that handler's result wins (pi treats undefined as fully transparent).
    if (!settings.enabled || isConflictPaused()) return undefined;
    return compactionHook(event, ctx, pi, widget, {
      context: todo.getContext(),
      bridge: todo.getBridge(),
    });
  });

  pi.on("session_start", emitReady);
}
