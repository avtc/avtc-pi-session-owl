// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// The per-agent executor binding layer: a run installs its tool bodies for
// the agent the shim just spawned (onSpawn), and the tool.call handler
// dispatches to THAT agent's bodies — the global executor map stays for
// process-wide tools, the per-agent layer is what the stage runs bind.
import { beforeEach, describe, expect, test } from "vitest";
import { recordDumpSection } from "../../host/stage/dumps.js";
import { clearAllStageRuns, completeStageRun, createStageRun } from "../../host/stage/runs.js";
import {
  bindAgentTools,
  DENY_REASON,
  handleStageToolCall,
  registerStageToolExecutor,
  resetStageToolExecutors,
  unbindAgentTools,
} from "../../host/stage/tools.js";

const CFG = { maxTokens: 1000, timeoutMs: 1000, noProgressTurns: 3 };

beforeEach(() => {
  resetStageToolExecutors();
  clearAllStageRuns();
});

describe("per-agent tool bodies", () => {
  test("a live run's call dispatches to ITS binding (not the global map)", async () => {
    createStageRun("ag-1", "observer", CFG);
    const global: string[] = [];
    registerStageToolExecutor("record_observations", () => {
      global.push("global");
      return { result: "" };
    });
    const mine: string[] = [];
    bindAgentTools("ag-1", {
      record_observations: async (e) => {
        mine.push(String((e as { observations?: unknown[] }).observations?.length ?? 0));
        return { result: "accepted: all" };
      },
    });
    const out = await handleStageToolCall(
      {
        tool: "mcp__session-owl__record_observations",
        agentId: "ag-1",
        observations: [{ summary: "s" }],
      } as unknown as { tool: string; agentId?: string },
      (id) => "ag-1".includes(id),
    );
    expect(mine).toEqual(["1"]);
    expect(global).toEqual([]);
    expect(out).toEqual({ result: "accepted: all" });
  });

  test("two runs' bindings are independent (last spawn does not win globally)", async () => {
    createStageRun("ag-a", "builder", CFG);
    createStageRun("ag-b", "builder", CFG);
    bindAgentTools("ag-a", { mkdir: async () => ({ result: { content: [{ type: "text", text: "A" }] } }) });
    bindAgentTools("ag-b", { mkdir: async () => ({ result: { content: [{ type: "text", text: "B" }] } }) });
    const live = (id: string) => id === "ag-a" || id === "ag-b";
    const a = await handleStageToolCall({ tool: "mcp__session-owl__mkdir", agentId: "ag-a" }, live);
    const b = await handleStageToolCall({ tool: "mcp__session-owl__mkdir", agentId: "ag-b" }, live);
    expect((a as { result: { content: Array<{ text: string }> } }).result.content[0].text).toBe("A");
    expect((b as { result: { content: Array<{ text: string }> } }).result.content[0].text).toBe("B");
  });

  test("the gate still denies non-live callers before any binding is consulted", async () => {
    bindAgentTools("ag-gone", { mkdir: async () => ({ result: { content: [] } }) });
    const out = await handleStageToolCall({ tool: "mcp__session-owl__mkdir", agentId: "ag-gone" }, () => false);
    expect(out).toEqual({ deny: DENY_REASON });
  });

  test("unbind (run end) falls back to the no-executor deny", async () => {
    createStageRun("ag-2", "observer", CFG);
    bindAgentTools("ag-2", { record_observations: async () => ({ result: { content: [] } }) });
    unbindAgentTools("ag-2");
    const out = await handleStageToolCall(
      { tool: "mcp__session-owl__record_observations", agentId: "ag-2" },
      () => true,
    );
    expect(out).toEqual({
      deny: 'session-owl: stage tool "record_observations" has no executor installed (stage runs not wired)',
    });
  });

  test("a global executor still serves when the agent has no binding (owl-wide tools)", async () => {
    createStageRun("ag-3", "observer", CFG);
    registerStageToolExecutor("mkdir", () => ({ result: { content: [{ type: "text", text: "G" }] } }));
    const out = await handleStageToolCall({ tool: "mcp__session-owl__mkdir", agentId: "ag-3" }, () => true);
    expect((out as { result: { content: Array<{ text: string }> } }).result.content[0].text).toBe("G");
  });
});

describe("dump sections", () => {
  test("run-scoped sections append in order (the chunk/pass forensics)", () => {
    const run = createStageRun("ag-d", "observer", CFG);
    recordDumpSection(run, '<chunk i="1/2">\n<allowed>\ne1\ne2\n</allowed>\n');
    recordDumpSection(run, "</chunk>\n");
    expect(run.dump.sections).toEqual(['<chunk i="1/2">\n<allowed>\ne1\ne2\n</allowed>\n', "</chunk>\n"]);
  });

  test("an opener stashes its closer; completion flushes it (balanced even when the caller never closes)", () => {
    const run = createStageRun("ag-c", "builder", CFG);
    recordDumpSection(run, '<pass n="1">\n');
    expect(run.dump.pendingCloser).toBe("</pass>\n");
    // a plain section does not disturb the pending closer
    recordDumpSection(run, "<allowed>\ne1\n</allowed>\n");
    expect(run.dump.pendingCloser).toBe("</pass>\n");
    completeStageRun("ag-c"); // removed + flushed
    expect(run.dump.sections).toEqual(['<pass n="1">\n', "<allowed>\ne1\n</allowed>\n", "</pass>\n"]);
    expect(run.dump.pendingCloser).toBeNull();
  });

  test("completion without an opener flushes nothing", () => {
    const run = createStageRun("ag-nc", "observer", CFG);
    completeStageRun("ag-nc");
    expect(run.dump.sections).toEqual([]);
  });
});
