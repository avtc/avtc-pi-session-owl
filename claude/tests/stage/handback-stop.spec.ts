// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// The stage handback stop: a stage agent's handback call is its last act —
// the payload already reached the stage tools, so the agent is stopped
// mid-call (its completion message would otherwise arrive as a peer prompt
// the drop path must refuse, printing the engine's "Prompt dropped by a
// hook" notice). The stop is marked deliberate (the run layer forgives it
// as a clean finish) and the completion routing is synthesized in the same
// breath, because a stopped loop raises no turn.complete of its own.
import { beforeEach, describe, expect, test } from "vitest";
import * as bridge from "../../host/engine-bridge.js";
import { createHarness } from "../helpers/harness.js";

let h: ReturnType<typeof createHarness>;

beforeEach(async () => {
  h = createHarness();
  await h.load();
});

describe("tool.call — the stage handback stop", () => {
  test("a registered stage agent is stopped after its handback call", async () => {
    bridge.recordSpawn("owl-hb-1", {});
    const parked = bridge.awaitAgentCompletion("owl-hb-1");
    try {
      const out = await h.dispatch("tool.call", {
        tool: "SubagentHandback",
        agentId: "owl-hb-1",
        input: { message: "report" },
      });
      expect(out).toEqual({ tool: "SubagentHandback", agentId: "owl-hb-1", input: { message: "report" } });
      expect(h.toolCalls.calls).toContainEqual({ tool: "TaskStop", task_id: "owl-hb-1" });
      const completion = await parked;
      expect(completion.isAborted).toBe(true);
      expect(completion.agentId).toBe("owl-hb-1");
    } finally {
      bridge.forgetSpawn("owl-hb-1");
    }
  });

  test("a foreign agent's handback passes through untouched", async () => {
    const out = await h.dispatch("tool.call", {
      tool: "SubagentHandback",
      agentId: "not-ours",
      input: { message: "x" },
    });
    expect(out).toEqual({ tool: "SubagentHandback", agentId: "not-ours", input: { message: "x" } });
    expect(h.toolCalls.calls.filter((c) => (c as { tool?: unknown }).tool === "TaskStop")).toEqual([]);
  });

  test("a stop that fails leaves the handback untouched", async () => {
    bridge.recordSpawn("owl-hb-2", {});
    h.flunkNextToolCall();
    try {
      const out = await h.dispatch("tool.call", {
        tool: "SubagentHandback",
        agentId: "owl-hb-2",
      });
      expect(out).toEqual({ tool: "SubagentHandback", agentId: "owl-hb-2" });
    } finally {
      bridge.forgetSpawn("owl-hb-2");
    }
  });
});
