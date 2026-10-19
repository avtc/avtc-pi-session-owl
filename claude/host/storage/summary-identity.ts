// SPDX-License-Identifier: MIT
// SPDXFileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// The own-summary identity, port-side: owl's answered compaction summaries
// are recorded as ledger records (kind "summary", the exact rendered text)
// and held per conversation store. A summary row the engine re-serves as a
// plain user row is owl's own exactly when its normalized text matches one
// of the recorded texts — native and foreign-mod summaries never match, and
// neither does user text that merely opens like a summary.

import { RESCAN_MODE_REUSE, RESCAN_TYPE } from "../../core/src/store/codecs.js";
import type { GraphStore, StoreEntry } from "../../core/src/store/graph-store.js";

/** The ledger kind / branch custom type of an own-summary record. */
export const SUMMARY_RECORD_TYPE = "session-owl.summary";

/** The comparison form of a summary text: recorded and candidate texts both
 *  reduce through this before matching (whitespace-stable identity). */
export function normalizeSummaryText(text: string): string {
  return text.trim();
}

/** The live per-store sets (a store drops out with its resident state — the
 *  registry holds no keys and never outlives the stores it describes). */
const summariesByStore = new WeakMap<GraphStore, Set<string>>();

/** Hold one more own-summary text on a conversation store. */
export function noteOwnSummary(store: GraphStore, text: string): void {
  const set = summariesByStore.get(store) ?? new Set<string>();
  set.add(normalizeSummaryText(text));
  summariesByStore.set(store, set);
}

/** Replace a store's own-summary set wholesale (load re-derivation, rescan
 *  reset). */
export function setOwnSummaries(store: GraphStore, texts: Iterable<string>): void {
  const set = new Set<string>();
  for (const text of texts) set.add(normalizeSummaryText(text));
  summariesByStore.set(store, set);
}

/** A store's recorded own-summary texts (empty until any is recorded). */
export function ownSummariesFor(store: GraphStore): ReadonlySet<string> {
  return summariesByStore.get(store) ?? EMPTY;
}

const EMPTY: ReadonlySet<string> = new Set<string>();

/** Derive the own-summary texts from a branch's interleaved entries: the
 *  texts of summary entries positioned after the latest PLAIN rescan marker
 *  (a plain rescan re-observes the full live path; a reuse-mode marker
 *  keeps them). */
export function collectOwnSummariesFromBranch(entries: readonly StoreEntry[]): string[] {
  let plainRescanAt = -1;
  for (let i = 0; i < entries.length; i += 1) {
    const e = entries[i];
    if (e.type !== "custom" || e.customType !== RESCAN_TYPE) continue;
    const mode = (e.data as { mode?: unknown } | undefined)?.mode;
    if (mode !== RESCAN_MODE_REUSE) plainRescanAt = i;
  }
  const out: string[] = [];
  for (let i = plainRescanAt + 1; i < entries.length; i += 1) {
    const e = entries[i];
    if (e.type !== "custom" || e.customType !== SUMMARY_RECORD_TYPE) continue;
    const text = (e.data as { text?: unknown } | undefined)?.text;
    if (typeof text === "string" && text.length > 0) out.push(normalizeSummaryText(text));
  }
  return out;
}
