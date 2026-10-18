// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>
// The mirror-retention prune helper: a real Node CLI over temp config
// trees — dry-run by default (--apply unlinks), per-SESSION granularity,
// the marker/scan liveness ladder, agent-suffixed dirs governed by their
// PARENT session.
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { promisify } from "node:util";
import { describe, expect, test } from "vitest";

const run = promisify(execFile);
const HELPER = join(__dirname, "..", "..", "helpers", "prune.mjs");
const NOW = "2026-10-08T12:00:00.000Z";
const NOW_MS = Date.parse(NOW);
const DAY_MS = 86_400_000;

// temp trees stay for post-mortem (the OS tmpdir sweep collects them)

interface PruneReport {
  mode: "off" | "days" | "follow";
  days: number | null;
  removed: number;
  errors: Array<{ dir: string; error: string }>;
  sessions: Array<{
    dir: string;
    sessionId: string;
    agentOf: string | null;
    verdict: "keep" | "expired" | "transcript-gone";
  }>;
}

async function prune(cfg: string, ...args: string[]): Promise<PruneReport> {
  const { stdout } = await run(process.execPath, [HELPER, "--config-dir", cfg, "--now", NOW, ...args]);
  return JSON.parse(stdout.trim().split("\n").pop() ?? "{}") as PruneReport;
}

/** A session dir with one batch file whose mtime is ageDays before NOW. */
function makeSession(
  cfg: string,
  sessionId: string,
  opts: { ageDays?: number; markerTranscript?: string | null; agentSuffix?: string } = {},
): string {
  const name = opts.agentSuffix !== undefined ? `${sessionId}-${opts.agentSuffix}` : sessionId;
  const dir = join(cfg, "session-owl", "sessions", name);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "m1-abcdef12.jsonl");
  writeFileSync(file, '{"uuid":"x"}\n', "utf8");
  const age = opts.ageDays ?? 0;
  const t = new Date(NOW_MS - age * DAY_MS);
  utimesSync(file, t, t);
  if (opts.markerTranscript !== undefined) {
    const marker = join(dir, ".session.json");
    writeFileSync(marker, `${JSON.stringify({ sessionId, transcriptPath: opts.markerTranscript })}\n`, "utf8");
    utimesSync(marker, t, t);
  }
  return dir;
}

function makeTranscript(cfg: string, sessionId: string): string {
  const dir = join(cfg, "projects", "E-proj");
  mkdirSync(dir, { recursive: true });
  const p = join(dir, `${sessionId}.jsonl`);
  writeFileSync(p, '{"uuid":"t"}\n', "utf8");
  return p;
}

function writeFileIfMissing(path: string): void {
  if (!existsSync(path)) writeFileSync(path, "x", "utf8");
}

function baseTree(): string {
  return mkdtempSync(join(tmpdir(), "owl-prune-"));
}

describe("helpers/prune.mjs — mode gating", () => {
  test("default keep-forever: no sweep at all (nothing enumerated, nothing removed even with --apply)", async () => {
    const cfg = baseTree();
    makeSession(cfg, "11111111-2222-3333-4444-555555555555", { ageDays: 400 });
    const report = await prune(cfg, "--apply");
    expect(report.mode).toBe("off");
    expect(report.sessions).toEqual([]);
    expect(report.removed).toBe(0);
    expect(existsSync(join(cfg, "session-owl", "sessions"))).toBe(true);
  });

  test("--days N switches to days mode; the host default surfaces in follow mode without settings.json", async () => {
    const cfg = baseTree();
    makeSession(cfg, "11111111-2222-3333-4444-555555555555", { ageDays: 0 });
    expect((await prune(cfg, "--days", "7")).mode).toBe("days");
    const follow = await prune(cfg, "--follow-cleanup");
    expect(follow.mode).toBe("follow");
    expect(follow.days).toBe(30); // Claude Code's cleanupPeriodDays default
  });

  test("cleanupPeriodDays 0 = the host keeps forever — follow mode sweeps nothing", async () => {
    const cfg = baseTree();
    mkdirSync(cfg, { recursive: true });
    writeFileSync(join(cfg, "settings.json"), JSON.stringify({ cleanupPeriodDays: 0 }), "utf8");
    makeSession(cfg, "11111111-2222-3333-4444-555555555555", { ageDays: 400 });
    const report = await prune(cfg, "--follow-cleanup", "--apply");
    expect(report.days).toBe(0);
    expect(report.sessions).toEqual([]); // no sweep at all
    expect(report.removed).toBe(0);
  });

  test("--follow-cleanup reads the host's cleanupPeriodDays from settings.json", async () => {
    const cfg = baseTree();
    mkdirSync(cfg, { recursive: true });
    writeFileSync(join(cfg, "settings.json"), JSON.stringify({ cleanupPeriodDays: 3 }), "utf8");
    makeTranscript(cfg, "11111111-2222-3333-4444-555555555555"); // live — only age can sweep
    makeSession(cfg, "11111111-2222-3333-4444-555555555555", { ageDays: 10 });
    const report = await prune(cfg, "--follow-cleanup");
    expect(report.days).toBe(3);
    expect(report.sessions[0]?.verdict).toBe("expired");
  });
});

describe("helpers/prune.mjs — expiry (per-SESSION granularity)", () => {
  test("dry-run default: an expired session is REPORTED but never unlinked; --apply unlinks only it", async () => {
    const cfg = baseTree();
    const oldDir = makeSession(cfg, "11111111-2222-3333-4444-555555555555", {
      ageDays: 10,
      markerTranscript: makeTranscript(cfg, "11111111-2222-3333-4444-555555555555"),
    });
    const newDir = makeSession(cfg, "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", {
      ageDays: 1,
      markerTranscript: makeTranscript(cfg, "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"),
    });
    const dry = await prune(cfg, "--days", "7");
    expect(dry.removed).toBe(0);
    expect(existsSync(oldDir)).toBe(true);
    const applied = await prune(cfg, "--days", "7", "--apply");
    expect(applied.removed).toBe(1);
    expect(existsSync(oldDir)).toBe(false);
    expect(existsSync(newDir)).toBe(true);
  });

  test("the verdicts carry the reason split (expired vs keep vs transcript-gone)", async () => {
    const cfg = baseTree();
    makeSession(cfg, "11111111-2222-3333-4444-555555555555", {
      ageDays: 10,
      markerTranscript: makeTranscript(cfg, "11111111-2222-3333-4444-555555555555"),
    });
    makeSession(cfg, "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", {
      ageDays: 1,
      markerTranscript: join(cfg, "missing.jsonl"),
    });
    const report = await prune(cfg, "--days", "7");
    const byDir = new Map(report.sessions.map((s) => [s.sessionId, s.verdict]));
    expect(byDir.get("11111111-2222-3333-4444-555555555555")).toBe("expired");
    expect(byDir.get("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee")).toBe("transcript-gone");
  });
});

describe("helpers/prune.mjs — liveness (marker authoritative, scan fallback)", () => {
  test("the marker's transcriptPath decides: exists = keep even when the scan would miss it", async () => {
    const cfg = baseTree();
    const sid = "11111111-2222-3333-4444-555555555555";
    // transcript OUTSIDE projects/ (cross-cwd sessions keep absolute paths)
    const outside = join(cfg, "elsewhere", `${sid}.jsonl`);
    mkdirSync(join(cfg, "elsewhere"), { recursive: true });
    writeFileSync(outside, "{}\n", "utf8");
    makeSession(cfg, sid, { ageDays: 10, markerTranscript: outside });
    const report = await prune(cfg, "--days", "7");
    expect(report.sessions[0]?.verdict).toBe("expired"); // old, but LIVE — the sweep verdict is age-based
    expect(report.removed).toBe(0);
  });

  test("a marker whose pointed-at path is GONE falls through to the scan (the cross-cwd ENOENT posture)", async () => {
    const cfg = baseTree();
    const sid = "11111111-2222-3333-4444-555555555555";
    makeTranscript(cfg, sid); // the scan DOES find the live transcript
    makeSession(cfg, sid, { ageDays: 10, markerTranscript: join(cfg, "stale-path", `${sid}.jsonl`) });
    const report = await prune(cfg, "--days", "7");
    expect(report.sessions[0]?.verdict).toBe("expired"); // live via the scan — only AGE may sweep
  });

  test("no marker: the filename scan of projects/**/<sessionId>.jsonl decides", async () => {
    const cfg = baseTree();
    const sid = "11111111-2222-3333-4444-555555555555";
    makeTranscript(cfg, sid); // the scan finds it
    makeSession(cfg, sid, { ageDays: 10 }); // no marker
    const orphanSid = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    makeSession(cfg, orphanSid, { ageDays: 1 }); // no marker, no transcript
    const report = await prune(cfg, "--days", "7");
    const byDir = new Map(report.sessions.map((s) => [s.sessionId, s.verdict]));
    expect(byDir.get(sid)).toBe("expired"); // live transcript: only AGE can sweep it
    expect(byDir.get(orphanSid)).toBe("transcript-gone"); // young but dead — swept
  });
});

describe("helpers/prune.mjs — agent-suffixed dirs (parent governance)", () => {
  const parent = "11111111-2222-3333-4444-555555555555";
  test("a LIVE parent keeps every loop's memory (an old agent dir survives; a young one with a dead parent sweeps)", async () => {
    const cfg = baseTree();
    makeTranscript(cfg, parent); // parent live
    const oldAgent = makeSession(cfg, parent, { ageDays: 10, agentSuffix: "agent-abc123" });
    const report = await prune(cfg, "--days", "7");
    const agent = report.sessions.find((s) => s.agentOf === parent);
    expect(agent?.verdict).toBe("keep"); // parent live overrides age
    expect(report.removed).toBe(0);
    expect(existsSync(oldAgent)).toBe(true);

    // dead parent: the agent dir dies with it regardless of age
    const deadParent = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    const youngAgent = makeSession(cfg, deadParent, { ageDays: 0, agentSuffix: "agent-xyz" });
    const applied = await prune(cfg, "--days", "7", "--apply");
    expect(applied.removed).toBe(1);
    expect(existsSync(youngAgent)).toBe(false);
  });

  test("a pruned main file but LIVE subagents dir keeps the parent (and its loops) alive", async () => {
    const cfg = baseTree();
    // the REAL captured layout: projects/<proj>/<sessionId>/subagents/*.jsonl
    const sid = "11111111-2222-3333-4444-555555555555";
    const projDir = join(cfg, "projects", "E-proj");
    mkdirSync(join(projDir, sid, "subagents"), { recursive: true });
    writeFileSync(join(projDir, sid, "subagents", "agent-abc123.jsonl"), "{}\n", "utf8");
    // the marker points at the (host-pruned) depth-1 main file; its dir still
    // holds the session's subagent transcripts
    makeSession(cfg, sid, { ageDays: 1, markerTranscript: join(projDir, `${sid}.jsonl`) });
    makeSession(cfg, sid, { ageDays: 10, agentSuffix: "agent-abc123" });
    const report = await prune(cfg, "--days", "7", "--apply");
    const agent = report.sessions.find((s) => s.agentOf !== null);
    expect(agent?.verdict).toBe("keep"); // the parent's subagents transcript still exists
    expect(report.removed).toBe(0);
  });

  test("an EMPTY subagents dir is dead — only .jsonl transcripts keep the parent", async () => {
    const cfg = baseTree();
    const sid = "11111111-2222-3333-4444-555555555555";
    const projDir = join(cfg, "projects", "E-proj");
    mkdirSync(join(projDir, sid, "subagents"), { recursive: true }); // no .jsonl inside
    makeSession(cfg, sid, { ageDays: 1, markerTranscript: join(projDir, `${sid}.jsonl`) });
    makeSession(cfg, sid, { ageDays: 1, agentSuffix: "agent-q" });
    const report = await prune(cfg, "--days", "7", "--apply");
    expect(report.removed).toBe(2); // both swept — the dir alone proves nothing
  });

  test("agent governance counts the parent's own liveness via its mirror marker too", async () => {
    const cfg = baseTree();
    // the parent's transcript exists but ONLY outside projects/ — reachable
    // through the PARENT session dir's marker (the agent dir has none)
    const outside = join(cfg, "elsewhere", `${parent}.jsonl`);
    mkdirSync(join(cfg, "elsewhere"), { recursive: true });
    writeFileSync(outside, "{}\n", "utf8");
    makeSession(cfg, parent, { ageDays: 1, markerTranscript: outside });
    makeSession(cfg, parent, { ageDays: 10, agentSuffix: "agent-q" });
    const report = await prune(cfg, "--days", "7");
    const agent = report.sessions.find((s) => s.agentOf === parent);
    expect(agent?.verdict).toBe("keep");
  });
});

describe("helpers/prune.mjs — CLI shape", () => {
  test("the report is JSON on stdout; usage errors exit 2 with a hint on stderr", async () => {
    const cfg = baseTree();
    const good = await run(process.execPath, [HELPER, "--config-dir", cfg, "--days", "7", "--now", NOW]);
    expect(() => JSON.parse(good.stdout.trim().split("\n").pop() ?? "{}")).not.toThrow();
    const bad = (await run(process.execPath, [HELPER, "--days", "abc"]).catch(
      (e: { code?: number; stderr?: string }) => e,
    )) as { code?: number; stderr?: string };
    expect(bad.code).toBe(2);
    expect(bad.stderr).toContain("usage");
  });

  test("one stubborn dir never aborts the sweep (per-dir errors, the rest proceed)", async () => {
    const cfg = baseTree();
    const sidA = "11111111-2222-3333-4444-555555555555";
    const sidB = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    makeTranscript(cfg, sidA);
    makeTranscript(cfg, sidB);
    makeSession(cfg, sidA, { ageDays: 10 }); // old + live transcript — swept fine
    makeSession(cfg, sidB, { ageDays: 10 }); // same — but blocked below
    if (process.platform === "win32") {
      // Windows user mode cannot force rmSync to fail (Node clears the
      // read-only bit, open handles don't block recursive delete) — pin the
      // never-abort shape under success instead; the failure containment is
      // pinned on posix (below) + by inspection (the per-dir try/catch)
      const report = await prune(cfg, "--days", "7", "--apply");
      expect(report.removed).toBe(2);
      expect(report.errors).toEqual([]);
      return;
    }
    const { chmodSync } = await import("node:fs");
    chmodSync(join(cfg, "session-owl", "sessions", sidB), 0o555); // unwritable dir → EACCES
    try {
      const report = await prune(cfg, "--days", "7", "--apply");
      expect(report.removed).toBe(1); // a swept
      expect((report.errors as Array<{ dir: string }>).some((e) => e.dir === sidB)).toBe(true); // b recorded
    } finally {
      chmodSync(join(cfg, "session-owl", "sessions", sidB), 0o755);
    }
  });

  test("the age is the MAX file mtime in the dir (a fresh write keeps an old session live)", async () => {
    const cfg = baseTree();
    const sid = "11111111-2222-3333-4444-555555555555";
    makeTranscript(cfg, sid);
    const dir = makeSession(cfg, sid, { ageDays: 10, markerTranscript: null }); // all files old
    // a fresh batch lands NOW — the session was just active on resume
    const fresh = join(dir, "m2-abcdef12.jsonl");
    writeFileSync(fresh, "{}\n", "utf8");
    const now = new Date(NOW_MS);
    utimesSync(fresh, now, now);
    const report = await prune(cfg, "--days", "7");
    expect(report.sessions[0]?.verdict).toBe("keep"); // max-mtime, not dir/min mtime
  });

  test("a FOREIGN entry under sessions/ is ignored (never enumerated, never deleted)", async () => {
    const cfg = baseTree();
    const foreign = join(cfg, "session-owl", "sessions", "not-a-session-dir");
    mkdirSync(foreign, { recursive: true });
    writeFileSync(join(foreign, "keep-me.txt"), "x", "utf8");
    writeFileIfMissing(join(cfg, "session-owl", "sessions", "README.md"));
    makeSession(cfg, "11111111-2222-3333-4444-555555555555", { ageDays: 10 });
    const report = await prune(cfg, "--days", "7", "--apply");
    expect(report.sessions.map((s) => s.dir)).toEqual(["11111111-2222-3333-4444-555555555555"]);
    expect(existsSync(join(foreign, "keep-me.txt"))).toBe(true);
  });

  test("an empty sessions root is a clean no-op", async () => {
    const cfg = baseTree();
    const report = await prune(cfg, "--days", "7", "--apply");
    expect(report.sessions).toEqual([]);
    expect(report.removed).toBe(0);
  });
});

describe("prune — flag-token values (the silent no-op class)", () => {
  test("--config-dir with a flag token as its value exits 2 (never scans a garbage root)", async () => {
    const res = (await run(process.execPath, [HELPER, "--config-dir", "--days", "30", "--apply"]).catch(
      (e: unknown) => e,
    )) as { code?: number; stderr?: string };
    expect(res.code).toBe(2);
    expect(res.stderr).toContain("usage:");
  });

  test("--now with a flag token as its value exits 2", async () => {
    const res = (await run(process.execPath, [HELPER, "--now", "--apply", "--days", "30"]).catch(
      (e: unknown) => e,
    )) as { code?: number; stderr?: string };
    expect(res.code).toBe(2);
    expect(res.stderr).toContain("usage:");
  });
});
