// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import type { LedgerWriter } from "../storage/ledger.js";
// The turn.complete flush: mirror flush scoped to the loop + the CHECK-record
// append point (the clean-check mark that makes the blind-window quarantine
// evaluable at any process start). The mid-turn split guard lives inside the
// mirror's flush (roll margin); this module sequences flush -> CHECK.
import type { MirrorWriter } from "../storage/mirror.js";

export interface FlushResult {
  /** Mirror batch files written this turn (empty when nothing buffered). */
  files: string[];
  /** The CHECK record's ledger id (the turn boundary mark); null when this
   *  flush skipped the boundary record (an unverified turn). */
  checkId: string | null;
}

/**
 * Flush one loop's turn: mirror first (rows durable), then the CHECK record
 * (the mark lands after the rows it covers — quarantine boundaries stay
 * sound even if the process dies between the two writes: unmarked rows are
 * simply the widened window).
 */
export async function flushTurn(
  mirror: MirrorWriter,
  ledger: LedgerWriter,
  tipUuid: string | null,
  opts: { check?: boolean } = {},
): Promise<FlushResult> {
  const files = await mirror.flush();
  // `check: false` skips the boundary record — a turn whose rewind check
  // skipped (api form unavailable, tripwires silent) or errored must not
  // advance the quarantine boundary over its unverified rows.
  let checkId: string | null = null;
  if (opts.check !== false) {
    checkId = ledger.append("CHECK", null, tipUuid ?? "seed");
  }
  await ledger.flush();
  return { files, checkId };
}
