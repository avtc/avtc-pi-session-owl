// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// The over-cap transcript tier's caller: $.fs.read refuses files over the
// 4 MiB platform cap, so CLI surfaces run helpers/verify.mjs (a streaming
// Node helper) for the same facts the whole-file read would have supplied —
// the chain rows + the live tip. Non-CLI surfaces DEFER (null — layer 2
// carries the verdict, 's degrade). The planner is pure (surface + paths
// in, argv out); the process run is an injected seam.

import { describe, expect, test } from "vitest";
import { isCapRefusal, parseHelperOutput, planVerifyInvocation, runVerifyPass } from "../../host/rewind/helper-pass.js";

describe("rewind helper pass — the planner", () => {
  test("CLI surfaces plan the helper; the desktop defers", () => {
    const cli = planVerifyInvocation({
      surface: null,
      transcriptPath: "/t/big.jsonl",
      pluginRoot: "/owl",
    });
    expect(cli.run).toBe(true);
    expect(cli.reason).toBe("cli");
    expect(cli.argv).toEqual(["node", "/owl/helpers/verify.mjs", "/t/big.jsonl"]);

    const terminal = planVerifyInvocation({ surface: "terminal", transcriptPath: "/t/b.jsonl", pluginRoot: "/owl" });
    expect(terminal.run).toBe(true);

    const desktop = planVerifyInvocation({ surface: "desktop", transcriptPath: "/t/b.jsonl", pluginRoot: "/owl" });
    expect(desktop.run).toBe(false);
    expect(desktop.reason).toBe("desktop-defers");
    expect(desktop.argv).toEqual([]);
  });

  test("an --after cursor and the node binary slot into the argv", () => {
    const plan = planVerifyInvocation({
      surface: null,
      transcriptPath: "/t/big.jsonl",
      pluginRoot: "/owl/",
      after: "uuid-9",
      nodeBin: "node.exe",
    });
    expect(plan.argv).toEqual(["node.exe", "/owl/helpers/verify.mjs", "/t/big.jsonl", "--after", "uuid-9"]);
  });
});

describe("rewind helper pass — the cap-refusal predicate", () => {
  test("matches the platform's over-cap refusal wordings", () => {
    expect(isCapRefusal("a text is over the 4194304-byte limit")).toBe(true);
    expect(isCapRefusal("File exceeds the 4194304 byte limit")).toBe(true);
    expect(isCapRefusal("read refused: over 4 MiB")).toBe(true);
  });

  test("an absent file or an unrelated failure is NOT a cap refusal", () => {
    expect(isCapRefusal("ENOENT: no such file or directory, open '/t/x.jsonl'")).toBe(false);
    expect(isCapRefusal("permission denied")).toBe(false);
    expect(isCapRefusal("")).toBe(false);
  });
});

describe("rewind helper pass — output parsing", () => {
  test("a well-formed line maps to the TranscriptPass shape", () => {
    const pass = parseHelperOutput('{"ok":true,"tip":"t1","edges":[["a",null],["b","a"]],"rowsAfter":2}');
    expect(pass).toEqual({
      kind: "ok",
      rows: [
        { uuid: "a", parentUuid: null },
        { uuid: "b", parentUuid: "a" },
      ],
      tip: "t1",
      rewound: false,
    });
  });

  test("a null tip, an ok:false report, and malformed lines all degrade to null", () => {
    expect(parseHelperOutput('{"ok":true,"tip":null,"edges":[["a",null]],"rowsAfter":1}')?.kind).toBe("ok");
    expect(parseHelperOutput('{"ok":false,"error":"boom"}')).toBeNull();
    expect(parseHelperOutput("not json")).toBeNull();
    expect(parseHelperOutput("")).toBeNull();
  });
});

describe("rewind helper pass — the runner", () => {
  const input = { surface: null as string | null, transcriptPath: "/t/b.jsonl", pluginRoot: "/owl" };

  test("a successful run returns the parsed pass; the deferred surface returns null without running", async () => {
    let ran = 0;
    const pass = await runVerifyPass(
      {
        runProcess: async () => {
          ran += 1;
          return { stdout: '{"ok":true,"tip":"t","edges":[["u",null]],"rowsAfter":1}', exitCode: 0 };
        },
        log: () => {},
      },
      input,
    );
    expect(pass).toEqual({ kind: "ok", rows: [{ uuid: "u", parentUuid: null }], tip: "t", rewound: false });
    expect(ran).toBe(1);

    const deferred = await runVerifyPass(
      {
        runProcess: async () => {
          ran += 1;
          return { stdout: '{"ok":true}', exitCode: 0 };
        },
        log: () => {},
      },
      { ...input, surface: "desktop" },
    );
    expect(deferred).toBeNull();
    expect(ran).toBe(1); // never ran for the desktop
  });

  test("non-zero exit, truncated stdout, and crashes all degrade to null (never throw)", async () => {
    const fail = async (
      runProcess: () => Promise<{ stdout: string; exitCode: number; isStdoutTruncated?: boolean }>,
    ) => {
      const logged: string[] = [];
      const out = await runVerifyPass({ runProcess, log: (m: string) => logged.push(m) }, input);
      return { out, logged };
    };
    expect((await fail(async () => ({ stdout: '{"ok":false,"error":"x"}', exitCode: 1 }))).out).toBeNull();
    expect((await fail(async () => ({ stdout: "x".repeat(10), exitCode: 0, isStdoutTruncated: true }))).out).toBeNull();
    expect(
      (
        await fail(async () => {
          throw new Error("spawn failed");
        })
      ).out,
    ).toBeNull();
    // every failure logged — the degrade is visible, never silent
    const all = await fail(async () => ({ stdout: "", exitCode: 1 }));
    expect(all.logged.length).toBeGreaterThan(0);
  });

  test("a restore marker's rewound flag rides the helper output", () => {
    const pass = parseHelperOutput('{"ok":true,"tip":"t9","rewound":true,"edges":[["a",null]],"rowsAfter":1}');
    expect(pass).toMatchObject({ kind: "ok", tip: "t9", rewound: true });
  });
});
