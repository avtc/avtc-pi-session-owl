// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>
//
// The host-untouched gate's own suite: the real repo passes, and a tampered
// tree trips (src/ modified ⇒ fail; an unlisted tests/ change ⇒ fail; the
// recorded allowlist entries alone ⇒ pass).
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { promisify } from "node:util";
import { afterAll, describe, expect, test } from "vitest";

const run = promisify(execFile);
const SCRIPT = join(__dirname, "..", "..", "..", "scripts", "h5-host-untouched.cjs");

const temps: string[] = [];
afterAll(() => {
  for (const t of temps) rmSync(t, { recursive: true, force: true });
});

/** A git repo whose diff base..HEAD encodes the given pi-tree changes. */
async function tamperRepo(changes: Array<(repo: string) => void>): Promise<string> {
  const { execFileSync } = await import("node:child_process");
  const repo = mkdtempSync(join(tmpdir(), "owl-h5-"));
  temps.push(repo);
  const git = (args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8" });
  git(["init", "-q"]);
  git(["config", "user.email", "t@t"]);
  git(["config", "user.name", "t"]);
  mkdirSync(join(repo, "src"), { recursive: true });
  mkdirSync(join(repo, "tests"), { recursive: true });
  mkdirSync(join(repo, "claude"), { recursive: true });
  writeFileSync(join(repo, "src", "index.ts"), "export const a = 1;\n", "utf8");
  writeFileSync(join(repo, "tests", "one.test.ts"), "test('x', () => {});\n", "utf8");
  writeFileSync(
    join(repo, "tests", "setup.ts"),
    'import "./log-backend-setup.js"; // FIRST — installs the claude-logger backend the rewritten vendored core needs at log.ts load\n',
    "utf8",
  );
  writeFileSync(join(repo, "claude", "plugin.txt"), "1\n", "utf8");
  git(["add", "-A"]);
  git(["commit", "-qm", "base"]);
  const base = git(["rev-parse", "HEAD"]).trim();
  for (const change of changes) change(repo);
  git(["add", "-A"]);
  git(["commit", "-qm", "port-ish"]);
  // the script locates the base as the parent of the first commit touching
  // claude/.claude-plugin/plugin.json — provide exactly that shape
  mkdirSync(join(repo, "claude", ".claude-plugin"), { recursive: true });
  writeFileSync(join(repo, "claude", ".claude-plugin", "plugin.json"), "{}\n", "utf8");
  git(["add", "-A"]);
  git(["commit", "-qm", "port scaffold"]);
  return `${repo}\u0000${base}`;
}

async function runScript(repo: string, base: string): Promise<{ code: number; stderr: string; stdout: string }> {
  return run(process.execPath, [SCRIPT, "--repo", repo, "--base", base]).then(
    (r) => ({ code: 0, stderr: r.stderr, stdout: r.stdout }),
    (e: { code?: number; stderr?: string; stdout?: string }) => ({
      code: e.code ?? 1,
      stderr: e.stderr ?? "",
      stdout: e.stdout ?? "",
    }),
  );
}

describe("h5-host-untouched gate", () => {
  test("the real repo is clean (src/ + index.ts untouched; tests/ within allowlist)", async () => {
    const { execFileSync } = await import("node:child_process");
    const repoRoot = join(__dirname, "..", "..", "..");
    const out = execFileSync(process.execPath, [SCRIPT, "--repo", repoRoot], { encoding: "utf8" });
    expect(out).toContain("clean");
  }, 30_000);

  test("a modified src/ file trips the gate", async () => {
    const [repo, base] = (
      await tamperRepo([(r) => writeFileSync(join(r, "src", "index.ts"), "export const a = 2;\n", "utf8")])
    ).split("\u0000");
    const res = await runScript(repo, base);
    expect(res.code).toBe(1);
    expect(res.stderr).toContain("src-surface");
  }, 60_000);

  test("a CHANGED diff on an allowlisted file trips (the content pin)", async () => {
    // the base carries the recorded setup.ts line; the port commit swaps it
    // for an equal-length different line — the name-set match, the content
    // compare fails (stronger than a pure addition: catches rewrites too)
    const [repo, base] = (
      await tamperRepo([
        (r) => {
          const setupPath = join(r, "tests", "setup.ts");
          writeFileSync(setupPath, `${readFileSync(setupPath, "utf8")}import "./extra.js";\n`, "utf8");
        },
      ])
    ).split("\u0000");
    const res = await runScript(repo, base);
    expect(res.code).toBe(1);
    expect(res.stderr).toContain("diff grew beyond the recorded hunk set");
  }, 60_000);

  test("an unlisted tests/ change trips; the allowlist shape alone passes", async () => {
    const [repo, base] = (
      await tamperRepo([(r) => writeFileSync(join(r, "tests", "one.test.ts"), "test('y', () => {});\n", "utf8")])
    ).split("\u0000");
    const bad = await runScript(repo, base);
    expect(bad.code).toBe(1);
    expect(bad.stderr).toContain("tests-surface");

    const [repo2, base2] = (
      await tamperRepo([(r) => writeFileSync(join(r, "tests", "log-backend-setup.ts"), "export {};\n", "utf8")])
    ).split("\u0000");
    const good = await runScript(repo2, base2);
    expect(good.code).toBe(0);
  }, 60_000);
});
