// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// renderDetails / computeDetailsCounts: re-render an observation's verbatim
// source ("details") from its sourceEntryIds, UNTRUNCATED, in the Observer's
// chunk tag format — but as a recall consumer (no entry=id attribute, since the
// agent/Builder/Selector have no use for raw session entry ids).
//
// FULL VERBATIM: thinking is ALWAYS included and tool args/results are NEVER
// capped — the Observer's observerIncludeThinking / observerToolBlockCapTokens
// exist so the Observer LLM doesn't choke on huge content; the verbatim source
// (counts at capture, full text at recall) is always complete.
//
// The toolCallId pairing (call -> its result, interleaved) is handled by
// renderGroups over the WHOLE resolved entry list — per-entry standalone flatten
// BREAKS multi-call entries (groups all calls then all results), so the whole
// list is rendered together.

import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { countLines, estimateContentTokens } from "../types.js";
import { type ChunkOptions, renderBlocks } from "./chunk.js";

/** A resolved details render: the verbatim source text + its size hints. */
export interface DetailsRender {
  readonly text: string;
  readonly lines: number;
  readonly tokens: number;
}

/**
 * Resolve a batch of source-entry ids to session entries. Loosely typed
 * (`unknown`) to match the GraphStore resolver (the store stays decoupled from
 * the pi SessionEntry shape); callers narrow. Missing ids are dropped
 * (graceful cross-branch drill).
 */
export type EntryResolver = (ids: readonly string[]) => readonly unknown[];

// The details render is deterministic given immutable source entries (full
// verbatim, no observer-config dependence), so the cache is STABLE per
// observation — no flag, no bust logic. Cleared per-session (entry ids are
// per-session). Pre-warmed at capture (computeDetailsAndCache renders the
// verbatim source once for the size counts AND caches the text, so the first
// recall of a session hits a hot cache) and re-warmed on demand by recall.
const detailsCache = new Map<string, DetailsRender>();

/** Render options for the verbatim-source details render: full, no entry=id. */
const DETAILS_OPTIONS: ChunkOptions = {
  tokenThreshold: Number.POSITIVE_INFINITY,
  toolBlockCapTokens: null, // untruncated — full verbatim
  includeThinking: true, // always — the verbatim source, not observer-gated
  includeEntryId: false, // recall consumers can't act on raw entry ids
};

/** Core render: resolve entries, render untruncated, count lines + tokens.
 *  Returns null when nothing resolves or nothing renderable. Pure (no cache). */
function renderDetailsText(sourceEntryIds: readonly string[], resolveEntries: EntryResolver): DetailsRender | null {
  const entries = resolveEntries(sourceEntryIds) as readonly SessionEntry[];
  if (entries.length === 0) return null; // source_unavailable
  const text = renderBlocks(entries, DETAILS_OPTIONS)
    .map((block) => block.text)
    .join("");
  if (text.length === 0) return null; // resolved but nothing renderable
  return { text, lines: countLines(text), tokens: estimateContentTokens(text) };
}

/**
 * Compute the verbatim-source counts AND cache the rendered text keyed by the
 * observation id — so the capture-time render (already needed for the counts) is
 * reused at recall instead of being discarded and re-rendered lazily. Warming
 * the cache at observation (a background stage) means the first find/cat of a
 * session hits a hot cache (no cold-cache latency). The capture resolver
 * resolves the same source entries the recall-time ctx resolver returns, so the
 * cached render is identical to a recall-time render.
 */
export function computeDetailsAndCache(
  obsId: string,
  sourceEntryIds: readonly string[],
  resolveEntries: EntryResolver,
): { lines: number; tokens: number } | null {
  const render = renderDetailsText(sourceEntryIds, resolveEntries);
  if (render === null) return null;
  detailsCache.set(obsId, render);
  return { lines: render.lines, tokens: render.tokens };
}

/**
 * Re-render an observation's verbatim source from its sourceEntryIds (full
 * text). Cached per observation id: a second call with the same obs id returns
 * the cached render without re-resolving or re-rendering. Returns null when the
 * source is unavailable (source_unavailable — the one-line summary still
 * renders; only the verbatim source is gone).
 */
export function renderDetails(
  obsId: string,
  sourceEntryIds: readonly string[],
  resolveEntries: EntryResolver,
): DetailsRender | null {
  const cached = detailsCache.get(obsId);
  if (cached !== undefined) return cached;
  const render = renderDetailsText(sourceEntryIds, resolveEntries);
  if (render === null) return null;
  detailsCache.set(obsId, render);
  return render;
}

/** Clear the per-observation details cache. Called on session_start (refresh)
 *  and session_shutdown (drop) so entry ids never collide across sessions. */
export function clearDetailsCache(): void {
  detailsCache.clear();
}
