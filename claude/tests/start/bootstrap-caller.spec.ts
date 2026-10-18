// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// The bootstrap-caller suite: the over-cap transcript's automatic rung —
// CLI surfaces stream helpers/bootstrap.mjs via the injected process-run
// seam (plan + run + summary parse), non-CLI surfaces defer, and the
// manual command /owl-status documents is the same helper, shell-ready.
import { describe, expect, test } from "vitest";
import {
  manualBootstrapCommand,
  planBootstrapInvocation,
  runBootstrapHelper,
} from "../../host/start/bootstrap-caller.js";

const BASE = {
  transcriptPath: "/t/sess.jsonl",
  configDir: "/cfg",
  sessionId: "sess-1",
  pluginRoot: "/plugins/session-owl",
};

describe("planBootstrapInvocation", () => {
  test("CLI surfaces (null = -p, terminal) run the helper with the full argv", () => {
    for (const surface of [null, "terminal"] as const) {
      const plan = planBootstrapInvocation({ ...BASE, surface });
      expect(plan.run).toBe(true);
      expect(plan.reason).toBe("cli");
      expect(plan.script).toBe("/plugins/session-owl/helpers/bootstrap.mjs");
      expect(plan.args).toEqual(["/t/sess.jsonl", "--config-dir", "/cfg", "--session-id", "sess-1"]);
    }
  });

  test("non-CLI surfaces defer to the next CLI open", () => {
    const plan = planBootstrapInvocation({ ...BASE, surface: "desktop" });
    expect(plan.run).toBe(false);
    expect(plan.reason).toBe("non-cli-defers");
    expect(plan.script).toBe(null);
  });
});

describe("runBootstrapHelper", () => {
  const logs: string[] = [];
  const deps = {
    log: (message: string, _err?: unknown) => logs.push(message),
  };

  test("exit 0 + a done summary line on stdout ⇒ ok with the parsed report", async () => {
    const runs: string[][] = [];
    const result = await runBootstrapHelper(
      {
        ...deps,
        runProcess: async (argv) => {
          runs.push(argv);
          return { stdout: `noise\n{"done":true,"rows":42,"pages":3}\n`, exitCode: 0 };
        },
      },
      { ...BASE, surface: "terminal" },
    );
    expect(result.ok).toBe(true);
    expect(result.report?.rows).toBe(42);
    expect(runs[0]?.[0]).toBe("node");
    expect(runs[0]?.[1]?.endsWith("helpers/bootstrap.mjs")).toBe(true);
  });

  test("an error summary line ⇒ {ok:false} with the helper's reason — never throws", async () => {
    const result = await runBootstrapHelper(
      { ...deps, runProcess: async () => ({ stdout: `{"done":false,"error":"ENOENT"}`, exitCode: 1 }) },
      { ...BASE, surface: null },
    );
    expect(result.ok).toBe(false);
    expect(result.error).toContain("ENOENT");
  });

  test("a truncated stdout ⇒ {ok:false} (the summary cannot be trusted)", async () => {
    const result = await runBootstrapHelper(
      { ...deps, runProcess: async () => ({ stdout: `{"done":true,"rows":1`, exitCode: 0, isStdoutTruncated: true }) },
      { ...BASE, surface: "terminal" },
    );
    expect(result.ok).toBe(false);
    expect(result.error).toContain("truncated");
  });

  test("exit 0 with no summary line still succeeds (the batches are the output)", async () => {
    const result = await runBootstrapHelper(
      { ...deps, runProcess: async () => ({ stdout: "", exitCode: 0 }) },
      { ...BASE, surface: "terminal" },
    );
    expect(result.ok).toBe(true);
  });

  test("a thrown run (helper missing) ⇒ {ok:false} with the message — never throws", async () => {
    const result = await runBootstrapHelper(
      {
        ...deps,
        runProcess: async () => {
          throw new Error("spawn failed");
        },
      },
      { ...BASE, surface: "terminal" },
    );
    expect(result.ok).toBe(false);
    expect(result.error).toBe("spawn failed");
    expect(logs.some((l) => l.includes("transcript bootstrap failed"))).toBe(true);
  });
});

describe("manualBootstrapCommand", () => {
  test("the /owl-status hint is the same helper, shell-ready with quoted paths", () => {
    const cmd = manualBootstrapCommand({ ...BASE, pluginRoot: "/plug ins/session-owl" });
    expect(cmd).toContain("node");
    expect(cmd).toContain('"/plug ins/session-owl/helpers/bootstrap.mjs"');
    expect(cmd).toContain("--config-dir");
    expect(cmd).toContain("sess-1");
  });
});
