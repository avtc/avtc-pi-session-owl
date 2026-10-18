// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import type { SessionEntry } from "@earendil-works/pi-coding-agent";
// The details bridge: wires the core's EntryResolver (and through it the
// details cache) to the port's read tiers. The resolver is SYNC, so it
// serves from the in-memory row index — the row cache (current process)
// UNION the adopted mirror rows (a restart's sweep/backfill materializes
// them into the same index before any recall; the transcript tier is that
// materialization's source, not a live tier of this resolver). Missed ids
// drop gracefully (pi's cross-branch drill behavior).
import { type ClaudeRow, groupRows } from "./grouper.js";

/** The sync entry index the resolver reads. */
export interface EntryIndex {
  /** Rows in arrival order (cache + adopted mirror). */
  rows(): readonly ClaudeRow[];
  /** Monotonic index version — bumped by EVERY mutation, including the
   *  same-length in-place refresh of a re-delivered uuid. When present it
   * replaces the length check as the cache generation (the capture side
   * DOES refresh rows in place — a length key would serve stale entries). */
  version?(): number;
}

/**
 * Build the EntryResolver over an index: resolves entry ids -> the pi-shaped
 * entries the details renderer consumes. Ids not in the index return nothing
 * for that slot (graceful drop).
 */
export function makeEntryResolver(index: EntryIndex): (ids: readonly string[]) => readonly unknown[] {
  let cache: Map<string, SessionEntry> | null = null;
  let cachedGen: number | null = null;
  const rebuild = (): Map<string, SessionEntry> => {
    // generation: the index's version when it exposes one (catches the
    // same-length in-place refresh of a re-delivered uuid), else the row
    // count (an append-only index)
    const rows = [...index.rows()];
    const gen = index.version !== undefined ? index.version() : rows.length;
    if (cache !== null && gen === cachedGen) return cache;
    const map = new Map<string, SessionEntry>();
    for (const entry of groupRows(rows)) {
      map.set(entry.id, entry);
    }
    cache = map;
    cachedGen = gen;
    return map;
  };
  return (ids: readonly string[]): readonly unknown[] => {
    const byId = rebuild();
    const out: unknown[] = [];
    for (const id of ids) {
      const entry = byId.get(id);
      if (entry !== undefined) out.push(entry);
    }
    return out;
  };
}
