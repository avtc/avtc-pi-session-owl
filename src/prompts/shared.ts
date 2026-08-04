// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// Shared fragments interpolated by the Builder and Selector system prompts.
// Extracted so the importance definition cannot drift between the two prompts;
// each prompt appends its own role-specific action clause.

/** The shared importance definition (the crit/high/med/low gloss). Both the
 *  Builder and Selector prompts prepend this, then append their own trailing
 *  "set it when..." clause (the actions differ by role). */
export const IMPORTANCE_GLOSS =
  "Importance is how much a node matters if lost: critical — a hard, persistent constraint or correction; high — a decision, choice, or unresolved blocker; medium — meaningful context, not itself a decision or constraint; low — routine activity or minor detail.";
