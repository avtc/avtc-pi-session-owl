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
  /** Rows in arrival order (cache + adopted mirror). Materializing them walks
   *  the whole index, so the resolver calls this only when the generation
   *  moved. */
  rows(): readonly ClaudeRow[];
  /** Monotonic index version — bumped by EVERY mutation: a live append, a
   *  restart's adoption, the load's re-sequencing, an in-place row refresh.
   *  When present it is the cache generation and `rows()` runs only when it
   *  moves; without it the generation is the row count (an append-only
   *  index), which needs `rows()` on every call. */
  version?(): number;
}

/**
 * Build the EntryResolver over an index: resolves entry ids -> the pi-shaped
 * entries the details renderer consumes. Ids not in the index return nothing
 * for that slot (graceful drop).
 *
 * The grouped entry map is built once per index generation. A details render
 * resolves per observation, so a whole-graph pass (the resume warm, a cold
 * search) calls this thousands of times against one generation — each call
 * must cost a map lookup, not a walk of every row.
 */
export function makeEntryResolver(index: EntryIndex): (ids: readonly string[]) => readonly unknown[] {
  let cache: Map<string, SessionEntry> | null = null;
  let cachedGen: number | null = null;
  const rebuild = (): Map<string, SessionEntry> => {
    let rows: readonly ClaudeRow[] | null = null;
    let gen: number;
    if (index.version !== undefined) {
      gen = index.version();
    } else {
      rows = index.rows();
      gen = rows.length;
    }
    if (cache !== null && gen === cachedGen) return cache;
    const map = new Map<string, SessionEntry>();
    for (const entry of groupRows(rows ?? index.rows())) {
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
