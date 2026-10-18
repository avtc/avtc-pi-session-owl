// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import type { TodoItemsStatus, TodoReadyItem } from "../snippets/vendored/subscribe-to-todo.js";
import type { TodoBridge, TodoContext, TodoItem } from "./types.js";

/** The subset of the vendored `subscribeToTodo` proxy the adapter consumes —
 *  just `getItems` (the read-only full-list getter). The proxy's other methods
 *  (getInProgressItem string, areAllTodosDone, getCompletedItemId) serve the
 *  followUp/compact path, not the Selector's todo context. */
export interface TodoProxy {
  getItems(filter: { status: TodoItemsStatus } | null): readonly TodoReadyItem[];
}

/** No status filter — return all items. Passed explicitly (no optional param on
 *  the vendored proxy's getItems, which takes `{status} | null`). */
const NO_FILTER = null;

/** Known session-owl statuses (the union). The vendored proxy's `status` is a
 *  bare `string` (cross-extension data), so mapTodoItem guards it at this trust
 *  boundary rather than casting blindly. */
const KNOWN_STATUSES = new Set<TodoItem["status"]>(["pending", "in_progress", "completed"]);

/** Status a `decomposed` (folder) item maps to — a terminal/done state,
 *  surfaced as `completed`. This is also the fallback for any UNKNOWN status
 *  the bridge may emit in the future (terminal is the least misleading — never
 *  surfaces as active/pending work). */
const TERMINAL_STATUS: TodoItem["status"] = "completed";

/** Map a raw bridge item (string status, includes `decomposed`, details always
 *  a string) to session-owl's `TodoItem` (literal status union, details optional).
 *  Drops `parentId` (not part of the Selector's todo view). Guards the status at
 *  the cross-extension boundary: decomposed → completed; unknown → completed. */
export function mapTodoItem(raw: TodoReadyItem): TodoItem {
  const status: TodoItem["status"] =
    raw.status === "decomposed" || !KNOWN_STATUSES.has(raw.status as TodoItem["status"])
      ? TERMINAL_STATUS
      : (raw.status as TodoItem["status"]);
  const details = raw.details.length === 0 ? undefined : raw.details;
  return { id: raw.id, name: raw.name, status, details };
}

/** A read adapter over the vendored todo proxy: derives the Selector's
 *  `TodoContext` (in-progress + pending, rendered in the input-view) and
 *  `TodoBridge` (full list with optional status filter, powers the todo_list
 *  tool) from the single `getItems` getter. All reads delegate lazily to the
 *  proxy, so an absent/older bridge (no getItems) yields empty lists — graceful
 *  degrade, not an error. */
export function makeTodoAdapter(proxy: TodoProxy): { context: TodoContext; bridge: TodoBridge } {
  const list = (status: TodoItemsStatus): TodoItem[] => proxy.getItems({ status }).map(mapTodoItem);

  const context: TodoContext = {
    getInProgress: () => {
      const items = list("in_progress");
      return items.length === 0 ? null : (items[0] ?? null);
    },
    getPending: () => list("pending"),
  };

  const bridge: TodoBridge = {
    getItems: (filter) => {
      if (filter === undefined || filter.status === undefined) {
        return proxy.getItems(NO_FILTER).map(mapTodoItem);
      }
      return proxy.getItems({ status: filter.status }).map(mapTodoItem);
    },
  };

  return { context, bridge };
}
