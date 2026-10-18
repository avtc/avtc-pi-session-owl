// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// Packaged-resolution smoke: pins that the plugin's own tree resolves the
// local shims and the vendored core byte-copies — the root test env resolves
// the real devDeps and would not catch a missing shim.
//
// IMPORT SPELLING: the engine's hooks environment (which plugin-test specs
// share) refuses bare package specifiers through the whole import closure —
// every import here is a relative own-file path (shims by path, typebox via
// the installed ./node_modules tree). The vendored core's bare VALUE imports
// are rewritten to the local shims by the sync table; this spec pins the
// shims AND the vendored chains that load through them.
import { describe, expect, test } from "claude-code/testing";
import { applyCreateNode, applyRecordObservation } from "../core/src/graph/mutations.js";
import { makeOwlRecallTool } from "../core/src/recall/owl-recall.js";
import { ImportanceSchema, NodeStateSchema, PageSchema } from "../core/src/schema.js";
import { makeObservation, O_INITIAL_PROMPT, SessionOwlGraph } from "../core/src/types.js";
import { agentLoop } from "../shims/pi-agent-core/index.js";
import { StringEnum } from "../shims/pi-ai/index.js";
import { type Component, Text } from "../shims/pi-tui/index.js";

describe("packaged resolution — shims + vendored core", () => {
  test("pi-tui shim: Text constructs, renders wrapped lines, satisfies Component", () => {
    const t = new Text("hello recall world", 1, 0);
    const lines = t.render(12);
    expect(lines.length).toBeGreaterThanOrEqual(2);
    expect(lines[0]?.startsWith(" ")).toBe(true);
    expect(lines.join("\n")).toContain("hello");
    const asComponent: Component = t;
    expect(Array.isArray(asComponent.render(20))).toBe(true);
  });

  test("pi-ai shim: StringEnum builds a typebox string-enum schema", () => {
    const s = StringEnum(["a", "b"], { description: "x" });
    const j = JSON.stringify(s);
    expect(j).toContain('"enum":["a","b"]');
    expect(j).toContain('"description":"x"');
  });

  test("pi-agent-core shim: agentLoop is the explicit throwing stub (runStage is the runtime)", () => {
    expect(() => agentLoop([], {} as never, {} as never, undefined, undefined as never)).toThrow(
      "the raw agentLoop has no engine counterpart",
    );
  });

  test("vendored schema.ts loads in the packaged tree (the pi-ai edge rewritten): the shared tool schemas build", () => {
    const imp = JSON.stringify(ImportanceSchema);
    expect(imp).toContain('"enum":["crit","high","med","low"]');
    const state = JSON.stringify(NodeStateSchema);
    expect(state).toContain('"enum"');
    const page = PageSchema as { properties?: Record<string, unknown> };
    expect(Object.keys(page.properties ?? {})).toContain("take");
    expect(Object.keys(page.properties ?? {})).toContain("afterId");
  });

  test("vendored owl-recall.ts loads in the packaged tree (the pi-tui edge rewritten): the tool factory builds", () => {
    const tool = makeOwlRecallTool();
    expect(tool.name).toBe("owl_recall");
    expect(typeof tool.execute).toBe("function");
  });

  test("vendored core: graph mutators run byte-identical", () => {
    const graph = new SessionOwlGraph({ nodes: new Map(), observations: new Map(), nextObsId: 1, nextNodeId: 1 });
    applyCreateNode(graph, {
      id: "n1",
      summary: "goal",
      importance: "high",
      parentNode: null,
      state: "active",
    });
    applyRecordObservation(graph, {
      obs: makeObservation({
        id: O_INITIAL_PROMPT,
        summary: "initial prompt",
        importance: "med",
        sourceEntryIds: [],
        timestamp: "2026-01-01T00:00:00.000Z",
        parentNode: "n1",
      }),
    });
    expect(graph.observations.size).toBe(1);
    expect(graph.hasInitialPrompt).toBe(true);
  });
});
