// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// The owl_recall registration lifecycle helpers. The tool registers at the
// awaited first session.start when owl is enabled or conflict-paused (the
// state layer's pending gate); a session starting disabled never sees it.
// This module owns the mid-session-enable path: when the enable flips on
// after the start gate passed without the tool, the settings-reload wiring
// calls registerOwlRecallIfNewlyEnabled — once per process (the engine has
// no unregister; a later disable leaves the tool registered and the HANDLER
// rejects instead).
import { isOwlEnabled, wasRecallToolRegistered } from "../state.js";
import { owlRecallToolSpec } from "./spec.js";

/** The registration capsule the wiring binds (a handler-authored closure
 *  spelling `$.tool.register` literally — the scanner's rule). */
export type ToolRegisterCapsule = (spec: {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}) => Promise<unknown>;

let midSessionRegistrationDone = false;

/** Register owl_recall when the session enabled itself after the start gate
 *  passed without the tool (the settings-reload wiring calls this on the
 *  enable flip). Idempotent per process once it succeeds;
 *  a no-op while still disabled (nothing registers early). */
export async function registerOwlRecallIfNewlyEnabled(toolRegister: ToolRegisterCapsule): Promise<void> {
  // the start gate may already have registered the tool (a session starting
  // enabled) — the enable off→on cycle must not issue a second
  // $.tool.register (the engine treats duplicates as an error)
  if (midSessionRegistrationDone || wasRecallToolRegistered() || !isOwlEnabled()) return;
  await toolRegister(owlRecallToolSpec());
  // the once-flag lands only on success — a failed registration stays
  // retryable at the next enable event
  midSessionRegistrationDone = true;
}

/** Test seam: clear the once-per-process mid-session flag. */
export function _resetRecallRegistration(): void {
  midSessionRegistrationDone = false;
}
