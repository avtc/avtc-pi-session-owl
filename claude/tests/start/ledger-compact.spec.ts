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

describe("helpers/ledger-compact.mjs — a mass that cannot fit one record", () => {
  test("a unique-edge set over the byte budget splits across lineage records; every part fits the cap and the stream heals", async () => {
    const tmp = tempDir("owl-ledger-compact-split");
    const sessDir = join(tmp, "cfg", "session-owl", "sessions", "s-split");
    mkdirSync(sessDir, { recursive: true });
    // two restating batches whose union of unique edges exceeds 3 MiB
    const CAP = 3 * 1024 * 1024;
    const edges: Array<{ uuid: string; parent: string | null }> = [];
    for (let i = 0; i < 60_000; i += 1) {
      edges.push({ uuid: `e${i}x${"0".repeat(12)}`, parent: i === 0 ? null : `e${i - 1}x${"0".repeat(12)}` });
    }
    writeFileSync(join(sessDir, "ledger-0001aaaa.jsonl"), lineage(edges.slice(0, 30_000), 1, 1000) + "\n");
    writeFileSync(
      join(sessDir, "ledger-0002bbbb.jsonl"),
      lineage(edges.slice(0, 20_000), 2, 1001) + "\n" + lineage(edges.slice(20_000), 3, 1002) + "\n",
    );
    const r = await run("node", [HELPER, "--session-dir", sessDir, "--apply"]);
    const report = parseReport(r.stdout);
    expect(report.done).toBe(true);
    expect(report.restatedEdges).toBe(30_000);
    expect(report.uniqueEdges).toBe(60_000);
    // every written batch stays under the cap, and the lineage block split
    const files = readdirSync(sessDir).filter((n) => n.startsWith("ledger-") && n.endsWith(".jsonl"));
    expect(files.length).toBeGreaterThanOrEqual(2);
    for (const f of files) {
      expect(readFileSync(join(sessDir, f), "utf8").length).toBeLessThan(CAP);
    }
    const lines = readAll(sessDir);
    const lineageLines = lines.filter((l) => (JSON.parse(l) as { kind: string }).kind === "lineage");
    expect(lineageLines.length).toBeGreaterThanOrEqual(2);
    const uuids: string[] = [];
    for (const l of lineageLines) {
      for (const e of (JSON.parse(l) as { payload: { edges: Array<{ uuid: string }> } }).payload.edges)
        uuids.push(e.uuid);
    }
    expect(new Set(uuids).size).toBe(60_000); // every uuid exactly once across parts
    // idempotent: the healed stream re-runs as a noop
    const again = await run("node", [HELPER, "--session-dir", sessDir]);
    const report2 = parseReport(again.stdout);
    expect(report2.noop).toBe(true);
  }, 60_000);

  test("a single non-lineage record over the budget is skipped and counted, the rest heal", async () => {
    const tmp = tempDir("owl-ledger-compact-oversize");
    const sessDir = join(tmp, "cfg", "session-owl", "sessions", "s-ovs");
    mkdirSync(sessDir, { recursive: true });
    const huge = "z".repeat(3 * 1024 * 1024);
    writeFileSync(
      join(sessDir, "ledger-0001aaaa.jsonl"),
      [
        rec("observation", 1, 1000, { text: "first" }),
        lineage([{ uuid: "u1", parent: null }], 2, 1001),
        rec("usage", 3, 1002, { blob: huge }),
      ].join("\n") + "\n",
    );
    writeFileSync(join(sessDir, "ledger-0002bbbb.jsonl"), lineage([{ uuid: "u1", parent: "x9" }], 4, 1003) + "\n");
    const r = await run("node", [HELPER, "--session-dir", sessDir, "--apply"]);
    const report = parseReport(r.stdout);
    expect(report.done).toBe(true);
    expect(report.skippedOversized).toBe(1);
    const lines = readAll(sessDir);
    const kinds = lines.map((l) => (JSON.parse(l) as { kind: string }).kind);
    expect(kinds).toContain("observation");
    expect(kinds).toContain("lineage");
    expect(kinds).not.toContain("usage"); // the oversized record is gone
    const lin = lines.find((l) => (JSON.parse(l) as { kind: string }).kind === "lineage");
    const edges = (JSON.parse(lin as string) as { payload: { edges: Array<{ uuid: string; parent?: string | null }> } })
      .payload.edges;
    expect(edges).toEqual([{ uuid: "u1", parent: "x9", exact: true }]); // last-wins survived
  });
});
