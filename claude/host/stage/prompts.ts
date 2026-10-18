// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// The stage prompts' supply (AgentSpec.prompt = the stage system prompt,
// ported verbatim). The vendored prompt modules provide the
// text; the RootShapeSettings slice defaults to the core's DEFAULT_CONFIG
// values — spelled LOCALLY, because config/schema.js value-imports the
// settings library (a bare specifier the hooks closure refuses; the parity
// with the core defaults is pinned by the spec suite). The settings
// wiring passes the live slice through `getStagePrompts`.
//
// Closure note: OBSERVER_SYSTEM's module is import-free; builder/selector
// prompts chain render.js → types.js/tokens.js (import-free) and
// root-shape.js → config/schema.js as a TYPE-ONLY edge (erases at emit).
import { builderSystemPrompt } from "../../core/src/prompts/builder.js";
import { OBSERVER_SYSTEM } from "../../core/src/prompts/observer.js";
import { selectorSystemPrompt } from "../../core/src/prompts/selector.js";

/** The shape-advice slice the Builder/Selector prompts read (structural —
 *  the core's RootShapeSettings). */
export interface RootShapeSettingsSlice {
  rootViewTargetNodes: number | null;
  rootViewStrategy: "balanced" | "by-task" | "by-category" | "by-recency" | "by-importance" | "by-topic";
}

/** The core's DEFAULT_CONFIG slice, spelled locally (see the header). */
export function defaultRootShapeSettings(): RootShapeSettingsSlice {
  return { rootViewTargetNodes: null, rootViewStrategy: "balanced" };
}

/** The three stage system prompts (verbatim from the vendored modules). */
export function getStagePrompts(settings?: RootShapeSettingsSlice): {
  observerPrompt: string;
  builderPrompt: string;
  selectorPrompt: string;
} {
  const slice = settings ?? defaultRootShapeSettings();
  return {
    observerPrompt: OBSERVER_SYSTEM,
    builderPrompt: builderSystemPrompt(slice),
    selectorPrompt: selectorSystemPrompt(slice),
  };
}
