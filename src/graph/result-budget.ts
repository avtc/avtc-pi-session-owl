// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// Result token-budget + targeted content-extraction helpers shared by the graph
// read tools (cat/find/ls) and the agent mk_recall. Pure functions; the tools
// wire them into their execute handlers.
//
// `estimateContentTokens` (chars/4, types.ts) is the token estimate used for the
// budget — the same heuristic Pi's own compaction applies.

import { estimateContentTokens } from "../types.js";

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
