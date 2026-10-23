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
  tip: string | null;
  edges: [string, string | null][];
  rowsAfter: number;
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
    expect(all.edges.length).toBe(3);
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
    const byUuid = new Map(report.edges.map((e: [string, string | null]) => [e[0], e[1]] as const));
    expect(byUuid.get("sys-b")).toBe("sys-a");
    expect(byUuid.get("m-5")).toBe("sys-b");
  });
});
