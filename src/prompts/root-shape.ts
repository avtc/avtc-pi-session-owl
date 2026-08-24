// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// Root-view shape advice shared by the Builder and Selector prompts — the
// strategy clause and the root-count sentence, both driven by settings and
// both advisory (the try_finish token budget stays the hard gate).

import type { RootViewStrategy } from "../config/schema.js";

/** The settings slice the shape advice reads (structural — run inputs satisfy it). */
export interface RootShapeSettings {
  rootViewTargetNodes: number | null;
  rootViewStrategy: RootViewStrategy;
}

/** Strategy → the advice paragraph injected after the organize bullets.
 *  balanced carries no clause (the prompt's own wording stands). */
const STRATEGY_CLAUSES: Readonly<Record<Exclude<RootViewStrategy, "balanced">, string>> = {
  "by-task":
    "Organize roots by task, in the order tasks occurred: one root per task (past, current, upcoming); merge only within a task; a completed task folds into one line.",
  "by-category":
    "Organize roots by category — group memory by the kind of thing it is. Base categories: user requests and intent, decisions and constraints, system and code understanding, work state and progress, pitfalls and dead ends, environment and commands; the list is open — add a category of its own when a distinct kind accumulates.",
  "by-recency":
    "Organize roots by recency: the newest material keeps fine-grained roots; as observations age, fold their roots into coarser ones. The recent past stays granular; the distant past compacts.",
  "by-importance":
    "Scale granularity with importance: crit and high items keep dedicated roots with rich lines; med and low items fold into coarse shared folders.",
  "by-topic": "Organize roots by topic — the distinct subjects the session works on",
};

/** The root-count sentence; null when no target is set (no advice — the
 *  openings' lean/budget clause is dropped with it). */
export function rootCountSentence(targetNodes: number | null): string | null {
  if (targetNodes === null) return null;
  return `Aim to have no more than ${targetNodes} nodes at root level.`;
}

/** The strategy paragraph; null for balanced (no advice). */
export function strategyClause(strategy: RootViewStrategy): string | null {
  if (strategy === "balanced") return null;
  return STRATEGY_CLAUSES[strategy];
}
