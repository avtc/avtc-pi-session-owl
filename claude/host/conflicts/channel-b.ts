// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// Channel B — the live plugin.register envelope listener.
// owl witnesses every later tier load, mid-session enable and hot reload
// through this channel: session.compact matched against the envelope's
// uses.events AS PATTERNS (the literal, "session.*" and "*" are
// affirmative; "classic.*" patterns are NOT — the classic PreCompact hook
// is a different seam and gets an advisory only; negated patterns are not
// affirmative), then the bounded scan over the envelope's root separates
// overriders from passive registrants. builtin tier entries are skipped
// (inner of user-tier owl — they can never conflict). A hit pauses
// immediately, strictly before that mod can touch any compaction.

import { log } from "../../core/src/log.js";
import type { ConflictAdvisory } from "./channel-a.js";
import { type ConflictHit, type ScanIo, scansCompactOverride } from "./scan.js";

/** The plugin.register envelope, narrowed to the fields Channel B reads. */
export interface Envelope {
  name: string;
  tier: string;
  root: string;
  events: string[];
}

/** Match session.compact against uses.events as patterns. */
export function envelopeCompactMatch(events: readonly string[]): { compact: boolean; classicOnly: boolean } {
  let compact = false;
  let classicOnly = false;
  for (const pattern of events) {
    if (pattern.startsWith("!")) continue; // negated patterns are not affirmative
    if (pattern === "session.compact" || pattern === "session.*" || pattern === "*") compact = true;
    else if (pattern.startsWith("classic.")) classicOnly = true;
  }
  return { compact, classicOnly };
}

export interface EnvelopeResult {
  /** An overriding registrant: pause immediately. */
  hit: ConflictHit | null;
  /** A classic-only registrant: advisory log line, no pause. */
  advisory: ConflictAdvisory | null;
  /** Every witnessed name (feeds Channel A-prime's rootedness set). */
  witness: string;
}

/** Handle one plugin.register envelope: witness the name, decide. */
export async function handlePluginRegisterEnvelope(
  envelope: Envelope,
  io: ScanIo,
  opts: { selfName: string; familyPrefix: string },
): Promise<EnvelopeResult> {
  const { name, tier, root, events } = envelope;
  const witness = name;

  if (name === opts.selfName || name.toLowerCase().includes(opts.familyPrefix.toLowerCase())) {
    return { hit: null, advisory: null, witness };
  }
  if (tier === "builtin") {
    // inner of user-tier owl — can never override; witnessed for A-prime.
    return { hit: null, advisory: null, witness };
  }

  const match = envelopeCompactMatch(events);
  if (!match.compact) {
    if (match.classicOnly) {
      return { hit: null, advisory: { name, evidence: "classic.*", reason: "classic-only" }, witness };
    }
    return { hit: null, advisory: null, witness };
  }

  function errText(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
  }

  // affirmative: separate overriders from passive registrants by source
  try {
    await io.list(root);
  } catch (err) {
    log.info(`conflict scan B: root unscannable (${name}): ${errText(err)}`);
    return { hit: { channel: "B", name, evidence: "unscannable" }, advisory: null, witness };
  }
  if (await scansCompactOverride(root, io)) {
    return { hit: { channel: "B", name, evidence: "session.compact" }, advisory: null, witness };
  }
  return { hit: null, advisory: null, witness };
}

// ---- the live per-wave hit set -------------------------------------------------------
//
// engine.create refires on any reload when a module hooks it (owl does), so
// every reload wave re-fires each remaining mod's plugin.register envelope
// through the listener: reset the live set at engine.create, repopulate per
// envelope, and the effective hits recompute (the pause auto-recovers on
// reload — a strict improvement over pi's next-start recovery).

let liveHits: ConflictHit[] = [];
let liveAdvisories: ConflictAdvisory[] = [];

/** Wave reset (engine.create): the envelopes that follow repopulate. */
export function resetWaveLiveHits(): void {
  liveHits = [];
  liveAdvisories = [];
}

/** Record one envelope's live outcome (hit or advisory). */
export function recordLiveOutcome(hit: ConflictHit | null, advisory: ConflictAdvisory | null): void {
  if (hit !== null && !liveHits.some((h) => h.name === hit.name && h.channel === hit.channel)) {
    liveHits.push(hit);
  }
  if (advisory !== null && !liveAdvisories.some((a) => a.name === advisory.name)) {
    liveAdvisories.push(advisory);
  }
}

/** The live per-wave hits (merged with Channel A's static set by the pause
 *  recompute). */
export function getLiveBHits(): ConflictHit[] {
  return [...liveHits];
}

/** The live per-wave advisories. */
export function getLiveBAdvisories(): ConflictAdvisory[] {
  return [...liveAdvisories];
}
