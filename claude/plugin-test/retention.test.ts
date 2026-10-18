// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>
//
// Kit twin (the two-surface rule): the retention planner's closure-clean
// slice. The spawn-based helper suite and the injected-seam caller suite
// live in the Node project (claude/tests/retention/) — the kit mirrors the
// pure decisions: surface gating, retention-off, argv assembly, and the
// log-and-continue contract.
import { test } from "claude-code/testing";
import { planPruneInvocation, type RunProcessFn, runPruneHelper } from "../host/retention/prune-caller.js";

const input = {
  surface: null,
  retentionDays: 7,
  followCleanupPeriodDays: false,
  configDir: "/cfg",
  pluginRoot: "/plugins/session-owl",
};

test("plan: retention-off = no sweep; CLI runs; desktop defers", () => {
  const off = planPruneInvocation({ ...input, retentionDays: null });
  if (off.run) throw new Error("retention-off must not run");
  if (off.reason !== "retention-off") throw new Error(`wrong reason: ${off.reason}`);

  const cli = planPruneInvocation(input);
  if (!cli.run || cli.reason !== "cli") throw new Error("CLI start must run the sweep");

  const desktop = planPruneInvocation({ ...input, surface: "desktop" });
  if (desktop.run || desktop.reason !== "desktop-defers") throw new Error("desktop must defer to a CLI run");
});

test("plan: argv carries --apply + the mode flags; follow-cleanup is exclusive of days", () => {
  const days = planPruneInvocation(input);
  const want = ["--config-dir", "/cfg", "--apply", "--days", "7"];
  if (JSON.stringify(days.args) !== JSON.stringify(want)) throw new Error(`days argv: ${JSON.stringify(days.args)}`);

  const follow = planPruneInvocation({ ...input, retentionDays: null, followCleanupPeriodDays: true });
  const wantFollow = ["--config-dir", "/cfg", "--apply", "--follow-cleanup"];
  if (JSON.stringify(follow.args) !== JSON.stringify(wantFollow)) {
    throw new Error(`follow argv: ${JSON.stringify(follow.args)}`);
  }
});

test("run: a helper failure degrades to {ok:false} — logged, never thrown", async () => {
  const fail: RunProcessFn = async () => ({ stdout: "", exitCode: 2 });
  const logs: string[] = [];
  const res = await runPruneHelper({ runProcess: fail, log: (m) => logs.push(m) }, input);
  if (res.ok) throw new Error("a non-zero exit must degrade");
  if (logs.length !== 1) throw new Error("exactly one log line expected");

  const boom: RunProcessFn = async () => {
    throw new Error("spawn failed");
  };
  const res2 = await runPruneHelper({ runProcess: boom, log: () => {} }, input);
  if (res2.ok || res2.error !== "spawn failed") throw new Error("a thrown run must degrade with the message");
});
