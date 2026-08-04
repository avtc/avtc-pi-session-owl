// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

/** A todo item shape used across the todo bridge and its consumers (the
 *  Selector input-view render + the Selector `todo_list` tool). */
export interface TodoItem {
  id: string;
  name: string;
  status: "in_progress" | "pending" | "completed";
  details?: string;
}

/** Port over the (optional) avtc-pi-todo bridge. `null`/undefined bridge → no
 *  todo context (graceful degrade; not an error). */
export interface TodoContext {
  getInProgress: () => TodoItem | null;
  getPending: () => TodoItem[];
}

/** The Selector's read-only todo access: a full-list getter (filterable by
 *  status) backing the `todo_list` drill-down tool. Absent when avtc-pi-todo
 *  is not installed. */
export interface TodoBridge {
  getItems(filter?: { status?: TodoItem["status"] }): TodoItem[];
}
