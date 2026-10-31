// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// renderDetails / computeDetailsCounts: re-render an observation's verbatim
// source ("details") from its sourceEntryIds, UNTRUNCATED, in the Observer's
// chunk tag format — but as a recall consumer (no entryId=id attribute, since the
// agent/Builder/Selector have no use for raw session entry ids).
//
// FULL VERBATIM: tool args/results are NEVER capped — the Observer's
// observerToolBlockCapTokens exists so the Observer LLM doesn't choke on huge
// content; the verbatim source (counts at capture, full text at recall) is
// always complete. Thinking is included unless hideThinking is on (some hosts
// review model-facing content for reasoning-like text).
//
// The toolCallId pairing (call -> its result, interleaved) is handled by
// renderGroups over the WHOLE resolved entry list — per-entry standalone flatten
// BREAKS multi-call entries (groups all calls then all results), so the whole
// list is rendered together.

import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { getSessionOwlSettings } from "../config/schema.js";
import { currentConversationKey } from "../runtime/conversation-key.js";
import { countLines, estimateContentTokens } from "../types.js";
import { BLOCK_SEP, type ChunkOptions, renderBlocks } from "./chunk.js";

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
// Bucketed PER CONVERSATION: obs ids are per-graph, so two conversations may
// legitimately collide on `o<N>` — one key's render must never serve another
// (pi never activates a key ⇒ its map holds exactly one bucket, today's
// behavior).
const detailsCaches = new Map<string, Map<string, DetailsRender>>();

function cacheForActiveConversation(): Map<string, DetailsRender> {
  const key = currentConversationKey();
  let cache = detailsCaches.get(key);
  if (cache === undefined) {
    cache = new Map<string, DetailsRender>();
    detailsCaches.set(key, cache);
  }
  return cache;
}

/** Render options for the verbatim-source details render: full, no entryId=id.
 *  Thinking rides the hideThinking gate (the cache key carries the flag, so a
 *  flip never serves a stale render). */
function detailsOptions(): ChunkOptions {
  return {
    tokenThreshold: Number.POSITIVE_INFINITY,
    toolBlockCapTokens: null, // untruncated — full verbatim
    includeThinking: !getSessionOwlSettings().hideThinking,
    includeEntryId: false, // recall consumers can't act on raw entry ids
  };
}

/** Cache key for an observation render — the hideThinking flag rides the key
 *  so flipping the setting never serves a render from the other mode. */
function cacheKey(obsId: string): string {
  return getSessionOwlSettings().hideThinking ? `${obsId}:ht` : obsId;
}

/** Core render: resolve entries, render untruncated, count lines + tokens.
 *  Returns null when nothing resolves or nothing renderable. Pure (no cache). */
function renderDetailsText(sourceEntryIds: readonly string[], resolveEntries: EntryResolver): DetailsRender | null {
  const entries = resolveEntries(sourceEntryIds) as readonly SessionEntry[];
  if (entries.length === 0) return null; // source_unavailable
  const text = renderBlocks(entries, detailsOptions())
    .map((block) => block.text)
    .join(BLOCK_SEP);
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
  cacheForActiveConversation().set(cacheKey(obsId), render);
  return { lines: render.lines, tokens: render.tokens };
}

/** Compute the verbatim-source counts AND cache the rendered text keyed by
 *  the observation id — into the NAMED conversation's bucket, regardless of
 *  which key is currently active (the resume-time warm writes from a lane
 *  where the active key belongs to nobody in particular). */
export function computeDetailsAndCacheFor(
  key: string,
  obsId: string,
  sourceEntryIds: readonly string[],
  resolveEntries: EntryResolver,
): { lines: number; tokens: number } | null {
  const render = renderDetailsText(sourceEntryIds, resolveEntries);
  if (render === null) return null;
  let bucket = detailsCaches.get(key);
  if (bucket === undefined) {
    bucket = new Map<string, DetailsRender>();
    detailsCaches.set(key, bucket);
  }
  bucket.set(cacheKey(obsId), render);
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
  const cache = cacheForActiveConversation();
  const key = cacheKey(obsId);
  const cached = cache.get(key);
  if (cached !== undefined) return cached;
  const render = renderDetailsText(sourceEntryIds, resolveEntries);
  if (render === null) return null;
  cache.set(key, render);
  return render;
}

/** Clear the ACTIVE conversation's per-observation details bucket. Called on
 *  session_start (refresh) and session_shutdown (drop) so entry ids never
 *  collide across sessions of that conversation. */
export function clearDetailsCache(): void {
  const cache = detailsCaches.get(currentConversationKey());
  if (cache !== undefined) cache.clear();
}

/** Detach the ACTIVE conversation's details bucket and hand it to the
 *  caller. A same-conversation reload (the rewind refold) detaches before
 *  the load clears, then re-attaches: renders are stable per observation id
 *  (no bust logic), so the surviving rows' entries stay valid and the next
 *  recall stays warm. Returns null when there is no bucket yet. */
export function detachActiveDetailsBucket(): Map<string, DetailsRender> | null {
  const key = currentConversationKey();
  const bucket = detailsCaches.get(key);
  if (bucket === undefined) return null;
  detailsCaches.delete(key);
  return bucket;
}

/** Re-install a detached bucket as the ACTIVE conversation's cache, merging
 *  any entries rendered while it was detached (renders are deterministic, so
 *  the pairs agree by construction). */
export function reattachActiveDetailsBucket(bucket: Map<string, DetailsRender>): void {
  const key = currentConversationKey();
  const existing = detailsCaches.get(key);
  if (existing !== undefined) {
    for (const [entryKey, render] of existing) bucket.set(entryKey, render);
  }
  detailsCaches.set(key, bucket);
}

/** Drop every conversation's bucket — the process-wide reset (test/teardown
 *  seam; graph-store's resetConversationStates calls this). */
export function clearAllDetailsCaches(): void {
  detailsCaches.clear();
}
