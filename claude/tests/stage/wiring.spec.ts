// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// The stage engine's register wiring, driven through the plugin harness:
// agent-type registration at session start, the offer hiding, the
// register-time deferral pins, the tool.call gate, the prompt.submit
// delivery drop, and the dump routing for stage-agent rows.
import { beforeEach, describe, expect, test } from "vitest";
import { createHarness } from "../helpers/harness.js";

describe("stage wiring — registration + hooks", () => {
  let h: any;
  beforeEach(() => {
    h = createHarness();
    h.env.set("CLAUDE_CONFIG_DIR", "/cfg");
  });

  test("session.start registers the tools, the nine stage tools, commands, and the three agent types", async () => {
    await h.load();
    await h.dispatch("classic.SessionStart", {
      source: "clear",
      session_id: "s-stage",
      transcript_path: "/t.jsonl",
      cwd: "/w",
    });
    const names = h.tools.registered.map((t: any) => String(t.name));
    expect(names).toContain("owl_recall");
    for (const short of ["record_observations", "mkdir", "mv", "merge", "supersede", "set_meta", "ls", "cat", "find"]) {
      expect(names).toContain(short);
    }
    const agents = h.agents.registered.map((a: any) => String(a.name));
    expect(agents).toEqual(["observer", "builder", "selector"]);
    const observer = h.agents.registered.find((a: any) => a.name === "observer") as Record<string, unknown>;
    expect("maxTurns" in observer).toBe(false); // pi parity — no turn cap on any stage agent
    expect(observer.omitClaudeMd).toBe(true);
    expect(observer.background).toBe(true);
    expect((observer.tools as string[])[0]).toBe("mcp__session-owl__record_observations");
    // the prompts are the vendored stage prompts (verbatim)
    expect(String(observer.prompt)).toMatch(/^You read one chunk of a coding session/);
    const builder = h.agents.registered.find((a: any) => a.name === "builder") as Record<string, unknown>;
    expect(String(builder.prompt).length).toBeGreaterThan(500);
  });

  test("registration is idempotent across a second start", async () => {
    await h.load();
    await h.dispatch("classic.SessionStart", {
      source: "clear",
      session_id: "s-a",
      transcript_path: "/t.jsonl",
      cwd: "/w",
    });
    await h.dispatch("session.start", { cwd: "/w", surface: null, isInteractive: false });
    expect(h.tools.registered).toHaveLength(14); // owl_recall + stage_launched + await_stage + 11 stage tools (incl. the conditional todo_list), no doubles
    expect(h.agents.registered).toHaveLength(3);
  });

  test("agent.offer hides the three namespaced stage types only", async () => {
    await h.load();
    const hidden = await h.dispatch("agent.offer", {
      agent: "session-owl:observer",
      description: "d",
      source: "plugin",
    });
    expect(hidden).toEqual({ isOffered: false });
    expect(
      await h.dispatch("agent.offer", { agent: "session-owl:builder", description: "d", source: "plugin" }),
    ).toEqual({
      isOffered: false,
    });
    const pass = await h.dispatch("agent.offer", { agent: "Explore", description: "d", source: "built-in" });
    expect(pass).toMatchObject({ agent: "Explore" }); // passes through (next's echo)
  });

  test("the registered specs carry the deferral pins (register-time isDeferred, t33)", async () => {
    await h.load();
    await h.dispatch("classic.SessionStart", {
      source: "startup",
      session_id: "s-wire",
      transcript_path: "/t.jsonl",
      cwd: "/w",
    });
    const stage = h.tools.registered.find((t: any) => t.name === "record_observations");
    expect(stage).toMatchObject({ isDeferred: true });
    const recall = h.tools.registered.find((t: any) => t.name === "owl_recall");
    expect(recall).toMatchObject({ isDeferred: false });
  });

  test("tool.call serves stage tools only to live spawns (the gate)", async () => {
    await h.load();
    const denied = await h.dispatch("tool.call", {
      tool: "mcp__session-owl__mkdir",
      agentId: "not-a-spawn",
      summary: "x",
      importance: "low",
    });
    expect(denied).toEqual({
      deny: "session-owl internal tool; for memory recall use the mcp__session-owl__owl_recall tool",
    });
    // a live run with no executor installed: explicit deny, never silent
    // success (liveness = a stage run in the map, not registry membership)
    const bridge = h.bridge();
    bridge.recordSpawn("ag-live", { stage: "builder" });
    const runs = await import("../../host/stage/runs.js");
    runs.createStageRun("ag-live", "builder", { maxTokens: 100, timeoutMs: null, noProgressTurns: 0 });
    const unwired = await h.dispatch("tool.call", { tool: "mcp__session-owl__mkdir", agentId: "ag-live" });
    expect(unwired).toMatchObject({ deny: expect.stringContaining("no executor installed") });
    // completion ends the run: membership may persist, the gate closes
    runs.completeStageRun("ag-live");
    const closed = await h.dispatch("tool.call", { tool: "mcp__session-owl__mkdir", agentId: "ag-live" });
    expect(closed).toEqual({
      deny: "session-owl internal tool; for memory recall use the mcp__session-owl__owl_recall tool",
    });
    bridge.forgetSpawn("ag-live");
  });

  test("a rejecting stage-tool executor answers in-band — the hook never fails open to the engine's no-answer fallback", async () => {
    await h.load();
    const bridge = h.bridge();
    const runs = await import("../../host/stage/runs.js");
    const tools = await import("../../host/stage/tools.js");
    bridge.recordSpawn("ag-reject", { stage: "builder" });
    runs.createStageRun("ag-reject", "builder", { maxTokens: 100, timeoutMs: null, noProgressTurns: 0 });
    tools.registerStageToolExecutor("mkdir", () => Promise.reject(new Error("kaboom")));
    try {
      const answered = await h.dispatch("tool.call", { tool: "mcp__session-owl__mkdir", agentId: "ag-reject" });
      expect(answered).toMatchObject({ result: expect.stringContaining("session-owl stage tool failed") });
      expect(answered).toMatchObject({ result: expect.stringContaining("kaboom") });
    } finally {
      tools.resetStageToolExecutors();
      runs.completeStageRun("ag-reject");
      bridge.forgetSpawn("ag-reject");
    }
  });

  test("the stage executor receives the call's full arguments (args ride top-level on the event)", async () => {
    await h.load();
    const bridge = h.bridge();
    const runs = await import("../../host/stage/runs.js");
    const tools = await import("../../host/stage/tools.js");
    bridge.recordSpawn("ag-args", { stage: "observer" });
    runs.createStageRun("ag-args", "observer", { maxTokens: 100, timeoutMs: null, noProgressTurns: 0 });
    let captured: Record<string, unknown> | null = null;
    tools.registerStageToolExecutor("record_observations", (e) => {
      captured = e;
      return { result: "ok" };
    });
    try {
      const answered = await h.dispatch("tool.call", {
        tool: "mcp__session-owl__record_observations",
        agentId: "ag-args",
        observations: [{ summary: "s", importance: "low", sourceEntryIds: ["e1"] }],
      });
      expect(answered).toEqual({ result: "ok" });
      expect(captured).not.toBeNull();
      expect((captured as unknown as { observations: unknown[] }).observations).toHaveLength(1);
    } finally {
      tools.resetStageToolExecutors();
      runs.completeStageRun("ag-args");
      bridge.forgetSpawn("ag-args");
    }
  });

  test("a re-entry failure asks the guard in the hook's place — stage tools still answer", async () => {
    await h.load();
    await h.dispatch("classic.SessionStart", {
      source: "startup",
      session_id: "s-re",
      transcript_path: "/t.jsonl",
      cwd: "/w",
    });
    await h.dispatch("session.start", { cwd: "/w", surface: null, isInteractive: false });
    const bridge = h.bridge();
    const runs = await import("../../host/stage/runs.js");
    const tools = await import("../../host/stage/tools.js");
    bridge.recordSpawn("ag-reentry", { stage: "builder" });
    runs.createStageRun("ag-reentry", "builder", { maxTokens: 100, timeoutMs: null, noProgressTurns: 0 });
    tools.registerStageToolExecutor("mkdir", () => ({ result: "made dir" }));
    try {
      // the engine refuses to run the hook beneath our own frame and asks
      // the catch handler instead — the stage tool must not fall to the
      // engine's generic no-hook-answered fallback
      const answered = await h.dispatchFailure(
        "tool.call",
        { tool: "mcp__session-owl__mkdir", agentId: "ag-reentry" },
        { kind: "re-entry", budget: 10_000 },
      );
      expect(answered).toEqual({ result: "made dir" });
      // a non-stage tool under re-entry falls through to what runs beneath
      const passthrough = await h.dispatchFailure(
        "tool.call",
        { tool: "NotOwl", agentId: "ag-reentry" },
        { kind: "re-entry", budget: 10_000 },
      );
      expect(passthrough).toEqual({ tool: "NotOwl", agentId: "ag-reentry" });
    } finally {
      tools.resetStageToolExecutors();
      runs.completeStageRun("ag-reentry");
      bridge.forgetSpawn("ag-reentry");
    }
  });

  test("every tool.call dispatch is diagnosed to the log before serving (live evidence of arrival)", async () => {
    await h.load();
    // arming first (production order): the bridge must be armed before any
    // handler can reach the services — the diag line rides them
    await h.dispatch("classic.SessionStart", {
      source: "startup",
      session_id: "s-d",
      transcript_path: "/t.jsonl",
      cwd: "/w",
    });
    await h.dispatch("session.start", { cwd: "/w", surface: null, isInteractive: false });
    await h.dispatch("tool.call", { tool: "mcp__session-owl__mkdir", agentId: "not-a-spawn" });
    expect(h.uiLog.some((l: string) => l.includes("tool.call dispatch") && l.includes("mkdir"))).toBe(true);
  });

  test("every session.receive delivery is diagnosed to the log with its origin shape", async () => {
    await h.load();
    await h.dispatch("classic.SessionStart", {
      source: "startup",
      session_id: "s-r",
      transcript_path: "/t.jsonl",
      cwd: "/w",
    });
    await h.dispatch("session.start", { cwd: "/w", surface: null, isInteractive: false });
    const foreign = await h.dispatch("session.receive", {
      text: "hello from elsewhere",
      origin: { kind: "bridge" },
    });
    expect(foreign).toMatchObject({ text: "hello from elsewhere" });
    const line = h.uiLog.find((l: string) => l.includes("session.receive:"));
    expect(line).toBeDefined();
    expect(line).toContain("bridge");
    expect(line).toContain("hello from elsewhere");
  });

  test("prompt.submit drops peer handbacks of registered stage agents only", async () => {
    await h.load();
    const bridge = h.bridge();
    bridge.recordSpawn("ag-hb", { stage: "observer" });
    const dropped = await h.dispatch("prompt.submit", {
      text: '<agent-message from="ag-hb">report</agent-message>',
      origin: { kind: "peer" },
      wait: false,
    });
    expect(dropped).toMatchObject({ drop: expect.stringContaining("ag-hb") });
    const kept = await h.dispatch("prompt.submit", { text: "hi", origin: { kind: "user" }, wait: false });
    expect(kept).toMatchObject({ text: "hi" });
    bridge.forgetSpawn("ag-hb");
  });

  test("session.receive CONSUMES a stage agent's handback before queueing — no prompt, no notice", async () => {
    await h.load();
    const bridge = h.bridge();
    bridge.recordSpawn("ag-rcv", { stage: "observer" });
    // the engine's own wrapper text, peer origin: taken here it is never
    // queued, never entering the transcript and never reaching prompt.submit
    const consumed = await h.dispatch("session.receive", {
      text: '<agent-message from="ag-rcv">report</agent-message>',
      origin: { kind: "peer" },
    });
    expect(consumed).toMatchObject({ consumed: expect.stringContaining("ag-rcv") });
    // a foreign agent's handback and a plain delivery pass through (queued)
    const foreign = await h.dispatch("session.receive", {
      text: '<agent-message from="someone-else">hi</agent-message>',
      origin: { kind: "peer" },
    });
    expect(foreign).toMatchObject({ text: '<agent-message from="someone-else">hi</agent-message>' });
    const plain = await h.dispatch("session.receive", { text: "remote prompt", origin: { kind: "bridge" } });
    expect(plain).toMatchObject({ text: "remote prompt" });
    bridge.forgetSpawn("ag-rcv");
  });

  test("the handback drop survives the run's completion (t15 ordering: delivery AFTER turn.complete)", async () => {
    await h.load();
    const bridge = h.bridge();
    const runs = await import("../../host/stage/runs.js");
    bridge.recordSpawn("ag-seq", { stage: "observer" });
    runs.createStageRun("ag-seq", "observer", { maxTokens: 100, timeoutMs: null, noProgressTurns: 0 });
    // the run completes — the shim's finally removes the run state (the
    // routed completion triggers it; simulated here without the spawn path)
    await h.dispatch("turn.complete", {
      answer: "done",
      isAborted: false,
      turnId: "t1",
      agentId: "ag-seq",
      reason: "answer",
    });
    runs.completeStageRun("ag-seq"); // the shim's finally
    expect(runs.getStageRun("ag-seq")).toBeUndefined(); // the run state is gone
    expect(bridge.spawnRegistry.has("ag-seq")).toBe(true); // membership retained
    const dropped = await h.dispatch("prompt.submit", {
      text: "report",
      origin: { kind: "peer" },
      context: ['<agent-message from="ag-seq">report</agent-message>'],
      wait: false,
    });
    expect(dropped).toMatchObject({ drop: expect.stringContaining("ag-seq") });
    bridge.forgetSpawn("ag-seq");
  });

  test("session.append routes a stage agent's rows to the run's dump buffer, not the mirror", async () => {
    await h.load();
    await h.dispatch("classic.SessionStart", {
      source: "clear",
      session_id: "s-dump",
      transcript_path: "/t.jsonl",
      cwd: "/w",
    });
    const bridge = h.bridge();
    bridge.recordSpawn("ag-dump", { stage: "observer" });
    const runs = await import("../../host/stage/runs.js");
    const run = runs.createStageRun("ag-dump", "observer", {
      maxTokens: 100,
      timeoutMs: null,
      noProgressTurns: 0,
    });
    await h.dispatch("session.append", {
      uuid: "row-1",
      parentUuid: null,
      agentId: "ag-dump",
      message: { role: "assistant", content: [{ type: "text", text: "stage output" }] },
    });
    expect(run.dump.outputRows).toHaveLength(1);
    // and nothing landed in the session mirror files for that row
    // (toEqual — a stray path prints itself on failure)
    expect(h.fsPaths().filter((p: string) => /m\d+-/.test(p))).toEqual([]);
    runs.completeStageRun("ag-dump");
    bridge.forgetSpawn("ag-dump");
  });
});
