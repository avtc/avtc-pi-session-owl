// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// The stage agent specs: exact tool sets, the bare-name/namespaced pair, the
// model/effort chain, and pi's tool-name inventory parity (the vendored
// MUTATE_TOOL_NAMES is the authority — a drift here breaks the agents'
// tool sets).
import { describe, expect, test } from "vitest";
import { MUTATE_TOOL_NAMES } from "../../core/src/builder/tools.js";
// the Selector's mutation subset is composed of vendored core constants
// (MKDIR/MV/MERGE/SELECTOR_SET_META — pi's SELECTOR_MUTATE_TOOL_NAMES)
import { MERGE_TOOL, MKDIR_TOOL, MV_TOOL, SELECTOR_SET_META_TOOL } from "../../core/src/graph/mutate-tools.js";
import { TRY_FINISH_TOOL } from "../../core/src/graph/read-tools.js";
import {
  agentSpecTools,
  effortFromThinking,
  type StageModelSettings,
  stageAgentSpecs,
  stageEffortFromSettings,
  stageModelFromSettings,
  stageSubagentType,
  stageToolName,
} from "../../host/stage/agents.js";

const NO_MODELS: StageModelSettings = {
  defaultModel: null,
  defaultThinkingLevel: null,
  observerModel: null,
  observerThinkingLevel: null,
  builderModel: null,
  builderThinkingLevel: null,
  selectorModel: null,
  selectorThinkingLevel: null,
};

describe("stage agent specs", () => {
  test("the namespaced pair: spec name is the bare short form, subagentType is <plugin>:<name>", () => {
    expect(stageSubagentType("observer")).toBe("session-owl:observer");
    expect(stageSubagentType("builder")).toBe("session-owl:builder");
    expect(stageSubagentType("selector")).toBe("session-owl:selector");
  });

  test("the Observer sees exactly its one record tool plus the engine's handback, mcp-prefixed", () => {
    expect(agentSpecTools("observer")).toEqual(["mcp__session-owl__record_observations", "SubagentHandback"]);
  });

  test("the Builder's set is the vendored MUTATE_TOOL_NAMES plus the read views, try_finish, and the handback", () => {
    const tools = agentSpecTools("builder");
    expect(new Set(tools)).toEqual(
      new Set(
        [...MUTATE_TOOL_NAMES, "ls", "cat", "find", TRY_FINISH_TOOL]
          .map((n) => stageToolName(n))
          .concat("SubagentHandback"),
      ),
    );
    expect(tools).toHaveLength(10); // pi's makeBuilderTools: 9 tools incl. try_finish + the handback
  });

  test("the Selector's set is its vendored mutation subset plus reads, try_finish, the conditional todo_list, and the engine file tools", () => {
    const tools = agentSpecTools("selector");
    const selectorMutate = new Set([MKDIR_TOOL, MV_TOOL, MERGE_TOOL, SELECTOR_SET_META_TOOL]);
    const graph = new Set(
      [...selectorMutate, "ls", "cat", "find", TRY_FINISH_TOOL, "todo_list"].map((n) => stageToolName(n)),
    );
    for (const t of tools)
      if (!graph.has(t)) expect(["Read", "Grep", "Glob", "LS", "SubagentHandback"].includes(t)).toBe(true);
    expect(tools).toHaveLength(14); // 8 graph + todo_list + 4 engine file reads + the handback
    expect(tools).toContain("Read");
    expect(tools).toContain(stageToolName("todo_list")); // AgentSpec.tools is exhaustive — the conditional tool MUST ride the spec
  });

  test("specs carry the pinned knobs: no turn cap (pi parity), omitClaudeMd, background, required description", () => {
    const specs = stageAgentSpecs({
      observerPrompt: "OBS",
      builderPrompt: "BLD",
      selectorPrompt: "SEL",
      settings: NO_MODELS,
    });
    expect(specs.map((s) => s.name)).toEqual(["observer", "builder", "selector"]);
    for (const s of specs) {
      expect(s.description.length).toBeGreaterThan(0);
      expect("maxTurns" in s).toBe(false); // pi sets no turn cap anywhere — the spec carries none
      expect(s.omitClaudeMd).toBe(true);
      expect(s.background).toBe(true);
      expect(s.model).toBeUndefined(); // nothing set — the session's model
      expect(s.effort).toBeUndefined();
    }
    expect(specs[0].prompt).toBe("OBS");
    expect(specs[1].prompt).toBe("BLD");
    expect(specs[2].prompt).toBe("SEL");
  });

  test("the model chain: stage setting beats default beats session (undefined)", () => {
    expect(stageModelFromSettings({ ...NO_MODELS, observerModel: "haiku" }, "observer")).toBe("haiku");
    expect(stageModelFromSettings({ ...NO_MODELS, defaultModel: "sonnet" }, "builder")).toBe("sonnet");
    expect(stageModelFromSettings({ ...NO_MODELS, observerModel: "haiku", defaultModel: "sonnet" }, "observer")).toBe(
      "haiku",
    );
    expect(stageModelFromSettings(NO_MODELS, "selector")).toBeUndefined();
  });

  test("effort maps thinking levels: off/minimal/null omit, levels pass through", () => {
    expect(effortFromThinking(null)).toBeUndefined();
    expect(effortFromThinking("off")).toBeUndefined();
    expect(effortFromThinking("minimal")).toBeUndefined();
    expect(effortFromThinking("low")).toBe("low");
    expect(effortFromThinking("high")).toBe("high");
    expect(effortFromThinking("xhigh")).toBe("xhigh");
    expect(effortFromThinking("max")).toBe("max");
  });

  test("the effort chain: stage level beats default beats undefined", () => {
    expect(stageEffortFromSettings({ ...NO_MODELS, observerThinkingLevel: "high" }, "observer")).toBe("high");
    expect(stageEffortFromSettings({ ...NO_MODELS, defaultThinkingLevel: "low" }, "builder")).toBe("low");
    expect(
      stageEffortFromSettings({ ...NO_MODELS, builderThinkingLevel: "off", defaultThinkingLevel: "low" }, "builder"),
    ).toBeUndefined();
    expect(stageEffortFromSettings(NO_MODELS, "selector")).toBeUndefined();
  });
});
