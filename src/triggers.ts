// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// STUB (replaced by T9): the real turn_end background-trigger evaluation for all
// three stages (Observer + Builder + Selector) + the Observer frontier live here.
// T7 imports `onTurnEnd` so the `turn_end` hook can delegate to it fire-and-forget;
// until T9 lands this is a no-op. T24 wires the final surface.

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { MemkeeperConfig } from "./config/schema.js";

/** Args handed to `onTurnEnd` from the `turn_end` hook (T9 owns the full contract).
 *  The run-lock is a module singleton (accessed where needed), not passed in. */
export interface TurnEndInput {
  ctx: ExtensionContext;
  settings: MemkeeperConfig;
}

/** STUB (T9 replaces): no-op turn_end evaluation. */
export function onTurnEnd(_input: TurnEndInput): void {
  // T9 implements the real Observer + Builder + Selector trigger evaluation.
}
