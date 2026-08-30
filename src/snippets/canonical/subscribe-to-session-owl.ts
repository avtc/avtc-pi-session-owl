// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** API object emitted on the `session-owl:ready` event. Lets a host reconfigure
 *  session-owl LIVE (reload the in-memory settings cache from PI_SETTINGS_SESSION_OWL
 *  env / files) without `ctx.reload()` (which would invalidate the command ctx).
 *  `getConfig` may be absent on older bridges — the proxy returns null then. */
export interface SessionOwlReadyApi {
  /** Re-read settings from env (PI_SETTINGS_SESSION_OWL) first, then files —
   *  refreshes the in-memory cache. */
  reloadConfig: () => void;
  /** Read the current effective config (snapshot). May be absent on older
   *  bridges — the proxy returns null then. */
  getConfig?: () => unknown;
  /** The ACTIVE conflict pause (what paused session-owl + why), or null when
   *  session-owl is live (no conflicts, or ignoreConflicts opted in). May be
   *  absent on older bridges — the proxy returns null then (indistinguishable
   *  from "not paused"). */
  getConflictPause?: () => Array<{ entry: string; matched: string }> | null;
}

/**
 * Subscribe to session-owl:ready and expose its reloadConfig/getConfig lazily.
 *
 * Reload-safe: session_shutdown fires before reload, cleaning all listeners.
 * Copy this file into your consumer's src/snippets/vendored/ directory verbatim — no changes needed.
 *
 * Returns a sync lazy proxy — reloadConfig + getConfig delegate to an internal
 * `_api` ref populated when :ready fires at session_start.
 * Before :ready fires (or when the bridge is absent/older): reloadConfig is a
 * no-op and getConfig returns null (safe defaults — graceful degrade).
 */
export function subscribeToSessionOwl(pi: ExtensionAPI): {
  reloadConfig(): void;
  getConfig(): unknown;
  getConflictPause(): Array<{ entry: string; matched: string }> | null;
} {
  const unsubs: Array<() => void> = [];

  // Internal API ref — populated when :ready fires
  let _api: SessionOwlReadyApi | null = null;

  // On session_shutdown (fires before reload): clean pi.events.on listeners
  pi.on("session_shutdown", () => {
    for (const unsub of unsubs) unsub();
    unsubs.length = 0;
  });

  // Register :ready listener
  unsubs.push(
    pi.events.on("session-owl:ready", (api: unknown) => {
      _api = api as SessionOwlReadyApi;
    }),
  );

  // Return sync lazy proxy — methods delegate to _api when available
  return {
    reloadConfig(): void {
      _api?.reloadConfig?.();
    },
    getConfig(): unknown {
      return _api?.getConfig?.() ?? null;
    },
    getConflictPause(): Array<{ entry: string; matched: string }> | null {
      return _api?.getConflictPause?.() ?? null;
    },
  };
}
