// Type-only stand-in for the todo-bridge snippet the vendored core imports.
// src/todo/bridge.ts (vendored) type-imports ../snippets/vendored/subscribe-to-todo.js;
// the snippet itself is host territory and never vendored, so this declaration
// file supplies exactly the two types the core uses, copied from the snippet.
// Declared here (not via ambient module declarations) because a relative
// specifier cannot be declared ambient — it must resolve to a file on disk.
// claude-sync ignores .d.ts files when checking vendored membership.
export type TodoItemsStatus = "pending" | "in_progress" | "completed";

export interface TodoReadyItem {
  id: string;
  parentId: string | null;
  name: string;
  details: string;
  status: string;
}
