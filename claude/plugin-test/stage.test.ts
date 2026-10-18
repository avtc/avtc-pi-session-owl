// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// Engine-kit twin of the stage suite: the registration surface (specs, the
// caller gate, the offer hiding, the describe pin, the delivery drop, the
// dump routing) loaded from the plugin's own tree under the hooks-environment
// import rules (relative own-file paths only). The full behavior table lives
// in the Node suite (tests/stage); this twin pins the contracts under the
// real kit loader.
import { describe, expect, test } from "claude-code/testing";
import {
  agentSpecTools,
  HANDBACK_TOOL,
  noStageModelSettings,
  stageAgentSpecs,
  stageSubagentType,
} from "../host/stage/agents.js";
import { shouldDropPeerMessage } from "../host/stage/delivery.js";
import { markFabricatedStop, recordDumpHandback, recordDumpOutputRow } from "../host/stage/dumps.js";
import { clearAllStageRuns, createStageRun } from "../host/stage/runs.js";
import {
  DENY_REASON,
  handleStageToolCall,
  resetStageToolExecutors,
  STAGE_TOOL_SPECS,
  stageToolShortName,
} from "../host/stage/tools.js";

describe("stage engine — engine-run twin", () => {
  test("the three agent specs carry the pinned knobs (names, tools, guards)", () => {
    const specs = stageAgentSpecs({
      observerPrompt: "O",
      builderPrompt: "B",
      selectorPrompt: "S",
      settings: noStageModelSettings(),
    });
    expect(specs.map((s) => s.name)).toEqual(["observer", "builder", "selector"]);
    expect(stageSubagentType("observer")).toBe("session-owl:observer");
    for (const s of specs) {
      expect("maxTurns" in s).toBe(false); // pi parity — no turn cap
      expect(s.omitClaudeMd).toBe(true);
      expect(s.background).toBe(true);
    }
    expect(agentSpecTools("observer")).toEqual(["mcp__session-owl__record_observations", HANDBACK_TOOL]);
  });

  test("the caller gate denies non-spawn callers", async () => {
    resetStageToolExecutors();
    const registry = new Map<string, unknown>();
    const r = await handleStageToolCall({ tool: "mcp__session-owl__mkdir", agentId: "somebody" }, (id) =>
      registry.has(id),
    );
    expect(r).toEqual({ deny: DENY_REASON });
    expect(stageToolShortName("Bash")).toBeNull();
    expect(STAGE_TOOL_SPECS.length).toBe(11); // + try_finish + the conditional todo_list join the nine
  });

  test("the delivery drop fires only for registry peer handbacks", () => {
    const registry = new Map<string, unknown>([["ag-9", {}]]);
    const drop = shouldDropPeerMessage(
      { text: '<agent-message from="ag-9">report</agent-message>', origin: { kind: "peer" } },
      registry,
    );
    expect(drop).toContain("ag-9");
    expect(shouldDropPeerMessage({ text: "user", origin: { kind: "user" } }, registry)).toBeNull();
  });

  test("the dump call sites fill the per-run buffer", () => {
    clearAllStageRuns();
    const run = createStageRun("ag-dump", "builder", {
      maxTokens: 10,
      timeoutMs: null,
      noProgressTurns: 0,
    });
    recordDumpOutputRow(run, { uuid: "r1" });
    recordDumpHandback(run, { tool: "SubagentHandback", result: { ok: true } });
    markFabricatedStop(run, "timeout");
    expect(run.dump).toEqual({
      outputRows: [{ uuid: "r1" }],
      handback: { tool: "SubagentHandback", result: { ok: true } },
      fabricatedStop: "timeout",
      sections: [],
      pendingCloser: null,
    });
    clearAllStageRuns();
  });
});
