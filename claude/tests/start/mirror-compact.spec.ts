// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// The mirror compaction helper suite: one line per uuid (latest write
// wins), old batches deleted, dry-run by default, idempotent, sweep
// compatibility after the rewrite.
import { execFile } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, test } from "vitest";
import { tempDir } from "../../../tests/temp-dir.js";
import { createMemoryFs } from "../../host/storage/fs-adapter.js";
import { sweepMirror } from "../../host/storage/mirror.js";

const run = promisify(execFile);
const HELPER = join(__dirname, "..", "..", "helpers", "mirror-compact.mjs");

function line(uuid: string, parent: string | null, text: string): string {
  return JSON.stringify({ uuid, parentUuid: parent, row: { role: "user", content: text } });
}

/** A dir with 3 unique rows written by TWO producers (the second a full
 *  re-stream — the duplication shape) plus one crash-window extra row the
 *  second producer added. */
function dupDir(): { cfg: string; sessDir: string } {
  const tmp = tempDir("owl-compact");
  const cfg = join(tmp, "cfg");
  const sessDir = join(cfg, "session-owl", "sessions", "s1");
  mkdirSync(sessDir, { recursive: true });
  writeFileSync(
    join(sessDir, "m1-aaaa1111.jsonl"),
    `${line("u1", null, "one")}\n${line("u2", "u1", "two")}\n${line("u3", "u2", "three")}\n`,
  );
  writeFileSync(
    join(sessDir, "m2-bbbb2222.jsonl"),
    `${line("u1", null, "one")}\n${line("u2", "u1", "two")}\n${line("u3", "u2", "three")}\n${line("u4", "u3", "four")}\n`,
  );
  return { cfg, sessDir };
}

function countLines(dir: string): { total: number; files: string[] } {
  const files = readdirSync(dir).filter((f) => /^m\d+-[0-9a-f]+(?:\.k\d+)?\.jsonl$/.test(f));
  let total = 0;
  for (const f of files) {
    for (const l of readFileSync(join(dir, f), "utf8").split("\n")) {
      if (l !== "") total += 1;
    }
  }
  return { total, files };
}

function memSweep(dir: string) {
  const mem = createMemoryFs();
  const sep = join("x", "y").slice(1, -1);
  const norm = (p: string) => p.split(sep).join("/");
  for (const f of readdirSync(dir)) {
    mem.adapter.writeText(`${norm(dir)}/${f}`, readFileSync(join(dir, f), "utf8"));
  }
  return sweepMirror(mem.adapter, norm(dir));
}

describe("helpers/mirror-compact.mjs", () => {
  test("dry-run (default): reports the projection, writes and deletes nothing", async () => {
    const { cfg, sessDir } = dupDir();
    const before = countLines(sessDir);
    const { stdout } = await run(process.execPath, [HELPER, "--config-dir", cfg, "--session-id", "s1"]);
    const report = JSON.parse(stdout.trim().split("\n").pop() ?? "{}");
    expect(report.done).toBe(true);
    expect(report.noop).toBe(false);
    expect(report.kept).toBe(4);
    expect(report.removed).toBe(3); // 7 lines - 4 unique
    expect(report.applied).toBe(false);
    const after = countLines(sessDir);
    expect(after.total).toBe(before.total); // untouched
  }, 30_000);

  test("--apply: one line per uuid survives, old batches deleted, the sweep reads the same rows", async () => {
    const { cfg, sessDir } = dupDir();
    const sweepBefore = await memSweep(sessDir);
    const uuidsBefore = [...new Set(sweepBefore.rows.map((r) => r.uuid))].sort();
    const { stdout } = await run(process.execPath, [HELPER, "--config-dir", cfg, "--session-id", "s1", "--apply"]);
    const report = JSON.parse(stdout.trim().split("\n").pop() ?? "{}");
    expect(report.done).toBe(true);
    expect(report.kept).toBe(4);
    expect(report.removed).toBe(3);
    expect(report.filesIn).toBe(2);
    expect(report.filesOut).toBeGreaterThanOrEqual(1);
    const after = countLines(sessDir);
    expect(after.total).toBe(4); // ONE copy — the verbatim mirror as designed
    // the sweep still resolves every row (format compatibility)
    const sweepAfter = await memSweep(sessDir);
    expect([...new Set(sweepAfter.rows.map((r) => r.uuid))].sort()).toEqual(uuidsBefore);
    expect(sweepAfter.uniqueUuids).toBe(4);
  }, 30_000);

  test("idempotent: a second --apply run is a no-op", async () => {
    const { cfg } = dupDir();
    await run(process.execPath, [HELPER, "--config-dir", cfg, "--session-id", "s1", "--apply"]);
    const { stdout } = await run(process.execPath, [HELPER, "--config-dir", cfg, "--session-id", "s1", "--apply"]);
    const report = JSON.parse(stdout.trim().split("\n").pop() ?? "{}");
    expect(report.done).toBe(true);
    expect(report.noop).toBe(true);
    expect(report.removed).toBe(0);
    expect(report.filesOut).toBe(0);
  }, 30_000);

  test("a fresh dir with no duplicates is a no-op", async () => {
    const tmp = tempDir("owl-compact-clean");
    const cfg = join(tmp, "cfg");
    const sessDir = join(cfg, "session-owl", "sessions", "s2");
    mkdirSync(sessDir, { recursive: true });
    writeFileSync(join(sessDir, "m1-cccc3333.jsonl"), `${line("v1", null, "one")}\n${line("v2", "v1", "two")}\n`);
    const { stdout } = await run(process.execPath, [HELPER, "--config-dir", cfg, "--session-id", "s2"]);
    const report = JSON.parse(stdout.trim().split("\n").pop() ?? "{}");
    expect(report.noop).toBe(true);
  }, 30_000);
});

describe("mirror-compact — review round 1 hardening", () => {
  test("a crash-truncated line is skipped (counted), never a permanent abort", async () => {
    const tmp = tempDir("owl-compact-trunc");
    const sessDir = join(tmp, "cfg", "session-owl", "sessions", "s-trunc");
    mkdirSync(sessDir, { recursive: true });
    // one healthy duplicate pair + a torn final line (a crash mid-write)
    writeFileSync(
      join(sessDir, "m1-aaaa1111.jsonl"),
      `${line("u1", null, "one")}\n${line("u2", "u1", "two")}\n` +
        '{"uuid":"u3","parentUuid":"u2","row":{"role":"user","content":"thr',
    );
    writeFileSync(join(sessDir, "m2-bbbb2222.jsonl"), `${line("u1", null, "one")}\n${line("u2", "u1", "two")}\n`);
    const r = await run("node", [HELPER, "--config-dir", join(tmp, "cfg"), "--session-id", "s-trunc", "--apply"]);
    const report = JSON.parse(r.stdout.trim().split("\n").pop() ?? "{}");
    expect(report.done).toBe(true);
    // the torn u3 line dropped; the duplicate u1/u2 collapsed
    const kept = countLines(sessDir);
    expect(kept.total).toBe(2);
    expect(kept.files).toHaveLength(1);
  });
});
