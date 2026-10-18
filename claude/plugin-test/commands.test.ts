// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// Engine-kit twin of the commands surface: the closure-clean slice — the
// notify adapter (the ui.log mapping: split-in-order, level dropped)
// and the registration table the engine actually loads (state's COMMAND_SPECS
// — the eight kebab names + pi-verbatim descriptions) — plus the dispatch
// twin: a classic start arms the session and a $.command.run traverses the
// plugin's command.run hook end-to-end under the real kit loader (the
// rewrite-table shims resolve the vendored bare edges the bodies import).
import type { On } from "claude-code";
import { describe, expect, mock as kitMock, test } from "claude-code/testing";
import { makeNotifyAdapter } from "../host/notify/adapter.js";
import { COMMAND_SPECS } from "../host/state.js";

describe("notify adapter — engine-run twin", () => {
  test("a multi-line message posts ONE call with the | delimiter (the block draw mangles newlines)", () => {
    const lines: string[] = [];
    makeNotifyAdapter((text) => lines.push(text))("l1\nl2\nl3", "info");
    expect(lines).toEqual(["l1 | l2 | l3"]);
  });

  test("the level is dropped; the text is byte-identical", () => {
    const seen: string[] = [];
    const notify = makeNotifyAdapter((text) => seen.push(text));
    notify("w", "warning");
    notify("e", "error");
    expect(seen).toEqual(["w", "e"]);
  });

  test("empty lines are dropped before the joined call posts", () => {
    const seen: string[] = [];
    const notify = makeNotifyAdapter((text) => seen.push(text));
    notify("a\n\nb", "info");
    expect(seen).toEqual(["a | b"]);
  });
});

describe("the command registration table — engine-run twin", () => {
  test("exactly the eight kebab commands register", () => {
    const names = COMMAND_SPECS.map((s) => s.name).sort();
    expect(names).toEqual(
      [
        "owl-cat",
        "owl-find",
        "owl-find-all",
        "owl-ls",
        "owl-reobserve-0-obs-chunks",
        "owl-rescan",
        "owl-settings",
        "owl-status",
      ].sort(),
    );
  });

  test("descriptions carry pi's usage strings with the kebab names", () => {
    const ls = COMMAND_SPECS.find((s) => s.name === "owl-ls");
    expect(ls?.description).toBe("List memory — roots, or a node's children. Usage: /owl-ls [nodeId]");
    const settings = COMMAND_SPECS.find((s) => s.name === "owl-settings");
    expect(settings?.description).toBe("Configure SessionOwl Settings");
  });
});

describe("owl-* command dispatch — engine-run twin", () => {
  type CommandDollar = {
    classic: { SessionStart: (e: Record<string, unknown>) => Promise<unknown> };
    command: { run: (input: Record<string, unknown>) => Promise<unknown> };
    tool: { call: (i: Record<string, unknown>) => Promise<unknown> };
  };

  const SESSION = "sess-twin-cmd";
  type World = { logs: string[]; tools: string[]; commands: string[]; agents: string[]; panes: string[] };

  /** The world beneath the plugin, stubbed per the kit's contract — the
   *  same shape the recall twin arms (spies, never blind). */
  function armWorld(on: On): World {
    const world: World = { logs: [], tools: [], commands: [], agents: [], panes: [] };
    kitMock.env(on, { CLAUDE_CONFIG_DIR: "/cfg" });
    kitMock.clock(on);
    on("env.set", () => ({ value: undefined }));
    on("settings.read", () => ({ value: {} }));
    on("fs.read", () => ({ deny: "ENOENT: not in the test fixture" }));
    on("fs.list", () => ({ value: [] }));
    on("fs.write", () => ({ value: undefined }));
    on("tool.register", (_$: unknown, e: unknown) => {
      const name = String((e as { name?: unknown }).name);
      world.tools.push(name);
      return { value: { tool: name } };
    });
    on("command.register", (_$: unknown, e: unknown) => {
      const name = String((e as { name?: unknown }).name);
      world.commands.push(name);
      return { value: { command: name } };
    });
    on("agent.register", (_$: unknown, e: unknown) => {
      const name = String((e as { name?: unknown }).name);
      world.agents.push(name);
      return { value: { agent: name } };
    });
    on("ui.status", () => ({ value: undefined }));
    on("ui.open", (_$: unknown, e: unknown) => {
      world.panes.push(String((e as { title?: unknown }).title));
      return { value: { isPlaced: true } };
    });
    on("ui.log", (_$: unknown, e: unknown) => {
      world.logs.push(String((e as { text?: unknown }).text));
      return { value: undefined };
    });
    on("model.complete", () => ({
      value: {
        isAnswered: false,
        reason: "empty-reply",
        usage: {
          input_tokens: 0,
          output_tokens: 0,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
        },
      },
    }));
    on("classic.SessionStart", () => ({}));
    return world;
  }

  /** Wait until the mod itself answers (retry past its load window). */
  async function warmMod(dollar: CommandDollar): Promise<void> {
    for (let attempt = 0; attempt < 30; attempt++) {
      try {
        const out = await dollar.tool.call({ tool: "mcp__session-owl__mkdir", agentId: "warm-none" });
        if (JSON.stringify(out).includes("deny")) return;
      } catch {
        // mid-load dispatch falls off the chain — retry after a beat
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error("session-owl mod never loaded in the kit");
  }

  async function startSession(dollar: CommandDollar): Promise<void> {
    await warmMod(dollar);
    await dollar.classic.SessionStart({
      source: "startup",
      session_id: SESSION,
      transcript_path: "/nope.jsonl",
      cwd: "/w",
    });
  }

  test("a classic start then $.command.run serves owl-ls and the usage arms through the engine", async ($: unknown, on: On) => {
    const world = armWorld(on);
    const dollar = $ as CommandDollar;
    await startSession(dollar);
    const out = await dollar.command.run({ command: "owl-ls", args: "" });
    expect(out).toEqual({});
    // the serve routes the WHOLE listing to the viewer pane — one root is
    // still a browse surface (ui.open sees it; the notify line does not)
    expect(world.panes).toContain("owl-ls — roots");
    expect(world.logs.some((l) => l.startsWith("📁 nGoal"))).toBe(false); // not via the notify line
    expect(world.logs.some((l) => l.includes("session bootstrap failed"))).toBe(false);
    // the usage arm answers pi's text through the same armed session
    const cat = await dollar.command.run({ name: "owl-cat", args: "  " });
    expect(cat).toEqual({});
    expect(world.logs).toContain("Usage: /owl-cat <id> — give a node id or an observation id.");
  });
});
