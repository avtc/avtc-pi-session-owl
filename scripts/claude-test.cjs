#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

/**
 * claude-test — offline gate: `claude plugin test ./claude`.
 *
 * Runs the plugin's behavioral specs under the engine's testing kit
 * (claude-code/testing), which the engine itself supplies — no network, no
 * model. Specs live under claude/plugin-test/ and accumulate as the port
 * grows; the engine enforces a small per-test time budget, so specs stay
 * short.
 *
 * Usage:
 *   node scripts/claude-test.cjs
 *
 * Exit codes:
 *   0  tests passed, or SKIPPED (no `claude` binary on PATH)
 *   1  tests failed, or the binary could not be executed
 */
const cp = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

// Specs accumulate under claude/plugin-test/ as the port grows; an empty
// spec tree is not a failure, it is "not written yet" — skip instead of
// letting the engine fail on `no *.test.ts under claude/`.
const specDir = path.resolve(__dirname, "..", "claude", "plugin-test");
const hasSpecs =
  fs.existsSync(specDir) && fs.readdirSync(specDir).some((f) => f.endsWith(".test.ts") || f.endsWith(".test.tsx"));

function run(cmd, args) {
  return new Promise((resolve) => {
    const child = cp.spawn(cmd, args, { shell: true, windowsHide: true });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    child.on("error", () => resolve({ ok: false, out, failed: true }));
    child.on("close", (code) => resolve({ ok: code === 0, out, code }));
  });
}

(async () => {
  if (!hasSpecs) {
    console.log("[claude-test] SKIP (no specs under claude/plugin-test/ yet)");
    process.exit(0);
  }
  const probe = await run("claude --version");
  if (probe.failed || probe.code !== 0) {
    console.log("[claude-test] SKIP (claude CLI not on PATH)");
    process.exit(0);
  }
  const version = probe.out.trim().split(/\r?\n/)[0];
  const res = await run("claude plugin test ./claude");
  if (res.out.trim()) console.log(res.out.trim());
  if (res.failed) {
    console.error(`[claude-test] FAIL: could not execute claude (${version})`);
    process.exit(1);
  }
  if (!res.ok) {
    console.error(`[claude-test] FAIL (${version})`);
    process.exit(1);
  }
  console.log(`[claude-test] ok (${version})`);
})();
