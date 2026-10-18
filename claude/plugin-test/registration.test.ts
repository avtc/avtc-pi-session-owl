// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// Kit twin of the registration suite: the spec contract under the REAL kit
// loader. The kit's nouns are mocked (no real fs); the engine-dispatched
// lifecycle assertions live in the Node suite's harness.
import { describe, expect, test } from "claude-code/testing";
import { owlRecallToolSpec } from "../host/recall/spec.js";
import { runBackfill } from "../host/start/backfill.js";
import { corePendingEvaluator } from "../host/start/pending.js";

describe("host binding skeleton — engine-run registration", () => {
  test("owl_recall registers in-list (the spec pins isDeferred:false — the register-time form, verified live in t33)", () => {
    const spec = owlRecallToolSpec();
    expect(spec.isDeferred).toBe(false);
    expect(spec.name).toBe("owl_recall");
    expect(spec.description).toContain("memory tree");
  });

  test("the wired start sequence loads under the hooks import rules (runBackfill + the pending evaluator)", () => {
    expect(typeof runBackfill).toBe("function");
    expect(typeof corePendingEvaluator).toBe("function");
  });
});
