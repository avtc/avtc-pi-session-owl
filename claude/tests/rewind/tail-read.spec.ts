// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>
//
// The tail-read tier of the live chain verifier: the file's last N
// uuid-bearing rows (with the compaction-boundary flag and the torn-tail
// signal) — the facts the deferred processor walks to assign parents and
// detect rewinds. The capsule tier reads the whole file (≤4 MiB platform
// cap) and parses only its end; the helper tier (helpers/verify.mjs --tail)
// streams a ring buffer for over-cap files. Every failure degrades to null
// — a missing tier is never a wrong verdict.

import { describe, expect, test } from "vitest";
import {
  parseCapsuleTail,
  parseTailHelperOutput,
  planTailInvocation,
  planTailTier,
  readTail,
} from "../../host/rewind/tail-read.js";

const CAP = 4 * 1024 * 1024;

describe("tail-read — capsule tail parsing", () => {
  test("keeps the last N uuid-bearing rows in file order, skipping metadata rows", () => {
    const text = [
      JSON.stringify({ type: "queue-operation", x: 1 }), // no uuid — skipped
      JSON.stringify({ uuid: "u1", parentUuid: null, type: "user" }),
      JSON.stringify({ uuid: "u2", parentUuid: "u1", type: "assistant" }),
      JSON.stringify({ uuid: "u3", parentUuid: "u2", type: "user" }),
      "",
    ].join("\n");
    const facts = parseCapsuleTail(text, 2);
    expect(facts.torn).toBe(false);
    expect(facts.rows.map((r) => r.uuid)).toEqual(["u2", "u3"]);
    expect(facts.rows[0]?.parentUuid).toBe("u1");
    expect(facts.rows.map((r) => r.boundary)).toEqual([false, false]);
  });

  test("flags compaction-boundary rows", () => {
    const text = [
      JSON.stringify({ uuid: "b1", parentUuid: null, type: "system", subtype: "compact_boundary" }),
      JSON.stringify({ uuid: "u1", parentUuid: "b1", type: "user" }),
      "",
    ].join("\n");
    const facts = parseCapsuleTail(text, 8);
    expect(facts.rows[0]).toEqual({ uuid: "b1", parentUuid: null, boundary: true });
    expect(facts.rows[1]?.boundary).toBe(false);
  });

  test("falls back to logicalParentUuid (the boundary-row normalization)", () => {
    const text = [
      JSON.stringify({
        uuid: "b1",
        parentUuid: null,
        logicalParentUuid: "old",
        type: "system",
        subtype: "compact_boundary",
      }),
      "",
    ].join("\n");
    const facts = parseCapsuleTail(text, 8);
    expect(facts.rows[0]?.parentUuid).toBe("old");
  });

  test("a last line without a trailing newline is torn and excluded", () => {
    const text = [
      JSON.stringify({ uuid: "u1", parentUuid: null, type: "user" }),
      JSON.stringify({ uuid: "u2", parentUuid: "u1", type: "user" }).slice(0, 20), // mid-write fragment
    ].join("\n"); // no trailing newline
    const facts = parseCapsuleTail(text, 8);
    expect(facts.torn).toBe(true);
    expect(facts.rows.map((r) => r.uuid)).toEqual(["u1"]);
  });

  test("an unparsable FINAL complete line is torn (mid-write suspicion); middle junk is skipped", () => {
    const text = [
      JSON.stringify({ uuid: "u1", parentUuid: null, type: "user" }),
      "not json at all",
      JSON.stringify({ uuid: "u2", parentUuid: "u1", type: "user" }),
      "",
    ].join("\n");
    const middle = parseCapsuleTail(text, 8);
    expect(middle.torn).toBe(false); // junk in the middle: tolerated, skipped
    expect(middle.rows.map((r) => r.uuid)).toEqual(["u1", "u2"]);

    const tailJunk = [
      JSON.stringify({ uuid: "u1", parentUuid: null, type: "user" }),
      'truncated json {"uuid":"u2"',
      "",
    ].join("\n");
    const facts = parseCapsuleTail(tailJunk, 8);
    expect(facts.torn).toBe(true);
    expect(facts.rows.map((r) => r.uuid)).toEqual(["u1"]);
  });

  test("empty text is not torn and carries no rows", () => {
    const facts = parseCapsuleTail("", 8);
    expect(facts.torn).toBe(false);
    expect(facts.rows).toEqual([]);
  });
});

describe("tail-read — tier planning", () => {
  test("null size (absent file) is the absent tier", () => {
    expect(planTailTier(null).tier).toBe("absent");
  });
  test("≤4 MiB reads the capsule; over-cap goes to the helper", () => {
    expect(planTailTier(CAP).tier).toBe("capsule");
    expect(planTailTier(CAP + 1).tier).toBe("helper");
    expect(planTailTier(1024).tier).toBe("capsule");
  });
});

describe("tail-read — helper output parsing", () => {
  test("a valid tail report parses into rows with boundary flags and the torn signal", () => {
    const raw = `${JSON.stringify({
      ok: true,
      torn: true,
      tail: [
        ["b1", null, 1],
        ["u1", "b1", 0],
      ],
    })}\n`;
    const facts = parseTailHelperOutput(raw);
    expect(facts).toEqual({
      torn: true,
      rows: [
        { uuid: "b1", parentUuid: null, boundary: true },
        { uuid: "u1", parentUuid: "b1", boundary: false },
      ],
    });
  });
  test("ok:false, malformed JSON, and an empty stdout all degrade to null", () => {
    expect(parseTailHelperOutput(JSON.stringify({ ok: false, error: "x" }))).toBeNull();
    expect(parseTailHelperOutput("not json")).toBeNull();
    expect(parseTailHelperOutput("")).toBeNull();
  });
});

describe("tail-read — invocation planning", () => {
  test("the argv targets the helper's tail mode", () => {
    expect(planTailInvocation({ transcriptPath: "/t/s.jsonl", pluginRoot: "/owl", maxRows: 256 })).toEqual([
      "node",
      "/owl/helpers/verify.mjs",
      "/t/s.jsonl",
      "--tail",
      "256",
    ]);
    expect(
      planTailInvocation({ transcriptPath: "/t/s.jsonl", pluginRoot: "/owl/", maxRows: 64, nodeBin: "node.exe" }),
    ).toEqual(["node.exe", "/owl/helpers/verify.mjs", "/t/s.jsonl", "--tail", "64"]);
  });
});

describe("tail-read — the orchestrating read", () => {
  const log = (_m: string) => {};

  test("absent size degrades to null without touching any seam", async () => {
    let read = 0;
    const facts = await readTail(
      {
        fsRead: async () => {
          read += 1;
          return "";
        },
        runProcess: async () => {
          throw new Error("unreachable");
        },
        log,
      },
      { size: null, transcriptPath: "/t/s.jsonl", pluginRoot: "/owl", maxRows: 8 },
    );
    expect(facts).toBeNull();
    expect(read).toBe(0);
  });

  test("the capsule tier serves an under-cap file", async () => {
    const text = [JSON.stringify({ uuid: "u1", parentUuid: null, type: "user" }), ""].join("\n");
    const facts = await readTail(
      {
        fsRead: async () => text,
        runProcess: async () => {
          throw new Error("unreachable");
        },
        log,
      },
      { size: 100, transcriptPath: "/t/s.jsonl", pluginRoot: "/owl", maxRows: 8 },
    );
    expect(facts?.rows.map((r) => r.uuid)).toEqual(["u1"]);
  });

  test("an over-cap file runs the helper tier", async () => {
    const calls: string[][] = [];
    const facts = await readTail(
      {
        fsRead: async () => {
          throw new Error("unreachable");
        },
        runProcess: async (argv: string[]) => {
          calls.push(argv);
          return { exitCode: 0, stdout: JSON.stringify({ ok: true, torn: false, tail: [["u9", "u8", 0]] }) };
        },
        log,
      },
      { size: CAP + 10, transcriptPath: "/t/s.jsonl", pluginRoot: "/owl", maxRows: 8 },
    );
    expect(calls[0]?.slice(-2)).toEqual(["--tail", "8"]);
    expect(facts?.rows[0]?.uuid).toBe("u9");
  });

  test("a capsule cap-refusal escalates to the helper (the size raced upward)", async () => {
    let helperRuns = 0;
    const facts = await readTail(
      {
        fsRead: async () => {
          throw new Error("a text is over the 4194304-byte limit");
        },
        runProcess: async () => {
          helperRuns += 1;
          return { exitCode: 0, stdout: JSON.stringify({ ok: true, torn: false, tail: [["u9", null, 0]] }) };
        },
        log,
      },
      { size: CAP, transcriptPath: "/t/s.jsonl", pluginRoot: "/owl", maxRows: 8 },
    );
    expect(helperRuns).toBe(1);
    expect(facts?.rows[0]?.uuid).toBe("u9");
  });

  test("a generic capsule failure and a helper crash both degrade to null (logged, never thrown)", async () => {
    const logs: string[] = [];
    const deps = {
      fsStat: async () => 100,
      fsRead: async () => {
        throw new Error("EACCES");
      },
      runProcess: async () => ({ exitCode: 1, stdout: JSON.stringify({ ok: false, error: "stream failed" }) }),
      log: (m: string) => logs.push(m),
    };
    const a = await readTail(deps, { size: 100, transcriptPath: "/t/s.jsonl", pluginRoot: "/owl", maxRows: 8 });
    expect(a).toBeNull();
    const b = await readTail(deps, { size: CAP + 5, transcriptPath: "/t/s.jsonl", pluginRoot: "/owl", maxRows: 8 });
    expect(b).toBeNull();
    expect(logs.length).toBeGreaterThanOrEqual(1);
  });
});
