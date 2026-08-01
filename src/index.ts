// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// The memkeeper extension activate entry point: register the settings command,
// the widget, and the four session hooks. Hooks read `getMemkeeperSettings()`
// live at each trigger (live-toggle guarantee); `enabled=false` is the master
// off-path (every entry early-returns; compaction returns undefined so Pi runs
// its native summary).

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { compactionHook } from "./compaction/hook.js";
import { getMemkeeperSettings, initMemkeeperSettings } from "./config/schema.js";
import { captureInitialPromptIfAbsent, onSessionShutdown, onSessionStart } from "./lifecycle.js";
import { log } from "./log.js";
import { createMkRecallTool } from "./recall/mk-recall.js";
import { makeBuilderRun, makeObserverRun, runBuilder, runObserver } from "./runtime/stages.js";
import { onTurnEnd, setStageRuns } from "./triggers.js";
import { initWidget } from "./widget/tracker.js";

export default function memkeeperExtension(pi: ExtensionAPI): void {
  initMemkeeperSettings(pi);
  const widget = initWidget();

  // The agent's read-only memory drill-down tool. Registered unconditionally
  // (it is read-only and harmless even when memkeeper is disabled — it just
  // reads whatever graph state exists).
  pi.registerTool(createMkRecallTool());

  // Wire the stage run functions (Observer + Builder now; the Selector lands in
  // its own task). Until then the trigger layer's default no-op stands for it.
  setStageRuns({
    runObserver: makeObserverRun(pi, runObserver),
    runBuilder: makeBuilderRun(pi, widget, runBuilder),
    runSelector: async () => {},
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
    // oInitialPrompt (never re-observed). Isolated so a capture failure (a real
    // invariant bug, surfaced via the logger) does not suppress this turn's
    // background trigger — the Observer still runs.
    try {
      captureInitialPromptIfAbsent(ctx, pi);
    } catch (err) {
      log.error("turn_end: initial-prompt capture failed", err);
    }
    // Fire-and-forget the background trigger evaluation (Observer + Builder +
    // Selector); the handler returns immediately and never blocks the agent.
    void onTurnEnd({ ctx, settings });
  });

  pi.on("session_before_compact", (event, ctx) => {
    const settings = getMemkeeperSettings();
    // enabled=false off-path: return undefined so Pi runs its native compaction.
    if (!settings.enabled) return undefined;
    return compactionHook(event, ctx, pi, widget);
  });
}
