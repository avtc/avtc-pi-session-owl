// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// The sessionOwl noun: the engine.create fold. `$` at engine.create is the
// EMPTY table — the noun's closures capture module state, never `$` (the
// empty-table rule); engine calls they make go through the bridge at
// dispatch time. This is the cross-mod seam other plugins read
// ($.state["session-owl"].sessionOwl) and the settings-ui/logger family's
// integration point. Every method answers LIVE state: the settings read is
// the vendored config entry point (handle-or-defaults, env-first reload),
// the pause predicate is the conflicts module's.
import { getSessionOwlSettings, reloadSessionOwlConfig } from "../core/src/config/schema.js";
import { isConflictPaused } from "./conflicts/pause.js";
import { getCurrentSession, isOwlEnabled, isOwlIgnoreConflicts } from "./state.js";

export async function reloadConfig(): Promise<Record<string, unknown>> {
  // env-first, then files — refreshes the in-memory cache (the live
  // reconfigure path a bench consumer drives); no-op before init
  reloadSessionOwlConfig();
  return getConfig();
}

export async function getConfig(): Promise<Record<string, unknown>> {
  return { ...getSessionOwlSettings() } as unknown as Record<string, unknown>;
}

export async function getConflictPause(): Promise<boolean> {
  return isConflictPaused(() => ({ enabled: isOwlEnabled(), ignoreConflicts: isOwlIgnoreConflicts() }));
}

/** The noun surface folded into the built engine (SessionOwlReadyApi). */
export function sessionOwlNoun(): {
  reloadConfig: () => Promise<Record<string, unknown>>;
  getConfig: () => Promise<Record<string, unknown>>;
  getConflictPause: () => Promise<boolean>;
} {
  return { reloadConfig, getConfig, getConflictPause };
}

/** Which conversation the noun currently serves (diagnostics). */
export function nounSession(): string | null {
  return getCurrentSession();
}
