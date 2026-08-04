// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// Higher-level budgeted content rendering for the graph read tools
// (cat/find/ls). Builds on the pure helpers in result-budget.ts (budgetWindow,
// runGrepExcerpts, sliceLineRange, parseLineRange) and adds:
//  - content-mode resolution (terse / full / grep / lines),
//  - the two-stage result token budget (terse structure first, then expand top-down
//    one whole item at a time),
//  - grep-mode (contentPattern) excerpts via the regex worker, batched
//    over all result observations' content lines in one worker round-trip.
//
// The tools stay thin: they fetch + select the items (as RenderItems), compile
// contentPattern (via tryCompileFindRegex, handling the error), resolve the
// mode + budget, and hand both to `renderBudgeted`. The agent mk_recall shares
// the lower-level primitives (contentBlock, grepBlock, runGrepExcerpts) but
// keeps its own opaque-unit budgeting (its units are heterogeneous node
// payloads / observations / not-found blocks).

import { estimateContentTokens } from "../types.js";
import { budgetReachedFooter, budgetWindow, parseLineRange, runGrepExcerpts, sliceLineRange } from "./result-budget.js";

/** How to render an observation's content within a result. */
export type ContentMode =
  | { kind: "terse" }
  | { kind: "full" }
  | { kind: "grep"; pattern: RegExp; context: number }
  | { kind: "lines"; start: number; end: number };

/** A pre-compiled grep spec handed to `resolveContentMode`: the caller compiled
 *  `contentPattern` (via tryCompileFindRegex) and resolved `contextLines`. */
export interface GrepSpec {
  pattern: RegExp;
  context: number;
}

/** Resolve the content mode from the new extraction params. Precedence
 *  (most-explicit first): lines > contentPattern > fullDetails > terse.
 *  `grep` is null when contentPattern is absent; the caller compiles it first
 *  (so this module never imports the regex compiler — no circular dep). */
export function resolveContentMode(
  fullDetails: boolean,
  grep: GrepSpec | null,
  lines: string | undefined,
): ContentMode | { error: string } {
  if (lines !== undefined && lines !== "") {
    const parsed = parseLineRange(lines);
    if ("error" in parsed) return parsed;
    return { kind: "lines", start: parsed.start, end: parsed.end };
  }
  if (grep !== null) return { kind: "grep", pattern: grep.pattern, context: grep.context };
  if (fullDetails) return { kind: "full" };
  return { kind: "terse" };
}

/** A single item to render: a one-line header (always shown) plus, for
 *  observations, optional content to expand under one of the content modes. */
export interface RenderItem {
  id: string;
  header: string;
  content?: string;
}

export interface BudgetedOptions {
  /** Token budget (chars/4). null = unbudgeted (a single-observation target
   *  in any mode — the cap lifts, the mode still applies). */
  budget: number | null;
  /** How to render `content`. `terse` uses only the header. */
  mode: ContentMode;
  /** findTimeoutMs — bounds the grep worker (a catastrophic pattern is killed at the timeout). */
  findTimeoutMs: number;
}

export interface BudgetedResult {
  /** The item bodies (headers + expanded content as the budget allows). */
  text: string;
  /** A footer/note to append (budget-reached / overflow / use-contentPattern).
   *  null when nothing overflowed. */
  note: string | null;
  /** The last item id emitted (for the afterId cursor), or null if none. */
  lastId: string | null;
}

const NO_ITEMS_NOTE = null;

/** Render items under `mode`, bounded by `budget`.*/
export async function renderBudgeted(items: RenderItem[], opts: BudgetedOptions): Promise<BudgetedResult> {
  if (items.length === 0) return { text: "", note: NO_ITEMS_NOTE, lastId: null };

  if (opts.budget === null) return renderUncapped(items, opts);

  switch (opts.mode.kind) {
    case "terse":
      return renderTerseBudgeted(items, opts.budget);
    case "full":
    case "lines":
      return renderTwoStageBudgeted(items, opts);
    case "grep":
      return renderGrepBudgeted(items, opts);
  }
}

// --- uncapped (single-observation target, any mode) -----------------------

async function renderUncapped(items: RenderItem[], opts: BudgetedOptions): Promise<BudgetedResult> {
  // The uncapped path serves a single-observation target (budget=null) in any
  // mode. Grep reuses the grep renderer with an infinite budget (all matches
  // shown); full / lines / terse expand via expandItems.
  if (opts.mode.kind === "grep") return renderGrepBudgeted(items, opts);
  const expanded = expandItems(items, opts.mode);
  const parts: string[] = [];
  for (const e of expanded) parts.push(e.render);
  return { text: parts.join("\n"), note: NO_ITEMS_NOTE, lastId: items[items.length - 1].id };
}

// --- terse (one-line items; budget truncates the list) ---------------------

function renderTerseBudgeted(items: RenderItem[], budget: number): BudgetedResult {
  const budgeted = items.map((i) => ({ id: i.id, text: i.header }));
  const { kept, remaining, lastKeptId } = budgetWindow(budgeted, budget);
  return {
    text: kept.map((k) => k.text).join("\n"),
    note: remaining > 0 ? budgetReachedFooter(remaining, lastKeptId, "item") : null,
    lastId: lastKeptId,
  };
}

// --- full / lines (per-item atomic, two-stage) -----------------------------

/** Two-stage: (1) terse headers first — if they overflow, return a partial list
 *  + footer (cursor pagination); (2) if headers fit, show all headers, then
 *  expand content top-down, one whole item at a time, stopping at the first
 *  item whose expansion won't fit (the rest stay header-only). */
async function renderTwoStageBudgeted(items: RenderItem[], opts: BudgetedOptions): Promise<BudgetedResult> {
  const budget = opts.budget ?? Number.POSITIVE_INFINITY;

  // stage 1: headers-only. If they overflow, behave like cursor pagination.
  let headerTotal = 0;
  const headerTokens = items.map((i) => estimateContentTokens(i.header));
  for (let i = 0; i < items.length; i += 1) {
    const next = headerTotal + headerTokens[i];
    if (i > 0 && next > budget) {
      // headers overflow → partial list of headers up to i.
      const kept = items.slice(0, i);
      const remaining = items.length - i;
      const lastKeptId = kept.length > 0 ? kept[kept.length - 1].id : null;
      return {
        text: kept.map((k) => k.header).join("\n"),
        note: budgetReachedFooter(remaining, lastKeptId, "item"),
        lastId: lastKeptId,
      };
    }
    headerTotal = next;
  }

  // stage 2: all headers fit. Expand content top-down, one whole item at a
  // time. The expansion is computed LAZILY per item (contentBlock only for
  // items with content that may fit), so items past the budget cutoff are never
  // rendered — only their (already-computed) header is reused.
  // (opts.mode is full|lines here — terse + grep route to their own renderers.)
  const mode = opts.mode as ExpandMode;

  let remaining = budget - headerTotal;
  const parts: string[] = [];
  let unexpandedWithContent = 0;
  for (let i = 0; i < items.length; i += 1) {
    const item = items[i];
    if (item.content !== undefined) {
      const render = contentBlock(item.header, item.content, mode);
      const expansionTokens = estimateContentTokens(render) - headerTokens[i];
      if (expansionTokens <= remaining) {
        parts.push(render);
        remaining -= expansionTokens;
        continue;
      }
      // expansion doesn't fit → header-only.
      parts.push(item.header);
      unexpandedWithContent += 1;
    } else {
      parts.push(item.header);
    }
  }
  const note =
    unexpandedWithContent > 0
      ? `budget reached · ${unexpandedWithContent} item${unexpandedWithContent === 1 ? "" : "s"} not expanded · use contentPattern for targeted extraction`
      : null;
  return { text: parts.join("\n"), note, lastId: items[items.length - 1].id };
}

// --- grep (single accumulating pass, per-excerpt budget) -------------------

/** Grep: one pass accumulating excerpts across all items, budget-checked per
 *  excerpt. Overflow message distinguishes "+N more matches in this
 *  observation" from "+M more observations". */
async function renderGrepBudgeted(items: RenderItem[], opts: BudgetedOptions): Promise<BudgetedResult> {
  const budget = opts.budget ?? Number.POSITIVE_INFINITY;
  if (opts.mode.kind !== "grep") {
    // defensive — renderBudgeted only routes grep here.
    return renderTwoStageBudgeted(items, opts);
  }
  const grep = opts.mode;

  // batch all content lines through one worker round-trip (shared helper).
  const grepable = items.map((i) => ({ id: i.id, content: i.content ?? "" }));
  const result = await runGrepExcerpts(grepable, grep.pattern, grep.context, opts.findTimeoutMs);
  if ("error" in result) return { text: result.error, note: null, lastId: null };
  const matchesPerItem = result.matchesPerItem;
  const perObsExcerpts = result.excerpts;

  const timedOutNote =
    result.timedOutMs !== null
      ? `grep timed out after ${(result.timedOutMs / 1000).toFixed(0)}s · partial excerpts`
      : null;

  let total = 0;
  const parts: string[] = [];
  let lastEmittedId: string | null = null;
  let overflow: { moreMatches: boolean; remainingObs: number } | null = null;

  for (let i = 0; i < items.length && overflow === null; i += 1) {
    const matches = matchesPerItem[i];
    if (matches.length === 0) continue; // no matches in this obs → skip entirely
    const header = items[i].header;
    const headerTokens = estimateContentTokens(header);
    const excerpts = perObsExcerpts.get(items[i].id) ?? [];
    // emit header (atomic with its first excerpt? emit header, then excerpts).
    if (total + headerTokens > budget && parts.length > 0) {
      // header won't fit → stop before this observation.
      overflow = { moreMatches: false, remainingObs: countRemainingObs(matchesPerItem, i) };
      break;
    }
    parts.push(header);
    total += headerTokens;
    lastEmittedId = items[i].id;
    let emittedExcerpt = false;
    for (const line of excerpts) {
      const lineTokens = estimateContentTokens(line);
      if (total + lineTokens > budget && emittedExcerpt) {
        // more matches in THIS observation.
        overflow = { moreMatches: true, remainingObs: countRemainingObs(matchesPerItem, i + 1) };
        break;
      }
      parts.push(line);
      total += lineTokens;
      emittedExcerpt = true;
    }
  }

  const notes: string[] = [];
  if (overflow !== null) {
    if (overflow.moreMatches) notes.push("more matches in this observation");
    if (overflow.remainingObs > 0)
      notes.push(`${overflow.remainingObs} more observation${overflow.remainingObs === 1 ? "" : "s"}`);
    notes.unshift("budget reached");
  }
  if (timedOutNote !== null) notes.push(timedOutNote);
  return { text: parts.join("\n"), note: notes.length > 0 ? notes.join(" · ") : null, lastId: lastEmittedId };
}

function countRemainingObs(matchesPerItem: number[][], fromIdx: number): number {
  let n = 0;
  for (let i = fromIdx; i < matchesPerItem.length; i += 1) if (matchesPerItem[i].length > 0) n += 1;
  return n;
}

// --- per-item expansion (full / lines) --------------------------------------

interface ExpandedItem {
  render: string;
}

/** The content modes that expand each item's body here (full / lines). Grep
 *  has its own renderer (renderGrepBudgeted — worker-batched excerpts) and is
 *  never routed through expandItems/contentBlock. */
type ExpandMode = Exclude<ContentMode, { kind: "grep" }>;

/** Expand each item under a full/lines mode (full = header + whole content;
 *  lines = header + a numbered line range). Returns the per-item rendered
 *  block. Grep is handled separately by renderGrepBudgeted (worker batching),
 *  so this only covers full / lines / terse. */
function expandItems(items: RenderItem[], mode: ExpandMode): ExpandedItem[] {
  return items.map((i) => ({ render: contentBlock(i.header, i.content, mode) }));
}

/** Render one item's body under full/lines/terse: header, then the content
 *  block (full content, a numbered line range, or nothing for terse /
 *  content-less items). Shared with the agent mk_recall, which passes a
 *  pre-computed header + content (and, for grep, pre-computed excerpts). */
export function contentBlock(header: string, content: string | undefined, mode: ExpandMode): string {
  if (content === undefined) return header;
  if (mode.kind === "terse") return header;
  if (mode.kind === "full") return `${header}\n${content}`;
  // lines
  const range = sliceLineRange(content, `${mode.start}-${mode.end}`);
  if ("error" in range) return header;
  if (range.lines.length === 0) return header;
  const numbered = range.lines.map((l, idx) => `  ${range.start + idx}: ${l}`);
  return `${header}\n${numbered.join("\n")}`;
}

/** Render one item's body when grep excerpts were pre-computed (header + the
 *  excerpt lines, or header-only when there are no excerpts). Used by the agent
 *  mk_recall, which pre-computes excerpts for the observations in its window. */
export function grepBlock(header: string, excerpts: readonly string[] | undefined): string {
  if (excerpts === undefined || excerpts.length === 0) return header;
  return `${header}\n${excerpts.join("\n")}`;
}
