// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import { log } from "../../core/src/log.js";
import type { TodoReadyItem } from "../../core/src/snippets/vendored/subscribe-to-todo.js";
//  todo bridge — the defensive consumption path over the vendored
// adapter (core todo/bridge.js). Detection: the plugin.register fingerprint
// (a mod whose statically-declared uses expose an `avtcTodo` noun) or
// $.tool.list() (an `mcp__todo__*` tool). Consumption: the wiring injects a
// LITERAL-SPELLED capsule (avtcTodoGetItems: () => $.avtcTodo.getItems() —
// the scanner forbids `$` crossing call boundaries); an absent noun is a
// plain TypeError that degrades to null — exactly pi's listen-then-null
// pattern (an older/absent bridge yields empty, never an error). The
// $.tool.call fallback reads the list tool the same way.
//
// Noun-only: the native TodoWrite/task tools are observed but not
// wired; an avtc-todo port designs noun-first.
import { makeTodoAdapter, type TodoProxy } from "../../core/src/todo/bridge.js";
import type { TodoBridge, TodoContext } from "../../core/src/todo/types.js";

/** What the wiring injects for noun consumption (the literal-spelled
 *  capsules — data-only, no `$` crosses the boundary). */
export interface TodoNounCapsules {
  avtcTodoGetItems: () => unknown;
}

/** What the wiring injects for the tool-level fallback. */
export interface TodoToolCapsules {
  toolCall: (name: string, args?: unknown) => Promise<unknown>;
}

/** A plugin.register fingerprint payload (the event data shape — `uses` is
 *  the engine's declaration summary: {events, calls} with the
 *  statically-declared noun.method call strings in `uses.calls`). */
export interface PluginFingerprint {
  uses?: { calls?: unknown } | unknown;
}

/** Does the fingerprint expose an avtcTodo noun? (Detection path 1 — the
 *  statically-declared `avtcTodo.*` calls show in uses.calls.) */
export function detectTodoByFingerprint(fp: PluginFingerprint | null): boolean {
  if (fp === null || typeof fp !== "object") return false;
  const uses = (fp as { uses?: { calls?: unknown } }).uses;
  if (typeof uses !== "object" || uses === null) return false;
  const calls = (uses as { calls?: unknown }).calls;
  if (!Array.isArray(calls)) return false;
  return calls.some((u) => typeof u === "string" && u.split(".")[0] === "avtcTodo");
}

/** Does the tool list carry an mcp__todo__* tool? (Detection path 2.) */
export function detectTodoByToolList(tools: readonly unknown[]): boolean {
  return tools.some((t) => typeof t === "string" && t.startsWith("mcp__todo__"));
}

/** The raw bridge item shape (the vendored TodoReadyItem, spelled locally
 *  so this module needs no type-only edge into the snippet file). */
export interface RawTodoItem {
  id: string;
  parentId: string | null;
  name: string;
  details: string;
  status: string;
}

/** Guard + narrow the noun's return: null/array-of-raw only. */
function asRawItems(value: unknown): readonly RawTodoItem[] | null {
  if (!Array.isArray(value)) return null;
  const out: RawTodoItem[] = [];
  for (const v of value) {
    if (typeof v !== "object" || v === null) return null;
    const r = v as Record<string, unknown>;
    if (typeof r.id !== "string" || typeof r.name !== "string" || typeof r.status !== "string") return null;
    out.push({
      id: r.id,
      parentId: typeof r.parentId === "string" ? r.parentId : null,
      name: r.name,
      details: typeof r.details === "string" ? r.details : "",
      status: r.status,
    });
  }
  return out;
}

/** Adapt fetched raw items through the vendored adapter (the mapping:
 *  decomposed→completed, unknown→completed, empty details dropped). */
export function adaptTodoApi(items: readonly RawTodoItem[]): { context: TodoContext; bridge: TodoBridge } {
  const proxy: TodoProxy = {
    getItems: (filter) => {
      const status = filter === null ? null : (filter.status as RawTodoItem["status"] | "completed");
      const filtered =
        status === null
          ? items
          : items.filter((i) => i.status === status || (status === "completed" && i.status === "decomposed"));
      return filtered as unknown as readonly TodoReadyItem[];
    },
  };
  return makeTodoAdapter(proxy);
}

/** Consume the noun defensively: absent (TypeError) or throwing ⇒ null
 *  (pi's listen-then-null degrade); live ⇒ the adapted context + bridge.
 *  The wiring calls this with the literal-spelled capsules. */
export async function makeTodoBridge(
  capsules: TodoNounCapsules,
): Promise<{ context: TodoContext; bridge: TodoBridge } | null> {
  try {
    const raw = await capsules.avtcTodoGetItems();
    const items = asRawItems(raw);
    if (items === null) return null;
    return adaptTodoApi(items);
  } catch (err) {
    log.info(`todo bridge noun read failed — bridge degrades to absent: ${errText(err)}`);
    return null; // absent noun (TypeError) or a failing bridge — degrade
  }
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** The $.tool.call fallback: read the list tool, adapt the same way.
 *  Missing items ⇒ null (not an error). */
export async function toolCallFallback(
  capsules: TodoToolCapsules,
): Promise<{ context: TodoContext; bridge: TodoBridge } | null> {
  try {
    const result = await capsules.toolCall("mcp__todo__list");
    const items = asRawItems((result as { items?: unknown } | null)?.items ?? result);
    if (items === null) return null;
    return adaptTodoApi(items);
  } catch (err) {
    log.info(`todo list tool-call fallback failed — treated as absent: ${errText(err)}`);
    return null;
  }
}
