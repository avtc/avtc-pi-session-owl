// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// The resume-time details warm: the store read already materialized the
// graph; the warm renders every observation's verbatim source into the
// conversation's details cache (keyed writes — safe from any lane), in
// chunks with yields. A resumed session's first owl_recall query then
// serves from the warm cache instead of rendering 20+ MB inline inside a
// budget-capped serve hook. Failures are per-observation, counted, never
// thrown — a partial warm still beats a cold cache.

import type { EntryResolver } from "../../core/src/format/details.js";

export interface WarmDetailsDeps {
  /** The conversation whose bucket receives the renders (its own key, not
   *  whatever is globally active). */
  key: string;
  /** The loaded graph (needs only `observations`). */
  graph: { observations: Map<string, { id: string; sourceEntryIds: readonly string[] }> };
  /** The entry resolver the core's serves use (mirror-backed). */
  resolver: EntryResolver;
  /** The keyed cache write (the core handle's details module — injected so
   *  this module holds no static import of a stateful core). */
  detailsWrite: (
    key: string,
    obsId: string,
    sourceEntryIds: readonly string[],
    resolver: EntryResolver,
  ) => { lines: number; tokens: number } | null;
  /** How many observations to render per chunk (default 200). */
  chunkSize?: number;
  /** Called between chunks (default: a microtask yield). */
  yieldLane?: () => Promise<void> | void;
}

export interface WarmReport {
  warmed: number;
  failed: number;
  ms: number;
}

/** Warm the conversation's details cache over every observation. Never
 *  throws; per-observation render failures count as `failed`. */
export async function warmDetailsCache(deps: WarmDetailsDeps): Promise<WarmReport> {
  const t0 = Date.now();
  const chunk = deps.chunkSize ?? 200;
  const yieldLane = deps.yieldLane ?? (() => Promise.resolve());
  let warmed = 0;
  let failed = 0;
  let sinceYield = 0;
  for (const obs of deps.graph.observations.values()) {
    try {
      const out = deps.detailsWrite(deps.key, obs.id, [...obs.sourceEntryIds], deps.resolver);
      if (out !== null) warmed += 1;
    } catch {
      failed += 1; // a poisoned entry never kills the warm
    }
    sinceYield += 1;
    if (sinceYield >= chunk) {
      sinceYield = 0;
      await yieldLane();
    }
  }
  return { warmed, failed, ms: Date.now() - t0 };
}
