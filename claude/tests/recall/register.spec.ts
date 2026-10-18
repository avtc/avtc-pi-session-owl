// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// The owl_recall registration lifecycle: the tool registers at the awaited
// first session.start when owl is enabled OR conflict-paused (a session
// starting disabled never gets it); the registered spec carries the REAL
// pi-verbatim description + schema (not the skeleton's placeholder); a
// mid-session enable registers it then (once per process — the
// registration-gate helpers).
import { beforeEach, describe, expect, test } from "vitest";
import { _resetRecallRegistration, registerOwlRecallIfNewlyEnabled } from "../../host/recall/register.js";
import { OWL_RECALL_INPUT_SCHEMA, OWL_RECALL_TOOL_DESCRIPTION } from "../../host/recall/spec.js";
import * as state from "../../host/state.js";

beforeEach(() => {
  state._resetForTest();
  _resetRecallRegistration();
});

describe("the registration spec — the real pi-verbatim surface", () => {
  test("starting enabled ⇒ owl_recall registers with the full description + schema", () => {
    const specs = state.pendingToolSpecs();
    const recall = specs.find((s) => s.name === "owl_recall");
    expect(recall).toBeDefined();
    expect(recall?.description).toBe(OWL_RECALL_TOOL_DESCRIPTION);
    expect(recall?.inputSchema).toEqual(OWL_RECALL_INPUT_SCHEMA);
  });

  test("starting DISABLED ⇒ the tool is ABSENT (a disabled owl registers no recall)", () => {
    state.setOwlEnabled(false);
    const specs = state.pendingToolSpecs();
    expect(specs.find((s) => s.name === "owl_recall")).toBeUndefined();
  });
});

describe("mid-session enable — the once-per-process registration", () => {
  test("enabled after a disabled start ⇒ registerIfNewlyEnabled registers once, then never again", async () => {
    state.setOwlEnabled(false);
    expect(state.pendingToolSpecs().find((s) => s.name === "owl_recall")).toBeUndefined();
    state.setOwlEnabled(true);
    const registered: string[] = [];
    const toolRegister = async (spec: { name: string }) => {
      registered.push(spec.name);
    };
    await registerOwlRecallIfNewlyEnabled(toolRegister);
    expect(registered).toEqual(["owl_recall"]);
    await registerOwlRecallIfNewlyEnabled(toolRegister); // idempotent
    expect(registered).toEqual(["owl_recall"]);
  });

  test("no-op while still disabled (nothing registers early)", async () => {
    state.setOwlEnabled(false);
    state.pendingToolSpecs(); // consume the gate
    state.setOwlEnabled(true);
    state.setOwlEnabled(false); // flipped back before any registration ran
    const registered: string[] = [];
    const toolRegister = async (spec: { name: string }) => {
      registered.push(spec.name);
    };
    await registerOwlRecallIfNewlyEnabled(toolRegister);
    expect(registered).toEqual([]);
  });

  test("a start-gate registration marks the mid-session path DONE (an enable off→on cycle re-registers nothing)", async () => {
    state.setOwlEnabled(true);
    const specs = state.pendingToolSpecs(); // the start gate consumes owl_recall
    expect(specs.some((s) => s.name === "owl_recall")).toBe(true);
    // the user flips enabled off then on in the pane — fireAfterChange calls
    // registerOwlRecallIfNewlyEnabled; a second $.tool.register would be a
    // duplicate registration inside the closure
    state.setOwlEnabled(false);
    state.setOwlEnabled(true);
    const registered: string[] = [];
    const toolRegister = async (spec: { name: string }) => {
      registered.push(spec.name);
    };
    await registerOwlRecallIfNewlyEnabled(toolRegister);
    expect(registered).toEqual([]); // already registered at the gate — NO double
  });
});
