// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>
//
// The prune caller's gating and tolerance: surface check (CLI runs, desktop
// defers), retention-off skip, argv assembly, and the log-and-continue
// contract (a helper failure NEVER blocks the start sequence).
import { describe, expect, test } from "vitest";
import { planPruneInvocation, type RunProcessFn, runPruneHelper } from "../../host/retention/prune-caller.js";

const INPUT = {
  surface: null as string | null,
  retentionDays: 7 as number | null,
  followCleanupPeriodDays: false,
  configDir: "/cfg",
  pluginRoot: "/plugins/session-owl",
};

describe("planPruneInvocation — the startup gating", () => {
  test("retention OFF (the keep-forever default): no sweep at all, on any surface", () => {
    const plan = planPruneInvocation({ ...INPUT, retentionDays: null, followCleanupPeriodDays: false });
    expect(plan.run).toBe(false);
    expect(plan.reason).toBe("retention-off");
    expect(plan.script).toBeNull();
  });

  test("CLI surfaces (null = -p, terminal) run; desktop defers to the next CLI run", () => {
    expect(planPruneInvocation({ ...INPUT, surface: null }).reason).toBe("cli");
    expect(planPruneInvocation({ ...INPUT, surface: "terminal" }).reason).toBe("cli");
    const desktop = planPruneInvocation({ ...INPUT, surface: "desktop" });
    expect(desktop.run).toBe(false);
    expect(desktop.reason).toBe("desktop-defers");
  });

  test("argv assembly: --apply always on, days vs follow-cleanup exclusive", () => {
    const days = planPruneInvocation({ ...INPUT, retentionDays: 7 });
    expect(days.args).toEqual(["--config-dir", "/cfg", "--apply", "--days", "7"]);
    const follow = planPruneInvocation({ ...INPUT, retentionDays: null, followCleanupPeriodDays: true });
    expect(follow.args).toEqual(["--config-dir", "/cfg", "--apply", "--follow-cleanup"]);
    expect(days.script?.replaceAll("\\", "/")).toBe("/plugins/session-owl/helpers/prune.mjs");
  });
});

describe("runPruneHelper — the tolerance contract", () => {
  test("a successful run parses the helper's report line", async () => {
    const runProcess: RunProcessFn = async (argv) => {
      expect(argv[0]).toBe("node");
      expect(argv[1].replaceAll("\\", "/")).toBe("/plugins/session-owl/helpers/prune.mjs");
      return { stdout: `noise\n${JSON.stringify({ mode: "days", removed: 2 })}\n`, exitCode: 0 };
    };
    const logs: string[] = [];
    const res = await runPruneHelper({ runProcess, log: (m) => logs.push(m) }, INPUT);
    expect(res.ok).toBe(true);
    expect(res.report).toEqual({ mode: "days", removed: 2 });
    expect(logs).toEqual([]);
  });

  test("a non-zero exit degrades to {ok:false} + a log line — never throws, never blocks backfill", async () => {
    const runProcess: RunProcessFn = async () => ({ stdout: "", exitCode: 2 });
    const logs: string[] = [];
    const res = await runPruneHelper({ runProcess, log: (m) => logs.push(m) }, INPUT);
    expect(res.ok).toBe(false);
    expect(res.error).toContain("exited 2");
    expect(logs).toEqual(["mirror retention sweep failed"]);
  });

  test("a truncated stdout is not a report — same degrade", async () => {
    const trunc: RunProcessFn = async () => ({ stdout: '{"mode":', exitCode: 0, isStdoutTruncated: true });
    const logs: string[] = [];
    const res = await runPruneHelper({ runProcess: trunc, log: (m) => logs.push(m) }, INPUT);
    expect(res.ok).toBe(false);
    expect(res.error).toContain("truncated");
  });

  test("a thrown run (spawn failure) and a malformed report both degrade the same way", async () => {
    const boom: RunProcessFn = async () => {
      throw new Error("spawn failed");
    };
    const logs: string[] = [];
    const log = (m: string) => logs.push(m);
    const res1 = await runPruneHelper({ runProcess: boom, log }, INPUT);
    expect(res1.ok).toBe(false);
    expect(res1.error).toBe("spawn failed");
    const garbage: RunProcessFn = async () => ({ stdout: "not json", exitCode: 0 });
    const res2 = await runPruneHelper({ runProcess: garbage, log }, INPUT);
    expect(res2.ok).toBe(false);
    expect(logs.length).toBe(2);
  });

  test("a not-running plan (retention-off / desktop) resolves ok without invoking the process", async () => {
    let calls = 0;
    const runProcess: RunProcessFn = async () => {
      calls += 1;
      return { stdout: "{}", exitCode: 0 };
    };
    const res = await runPruneHelper({ runProcess, log: () => {} }, { ...INPUT, retentionDays: null });
    expect(res.ok).toBe(true);
    expect(res.skipped).toBe("retention-off");
    expect(res.report).toBeUndefined();
    expect(calls).toBe(0);
  });
});
