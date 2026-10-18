// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import { OWL_RECALL_FULL_NAME } from "./spec.js";

// The owl_recall render-site restyle (human-facing only — the model always
// receives the full result text). The vendored CollapsedOutput caps a
// transcript result at COLLAPSED_LINE_LIMIT screen rows + the expand-hint
// row; the Claude ToolResult render site restyles the OUTPUT PROP instead:
// a plugin tool's result object carries the text under `result`, so the
// restyle hands the engine a pre-collapsed text with the same hint. Error
// rows are never collapsed (the platform draws the thrown error text in
// full — pi parity without a flag). The compact CALL LINE is ported as the
// pure recallCallLine below; its render-site drawing is deferred (the
// element-tree idiom).

/** The collapsed row cap (pi's CollapsedOutput limit). */
export const RECALL_COLLAPSED_LINE_LIMIT = 12;

/** The expand hint appended under a truncated collapsed render (pi's). */
export const RECALL_EXPAND_HINT = "(Ctrl+O to expand)";

/** The ToolResult props slice the restyle reads (the engine's shape). */
export interface ToolResultPropsLike {
  tool: string;
  output: unknown;
  isErrored: boolean;
  onScreen?: unknown;
}

/** Collapse a result text to the row cap + the hint. Word-wrap width is a
 *  render-time fact the prop restyle cannot know, so the cap applies to
 *  LOGICAL lines (the engine wraps after); texts at or under the cap pass
 *  through unchanged with no hint. */
export function collapseRecallOutput(text: string): string {
  const lines = text.split("\n");
  if (lines.length <= RECALL_COLLAPSED_LINE_LIMIT) return text;
  return [...lines.slice(0, RECALL_COLLAPSED_LINE_LIMIT), RECALL_EXPAND_HINT].join("\n");
}

/** The compact call line (pi's renderRecallCall action/qualifier logic,
 *  pure): `owl_recall ids: n23, o5 · lines 40-60` / `search: … · grep: …` /
 *  with the surviving qualifiers. The render-site mechanism for
 *  drawing it rides the element-tree render idiom — the ToolUse
 *  input-prop rewrite carries no engine support. */
export function recallCallLine(input: Record<string, unknown>): string {
  const parts: string[] = [];
  const ids = Array.isArray(input.ids) ? input.ids.filter((id) => typeof id === "string" && id !== "") : [];
  const query = typeof input.query === "string" && input.query !== "" ? input.query : undefined;
  const grep =
    typeof input.contentPattern === "string" && input.contentPattern !== "" ? input.contentPattern : undefined;
  if (ids.length > 0) {
    parts.push(`ids: ${ids.join(", ")}`);
    if (typeof input.lines === "string" && input.lines !== "") parts.push(`lines ${input.lines}`);
  } else {
    if (query !== undefined) {
      parts.push(`search: ${query}`);
      if (grep !== undefined) parts.push(`grep: ${grep}`);
    } else if (grep !== undefined) {
      parts.push(`grep: ${grep}`);
    } else {
      parts.push("browse");
    }
    if (typeof input.from === "string" && input.from !== "") parts.push(`from ${input.from}`);
    if (typeof input.to === "string" && input.to !== "") parts.push(`to ${input.to}`);
    if (input.includeSuperseded === true) parts.push("superseded");
  }
  if (typeof input.contextLines === "number" && input.contextLines !== 2) parts.push(`ctx ${input.contextLines}`);
  if (input.fullDetails === true) parts.push("full");
  if (input.take !== undefined) parts.push(input.take === 0 ? "take all" : `take ${String(input.take)}`);
  if (typeof input.afterId === "string" && input.afterId !== "") parts.push(`after ${input.afterId}`);
  return parts.length === 0 ? "owl_recall" : `owl_recall ${parts.join(" · ")}`;
}

/** The ToolResult restyle for owl_recall rows: our tool, not errored, an
 *  output text present ⇒ the collapsed text replaces it; everything else
 *  (other tools, error rows, non-text outputs) passes through untouched. */
export function restyleToolResultProps(props: ToolResultPropsLike): ToolResultPropsLike {
  if (props.tool !== OWL_RECALL_FULL_NAME || props.isErrored) return props;
  const output = props.output as { result?: unknown } | null;
  if (typeof output !== "object" || output === null || typeof output.result !== "string") return props;
  return { ...props, output: { ...output, result: collapseRecallOutput(output.result) } };
}
