// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import { log } from "../../core/src/log.js";
/** Error → log text with the stack preserved (never a silent catch; the
 *  log must carry the stack when one exists).
 *
 *  - an Error WITH a stack: the stack alone when it already contains the
 *    message (the normal V8 shape — "Error: <message>\n    at …"), else
 *    message + stack (a stack that lost its header line still shows both);
 *  - an Error without a stack: the message;
 *  - anything else: String(value) — all a non-Error throw carries.
 *
 * errDetail is pure and import-free; sayError (below) carries the two
 * logger imports. */
import { currentServices } from "../engine-bridge.js";

export function errDetail(err: unknown): string {
  if (err instanceof Error) {
    const stack = typeof err.stack === "string" ? err.stack : "";
    if (stack !== "") return stack.includes(err.message) ? stack : `${err.message}\n${stack}`;
    return err.message;
  }
  return String(err);
}

/** Attach a rejection logger to a fire-and-forget promise (a floating
 *  promise that rejects must LAND IN THE LOG with its
 *  stack — the engine's own "mod .catch" warning is transient and names
 *  nothing; this keeps the evidence in 0.log). Returns the promise unchanged
 *  (the caller that DOES await still gets the rejection; the one that does
 *  not has already been said). File log only — these are internal
 *  diagnostics, not user-facing errors (sayError is that transport). */
export function guarded<T>(p: Promise<T>, label: string): Promise<T> {
  p.catch((err: unknown) => {
    try {
      log.warn(`unhandled rejection (${label}): ${errDetail(err)}`);
    } catch {
      // the pre-init stub drops the record — nothing else exists pre-init
    }
  });
  return p;
}

/** Say an ERROR so it cannot be missed:
 *  the FILE logger (best effort — its pre-init stub drops the record, the
 *  ui copy below still carries it) AND the ENGINE's own transport
 *  ($.ui.log — a dim transcript row the USER sees; the engine's debug log
 *  gets it either way), never duplicated on the console. The console is
 *  strictly the last resort for the module-load/pre-arm window where
 *  neither channel exists — console.error there is invisible to everyone
 *  who is not attached to a terminal.
 *
 *  Order: file log (no throw — the library drops pre-init) → ui.log
 *  (return on success) → console.error (only when the ui capsule refused). */
export function sayError(text: string, opts?: { uiText?: string }): void {
  // The ui copy may drop the caller's manual "session-owl: " prefix: the
  // engine's own row attribution already names the plugin — no double
  // prefix. The FILE copy always keeps the full text.
  const uiText = opts?.uiText ?? text;
  try {
    log.warn(text);
  } catch {
    // the library's best-effort contract drops records pre-init — the ui
    // copy below is the carrier then
  }
  try {
    currentServices().uiLog(uiText);
    return;
  } catch {
    // no armed bridge (module-load / pre-arm window)
  }
  try {
    console.error(uiText);
  } catch {
    // no console in this sandbox — nothing exists to say it with
  }
}
