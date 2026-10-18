// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// The conflict activation orchestrator: runs once at the
// awaited first session.start — Channel A's disk enumeration, Channel
// A-prime's unrooted determination over the engine.create fold snapshot —
// and merges everything with Channel B's live per-wave hits into the pause
// module's recorded set. The log ladder is pi's: conflicts + disabled ⇒
// silent (off by choice is not a pause); conflicts + pause ⇒ the pause
// line; conflicts + ignoreConflicts ⇒ the deliberate-co-run line.
// Closure-safe: imports only the conflicts modules (data-only).

import { type ChannelAIo, type ConflictAdvisory, runChannelA } from "./channel-a.js";

export type { ChannelAIo } from "./channel-a.js";

import { determineUnrooted } from "./channel-a-prime.js";
import { getLiveBAdvisories, getLiveBHits } from "./channel-b.js";
import { setConflictHits } from "./pause.js";
import type { ConflictHit } from "./scan.js";

/** What the activation decided (the wiring logs from this). */
export interface ActivationOutcome {
  hits: ConflictHit[];
  advisories: ConflictAdvisory[];
  log: "none" | "pause" | "ignore-conflicts";
}

/** Run the activation: Channel A + A-prime + the live B merge. The io comes
 *  from the $-capsule bridge; the self/family identity from the manifest. */
export async function runConflictActivation(
  io: ChannelAIo,
  opts: { selfName: string; selfRoot: string; familyPrefix: string; enabled: boolean; ignoreConflicts: boolean },
): Promise<ActivationOutcome> {
  const a = await runChannelA({
    io,
    selfName: opts.selfName,
    selfRoot: opts.selfRoot,
    familyPrefix: opts.familyPrefix,
  });
  const aPrime = determineUnrooted({
    selfName: opts.selfName,
    familyPrefix: opts.familyPrefix,
    rootedNames: a.rootedNames,
  });
  const hits = [...a.hits, ...aPrime, ...getLiveBHits()];
  const advisories = [...a.advisories, ...getLiveBAdvisories()];
  staticHits = [...a.hits, ...aPrime];
  setConflictHits(hits, advisories);

  let log: ActivationOutcome["log"] = "none";
  if (hits.length > 0 && !opts.enabled) {
    // Detect + record only — enabled=false is the operator's explicit
    // choice; a conflict warning would claim a pause that is not why
    // session-owl is off.
    log = "none";
  } else if (hits.length > 0 && !opts.ignoreConflicts) {
    log = "pause";
  } else if (hits.length > 0) {
    log = "ignore-conflicts";
  }
  return { hits, advisories, log };
}

/** The activation's static result (Channel A + A-prime), kept for the live
 *  recompute Channel B triggers on every new envelope hit. */
let staticHits: ConflictHit[] = [];

/** Test seam: seed the static (Channel A) set the way the activation
 *  would — recomputePauseSet merges from it, so a bypassing setConflictHits
 *  call would be wiped by the next recompute. */
export function _setStaticHitsForTest(hits: ConflictHit[]): void {
  staticHits = hits;
}

/** Recompute the effective hit set after a live Channel B change (a new
 *  envelope hit mid-session — "pause immediately, strictly before that mod
 *  can touch any compaction"): the static set merges with the live one. */
export function recomputePauseSet(): void {
  setConflictHits([...staticHits, ...getLiveBHits()]);
}

/** Test seam: none needed (state lives in the pause module). */
