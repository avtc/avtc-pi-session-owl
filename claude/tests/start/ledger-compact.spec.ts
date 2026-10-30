// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// The ledger compaction helper suite: a lineage stream may state each uuid
// exactly once — the rewrite keeps every non-lineage record verbatim and in
// order, folds lineage to one final-per-uuid record, never leaves a
// half-written state (all-or-nothing), and is idempotent.
import { execFile } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, test } from "vitest";
import { tempDir } from "../../../tests/temp-dir.js";

const run = promisify(execFile);
const HELPER = join(__dirname, "..", "..", "helpers", "ledger-compact.mjs");

function rec(kind: string, seq: number, ts: number, payload: unknown, producer = "p-a-1"): string {
  return JSON.stringify({ producerId: producer, seq, ts, marker: "m" + seq, at: "m" + seq, kind, payload });
}

function lineage(
  edges: Array<{ uuid: string; parent: string | null }>,
  seq: number,
  ts: number,
  producer = "p-a-1",
): string {
  return rec("lineage", seq, ts, { edges: edges.map((e) => ({ ...e, exact: true })) }, producer);
}

/** The damaged shape: non-lineage records around lineage records where the
 *  second re-states the first's uuids (the legacy full-pass writer). */
function damagedDir(): { cfg: string; sessDir: string } {
  const tmp = tempDir("owl-ledger-compact");
  const cfg = join(tmp, "cfg");
  const sessDir = join(cfg, "session-owl", "sessions", "s1");
  mkdirSync(sessDir, { recursive: true });
  writeFileSync(
    join(sessDir, "ledger-0001aaaa.jsonl"),
    [
      rec("observation", 1, 1000, { text: "first" }),
      lineage(
        [
          { uuid: "u1", parent: null },
          { uuid: "u2", parent: "u1" },
        ],
        2,
        1001,
      ),
      rec("usage", 3, 1002, { tokens: 5 }),
    ].join("\n") + "\n",
  );
  writeFileSync(
    join(sessDir, "ledger-0002bbbb.jsonl"),
    [
      // the re-statement record: u1/u2 identical, u3 new
      lineage(
        [
          { uuid: "u1", parent: null },
          { uuid: "u2", parent: "u1" },
          { uuid: "u3", parent: "u2" },
        ],
        4,
        1003,
      ),
      rec("observation", 5, 1004, { text: "second" }),
    ].join("\n") + "\n",
  );
  return { cfg, sessDir };
}

function readAll(dir: string): string[] {
  const out: string[] = [];
  for (const f of readdirSync(dir)
    .filter((n) => n.startsWith("ledger-") && n.endsWith(".jsonl"))
    .sort()) {
    for (const line of readFileSync(join(dir, f), "utf8").split("\n")) {
      if (line !== "") out.push(line);
    }
  }
  return out;
}

function parseReport(stdout: string): Record<string, unknown> {
  const line = stdout.trim().split("\n").pop() ?? "";
  return JSON.parse(line) as Record<string, unknown>;
}

describe("helpers/ledger-compact.mjs", () => {
  test("rewrites to one lineage record, non-lineage verbatim and in order", async () => {
    const { sessDir } = damagedDir();
    const r = await run("node", [HELPER, "--session-dir", sessDir, "--apply"]);
    const report = parseReport(r.stdout);
    expect(report.done).toBe(true);
    expect(report.noop).not.toBe(true);

    const lines = readAll(sessDir);
    // non-lineage records survive VERBATIM, in fold order
    const kinds = lines.map((l) => (JSON.parse(l) as { kind: string }).kind);
    const obs = lines.filter((l) => (JSON.parse(l) as { kind: string }).kind === "observation");
    expect(obs).toEqual([
      rec("observation", 1, 1000, { text: "first" }),
      rec("observation", 5, 1004, { text: "second" }),
    ]);
    expect(kinds.filter((k) => k === "lineage")).toHaveLength(1);
    // the consolidated record holds every uuid exactly once (u1, u2, u3)
    const lin = lines.find((l) => (JSON.parse(l) as { kind: string }).kind === "lineage");
    const edges = (JSON.parse(lin as string) as { payload: { edges: Array<{ uuid: string; parent?: string | null }> } })
      .payload.edges;
    expect(edges.map((e) => e.uuid).sort()).toEqual(["u1", "u2", "u3"]);
    // and the last record's values survive: u3's edge exists
    expect(edges.some((e) => e.uuid === "u3" && e.parent === "u2")).toBe(true);
    // order: consolidated lineage sorts where the LAST lineage record was
    const seqs = lines.map((l) => (JSON.parse(l) as { seq: number }).seq);
    expect(seqs.indexOf(4)).toBeGreaterThan(seqs.indexOf(3));
  });

  test("last-wins when a later record changes a uuid's edge", async () => {
    const tmp = tempDir("owl-ledger-compact-lw");
    const sessDir = join(tmp, "cfg", "session-owl", "sessions", "s2");
    mkdirSync(sessDir, { recursive: true });
    writeFileSync(
      join(sessDir, "ledger-0001cccc.jsonl"),
      [lineage([{ uuid: "u1", parent: null }], 1, 1000), lineage([{ uuid: "u1", parent: "u9" }], 2, 1001)].join("\n") +
        "\n",
    );
    const r = await run("node", [HELPER, "--session-dir", sessDir, "--apply"]);
    const lines = readAll(sessDir);
    const lin = lines.find((l) => (JSON.parse(l) as { kind: string }).kind === "lineage");
    const edges = (JSON.parse(lin as string) as { payload: { edges: Array<{ uuid: string; parent: string | null }> } })
      .payload.edges;
    expect(edges).toEqual([{ uuid: "u1", parent: "u9", exact: true }]);
    expect(parseReport(r.stdout).restatedEdges).toBe(1);
  });

  test("noop on a healthy stream (no rewrite, originals untouched)", async () => {
    const tmp = tempDir("owl-ledger-compact-ok");
    const sessDir = join(tmp, "cfg", "session-owl", "sessions", "s3");
    mkdirSync(sessDir, { recursive: true });
    const original =
      [rec("observation", 1, 1000, { a: 1 }), lineage([{ uuid: "u1", parent: null }], 2, 1001)].join("\n") + "\n";
    writeFileSync(join(sessDir, "ledger-0001dddd.jsonl"), original);
    const before = readdirSync(sessDir);
    const r = await run("node", [HELPER, "--session-dir", sessDir, "--apply"]);
    const report = parseReport(r.stdout);
    expect(report.noop).toBe(true);
    expect(readdirSync(sessDir)).toEqual(before);
    expect(readFileSync(join(sessDir, before[0] as string), "utf8")).toBe(original);
  });

  test("idempotent: a second run on the healed stream is a noop", async () => {
    const { sessDir } = damagedDir();
    await run("node", [HELPER, "--session-dir", sessDir, "--apply"]);
    const r2 = await run("node", [HELPER, "--session-dir", sessDir, "--apply"]);
    expect(parseReport(r2.stdout).noop).toBe(true);
  });

  test("all-or-nothing: an unreadable batch file aborts with no writes", async () => {
    const tmp = tempDir("owl-ledger-compact-abort");
    const sessDir = join(tmp, "cfg", "session-owl", "sessions", "s4");
    mkdirSync(sessDir, { recursive: true });
    writeFileSync(join(sessDir, "ledger-0001eeee.jsonl"), lineage([{ uuid: "u1", parent: null }], 1, 1000) + "\n");
    // an unreadable file in the set (a directory with the ledger name)
    mkdirSync(join(sessDir, "ledger-0002ffff.jsonl"));
    const before = readdirSync(sessDir).sort();
    await expect(run("node", [HELPER, "--session-dir", sessDir, "--apply"])).rejects.toThrow();
    expect(readdirSync(sessDir).sort()).toEqual(before);
  });

  test("dry-run default: reports the mass, writes nothing", async () => {
    const { sessDir } = damagedDir();
    const before = readdirSync(sessDir).sort();
    const r = await run("node", [HELPER, "--session-dir", sessDir]);
    const report = parseReport(r.stdout);
    expect(report.done).toBe(true);
    expect(report.noop).not.toBe(true);
    expect(readdirSync(sessDir).sort()).toEqual(before);
    rmSync(sessDir, { recursive: true, force: true });
  });
});
