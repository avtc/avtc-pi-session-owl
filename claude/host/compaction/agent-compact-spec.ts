// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// The owl_compact registration spec, as import-free literals: the hooks
// closure cannot import the vendored compaction module (its import chain
// carries bare package specifiers the loader refuses), so the description
// (pi's verbatim text) and the JSON Schema (the vendored typebox params,
// JSON-round-tripped — typebox symbols stripped) ship here as data, exactly
// as the recall spec does. The spec suite pins both byte-identical to the
// vendored tool.

/** The tool name, as the model calls it. */
const OWL_COMPACT_TOOL_NAME = "owl_compact";

/** The engine-namespaced full name a tool.call matcher keys on. */
export const OWL_COMPACT_FULL_NAME = "mcp__session-owl__owl_compact";

/** The owl_compact description (pi's verbatim text). */
export const OWL_COMPACT_TOOL_DESCRIPTION =
  "Runs compaction at the end of this turn. continue_notes will be rendered into compaction summary - " +
  "pass everything you keep in mind to effectively continue planned work after compaction. " +
  "The past turns are observed by owl, but future plans are only in your mind. " +
  "Consult with owl_recall to see root nodes summaries if needed";

/** The owl_compact input schema (the vendored typebox params, JSON-round-tripped). */
export const OWL_COMPACT_INPUT_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    continue_notes: {
      type: "string",
      description: "What you need to know after compaction to effectively continue planned work",
      minLength: 1,
    },
  },
  required: ["continue_notes"],
};

/** The tool spec for `$.tool.register` (boot arm: in the prompt's list from
 *  the first request — the prefix cache builds with it present). */
export function owlCompactToolSpec(): {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  isDeferred: false;
} {
  return {
    name: OWL_COMPACT_TOOL_NAME,
    description: OWL_COMPACT_TOOL_DESCRIPTION,
    inputSchema: OWL_COMPACT_INPUT_SCHEMA,
    isDeferred: false,
  };
}

/** The mid-session-enable variant: registered behind ToolSearch (its schema
 *  never enters the prompt until the model asks for it by name), so enabling
 *  the knob mid-session spends no prefix cache. */
export function owlCompactDeferredToolSpec(): {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  isDeferred: true;
} {
  return { ...owlCompactToolSpec(), isDeferred: true };
}
