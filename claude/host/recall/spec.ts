// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// The owl_recall registration spec, as import-free literals: the hooks
// closure cannot import the vendored recall module (its import chain carries
// bare package specifiers the loader refuses), so the description (pi's
// verbatim text) and the JSON Schema (the vendored typebox params,
// JSON-round-tripped — typebox symbols stripped) ship here as data. The
// recall spec suite pins both byte-identical to the vendored tool; when the
// core changes them, regenerate this literal (a build-time
// JSON.parse(JSON.stringify(makeOwlRecallTool().parameters))).
export const OWL_RECALL_TOOL_NAME = "owl_recall";

/** The engine-namespaced full name a tool.call matcher keys on. */
export const OWL_RECALL_FULL_NAME = "mcp__session-owl__owl_recall";

export const OWL_RECALL_TOOL_DESCRIPTION =
  "Browse the full memory tree preserved across compactions — the memory summary shows only the top level. Fetch the detail behind any id (a node, its observations, their verbatim source lines), search all captured memory by regex, or filter by time. Use it proactively: recall before relying on session-derived understanding — search memory, expand a visible related id, add fullDetails for exact source.";

export const OWL_RECALL_INPUT_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    ids: {
      type: "array",
      items: {
        type: "string",
      },
      description:
        "Specific ids to fetch (e.g. ['n23','o5']). Drill into an id from the memory summary or a result's children. The prefix gives the kind: n = node, o = observation. Id lookups return each item exactly as-is and ignore the filters below — a superseded node still returns, with its replacement id.",
    },
    query: {
      type: "string",
      description:
        "Find items by regex (JS) over node summaries and observation content. A pattern that runs too long is stopped; partial matches come back with a note to narrow the query.",
    },
    from: {
      type: "string",
      description: "Start of the time range, inclusive — YYYY-MM-DD HH:mm.",
    },
    to: {
      type: "string",
      description: "End of the time range, exclusive — YYYY-MM-DD HH:mm.",
    },
    includeSuperseded: {
      type: "boolean",
      description:
        "false (default) returns only current memory — superseded and obsolete items are hidden. true includes them as well (shown with 🪦, and where replaced, the replacement id). Ignored when ids is set.",
    },
    fullDetails: {
      type: "boolean",
      description:
        "false (default): summaries shown; true: full observed session entries shown — user and agent messages, agent thinking and tool calls.",
    },
    contentPattern: {
      type: "string",
      description:
        "Extract matching lines from observations as grep-style excerpts (with `contextLines` and line numbers) instead of the whole text — greps every observation, or just those an `ids` drill or `query` search returns.",
    },
    contextLines: {
      type: "integer",
      minimum: 0,
      description: "Lines of context shown before and after each `contentPattern` match (default 2).",
    },
    lines: {
      type: "string",
      description:
        "Read a line range (e.g. '40-60') of a single observation — pass an observation id, or a node id with one observation.",
    },
    take: {
      type: "integer",
      minimum: 0,
      description: "Page size (default 50; 0 returns all).",
    },
    afterId: {
      type: "string",
      description: "Pagination cursor — the last id from the previous page. Omit on the first page.",
    },
  },
};

/** The engine registration spec (ToolSpec): name, the verbatim description,
 *  the JSON Schema inputSchema, and the in-list pin — `isDeferred: false`
 *  puts the schema in the prompt's tool list from the first render (the
 *  discoverability pin; subagent visibility verified live).  */
export function owlRecallToolSpec(): {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  isDeferred: false;
} {
  return {
    name: OWL_RECALL_TOOL_NAME,
    description: OWL_RECALL_TOOL_DESCRIPTION,
    inputSchema: OWL_RECALL_INPUT_SCHEMA,
    isDeferred: false,
  };
}
