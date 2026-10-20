// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// The tool.check self-approval for stage agent spawns: in auto-mode desktop
// sessions the server-side classifier gives no verdict for ambient
// mod-initiated Agent spawns, which denies the stage launch. The plugin
// answers the permission decision itself for exactly its own registered
// agent types; every other call keeps the engine's verdict untouched.
import { beforeEach, describe, expect, test } from "vitest";
import { createHarness } from "../helpers/harness.js";

let h: ReturnType<typeof createHarness>;

beforeEach(async () => {
  h = createHarness();
  await h.load();
});

describe("tool.check — stage spawn self-approval", () => {
  test("a stage agent spawn is allowed outright", async () => {
    const out = await h.dispatch("tool.check", {
      tool: "Agent",
      input: { subagent_type: "session-owl:observer", prompt: "observe" },
    });
    expect(out).toEqual({ decision: "allow" });
  });

  test("every stage type is covered", async () => {
    for (const type of ["session-owl:builder", "session-owl:selector"]) {
      const out = await h.dispatch("tool.check", {
        tool: "Agent",
        input: { subagent_type: type, prompt: "p" },
      });
      expect(out).toEqual({ decision: "allow" });
    }
  });

  test("a foreign agent type passes through with the engine's verdict", async () => {
    const out = await h.dispatch("tool.check", {
      tool: "Agent",
      input: { subagent_type: "other:runner", prompt: "x" },
    });
    expect(out).toEqual({ tool: "Agent", input: { subagent_type: "other:runner", prompt: "x" } });
  });

  test("a spawn without a subagent type passes through", async () => {
    const out = await h.dispatch("tool.check", { tool: "Agent", input: { prompt: "x" } });
    expect(out).toEqual({ tool: "Agent", input: { prompt: "x" } });
  });

  test("a non-Agent tool check passes through", async () => {
    const out = await h.dispatch("tool.check", { tool: "Bash", input: { command: "ls" } });
    expect(out).toEqual({ tool: "Bash", input: { command: "ls" } });
  });
});
