// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { subscribeToTodo } from "../snippets/vendored/subscribe-to-todo.js";
import { makeTodoAdapter } from "./bridge.js";
import type { TodoBridge, TodoContext } from "./types.js";

/** `disableBuiltInFollowUp = false` — memkeeper does not manage todo's followUp
 *  message (named constant for the no-bare-literals rule). */
const FOLLOWUP_NOT_DISABLED = false;

/** Optional avtc-pi-todo wiring. `getContext`/`getBridge` return null until
 *  `pi-todo:ready` fires (i.e. avtc-pi-todo is installed and activated), and a
 *  live {@link TodoContext}/{@link TodoBridge} afterward. Null = omit the todo
 *  section / tool entirely (graceful degrade — not an error). */
export interface TodoWiring {
  getContext(): TodoContext | null;
  getBridge(): TodoBridge | null;
}

/** Subscribe to the optional avtc-pi-todo companion and expose its todo context
 *  + bridge lazily. The vendored snippet handles its own `pi-todo:ready` listener
 *  + reload-safe `session_shutdown` cleanup; this adds a readiness flag (a SECOND
 *  `pi-todo:ready` listener on the shared eventBus) so callers can tell "not
 *  installed" (null) from "installed but empty" (non-null context). That extra
 *  listener is unregistered on `session_shutdown` too — both the snippet and
 *  this wiring clean up, so no listener leaks across reloads (Pi's eventBus
 *  persists across reload; `pi.on` per-extension handlers do not, but `pi.events`
 *  does, so explicit cleanup is required). */
export function createTodoWiring(pi: ExtensionAPI): TodoWiring {
  const proxy = subscribeToTodo(pi, FOLLOWUP_NOT_DISABLED);
  const adapter = makeTodoAdapter(proxy);
  let installed = false;
  const offReady = pi.events.on("pi-todo:ready", () => {
    installed = true;
  });
  pi.on("session_shutdown", () => {
    offReady();
  });
  return {
    getContext: () => (installed ? adapter.context : null),
    getBridge: () => (installed ? adapter.bridge : null),
  };
}
