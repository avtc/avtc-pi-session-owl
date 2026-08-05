// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// renderDetails: re-render an observation's verbatim source ("details") from
// its sourceEntryIds, UNTRUNCATED, in the Observer's chunk tag format — but as
// a recall consumer (no entry=id attribute, since the agent/Builder/Selector
// have no use for raw session entry ids).
//
// FULL VERBATIM: thinking is ALWAYS included and tool args/results are NEVER
// capped — the Observer's observerIncludeThinking / observerToolBlockCapTokens
// exist so the Observer LLM doesn't choke on huge content; recall returns the
// complete source.
//
// The toolCallId pairing (call → its result, interleaved) is handled by
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
 * the pi SessionEntry shape); renderDetails narrows. Missing ids are dropped
 * (graceful cross-branch drill).
 */
export type EntryResolver = (ids: readonly string[]) => readonly unknown[];

// Details render is deterministic given immutable source entries (full verbatim,
// no observer-config dependence), so the cache is STABLE per observation — no
// flag, no bust logic. Cleared per-session (entry ids are per-session).
const detailsCache = new Map<string, DetailsRender>();

/** Render options for the verbatim-source details render: full, no entry=id. */
const DETAILS_OPTIONS: ChunkOptions = {
  tokenThreshold: Number.POSITIVE_INFINITY,
  toolBlockCapTokens: null, // untruncated — full verbatim
  includeThinking: true, // always — recall is the full source, not observer-gated
  includeEntryId: false, // recall consumers can't act on raw entry ids
};

/**
 * Re-render an observation's verbatim source from its sourceEntryIds. Returns
 * null when no source entries resolve (source_unavailable — the one-line summary
 * still renders; only the verbatim source is gone). Cached per observation id:
 * a second call with the same obs id returns the cached render without
 * re-resolving or re-rendering.
 */
export function renderDetails(
  obsId: string,
  sourceEntryIds: readonly string[],
  resolveEntries: EntryResolver,
): DetailsRender | null {
  const cached = detailsCache.get(obsId);
  if (cached !== undefined) return cached;

  const entries = resolveEntries(sourceEntryIds) as readonly SessionEntry[];
  if (entries.length === 0) return null; // source_unavailable
  const text = renderBlocks(entries, DETAILS_OPTIONS)
    .map((block) => block.text)
    .join("");
  if (text.length === 0) return null; // resolved but nothing renderable
  const render: DetailsRender = { text, lines: countLines(text), tokens: estimateContentTokens(text) };
  detailsCache.set(obsId, render);
  return render;
}

/** Clear the per-observation details cache. Called on session_start (refresh)
 *  and session_shutdown (drop) so entry ids never collide across sessions. */
export function clearDetailsCache(): void {
  detailsCache.clear();
}
