// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// The owl_recall spec literals — the registration surface's description and
// JSON Schema must stay byte-identical to the vendored tool's (pi-verbatim,
// registration/description decisions): the hooks closure cannot import the vendored module (its
// import chain carries bare package specifiers the loader refuses), so the
// spec ships as import-free literals and THIS suite pins them against the
// vendored source — any core drift fails here until the literal is
// regenerated.
import { describe, expect, test } from "vitest";
import { makeOwlRecallTool } from "../../core/src/recall/owl-recall.js";
import {
  OWL_RECALL_FULL_NAME,
  OWL_RECALL_INPUT_SCHEMA,
  OWL_RECALL_TOOL_DESCRIPTION,
  owlRecallToolSpec,
} from "../../host/recall/spec.js";

describe("owl_recall spec literals — pi-verbatim, drift-pinned", () => {
  test("the description is byte-identical to the vendored tool's", () => {
    expect(OWL_RECALL_TOOL_DESCRIPTION).toBe(makeOwlRecallTool().description);
  });

  test("the JSON Schema is the vendored typebox params, JSON-round-tripped (symbols stripped)", () => {
    const expected = JSON.parse(JSON.stringify(makeOwlRecallTool().parameters));
    expect(OWL_RECALL_INPUT_SCHEMA).toEqual(expected);
  });

  test("the schema carries all eleven fields with their descriptions and constraints", () => {
    const props = (OWL_RECALL_INPUT_SCHEMA as { properties: Record<string, unknown> }).properties;
    expect(Object.keys(props)).toEqual([
      "ids",
      "query",
      "from",
      "to",
      "includeSuperseded",
      "fullDetails",
      "contentPattern",
      "contextLines",
      "lines",
      "take",
      "afterId",
    ]);
    expect((props.contextLines as { minimum: number }).minimum).toBe(0);
    expect((props.take as { minimum: number }).minimum).toBe(0);
  });

  test("the literals are pure JSON (JSON round-trip stable — nothing a loader could choke on)", () => {
    expect(JSON.parse(JSON.stringify(OWL_RECALL_INPUT_SCHEMA))).toEqual(OWL_RECALL_INPUT_SCHEMA);
    expect(JSON.parse(JSON.stringify(OWL_RECALL_TOOL_DESCRIPTION))).toBe(OWL_RECALL_TOOL_DESCRIPTION);
  });

  test("the full engine name is the plugin-namespaced form", () => {
    expect(OWL_RECALL_FULL_NAME).toBe("mcp__session-owl__owl_recall");
  });
});

describe("owl_recall spec — register-time deferral pin (2.1.293, t33)", () => {
  test("the spec pins isDeferred:false — the in-list fact rides the registration", () => {
    expect(owlRecallToolSpec()).toMatchObject({ isDeferred: false });
  });
});
