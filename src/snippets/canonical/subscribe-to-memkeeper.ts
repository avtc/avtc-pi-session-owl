// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** API object emitted on the `memkeeper:ready` event. Lets a host reconfigure
 *  memkeeper LIVE (reload the in-memory settings cache from PI_SETTINGS_MEMKEEPER
 *  env / files) without `ctx.reload()` (which would invalidate the command ctx).
 *  `getConfig` may be absent on older bridges — the proxy returns null then. */
export interface MemkeeperReadyApi {
  /** Re-read settings from env (PI_SETTINGS_MEMKEEPER) first, then files —
   *  refreshes the in-memory cache. */
  reloadConfig: () => void;
  /** Read the current effective config (snapshot). May be absent on older
   *  bridges — the proxy returns null then. */
  getConfig?: () => unknown;
}

/**
 * Subscribe to memkeeper:ready and expose its reloadConfig/getConfig lazily.
 *
 * Reload-safe: session_shutdown fires before reload, cleaning all listeners.
 * Copy this file into your consumer's src/snippets/vendored/ directory verbatim — no changes needed.
 *
 * Returns a sync lazy proxy — reloadConfig + getConfig delegate to an internal
 * `_api` ref populated when :ready fires at session_start.
 * Before :ready fires (or when the bridge is absent/older): reloadConfig is a
 * no-op and getConfig returns null (safe defaults — graceful degrade).
 */
export function subscribeToMemkeeper(pi: ExtensionAPI): {
  reloadConfig(): void;
  getConfig(): unknown;
} {
  const unsubs: Array<() => void> = [];

  // Internal API ref — populated when :ready fires
  let _api: MemkeeperReadyApi | null = null;

  // On session_shutdown (fires before reload): clean pi.events.on listeners
  pi.on("session_shutdown", () => {
    for (const unsub of unsubs) unsub();
    unsubs.length = 0;
  });

  // Register :ready listener
  unsubs.push(
    pi.events.on("memkeeper:ready", (api: unknown) => {
      _api = api as MemkeeperReadyApi;
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
  };
}
