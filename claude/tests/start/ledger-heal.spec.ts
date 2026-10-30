// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// The ledger-heal caller suite: the node binary leads the argv (a bare
// .mjs path would shell-open), the plan carries --apply, and every failure
// degrades to done:false — the heal never throws into the load.
import { describe, expect, test } from "vitest";
import { planLedgerHealInvocation, runLedgerHeal } from "../../host/start/ledger-heal.js";

describe("planLedgerHealInvocation", () => {
  test("builds the node helper invocation with --apply", () => {
    const plan = planLedgerHealInvocation({ pluginRoot: "E:/x/claude/", sessionDir: "C:/cfg/session-owl/sessions/s1" });
    expect(plan.script).toBe("E:/x/claude/helpers/ledger-compact.mjs");
    expect(plan.args).toEqual(["--session-dir", "C:/cfg/session-owl/sessions/s1", "--apply"]);
  });
});

describe("runLedgerHeal", () => {
  const input = { pluginRoot: "E:/x/claude", sessionDir: "C:/s1" };

  test("the spawn carries the NODE BINARY first", async () => {
    const argvs: string[][] = [];
    await runLedgerHeal(
      {
        runProcess: async (argv) => {
          argvs.push(argv);
          return { stdout: JSON.stringify({ done: true, noop: true, restatedEdges: 0, uniqueEdges: 3 }), exitCode: 0 };
        },
        log: () => {},
      },
      input,
    );
    expect(argvs[0]?.[0]).toBe("node");
    expect(argvs[0]?.[1]).toContain("ledger-compact.mjs");
    expect(argvs[0]?.slice(2)).toEqual(["--session-dir", "C:/s1", "--apply"]);
  });

  test("a success report passes through", async () => {
    const r = await runLedgerHeal(
      {
        runProcess: async () => ({
          stdout: JSON.stringify({ done: true, restatedEdges: 15, uniqueEdges: 3 }),
          exitCode: 0,
        }),
        log: () => {},
      },
      input,
    );
    expect(r).toEqual({ done: true, restatedEdges: 15, uniqueEdges: 3, noop: undefined });
  });

  test("a non-zero exit degrades to done:false, never throws", async () => {
    const r = await runLedgerHeal(
      {
        runProcess: async () => ({ stdout: JSON.stringify({ done: false, error: "batch unreadable" }), exitCode: 1 }),
        log: () => {},
      },
      input,
    );
    expect(r).toEqual({ done: false });
  });

  test("a thrown seam degrades to done:false, never throws", async () => {
    const r = await runLedgerHeal(
      {
        runProcess: async () => {
          throw new Error("no seam");
        },
        log: () => {},
      },
      input,
    );
    expect(r).toEqual({ done: false });
  });

  test("empty stdout degrades to done:false", async () => {
    const r = await runLedgerHeal(
      {
        runProcess: async () => ({ stdout: "", exitCode: 0 }),
        log: () => {},
      },
      input,
    );
    expect(r).toEqual({ done: false });
  });
});
