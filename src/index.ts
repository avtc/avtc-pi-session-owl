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
import { onTurnEnd } from "./triggers.js";
import { initWidget } from "./widget/tracker.js";

export default function memkeeperExtension(pi: ExtensionAPI): void {
  initMemkeeperSettings(pi);
  const widget = initWidget();

  pi.on("session_start", (event, ctx) => onSessionStart(event, ctx, pi, widget));
  pi.on("session_shutdown", (_event, _ctx) => onSessionShutdown(_event, widget));

  pi.on("turn_end", (_event, ctx) => {
    const settings = getMemkeeperSettings();
    // enabled=false off-path: no work, no capture, no background run.
    if (!settings.enabled) return;
    // Capture the verbatim initial user message (mechanical, ahead of the
    // Observer frontier so it is never re-observed).
    captureInitialPromptIfAbsent(ctx, pi);
    // Fire-and-forget the background trigger evaluation (Observer + Builder +
    // Selector); the handler returns immediately and never blocks the agent.
    void onTurnEnd({ ctx, settings });
  });

  pi.on("session_before_compact", (event, ctx) => {
    const settings = getMemkeeperSettings();
    // enabled=false off-path: return undefined so Pi runs its native compaction.
    if (!settings.enabled) return undefined;
    return compactionHook(event, ctx, pi);
  });
}
