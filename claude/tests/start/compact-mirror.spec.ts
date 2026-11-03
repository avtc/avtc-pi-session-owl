// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// The resume-time compaction decision: the threshold keeps the rewrite off
// healthy stores, the runner degrades to {done:false} on any seam failure,
// and the backfill hook fires only when the sweep's census crosses.
import { describe, expect, test } from "vitest";
import { planMirrorCompactInvocation, runMirrorCompact, shouldCompactMirror } from "../../host/start/compact-mirror.js";

describe("shouldCompactMirror — the census threshold", () => {
  test("healthy stores never cross", () => {
    expect(shouldCompactMirror({ lines: 24_000, uniqueUuids: 24_000 })).toBe(false);
    expect(shouldCompactMirror({ lines: 24_100, uniqueUuids: 24_000 })).toBe(false); // 100 dups — noise
    expect(shouldCompactMirror({ lines: 0, uniqueUuids: 0 })).toBe(false);
  });
  test("the dup-laden store crosses", () => {
    expect(shouldCompactMirror({ lines: 160_482, uniqueUuids: 24_147 })).toBe(true); // the measured shape
    expect(shouldCompactMirror({ lines: 5_000, uniqueUuids: 3_000 })).toBe(true); // 40% dup over the floor
  });
  test("a large-but-thin duplicate mass stays (ratio guard)", () => {
    expect(shouldCompactMirror({ lines: 100_000, uniqueUuids: 90_000 })).toBe(false); // 10k dups but only 10%
  });
});

describe("planMirrorCompactInvocation", () => {
  test("always --apply, plugin-relative script", () => {
    const plan = planMirrorCompactInvocation({ pluginRoot: "E:/x/claude/", configDir: "C:/cfg", sessionId: "s1" });
    expect(plan.script).toBe("E:/x/claude/helpers/mirror-compact.mjs");
    expect(plan.args).toEqual(["--config-dir", "C:/cfg", "--session-id", "s1", "--apply"]);
  });
});

describe("runMirrorCompact — degradation", () => {
  test("the spawn carries the NODE BINARY first (a bare .mjs path would shell-open, not run)", async () => {
    const argvs: string[][] = [];
    await runMirrorCompact(
      {
        runProcess: async (argv) => {
          argvs.push(argv);
          return { stdout: JSON.stringify({ done: true, kept: 1, removed: 0 }), exitCode: 0 };
        },
        log: () => {},
      },
      { pluginRoot: "E:/x/claude", configDir: "C:/cfg", sessionId: "s1" },
    );
    expect(argvs[0]?.[0]).toBe("node");
    expect(argvs[0]?.[1]).toContain("mirror-compact.mjs");
  });

  test("a thrown seam degrades to done:false, never throws", async () => {
    const logs: string[] = [];
    const report = await runMirrorCompact(
      {
        runProcess: async () => {
          throw new Error("process seam unavailable");
        },
        log: (m) => logs.push(m),
      },
      { pluginRoot: "E:/x/claude", configDir: "C:/cfg", sessionId: "s1" },
    );
    expect(report.done).toBe(false);
    expect(logs.join("\n")).toContain("unavailable");
  });
  test("a non-zero exit parses the error report", async () => {
    const report = await runMirrorCompact(
      {
        runProcess: async () => ({ stdout: JSON.stringify({ done: false, error: "batch read failed" }), exitCode: 1 }),
        log: () => {},
      },
      { pluginRoot: "E:/x/claude", configDir: "C:/cfg", sessionId: "s1" },
    );
    expect(report.done).toBe(false);
    expect(report.error).toContain("batch read failed");
  });
  test("a successful run reports the kept/removed counts", async () => {
    const report = await runMirrorCompact(
      {
        runProcess: async () => ({
          stdout: JSON.stringify({ done: true, kept: 24_147, removed: 136_335 }),
          exitCode: 0,
        }),
        log: () => {},
      },
      { pluginRoot: "E:/x/claude", configDir: "C:/cfg", sessionId: "s1" },
    );
    expect(report).toMatchObject({ done: true, kept: 24_147, removed: 136_335 });
  });
  test("a transcript path rides the invocation as --transcript", () => {
    const plan = planMirrorCompactInvocation({
      pluginRoot: "E:/x/claude",
      configDir: "C:/cfg",
      sessionId: "s1",
      transcriptPath: "C:/projects/x/tx.jsonl",
    });
    expect(plan.args).toContain("--transcript");
    expect(plan.args[plan.args.indexOf("--transcript") + 1]).toBe("C:/projects/x/tx.jsonl");
  });

  test("no transcript path keeps the plain invocation", () => {
    const plan = planMirrorCompactInvocation({
      pluginRoot: "E:/x/claude",
      configDir: "C:/cfg",
      sessionId: "s1",
      transcriptPath: null,
    });
    expect(plan.args).not.toContain("--transcript");
  });
});
