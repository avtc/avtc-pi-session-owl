// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// The resume-time compaction decision: the threshold keeps the rewrite off
// healthy stores, the runner degrades to {done:false} on any seam failure,
// and the backfill hook fires only when the sweep's census crosses.
import { describe, expect, test } from "vitest";
import {
  planMirrorCompactInvocation,
  runMirrorCompact,
  shouldCompactMirror,
  shouldStitchMirrorParents,
  sweepWithStitch,
} from "../../host/start/compact-mirror.js";

describe("runMirrorCompact — one rewrite per session at a time", () => {
  test("concurrent callers share one helper run and its report", async () => {
    let spawns = 0;
    const report = { done: true, noop: false, kept: 3, removed: 0 };
    const runProcess = async () => {
      spawns += 1;
      await new Promise((r) => setTimeout(r, 30));
      return { stdout: `${JSON.stringify(report)}\n`, exitCode: 0 };
    };
    const input = { pluginRoot: "P", configDir: "C", sessionId: "S", transcriptPath: null };
    const [a, b] = await Promise.all([
      runMirrorCompact({ runProcess, log: () => {} }, input),
      runMirrorCompact({ runProcess, log: () => {} }, input),
    ]);
    expect(spawns).toBe(1);
    expect(a.done).toBe(true);
    expect(b.done).toBe(true);
  });
});

describe("sweepWithStitch — the load-time heal lane", () => {
  const row = (uuid: string, parent: string | null, door?: string) => ({
    uuid,
    parentUuid: parent,
    row: door === undefined ? { role: "user" } : { door },
  });
  const sweepOf = (rows: { uuid: string; parentUuid: string | null; row: unknown }[]) => ({
    rows,
    lines: rows.length,
    uniqueUuids: rows.length,
  });

  test("an artifact edge fires the heal and serves the re-swept rows", async () => {
    const rows: { uuid: string; parentUuid: string | null; row: unknown }[] = [];
    for (let i = 0; i < 800; i += 1) rows.push(row(`r${String(i)}`, i === 0 ? null : `r${String(i - 1)}`));
    rows.push(row("custom", "r5", "compaction"));
    let healed = 0;
    let reswept = 0;
    const logs: string[] = [];
    const out = await sweepWithStitch(
      sweepOf(rows),
      async () => {
        healed += 1;
        return true;
      },
      async () => {
        reswept += 1;
        const fresh = rows.map((r) => (r.uuid === "custom" ? { ...r, parentUuid: "r799" } : r));
        return sweepOf(fresh);
      },
      (m) => logs.push(m),
    );
    expect(healed).toBe(1);
    expect(reswept).toBe(1);
    expect(out.compacted).toBe(true);
    expect(out.sweep.rows.find((r) => r.uuid === "custom")?.parentUuid).toBe("r799");
    expect(logs[0]).toContain("mirror compacted");
  });

  test("a healthy sweep never heals (the boot stays read-only)", async () => {
    const rows = [row("a", null), row("b", "a"), row("custom", "b", "compaction")];
    let healed = 0;
    const out = await sweepWithStitch(
      sweepOf(rows),
      async () => {
        healed += 1;
        return true;
      },
      async () => sweepOf(rows),
      () => {},
    );
    expect(healed).toBe(0);
    expect(out.compacted).toBe(false);
    expect(out.sweep.rows).toBe(rows);
  });

  test("a failed heal keeps the original rows (a later load retries)", async () => {
    const rows = [row("a", null), row("custom", "a", "compaction")];
    rows.push(...[]);
    const artifact = rows.slice();
    artifact.push(row("x1", null));
    for (let i = 1; i < 50; i += 1) artifact.push(row(`x${String(i + 1)}`, `x${String(i)}`));
    artifact.push(row("c2", "x1", "compaction"));
    const out = await sweepWithStitch(
      sweepOf(artifact),
      async () => false,
      async () => {
        throw new Error("unreachable");
      },
      () => {},
    );
    expect(out.compacted).toBe(false);
    expect(out.sweep.rows).toBe(artifact);
  });
});

describe("shouldStitchMirrorParents — the artifact-edge signature", () => {
  const row = (uuid: string, parent: string | null, door?: string) => ({
    uuid,
    parentUuid: parent,
    row: door === undefined ? { role: "user" } : { door },
  });

  test("a compaction custom parented hundreds of rows back fires (the rewrite-era artifact)", () => {
    const rows = [];
    for (let i = 0; i < 800; i += 1) rows.push(row(`r${String(i)}`, i === 0 ? null : `r${String(i - 1)}`));
    rows.push(row("custom", "r5", "compaction")); // 795 rows back — the walker skips the whole span
    expect(shouldStitchMirrorParents(rows)).toBe(true);
  });

  test("a null-parent custom (the engine boundary row is never delivered) stays quiet", () => {
    const rows = [row("a", null), row("custom", null, "compaction")];
    expect(shouldStitchMirrorParents(rows)).toBe(false);
  });

  test("the live capture's near inference parent stays quiet", () => {
    const rows = [row("a", null), row("b", "a"), row("custom", "b", "compaction")];
    expect(shouldStitchMirrorParents(rows)).toBe(false);
  });

  test("a far-back parent on an ordinary door is the engine's own edge — quiet", () => {
    const rows = [];
    for (let i = 0; i < 800; i += 1) rows.push(row(`r${String(i)}`, i === 0 ? null : `r${String(i - 1)}`));
    rows.push(row("resume-prompt", "r5", "prompt"));
    expect(shouldStitchMirrorParents(rows)).toBe(false);
  });

  test("an empty sweep stays quiet", () => {
    expect(shouldStitchMirrorParents([])).toBe(false);
  });
});

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
