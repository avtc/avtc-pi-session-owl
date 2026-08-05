// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// Result token-budget + targeted content-extraction helpers shared by the graph
// read tools (cat/find/ls) and the agent mk_recall. Pure functions; the tools
// wire them into their execute handlers.
//
// `estimateContentTokens` (chars/4, types.ts) is the token estimate used for the
// budget — the same heuristic Pi's own compaction applies.

import { getMemkeeperSettings } from "../config/schema.js";
import { pluralize } from "../format/render.js";
import { estimateContentTokens } from "../types.js";
import { runRegexTests } from "./regex-runner.js";

/** A rendered item with an id (for the continuation cursor) and its text. */
export interface BudgetItem {
  id: string;
  text: string;
}

/** Truncate a list of rendered items to a token budget. Items are emitted in
 *  order while the accumulated token estimate stays within `budget`; the FIRST
 *  item is always kept (never returns an empty kept-list for a non-empty input —
 *  a single item is returned whole even if it alone exceeds the budget, so the
 *  caller always shows at least what it asked the leading id for). Returns the
 *  kept items, how many were dropped, and the last kept id (for the afterId
 *  footer). */
export function budgetWindow<T extends BudgetItem>(
  items: T[],
  budget: number,
): {
  kept: T[];
  remaining: number;
  lastKeptId: string | null;
} {
  if (items.length === 0) return { kept: [], remaining: 0, lastKeptId: null };
  let total = 0;
  let cut = 0;
  for (; cut < items.length; cut += 1) {
    const next = total + estimateContentTokens(items[cut].text);
    if (cut > 0 && next > budget) break; // first item always kept
    total = next;
  }
  const kept = items.slice(0, cut);
  return { kept, remaining: items.length - cut, lastKeptId: kept.length > 0 ? kept[kept.length - 1].id : null };
}

/** Build a grep-style excerpt from a content's lines: each match line ±
 *  `contextLines` of context, overlapping/adjacent ranges merged, each emitted
 *  line prefixed with its 1-indexed line number (`  L: text`). Pure — the caller
 *  budget-checks the emitted lines. */
export function buildGrepExcerpt(lines: string[], matchLineIndices: number[], contextLines: number): string[] {
  if (matchLineIndices.length === 0 || lines.length === 0) return [];
  const clampedContext = Math.max(0, contextLines);
  // build [start, end] inclusive ranges (0-indexed) per match, clamped to bounds.
  const ranges: [number, number][] = matchLineIndices.map((idx) => [
    Math.max(0, idx - clampedContext),
    Math.min(lines.length - 1, idx + clampedContext),
  ]);
  // merge overlapping/adjacent ranges.
  ranges.sort((a, b) => a[0] - b[0]);
  const merged: [number, number][] = [];
  for (const [s, e] of ranges) {
    const last = merged[merged.length - 1];
    if (last !== undefined && s <= last[1] + 1) {
      last[1] = Math.max(last[1], e);
    } else {
      merged.push([s, e]);
    }
  }
  // emit each line with a 1-indexed number.
  const out: string[] = [];
  for (const [s, e] of merged) {
    for (let i = s; i <= e; i += 1) {
      out.push(`  ${i + 1}: ${lines[i]}`);
    }
  }
  return out;
}

/** Parse a line-range spec ("N-M" or "N"), 1-indexed. Swaps reversed bounds;
 *  rejects non-positive or non-numeric input. */
export function parseLineRange(range: string): { start: number; end: number } | { error: string } {
  const trimmed = range.trim();
  const match = /^(\d+)(?:\s*-\s*(\d+))?$/.exec(trimmed);
  if (match === null) {
    return { error: `Invalid line range "${range}" — use N or N-M (1-indexed).` };
  }
  const start = Number(match[1]);
  const endRaw = match[2] !== undefined ? Number(match[2]) : start;
  if (start < 1 || endRaw < 1) {
    return { error: `Invalid line range "${range}" — lines are 1-indexed (min 1).` };
  }
  return { start: Math.min(start, endRaw), end: Math.max(start, endRaw) };
}

/** Slice a content string to a 1-indexed line range (clamped to the content's
 *  actual line count). Returns the lines + the clamped start. */
export function sliceLineRange(content: string, range: string): { lines: string[]; start: number } | { error: string } {
  const parsed = parseLineRange(range);
  if ("error" in parsed) return parsed;
  const lines = content.split("\n");
  const start = Math.max(1, parsed.start);
  const end = Math.min(lines.length, parsed.end);
  if (start > lines.length) return { lines: [], start };
  return { lines: lines.slice(start - 1, end), start };
}

/** An item whose content is grep-able. */
export interface GrepableItem {
  id: string;
  content: string;
}

/** Build the uniform budget-reached footer shown when a result list is
 *  truncated by the token budget. Always carries the continuation cursor
 *  (`afterId`) so the agent/user can page — truncation always has a cursor.
 *  `noun` ("item" | "match" | "observation") labels what "more" counts, for the
 *  rare caller where the unit is ambiguous; it pluralizes itself. */
export function budgetReachedFooter(
  remaining: number,
  lastKeptId: string | null,
  noun: "item" | "match" | "observation",
): string {
  const unit = pluralize(remaining, noun, `${noun}s`);
  const cursor = lastKeptId === null ? "" : ` · afterId=${lastKeptId}`;
  return `budget reached · +${remaining} more ${unit}${cursor}`;
}

/** The note surfaced when a find/search times out: how long it ran, how many of
 *  the candidate items were tested before the worker was killed, and the hint
 *  to narrow the query. Shared by find (read-tools) and mk_recall search. */
export function searchTimeoutNote(timedOutMs: number, testedCount: number, total: number): string {
  const seconds = Math.floor(timedOutMs / 1000);
  return `Search timed out after ${seconds}s — tested ${testedCount} of ${total} items before the kill. These are partial results; refine or narrow the query.`;
}

/** Intersect multiple regex filters over a batch of texts (worker-bounded by
 *  `findTimeoutMs`). An item passes only if it matches EVERY regex. A timed-out
 *  regex marks untested items false (conservative — partial matches + note).
 *  Used by `find`/`mk_recall` search to intersect `query` + `contentPattern` over
 *  node summaries + observation text. Returns the per-text pass flags + an
 *  optional timeout note, or an error string the caller surfaces verbatim. */
export async function intersectRegexFilters(
  texts: readonly string[],
  regexes: readonly RegExp[],
): Promise<{ passes: boolean[]; note?: string } | { error: string }> {
  const passes = new Array<boolean>(texts.length).fill(true);
  let note: string | undefined;
  for (const re of regexes) {
    const outcome = await runRegexTests(re, texts, getMemkeeperSettings().findTimeoutMs);
    if ("error" in outcome) return { error: outcome.error };
    for (let i = 0; i < texts.length; i += 1) {
      if (!outcome.results[i]) passes[i] = false;
    }
    if ("testedCount" in outcome) {
      note = searchTimeoutNote(outcome.timedOutMs, outcome.testedCount, texts.length);
    }
  }
  return { passes, note };
}

/** The note surfaced when a contentPattern-grep over observation content lines
 *  times out: partial excerpts are returned. Shared by cat/find (result-render)
 *  and mk_recall (grep excerpts). */
export function grepTimeoutNote(timedOutMs: number): string {
  const seconds = Math.floor(timedOutMs / 1000);
  return `Grep timed out after ${seconds}s — partial excerpts only; refine or narrow the pattern.`;
}

/** Outcome of batching a contentPattern over many items' content lines in one
 *  worker round-trip (see runGrepExcerpts). */
export interface GrepExcerptsOutcome {
  /** For each input item (in order), the 0-indexed local line indices that
   *  matched. */
  matchesPerItem: number[][];
  /** Built excerpts keyed by item id (only items with >=1 match). */
  excerpts: ReadonlyMap<string, string[]>;
  /** Non-null when the worker timed out (partial results). */
  timedOutMs: number | null;
}

/** Batch-test a contentPattern over many items' content lines in ONE worker
 *  round-trip (via runRegexTests), map the hits back to per-item local line
 *  indices, and build ±context excerpts (merged ranges) per item. Shared by the
 *  budgeted grep renderer and the agent mk_recall's pre-compute path. Returns an
 *  error string on a compile/worker failure (surfaced verbatim to the caller). */
export async function runGrepExcerpts(
  items: readonly GrepableItem[],
  pattern: RegExp,
  context: number,
  timeoutMs: number,
): Promise<GrepExcerptsOutcome | { error: string }> {
  const perItemLines: string[][] = [];
  const globalLines: string[] = [];
  const owner: { itemIdx: number; localIdx: number }[] = [];
  for (let ii = 0; ii < items.length; ii += 1) {
    const content = items[ii].content ?? "";
    const lines = content.length === 0 ? [] : content.split("\n");
    perItemLines.push(lines);
    for (let li = 0; li < lines.length; li += 1) {
      globalLines.push(lines[li]);
      owner.push({ itemIdx: ii, localIdx: li });
    }
  }
  const outcome = await runRegexTests(pattern, globalLines, timeoutMs);
  if ("error" in outcome) return outcome;
  const matchesPerItem: number[][] = items.map(() => []);
  for (let gi = 0; gi < globalLines.length; gi += 1) {
    if (outcome.results[gi]) {
      const o = owner[gi];
      matchesPerItem[o.itemIdx].push(o.localIdx);
    }
  }
  const excerpts = new Map<string, string[]>();
  for (let ii = 0; ii < items.length; ii += 1) {
    if (matchesPerItem[ii].length > 0) {
      excerpts.set(items[ii].id, buildGrepExcerpt(perItemLines[ii], matchesPerItem[ii], context));
    }
  }
  return {
    matchesPerItem,
    excerpts,
    timedOutMs: "testedCount" in outcome ? outcome.timedOutMs : null,
  };
}
