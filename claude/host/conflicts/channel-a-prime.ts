// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// Channel A-prime — the fold-list unrooted determination.
// owl snapshots e.plugins at its engine.create step (the COMPLETE module
// list of the load in chain order — mods that loaded before owl are
// invisible to plugin.register). At the awaited first session.start, after
// loads settle, any entry not self, not rooted via Channel A and not
// witnessed via Channel B is unrooted: fail-safe conservative hit with the
// name. Escape is ignoreConflicts (dev-mode co-runs).

import type { ConflictHit } from "./scan.js";

let foldList: string[] | null = null;
const bWitnesses = new Set<string>();

/** Snapshot the engine.create fold list (module names, chain order). */
export function recordFoldList(names: string[]): void {
  foldList = [...names];
}

/** Channel B marks a name as witnessed (its plugin.register envelope seen). */
export function recordBWitness(name: string): void {
  bWitnesses.add(name);
}

/** The recorded fold snapshot (tests + the A-prime twin read it). */
export function getFoldList(): string[] | null {
  return foldList === null ? null : [...foldList];
}

/** Test seam: clear the per-process snapshot + witnesses. */
export function resetFoldState(): void {
  foldList = null;
  bWitnesses.clear();
}

/** A bare fold name ("evil") roots any registry key whose plugin name
 *  matches ("evil@market") — the market suffix is not part of the fold
 *  entry. */
function rootsAny(name: string, rootedNames: readonly string[]): boolean {
  return rootedNames.some((key) => key === name || key.startsWith(`${name}@`));
}

/**
 * The unrooted determination (awaited first session.start): every fold
 * entry BEFORE owl in the chain that is neither self, nor family, nor
 * Channel-A-rooted, nor Channel-B-witnessed fails safe — a conservative
 * hit that pauses with the name. Entries AFTER owl are exempt: the fold
 * list is first-outermost, so they sit INNER of owl and can never override
 * its answers — on a stock install that region is the engine's own
 * builtins (cc-plugin-*), whose plugin.register envelopes never reach a
 * user-tier listener (kickoff cell 7) and which the installs-only registry
 * can never root (cell 12) — without this exemption owl would self-pause
 * on every stock machine. If owl itself is absent from the list
 * (degenerate), the full scan runs (fail safe).
 */
export function determineUnrooted(opts: {
  selfName: string;
  familyPrefix: string;
  rootedNames: readonly string[];
}): ConflictHit[] {
  const list = foldList ?? [];
  const selfIndex = list.indexOf(opts.selfName);
  const hits: ConflictHit[] = [];
  for (let i = 0; i < list.length; i += 1) {
    const name = list[i] as string;
    // inner-of-owl entries are not conflict candidates (see above)
    if (selfIndex >= 0 && i > selfIndex) continue;
    if (name === opts.selfName) continue;
    if (name.toLowerCase().includes(opts.familyPrefix.toLowerCase())) continue;
    if (bWitnesses.has(name)) continue;
    if (rootsAny(name, opts.rootedNames)) continue;
    hits.push({ channel: "A-prime", name, evidence: "unrooted" });
  }
  return hits;
}
