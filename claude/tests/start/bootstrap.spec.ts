// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
// The bootstrap ladder: how a >read-cap transcript gets bootstrapped per
// surface (direct read / helper stream / blocked with the status hint), and
// the Node helper CLI that writes owl mirror segments directly from a
// transcript (streamed, never holding the file).
import { beforeEach, describe, expect, test } from "vitest";
import { clearDetailsCache } from "../../core/src/format/details.js";
import { resetForNewSession } from "../../core/src/store/graph-store.js";
import { _resetCoreInstances } from "../../host/core-instances.js";
import { runBackfill } from "../../host/start/backfill.js";
import { planBootstrap } from "../../host/start/bootstrap-ladder.js";
import { corePendingEvaluator } from "../../host/start/pending.js";
import { READ_CAP } from "../../host/start/transcript-reader.js";
import { createMemoryFs } from "../../host/storage/fs-adapter.js";
import { LedgerWriter } from "../../host/storage/ledger.js";
import { MirrorWriter, sweepMirror } from "../../host/storage/mirror.js";

const CAP = 4 * 1024 * 1024 - 64 * 1024;

describe("bootstrap-ladder — rung selection", () => {
  test("within the read cap: direct read on every surface", () => {
    expect(planBootstrap({ byteSize: 1024, canRunProcess: false }).read).toBe("direct");
    expect(planBootstrap({ byteSize: CAP, canRunProcess: true }).read).toBe("direct");
  });

  test("over the cap with $.process (CLI): the helper streams automatically", () => {
    const plan = planBootstrap({ byteSize: CAP + 1, canRunProcess: true });
    expect(plan.read).toBe("helper");
    expect(plan.statusHint).toBeNull();
    expect(plan.degraded).toBe(false);
  });

  test("over the cap without $.process (non-CLI): blocked with the ladder hint", () => {
    const plan = planBootstrap({ byteSize: CAP + 1, canRunProcess: false });
    expect(plan.read).toBe("blocked");
    // the status line: self-heals at the next CLI open, or run the script now
    expect(plan.statusHint).toBe("await-cli-open");
    expect(plan.degraded).toBe(true); // rung 4: observe the readable, keep the rest pending
  });

  test("an unknown size attempts the direct read (the cap check happens at read)", () => {
    expect(planBootstrap({ byteSize: "unknown", canRunProcess: false }).read).toBe("direct");
  });
});

describe("helpers/bootstrap.mjs — the user-run bootstrap", () => {
  test("writes owl mirror batches from a transcript, streamed, sweep-compatible", async () => {
    const run = promisify(execFile);
    const tmp = mkdtempSync(join(tmpdir(), "owl-boot-"));
    const transcript = [
      JSON.stringify({ uuid: "b-1", parentUuid: null, type: "user", message: { role: "user", content: "hello" } }),
      JSON.stringify({
        uuid: "b-2",
        parentUuid: "b-1",
        type: "assistant",
        message: { id: "r1", model: "m", content: [{ type: "text", text: "world" }] },
      }),
      JSON.stringify({ type: "cost-state", total: 1 }),
      JSON.stringify({ uuid: "b-3", parentUuid: "b-2", type: "user", message: { role: "user", content: "again" } }),
    ].join("\n");
    const transcriptPath = join(tmp, "sess-boot.jsonl");
    writeFileSync(transcriptPath, transcript, "utf8");
    const cfg = join(tmp, "cfg");
    mkdirSync(cfg, { recursive: true });

    const { stdout, stderr } = await run(process.execPath, [
      join(__dirname, "..", "..", "helpers", "bootstrap.mjs"),
      transcriptPath,
      "--config-dir",
      cfg,
    ]);
    // summary JSON on stderr (the scan.mjs protocol) AND the SAME line on
    // stdout (the engine-run caller parses stdout — $.process.run exposes it)
    const summary = JSON.parse(stderr.trim().split("\n").pop() ?? "{}");
    expect(summary.done).toBe(true);
    expect(summary.rows).toBe(3); // metadata row skipped
    const stdoutSummary = JSON.parse(stdout.trim().split("\n").pop() ?? "{}");
    expect(stdoutSummary).toEqual(summary);

    // the batches live in the owl session dir and sweep correctly (format
    // compatibility with the TS mirror — the whole point of the helper)
    const sessDir = join(cfg, "session-owl", "sessions", "sess-boot");
    const files = readdirSync(sessDir).filter((f) => /^m\d+-\w+\.jsonl$/.test(f));
    expect(files.length).toBeGreaterThanOrEqual(1);
    const mem = createMemoryFs();
    const sep = join("x", "y").slice(1, -1); // the platform path separator
    const norm = (p: string) => p.split(sep).join("/");
    for (const f of readdirSync(sessDir)) {
      mem.adapter.writeText(`${norm(sessDir)}/${f}`, readFileSync(join(sessDir, f), "utf8"));
    }
    const sweep = await sweepMirror(mem.adapter, norm(sessDir));
    expect(sweep.rows.map((r) => r.uuid)).toEqual(["b-1", "b-2", "b-3"]);
    const second = sweep.rows[1]?.row as { message?: { content?: unknown } };
    expect(Array.isArray(second.message?.content)).toBe(true);
    // rows are DERIVED (door/origin/message.type), not raw — so the
    // grouper consumes helper-bootstrapped segments like live ones
    const first = sweep.rows[0]?.row as { door?: string; origin?: { kind?: string }; message?: { type?: string } };
    expect(first.door).toBe("prompt");
    expect(first.origin).toMatchObject({ kind: "composer" });
    expect(first.message?.type).toBe("user");
    const asst = sweep.rows[1]?.row as { door?: string; origin?: { kind?: string; model?: string } };
    expect(asst.door).toBe("response");
    expect(asst.origin).toMatchObject({ kind: "model", model: "m" });
  }, 30_000);

  test("a trailing --after with no value exits 2 (no silent zero-row mirror)", async () => {
    const run = promisify(execFile);
    const tmp = mkdtempSync(join(tmpdir(), "owl-boot-after-"));
    const t = join(tmp, "t.jsonl");
    writeFileSync(
      t,
      JSON.stringify({ uuid: "a-1", parentUuid: null, type: "user", message: { role: "user", content: "x" } }),
      "utf8",
    );
    const res = (await run(process.execPath, [
      join(__dirname, "..", "..", "helpers", "bootstrap.mjs"),
      t,
      "--config-dir",
      join(tmp, "cfg"),
      "--after",
    ]).catch((e: unknown) => e)) as { code?: number; stderr?: string };
    expect(res.code).toBe(2);
    expect(res.stderr).toContain("usage:");
  }, 30_000);

  test("a flag token as the --after value exits 2 (no silent zero-row mirror)", async () => {
    const run = promisify(execFile);
    const tmp = mkdtempSync(join(tmpdir(), "owl-boot-after-flag"));
    const t = join(tmp, "t.jsonl");
    writeFileSync(
      t,
      JSON.stringify({ uuid: "a-1", parentUuid: null, type: "user", message: { role: "user", content: "x" } }),
      "utf8",
    );
    // --after --limit 5: the flag token would pass the missing-value guard,
    // match no row, and exit 0 with zero rows — the same silent-no-op class
    const res = (await run(process.execPath, [
      join(__dirname, "..", "..", "helpers", "bootstrap.mjs"),
      t,
      "--config-dir",
      join(tmp, "cfg"),
      "--after",
      "--limit",
      "5",
    ]).catch((e: unknown) => e)) as { code?: number; stderr?: string };
    expect(res.code).toBe(2);
    expect(res.stderr).toContain("usage:");
  }, 30_000);

  test("a flag token as --session-id exits 2 (no garbage sessions/--limit dir)", async () => {
    const run = promisify(execFile);
    const tmp = mkdtempSync(join(tmpdir(), "owl-boot-sid-flag"));
    const t = join(tmp, "t.jsonl");
    writeFileSync(
      t,
      JSON.stringify({ uuid: "a-1", parentUuid: null, type: "user", message: { role: "user", content: "x" } }),
      "utf8",
    );
    const res = (await run(process.execPath, [
      join(__dirname, "..", "..", "helpers", "bootstrap.mjs"),
      t,
      "--config-dir",
      join(tmp, "cfg"),
      "--session-id",
      "--limit",
      "5",
    ]).catch((e: unknown) => e)) as { code?: number; stderr?: string };
    expect(res.code).toBe(2);
    expect(res.stderr).toContain("usage:");
  }, 30_000);

  test("multi-page runs keep ONE seq with .k continuation parts (writer parity)", async () => {
    const run = promisify(execFile);
    const tmp = mkdtempSync(join(tmpdir(), "owl-boot2-"));
    const rows = [];
    for (let i = 0; i < 6; i += 1) {
      rows.push(
        JSON.stringify({
          uuid: `p-${i}`,
          parentUuid: i === 0 ? null : `p-${i - 1}`,
          type: "user",
          message: { role: "user", content: `row ${i} ${"x".repeat(120)}` },
        }),
      );
    }
    const transcriptPath = join(tmp, "sess-pages.jsonl");
    writeFileSync(transcriptPath, `${rows.join("\n")}\n`, "utf8");
    const cfg = join(tmp, "cfg");
    mkdirSync(cfg, { recursive: true });

    const { stderr } = await run(process.execPath, [
      join(__dirname, "..", "..", "helpers", "bootstrap.mjs"),
      transcriptPath,
      "--config-dir",
      cfg,
      "--page-bytes",
      "400",
    ]);
    const summary = JSON.parse(stderr.trim().split("\n").pop() ?? "{}");
    expect(summary.done).toBe(true);
    expect(summary.rows).toBe(6);
    expect(summary.pages).toBeGreaterThanOrEqual(2);
    const sessDir = join(cfg, "session-owl", "sessions", "sess-pages");
    const batches = readdirSync(sessDir).filter((f) => /^m\d+-[0-9a-f]+/.test(f));
    // ONE seq across pages: m1-<tag>.jsonl, m1-<tag>.k1.jsonl, ...
    const seqs = new Set(batches.map((f) => /^m(\d+)-/.exec(f)?.[1]));
    expect(seqs.size).toBe(1);
    expect(batches.some((f) => f.includes(".k1"))).toBe(true);
  }, 30_000);

  test("the page budget is BYTES: CJK rows split at the byte budget, files stay under it", async () => {
    const run = promisify(execFile);
    const tmp = mkdtempSync(join(tmpdir(), "owl-boot4-"));
    const rows = [];
    for (let i = 0; i < 8; i += 1) {
      rows.push(
        JSON.stringify({
          uuid: `cjk-${i}`,
          parentUuid: i === 0 ? null : `cjk-${i - 1}`,
          type: "user",
          message: { role: "user", content: `配置检查第${i}行${"汉".repeat(100)}` },
        }),
      );
    }
    const transcriptPath = join(tmp, "sess-cjk.jsonl");
    writeFileSync(transcriptPath, `${rows.join("\n")}\n`, "utf8");
    const cfg = join(tmp, "cfg");
    mkdirSync(cfg, { recursive: true });
    const { stderr } = await run(process.execPath, [
      join(__dirname, "..", "..", "helpers", "bootstrap.mjs"),
      transcriptPath,
      "--config-dir",
      cfg,
      "--page-bytes",
      "600",
    ]);
    const summary = JSON.parse(stderr.trim().split("\n").pop() ?? "{}");
    expect(summary.done).toBe(true);
    expect(summary.rows).toBe(8);
    const sessDir = join(cfg, "session-owl", "sessions", "sess-cjk");
    for (const f of readdirSync(sessDir).filter((x) => /^m\d+-/.test(x))) {
      const size = statSync(join(sessDir, f)).size;
      expect(size).toBeLessThanOrEqual(620); // the byte budget (+ newline slack)
    }
  }, 30_000);

  test("uuid-bearing metadata rows are skipped (the host reader's type filter)", async () => {
    const run = promisify(execFile);
    const tmp = mkdtempSync(join(tmpdir(), "owl-boot5-"));
    const rows = [
      JSON.stringify({ uuid: "ok-1", parentUuid: null, type: "user", message: { role: "user", content: "real" } }),
      JSON.stringify({
        uuid: "meta-1",
        parentUuid: "ok-1",
        type: "queue_notification",
        message: { role: "user", content: "engine noise" },
      }),
      JSON.stringify({
        uuid: "ok-2",
        parentUuid: "ok-1",
        type: "assistant",
        message: { id: "r9", model: "m", content: [{ type: "text", text: "reply" }] },
      }),
    ];
    const transcriptPath = join(tmp, "sess-meta.jsonl");
    writeFileSync(transcriptPath, `${rows.join("\n")}\n`, "utf8");
    const cfg = join(tmp, "cfg");
    mkdirSync(cfg, { recursive: true });
    const { stderr } = await run(process.execPath, [
      join(__dirname, "..", "..", "helpers", "bootstrap.mjs"),
      transcriptPath,
      "--config-dir",
      cfg,
    ]);
    const summary = JSON.parse(stderr.trim().split("\n").pop() ?? "{}");
    expect(summary.rows).toBe(2); // the queue_notification row skipped
    const sessDir = join(cfg, "session-owl", "sessions", "sess-meta");
    const mem = createMemoryFs();
    const sep = join("x", "y").slice(1, -1);
    const norm = (pp: string) => pp.split(sep).join("/");
    for (const f of readdirSync(sessDir)) {
      await mem.adapter.writeText(`${norm(sessDir)}/${f}`, readFileSync(join(sessDir, f), "utf8"));
    }
    const sweep = await sweepMirror(mem.adapter, norm(sessDir));
    expect(sweep.rows.map((r) => r.uuid)).toEqual(["ok-1", "ok-2"]);
  }, 30_000);

  test("--after bounds the walk (known uuid skips; unknown uuid is a silent no-op)", async () => {
    const run = promisify(execFile);
    const tmp = mkdtempSync(join(tmpdir(), "owl-boot6-"));
    const rows = [
      JSON.stringify({ uuid: "a-1", parentUuid: null, type: "user", message: { role: "user", content: "one" } }),
      JSON.stringify({ uuid: "a-2", parentUuid: "a-1", type: "user", message: { role: "user", content: "two" } }),
    ];
    const transcriptPath = join(tmp, "sess-after.jsonl");
    writeFileSync(transcriptPath, `${rows.join("\n")}\n`, "utf8");
    const cfg = join(tmp, "cfg");
    mkdirSync(cfg, { recursive: true });
    const known = await run(process.execPath, [
      join(__dirname, "..", "..", "helpers", "bootstrap.mjs"),
      transcriptPath,
      "--config-dir",
      cfg,
      "--after",
      "a-1",
    ]);
    expect(JSON.parse(known.stderr.trim().split("\n").pop() ?? "{}").rows).toBe(1); // only a-2
    const unknown = await run(process.execPath, [
      join(__dirname, "..", "..", "helpers", "bootstrap.mjs"),
      transcriptPath,
      "--config-dir",
      join(tmp, "cfg2"),
      "--after",
      "never-seen",
    ]);
    const summary = JSON.parse(unknown.stderr.trim().split("\n").pop() ?? "{}");
    expect(summary.done).toBe(true); // silent no-op: nothing after the marker
    expect(summary.rows).toBe(0);
  }, 30_000);

  test("a non-numeric --page-bytes exits 2 with the usage line; a missing file exits 1 with {error}", async () => {
    const run = promisify(execFile);
    const tmp = mkdtempSync(join(tmpdir(), "owl-boot3-"));
    const cfg = join(tmp, "cfg");
    mkdirSync(cfg, { recursive: true });
    await expect(
      run(process.execPath, [
        join(__dirname, "..", "..", "helpers", "bootstrap.mjs"),
        join(tmp, "x.jsonl"),
        "--config-dir",
        cfg,
        "--page-bytes",
        "NaN!",
      ]),
    ).rejects.toMatchObject({ code: 2 });
    await expect(
      run(process.execPath, [
        join(__dirname, "..", "..", "helpers", "bootstrap.mjs"),
        join(tmp, "absent.jsonl"),
        "--config-dir",
        cfg,
      ]),
    ).rejects.toMatchObject({ code: 1 });
  }, 30_000);
});

describe("helpers/bootstrap.mjs — the session-id sanitizer", () => {
  test("a hostile --session-id stays inside the sessions root (percent-encoded)", async () => {
    const run = promisify(execFile);
    const tmp = mkdtempSync(join(tmpdir(), "owl-boot-san-"));
    const transcriptPath = join(tmp, "sess-san.jsonl");
    writeFileSync(
      transcriptPath,
      JSON.stringify({ uuid: "s-1", parentUuid: null, type: "user", message: { role: "user", content: "hi" } }),
      "utf8",
    );
    const cfg = join(tmp, "cfg");
    mkdirSync(cfg, { recursive: true });
    await run(process.execPath, [
      join(__dirname, "..", "..", "helpers", "bootstrap.mjs"),
      transcriptPath,
      "--config-dir",
      cfg,
      "--session-id",
      "../../escape|attempt",
    ]);
    // the sanitized dir name: path separators and '|' percent-encoded — the
    // tree under cfg has exactly ONE session dir and nothing outside it
    const sessionsRoot = join(cfg, "session-owl", "sessions");
    const entries = readdirSync(sessionsRoot);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toBe("..%2f..%2fescape%7cattempt");
    expect(existsSync(join(tmp, "escape"))).toBe(false); // nothing escaped
  }, 30_000);
});

describe("helpers/bootstrap.mjs — the isMeta three-way split (host-reader parity)", () => {
  function runRows(rows: unknown[]): Promise<string> {
    // runs the helper over a generated transcript, then returns the session
    // dir's swept rows as JSON (door/origin per row)
    const tmp = mkdtempSync(join(tmpdir(), "owl-boot-meta-"));
    const transcriptPath = join(tmp, "t.jsonl");
    writeFileSync(transcriptPath, `${rows.map((r) => JSON.stringify(r)).join("\n")}\n`, "utf8");
    const cfg = join(tmp, "cfg");
    mkdirSync(cfg, { recursive: true });
    const run = promisify(execFile);
    return run(process.execPath, [
      join(__dirname, "..", "..", "helpers", "bootstrap.mjs"),
      transcriptPath,
      "--config-dir",
      cfg,
      "--session-id",
      "meta-parity",
    ]).then(async () => {
      const sessDir = join(cfg, "session-owl", "sessions", "meta-parity");
      const mem = createMemoryFs();
      const sep = join("x", "y").slice(1, -1);
      const norm = (p: string) => p.split(sep).join("/");
      for (const f of readdirSync(sessDir)) {
        mem.adapter.writeText(`${norm(sessDir)}/${f}`, readFileSync(join(sessDir, f), "utf8"));
      }
      const sweep = await sweepMirror(mem.adapter, norm(sessDir));
      return JSON.stringify(
        sweep.rows.map((r) => ({
          door: (r.row as { door?: string }).door,
          origin: (r.row as { origin?: { kind?: string } }).origin,
        })),
      );
    });
  }

  test("reminder-tag isMeta -> attachment/engine; plugin-user isMeta -> note/plugin; other isMeta -> attachment/engine", async () => {
    const out = JSON.parse(
      await runRows([
        { uuid: "m-1", parentUuid: null, type: "user", message: { role: "user", content: "hi" } },
        {
          uuid: "m-2",
          parentUuid: "m-1",
          type: "user",
          isMeta: true,
          message: {
            role: "user",
            content: [{ type: "text", text: "<system-reminder>you are a subagent</system-reminder>" }],
          },
        },
        {
          uuid: "m-3",
          parentUuid: "m-2",
          type: "user",
          isMeta: true,
          message: { role: "user", content: [{ type: "text", text: "injected by another plugin" }] },
        },
        {
          uuid: "m-4",
          parentUuid: "m-3",
          type: "assistant",
          isMeta: true,
          message: { role: "assistant", content: [] },
        },
      ]),
    ) as Array<{ door: string; origin: { kind: string } }>;
    expect(out[0]).toEqual({ door: "prompt", origin: { kind: "composer" } });
    expect(out[1]).toEqual({ door: "attachment", origin: { kind: "engine" } }); // the reminder class: skipped
    expect(out[2]).toEqual({ door: "note", origin: { kind: "plugin" } }); // plugin append: custom_message via the grouper
    expect(out[3]).toEqual({ door: "attachment", origin: { kind: "engine" } }); // non-user meta: skipped
  }, 30_000);
});

describe("runBackfill — the over-cap bootstrap seam", () => {
  const mem = createMemoryFs();

  beforeEach(async () => {
    mem.files.clear();
    _resetCoreInstances();
    resetForNewSession();
    clearDetailsCache();
  });

  async function backfillWith(over: ((p: string) => Promise<boolean>) | undefined) {
    const dir = "/cfg/session-owl/sessions/sess-boot2";
    await mem.adapter.writeText("/t/sess-boot2.jsonl", "x".repeat(READ_CAP + 128));
    const mirror = new MirrorWriter(mem.adapter, dir, "run-sess-boot2");
    const ledger = new LedgerWriter(mem.adapter, dir, "run-sess-boot2");
    return await runBackfill(mirror, ledger, {
      key: "sess-boot2",
      sessionId: "sess-boot2",
      agentId: null,
      fs: mem.adapter,
      transcriptPath: "/t/sess-boot2.jsonl",
      enabled: true,
      fireGoalExtract: () => {},
      computePending: corePendingEvaluator,
      bootstrapOverCap: over,
    });
  }

  test("an over-cap transcript runs the injected helper BEFORE the sweep; ok clears the block", async () => {
    const calls: string[] = [];
    const result = await backfillWith(async (p) => {
      calls.push(p);
      return true; // the helper wrote mirror batches
    });
    expect(calls).toEqual(["/t/sess-boot2.jsonl"]);
    expect(result.tooLarge).toBe(true);
    expect(result.bootstrapBlocked).toBe(false);
  });

  test("a failed/absent helper leaves the backlog blocked (the /owl-status note)", async () => {
    const failed = await backfillWith(async () => false);
    expect(failed.bootstrapBlocked).toBe(true);
    const absent = await backfillWith(undefined);
    expect(absent.bootstrapBlocked).toBe(true);
  });
});
