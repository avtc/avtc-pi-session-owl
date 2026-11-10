// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>
// The over-cap transcript verify helper: a real Node CLI over temp
// transcript files — streams JSONL line-by-line (never holds the file),
// extracts the chain rows (uuid/parentUuid) and the live tip (the LAST
// last-prompt row's leafUuid), prints ONE compact JSON line. The output
// shape feeds parseHelperOutput (pinned in helper-pass.spec); this suite
// pins the EXEC contract: tolerant parsing, the --after cursor, failure
// exits.
import { execFile } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";
import { promisify } from "node:util";
import { describe, expect, test } from "vitest";
import { tempDir } from "../../../tests/temp-dir.js";

const run = promisify(execFile);
const HELPER = join(__dirname, "..", "..", "helpers", "verify.mjs");

interface VerifyReport {
  ok: boolean;
  tip?: string | null;
  edges?: [string, string | null][];
  rowsAfter?: number;
  torn?: boolean;
  tail?: [string, string | null, number][];
  echo?: string[];
}

async function verify(file: string, ...args: string[]): Promise<VerifyReport> {
  const { stdout } = await run(process.execPath, [HELPER, file, ...args]);
  return JSON.parse(stdout.trim().split("\n").pop() ?? "{}") as VerifyReport;
}

function tempTranscript(text: string): string {
  const dir = tempDir("owl-verify");
  const file = join(dir, "t.jsonl");
  writeFileSync(file, text, "utf8");
  return file;
}

describe("helpers/verify.mjs — the streaming over-cap pass", () => {
  test("chain rows + the last-prompt tip; malformed and metadata lines skip", async () => {
    const file = tempTranscript(
      [
        '{"type":"cost-state","totalCostUsd":0.01}', // metadata without a uuid
        "{broken json", // tolerated
        '{"uuid":"a","parentUuid":null}',
        '{"uuid":"b","parentUuid":"a"}',
        '{"uuid":"c","parentUuid":"b","isSidechain":true}', // sidechain rows still carry edges
        '{"type":"last-prompt","sessionId":"s","leafUuid":"b"}', // an older tip
        '{"uuid":"d","parentUuid":null}',
        '{"type":"last-prompt","sessionId":"s","leafUuid":"d"}', // the LIVE tip wins
        "",
      ].join("\n"),
    );
    const report = await verify(file);
    expect(report.ok).toBe(true);
    expect(report.tip).toBe("d");
    expect(report.edges).toEqual([
      ["a", null],
      ["b", "a"],
      ["c", "b"],
      ["d", null],
    ]);
    expect(report.rowsAfter).toBe(4);
  });

  test("--after limits edges to rows appended after the cursor; the tip stays the file's live one", async () => {
    const file = tempTranscript(
      [
        '{"uuid":"a","parentUuid":null}',
        '{"uuid":"b","parentUuid":"a"}',
        '{"uuid":"c","parentUuid":"b"}',
        '{"type":"last-prompt","sessionId":"s","leafUuid":"c"}',
      ].join("\n"),
    );
    const report = await verify(file, "--after", "a");
    expect(report.edges).toEqual([
      ["b", "a"],
      ["c", "b"],
    ]);
    expect(report.rowsAfter).toBe(2);
    expect(report.tip).toBe("c");
    // a cursor that never appears = the whole file
    const all = await verify(file, "--after", "zzz");
    expect((all.edges ?? []).length).toBe(3);
  });

  test("an absent file exits 1 with ok:false; a missing operand exits 2", async () => {
    const dir = tempDir("owl-verify");
    await expect(verify(join(dir, "nope.jsonl"))).rejects.toMatchObject({ code: 1 });
    await expect(run(process.execPath, [HELPER])).rejects.toMatchObject({ code: 2 });
  });
});

describe("helpers/verify.mjs — compaction-boundary logical edges", () => {
  test("a compact_boundary row's edge is its logicalParentUuid (null parentUuid + logical link)", async () => {
    const file = tempTranscript(
      [
        '{"uuid":"m-1","parentUuid":null}',
        '{"uuid":"m-2","parentUuid":"m-1"}',
        '{"uuid":"m-3","parentUuid":"m-2"}', // the abandoned invocation
        '{"uuid":"m-2b","parentUuid":"m-2"}', // the rewound sibling
        '{"uuid":"sys-a","type":"system","subtype":"informational","parentUuid":"m-2b"}',
        '{"uuid":"sys-b","type":"system","subtype":"compact_boundary","parentUuid":null,"logicalParentUuid":"sys-a"}',
        '{"uuid":"m-5","parentUuid":"sys-b"}', // the summary row
        '{"uuid":"m-6","parentUuid":"m-5"}',
        '{"type":"last-prompt","sessionId":"s","leafUuid":"m-6"}',
        "",
      ].join("\n"),
    );
    const report = await verify(file);
    expect(report.ok).toBe(true);
    const byUuid = new Map((report.edges ?? []).map((e: [string, string | null]) => [e[0], e[1]] as const));
    expect(byUuid.get("sys-b")).toBe("sys-a");
    expect(byUuid.get("m-5")).toBe("sys-b");
  });
});

describe("helpers/verify.mjs --tail N — the live chain verifier's tail tier", () => {
  test("the LAST N uuid rows as [uuid, parent, boundary01] triples; metadata skips", async () => {
    const file = tempTranscript(
      [
        '{"type":"cost-state","x":1}', // no uuid — skipped
        '{"uuid":"u1","parentUuid":null,"type":"user"}',
        '{"uuid":"b1","parentUuid":null,"logicalParentUuid":"old","type":"system","subtype":"compact_boundary"}',
        '{"uuid":"u2","parentUuid":"b1","type":"user"}',
        "",
      ].join("\n"),
    );
    const report = await verify(file, "--tail", "2");
    expect(report.ok).toBe(true);
    expect(report.torn).toBe(false);
    expect(report.tail).toEqual([
      ["b1", "old", 1, 0],
      ["u2", "b1", 0, 0],
    ]);
  });

  test("a chain-id row written without a uuid counts in the tail via messageId", async () => {
    const file = tempTranscript(
      [
        '{"type":"cost-state","x":1}', // no chain id — skipped
        '{"type":"file-history-snapshot","messageId":"m1a","snapshot":{}}', // chrome — no slot
        '{"type":"command","messageId":"m1a","command":{}}',
        '{"uuid":"u1","parentUuid":null,"type":"user"}',
        '{"uuid":"u2","parentUuid":"u1","type":"user"}',
        "",
      ].join("\n"),
    );
    const report = await verify(file, "--tail", "3");
    expect(report.ok).toBe(true);
    expect(report.tail).toEqual([
      ["m1a", null, 0, 0],
      ["u1", null, 0, 0],
      ["u2", "u1", 0, 0],
    ]);
  });

  test.each([
    ["after", true],
    ["before", false],
  ])(
    "a messageId row sharing a real row's id (written %s it) yields the slot to the real row",
    async (_label, after) => {
      const snapshot = '{"type":"file-history-snapshot","messageId":"p1","snapshot":{}}';
      const prompt = '{"uuid":"p1","parentUuid":"td","type":"user"}';
      const file = tempTranscript(
        [
          '{"uuid":"td","parentUuid":"a1","type":"system","subtype":"turn_duration"}',
          ...(after ? [prompt, snapshot] : [snapshot, prompt]),
          '{"type":"file-history-delta","messageId":"m9","snapshotMessageId":"p1"}',
          "",
        ].join("\n"),
      );
      const report = await verify(file, "--tail", "10");
      expect(report.ok).toBe(true);
      expect(report.tail).toEqual([
        ["td", "a1", 0, 0],
        ["p1", "td", 0, 0],
        // the twinless delta row ("m9") is chrome — no chain slot
      ]);
    },
  );

  test("file-history chrome names its ids in echo — presence without a chain slot", async () => {
    // a side-branched command row is never filed: its id survives only on
    // the file-history-snapshot of that message boundary — echoed, never a
    // tail row (no uuid, no parent)
    const file = tempTranscript(
      [
        '{"uuid":"r1","parentUuid":"r0","type":"user"}',
        '{"uuid":"br","parentUuid":"r1","type":"user"}',
        '{"type":"file-history-snapshot","messageId":"cmd1","snapshot":{}}',
        "",
      ].join("\n"),
    );
    const report = await verify(file, "--tail", "10");
    expect(report.ok).toBe(true);
    expect(report.tail).toEqual([
      ["r1", "r0", 0, 0],
      ["br", "r1", 0, 0],
    ]);
    expect(report.echo).toEqual(["cmd1"]);
  });

  test("the window counts UUID rows, not raw lines — dense metadata cannot push queued rows out of the tail", async () => {
    // a busy turn's file: every uuid row is surrounded by several metadata
    // lines (api-request, queue-operation, ...). A raw-line window would
    // return fewer uuid rows than asked and the oldest queued row would read
    // as absent — a false amputation. The collection must stop only after N
    // uuid-bearing lines.
    const rows: string[] = [];
    const meta = (n: number): string => JSON.stringify({ type: "queue-operation", operation: "op", n });
    for (let i = 1; i <= 6; i += 1) {
      rows.push(meta(i * 10), meta(i * 10 + 1), meta(i * 10 + 2));
      rows.push(JSON.stringify({ uuid: `u${i}`, parentUuid: i === 1 ? null : `u${i - 1}`, type: "user" }));
    }
    const file = tempTranscript(`${rows.join("\n")}\n`);
    const report = await verify(file, "--tail", "5");
    expect(report.ok).toBe(true);
    expect(report.torn).toBe(false);
    // FIVE uuid rows come back — not five raw lines' worth (~1-2 uuid rows)
    expect(report.tail).toEqual([
      ["u2", "u1", 0, 0],
      ["u3", "u2", 0, 0],
      ["u4", "u3", 0, 0],
      ["u5", "u4", 0, 0],
      ["u6", "u5", 0, 0],
    ]);
  });

  test("a last byte that is not a newline is torn; the fragment is excluded", async () => {
    const file = tempTranscript(
      ['{"uuid":"u1","parentUuid":null,"type":"user"}', '{"uuid":"u2","parentUuid":"u1"'].join("\n"),
    );
    const report = await verify(file, "--tail", "8");
    expect(report.ok).toBe(true);
    expect(report.torn).toBe(true);
    expect(report.tail).toEqual([["u1", null, 0, 0]]);
  });

  test("a multibyte character straddling a 64 KiB block boundary survives (block-safe decode)", async () => {
    // place a row whose emoji content crosses the read-block boundary;
    // a naive block decode would emit U+FFFD, fail JSON.parse, and drop
    // the row (reading as amputation in the caller)
    const emoji = "\u{1F989}".repeat(4);
    const rowText = JSON.stringify({
      uuid: "owl1",
      parentUuid: null,
      message: { role: "user", content: `night ${emoji} bird` },
    });
    const filler = `${JSON.stringify({ uuid: "f0", parentUuid: null, message: { role: "user", content: "x".repeat(60) } })}\n`;
    const target = 64 * 1024;
    const prefixRows: string[] = [];
    let prefixLen = 0;
    let i = 1;
    while (prefixLen + filler.length < target - rowText.length - 64) {
      prefixRows.push(
        JSON.stringify({
          uuid: `p${i}`,
          parentUuid: i === 1 ? null : `p${i - 1}`,
          message: { role: "user", content: "y".repeat(60) },
        }),
      );
      prefixLen += prefixRows[prefixRows.length - 1].length + 1;
      i += 1;
    }
    // the emoji row sits so its multibyte bytes straddle the boundary
    const pad = target - prefixLen - rowText.length - 10;
    const file = `${[...prefixRows, `${JSON.stringify({ uuid: "pad", parentUuid: null, message: { role: "user", content: "z".repeat(Math.max(0, pad)) } })}`].join("\n")}\n${rowText}\n${JSON.stringify({ uuid: "owl2", parentUuid: "owl1", message: { role: "user", content: "tail" } })}\n`;
    const tmp = tempTranscript(file);
    const report = await verify(tmp, "--tail", "2");
    expect(report.ok).toBe(true);
    expect(report.torn).toBe(false);
    expect(report.tail).toEqual([
      ["owl1", null, 0, 0],
      ["owl2", "owl1", 0, 0],
    ]);
  });

  test("a multi-block file (>128 KiB) reads the tail across blocks in file order", async () => {
    const rows: string[] = [];
    for (let i = 1; i <= 2400; i += 1) {
      rows.push(
        JSON.stringify({
          uuid: `m${i}`,
          parentUuid: i === 1 ? null : `m${i - 1}`,
          message: { role: "user", content: "c".repeat(60) },
        }),
      );
    }
    const tmp = tempTranscript(`${rows.join("\n")}\n`);
    const report = await verify(tmp, "--tail", "3");
    expect(report.ok).toBe(true);
    expect(report.torn).toBe(false);
    expect(report.tail).toEqual([
      ["m2398", "m2397", 0, 0],
      ["m2399", "m2398", 0, 0],
      ["m2400", "m2399", 0, 0],
    ]);
  });

  test("rows straddling block boundaries all survive — mixed sizes, rows larger than a block, a deep window", async () => {
    // a window spanning many 64 KiB blocks: every row that crosses a block
    // boundary must come back (a dropped one reads as amputation in the
    // caller and aborts the in-flight stage)
    const sizes = [200, 800, 5000, 21000, 70000, 150000];
    const rows: string[] = [];
    const ids: string[] = [];
    for (let i = 1; i <= 120; i += 1) {
      const id = `s${i}`;
      ids.push(id);
      rows.push(
        JSON.stringify({
          uuid: id,
          parentUuid: i === 1 ? null : `s${i - 1}`,
          message: { role: "user", content: `\u{1F989}${"w".repeat(sizes[i % sizes.length] ?? 0)}` },
        }),
      );
    }
    const tmp = tempTranscript(`${rows.join("\n")}\n`);
    const report = await verify(tmp, "--tail", "100");
    expect(report.ok).toBe(true);
    expect(report.torn).toBe(false);
    expect(report.tail?.map((r) => r[0])).toEqual(ids.slice(-100));
    // the whole file — the first line (no newline before it) included
    const all = await verify(tmp, "--tail", "500");
    expect(all.tail?.map((r) => r[0])).toEqual(ids);
  });

  test("an unterminated final fragment larger than a block is excluded, the rows before it intact", async () => {
    const before = [1, 2, 3].map((i) =>
      JSON.stringify({ uuid: `q${i}`, parentUuid: i === 1 ? null : `q${i - 1}`, content: "v".repeat(90000) }),
    );
    const fragment = `{"uuid":"q4","parentUuid":"q3","content":"${"t".repeat(200000)}`;
    const tmp = tempTranscript(`${before.join("\n")}\n${fragment}`);
    const report = await verify(tmp, "--tail", "8");
    expect(report.ok).toBe(true);
    expect(report.torn).toBe(true);
    expect(report.tail?.map((r) => r[0])).toEqual(["q1", "q2", "q3"]);
  });

  test("a complete but unparsable final line is torn", async () => {
    const file = tempTranscript(`${['{"uuid":"u1","parentUuid":null,"type":"user"}', "not json"].join("\n")}\n`);
    const report = await verify(file, "--tail", "8");
    expect(report.ok).toBe(true);
    expect(report.torn).toBe(true);
    expect(report.tail).toEqual([["u1", null, 0, 0]]);
  });

  test("an empty file is ok, not torn, empty tail", async () => {
    const file = tempTranscript("");
    const report = await verify(file, "--tail", "8");
    expect(report.ok).toBe(true);
    expect(report.torn).toBe(false);
    expect(report.tail).toEqual([]);
  });

  test("a missing file fails with ok:false", async () => {
    const dir = tempDir("owl-verify");
    const missing = join(dir, "absent.jsonl");
    await expect(verify(missing, "--tail", "8")).rejects.toThrow();
  });
});
