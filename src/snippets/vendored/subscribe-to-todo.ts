// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// VENDORED COPY — synced verbatim from
// avtc-pi-todo/src/snippets/canonical/subscribe-to-todo.ts. Do not edit here;
// update the canonical source and re-vendor. Vendored (not imported) because
// the no-bundled-extension-imports lint forbids importing avtc-pi-todo as code;
// this snippet is the runtime bridge via the pi-todo:ready event.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** A single todo item, as a read-only shallow copy (parentId normalized to
 *  string | null). Returned by `TodoReadyApi.getItems`. */
export interface TodoReadyItem {
  id: string;
  parentId: string | null;
  name: string;
  details: string;
  status: string;
}

/** Status filter for `getItems`. `"completed"` includes decomposed (folder)
 *  items. */
export type TodoItemsStatus = "pending" | "in_progress" | "completed";

/** API object emitted on the `pi-todo:ready` event. */
export interface TodoReadyApi {
  disableBuiltInFollowUp: () => void;
  getCompletedItemId?: () => string | null;
  getInProgressItem?: () => string | null;
  areAllTodosDone?: () => boolean;
  /** Read-only full list getter. `null` returns all items; a status filter
   *  narrows by status (completed includes decomposed). May be absent on older
   *  bridges — the proxy returns `[]` then. */
  getItems?: (filter: { status: TodoItemsStatus } | null) => readonly TodoReadyItem[];
}

/**
 * Subscribe to pi-todo:ready and register hooks.
 * Reload-safe: session_shutdown fires before reload, cleaning all listeners.
 * Copy this file into your consumer's src/snippets/vendored/ directory verbatim — no changes needed.
 *
 * Returns sync lazy proxy — getCompletedItemId, getInProgressItem, areAllTodosDone and getItems delegate to
 * internal _api ref populated when :ready fires at session_start.
 * disableBuiltInFollowUp is passed as a boolean flag, applied inside :ready handler.
 * No pending queue needed — the flag is evaluated when _api is available.
 * Before :ready fires (or when the bridge is absent/older): getItems returns [], getCompletedItemId/getInProgressItem
 * return null, areAllTodosDone returns true (safe defaults — graceful degrade).
 */
export function subscribeToTodo(
  pi: ExtensionAPI,
  disableBuiltInFollowUp: boolean,
): {
  getCompletedItemId(): string | null;
  getInProgressItem(): string | null;
  areAllTodosDone(): boolean;
  getItems(filter: { status: TodoItemsStatus } | null): readonly TodoReadyItem[];
} {
  const unsubs: Array<() => void> = [];

  // Internal API ref — populated when :ready fires
  let _api: TodoReadyApi | null = null;

  // On session_shutdown (fires before reload): clean pi.events.on listeners
  pi.on("session_shutdown", () => {
    for (const unsub of unsubs) unsub();
    unsubs.length = 0;
  });

  // Register :ready listener
  unsubs.push(
    pi.events.on("pi-todo:ready", (api: unknown) => {
      _api = api as TodoReadyApi;
      if (disableBuiltInFollowUp) _api.disableBuiltInFollowUp();
    }),
  );

  // Return sync lazy proxy — methods delegate to _api when available
  return {
    getCompletedItemId(): string | null {
      return _api?.getCompletedItemId?.() ?? null;
    },
    getInProgressItem(): string | null {
      return _api?.getInProgressItem?.() ?? null;
    },
    areAllTodosDone(): boolean {
      return _api?.areAllTodosDone?.() ?? true;
    },
    getItems(filter: { status: TodoItemsStatus } | null): readonly TodoReadyItem[] {
      return _api?.getItems?.(filter) ?? [];
    },
  };
}
