// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// Engine-kit twin of the recall surface: the closure-clean slice — the
// registration spec literals (pi-verbatim description + JSON Schema, the
// same data the register serves at session.start) and the render restyle
// (the row cap + expand hint, error-full, pass-through rules) — plus,
// with the rewrite-table shims resolving the vendored bare edges, the
// SERVE path:
// a classic start arms the session and a $.tool.call traverses the
// plugin's tool.call hook end-to-end under the real kit loader (the engine
// raises both events; the test drives the engine, never the plugin's module
// state directly).
import type { On } from "claude-code";
import { describe, expect, mock as kitMock, test } from "claude-code/testing";
import { collapseRecallOutput, recallCallLine, restyleToolResultProps } from "../host/recall/render.js";
import {
  OWL_RECALL_FULL_NAME,
  OWL_RECALL_INPUT_SCHEMA,
  OWL_RECALL_TOOL_DESCRIPTION,
  owlRecallToolSpec,
} from "../host/recall/spec.js";

describe("recall surface — engine-run twin", () => {
  test("the registration spec: owl_recall, the full description, the eleven-field schema", () => {
    const spec = owlRecallToolSpec();
    expect(spec.name).toBe("owl_recall");
    expect(spec.description).toBe(OWL_RECALL_TOOL_DESCRIPTION);
    expect(spec.description.length).toBeGreaterThan(200); // pi's full text, never the short placeholder
    expect(Object.keys((OWL_RECALL_INPUT_SCHEMA as { properties: Record<string, unknown> }).properties)).toHaveLength(
      11,
    );
  });

  test("the full engine name is the plugin-namespaced form a matcher keys on", () => {
    expect(OWL_RECALL_FULL_NAME).toBe("mcp__session-owl__owl_recall");
  });

  test("the render restyle: our tool's long result collapses with the hint; errors never", () => {
    const long = Array.from({ length: 30 }, (_, i) => `row ${i + 1}`).join("\n");
    const restyled = restyleToolResultProps({
      tool: "mcp__session-owl__owl_recall",
      output: { result: long },
      isErrored: false,
    });
    const out = (restyled.output as { result: string }).result;
    expect(out.split("\n")).toHaveLength(13);
    expect(out.endsWith("(Ctrl+O to expand)")).toBe(true);
    const errored = restyleToolResultProps({
      tool: "mcp__session-owl__owl_recall",
      output: { result: long },
      isErrored: true,
    });
    expect((errored.output as { result: string }).result).toBe(long);
    expect(collapseRecallOutput("short")).toBe("short"); // under the cap: untouched, no hint
  });

  test("the compact call line (pi's action/qualifier logic, pure)", () => {
    expect(recallCallLine({ ids: ["n23", "o5"], lines: "40-60" })).toBe("owl_recall ids: n23, o5 · lines 40-60");
    expect(recallCallLine({ query: "rewind", take: 0 })).toBe("owl_recall search: rewind · take all");
    expect(recallCallLine({})).toBe("owl_recall browse");
  });
});

describe("owl_recall serving — engine-run twin", () => {
  type ToolCallDollar = {
    classic: { SessionStart: (e: Record<string, unknown>) => Promise<unknown> };
    tool: { call: (input: Record<string, unknown>) => Promise<{ result?: unknown }> };
  };

  const SESSION = "sess-twin-rk";

  /** What the world-stubs OBSERVE (the mods-API answers are the engine's
   *  side of the seam — never our own code; what our bootstrap does through
   *  them is recorded so the test asserts the real work, not a void). */
  type World = { logs: string[]; tools: string[]; commands: string[]; agents: string[] };

  /** The world beneath the plugin, stubbed per the kit's contract: every
   *  mods-API call the bootstrap makes must be answered (an unanswered one
   *  skips the REST of the hook that made it), each returning `{value}`.
   *  `$.session.messages` is deliberately left unanswered: the rewind check
   *  then degrades to its tripwire tier, as on a host without a view. */
  function armWorld(on: On): World {
    const world: World = { logs: [], tools: [], commands: [], agents: [] };
    kitMock.env(on, { CLAUDE_CONFIG_DIR: "/cfg" });
    kitMock.clock(on);
    on("env.set", () => ({ value: undefined }));
    on("fs.read", () => ({ deny: "ENOENT: not in the test fixture" })); // an empty disk everywhere
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
    on("ui.log", (_$: unknown, e: unknown) => {
      world.logs.push(String((e as { text?: unknown }).text));
      return { value: undefined };
    });
    // no model runs; an unanswered reply would break the boot — the
    // "no reply" shape the completion union carries
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
    // the chain's bottom: classic events carry their own result
    on("classic.SessionStart", () => ({}));
    return world;
  }

  /** Wait until the mod itself answers (its stage gate's deny): the mod
   *  starts loading at the test's first $ use, and a dispatch that lands
   *  mid-load falls off the chain — retry until it is live. */
  async function warmMod(dollar: ToolCallDollar): Promise<void> {
    const tool = (dollar as unknown as { tool: { call: (i: Record<string, unknown>) => Promise<unknown> } }).tool;
    for (let attempt = 0; attempt < 30; attempt++) {
      try {
        const out = await tool.call({ tool: "mcp__session-owl__mkdir", agentId: "warm-none" });
        if (JSON.stringify(out).includes("deny")) return; // the plugin answered
      } catch {
        // mid-load dispatch falls off the chain — retry after a beat
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error("session-owl mod never loaded in the kit");
  }
  async function startSession(dollar: ToolCallDollar): Promise<void> {
    await warmMod(dollar);
    await dollar.classic.SessionStart({
      source: "startup",
      session_id: SESSION,
      transcript_path: "/nope.jsonl",
      cwd: "/w",
    });
  }

  test("a classic start then a $.tool.call SERVE the recall ({result} answers, empty store)", async ($: unknown, on: On) => {
    const world = armWorld(on);
    const dollar = $ as ToolCallDollar;
    await startSession(dollar);
    // the REAL bootstrap ran: it registered owl's surfaces through the
    // engine seam (what it does through it is asserted, not blind)
    expect(world.tools).toContain("owl_recall");
    expect(world.commands.some((c) => c.startsWith("owl-"))).toBe(true);
    expect(world.agents.some((a) => a.includes("observer"))).toBe(true);
    const out = await dollar.tool.call({ tool: OWL_RECALL_FULL_NAME, tool_use_id: "tw-serve" });
    expect(typeof out.result).toBe("string"); // served text — seed-dependent exact text pins elsewhere
    expect(String(out.result).length).toBeGreaterThan(0);
    expect(world.logs.some((l) => l.includes("session bootstrap failed"))).toBe(false);
  });

  test("an in-band error ANSWERS {deny} with pi's exact text (args spread beside tool)", async ($: unknown, on: On) => {
    armWorld(on);
    const dollar = $ as ToolCallDollar;
    await startSession(dollar);
    const EXACT =
      "`lines` reads a range of a single observation — pass one observation id, or a node id with one observation.";
    const out = await dollar.tool.call({
      tool: OWL_RECALL_FULL_NAME,
      tool_use_id: "tw-err",
      lines: "40-60",
    });
    // the hook answers {deny: text} — the error delivery the model reads
    expect(out as unknown).toEqual({ deny: EXACT });
  });
});
