// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// The command registrar arm: the table of the eight `/owl-*` commands
// (pi's `/owl:*` names kebab-cased — the platform refuses colons; pi's
// descriptions verbatim with the name swapped in) and the command.run
// dispatcher. The handler answers OUR commands with `{}` (H3 — nothing
// model-visible; the user surface is the notify adapter's ui.log lines) and
// returns null for foreign names so the wiring passes them through to the
// engine untouched.
import { COMMAND_SPECS } from "../state.js";
import type { OwlCommandDeps } from "./handlers.js";
import {
  runOwlCat,
  runOwlFind,
  runOwlFindAll,
  runOwlLs,
  runOwlReobserve,
  runOwlRescan,
  runOwlSettings,
  runOwlStatus,
} from "./handlers.js";

/** One registered command: the kebab name, pi's description, the body. */
export interface OwlCommandSpec {
  name: string;
  description: string;
  handler: (args: string, deps: OwlCommandDeps) => Promise<void>;
}

/** The handlers by kebab name (the dispatch half of the table). */
const HANDLERS: Record<string, (args: string, deps: OwlCommandDeps) => Promise<void>> = {
  "owl-ls": runOwlLs,
  "owl-cat": runOwlCat,
  "owl-find": runOwlFind,
  "owl-find-all": runOwlFindAll,
  "owl-rescan": runOwlRescan,
  "owl-reobserve-0-obs-chunks": runOwlReobserve,
  "owl-status": runOwlStatus,
  "owl-settings": runOwlSettings,
};

/** The eight commands (pi's registerUserCommands + registerStatusCommand +
 * the settings pane's registration, kebab-renamed). The names AND
 * descriptions come from state's COMMAND_SPECS — the registration data the
 * engine loads — so the dispatch table can never drift from what
 * registered (a missing or renamed entry fails the join loudly). */
export const OWL_COMMANDS: OwlCommandSpec[] = COMMAND_SPECS.map((spec) => ({
  name: spec.name,
  description: spec.description,
  handler: HANDLERS[spec.name],
}));
// The loud join: a registered command without a handler entry fails at
// MODULE INIT (not deferred to the user typing it) — the map's undefined
// would otherwise surface only at dispatch time.
for (const spec of COMMAND_SPECS) {
  if (HANDLERS[spec.name] === undefined) {
    throw new Error(`commands: no handler bound for registered command '${spec.name}'`);
  }
}

/** Resolve one command by its exact kebab name. */
export function owlCommandByName(name: string): OwlCommandSpec | undefined {
  return OWL_COMMANDS.find((c) => c.name === name);
}

/** The command.run dispatch: our command ⇒ run its body over the deps and
 *  answer `{}` (H3 — no text, no context, nothing model-visible; the user
 *  saw the notify lines); a foreign command ⇒ null (the caller passes it
 *  through to the engine). */
export async function dispatchOwlCommand(
  e: { command: string; args?: string },
  deps: OwlCommandDeps,
): Promise<Record<string, never> | null> {
  const spec = owlCommandByName(e.command);
  if (spec === undefined) return null;
  await spec.handler(e.args ?? "", deps);
  return {};
}
