#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

/**
 * claude-validate — offline gate: `claude plugin validate` over both
 * plugin trees: ./claude (session-owl) and ./claude-subagent-support (the
 * stage spawner companion).
 *
 * The validator reads the plugin manifest and the hooks module's source the
 * way the engine will (event registrations, literal `$` call sites, manifest
 * shape) and refuses anything the engine would refuse — before any session
 * loads the plugin. It runs fully offline.
 *
 * Usage:
 *   node scripts/claude-validate.cjs
 *
 * Exit codes:
 *   0  validation passed, or SKIPPED (no `claude` binary on PATH)
 *   1  validation failed, or the binary could not be executed
 */
const cp = require("node:child_process");

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
  const probe = await run("claude --version");
  if (probe.failed || probe.code !== 0) {
    console.log("[claude-validate] SKIP (claude CLI not on PATH)");
    process.exit(0);
  }
  const version = probe.out.trim().split(/\r?\n/)[0];
  let failed = false;
  for (const dir of ["./claude", "./claude-subagent-support"]) {
    const res = await run(`claude plugin validate ${dir}`);
    if (res.out.trim()) console.log(res.out.trim());
    if (res.failed) {
      console.error(`[claude-validate] FAIL: could not execute claude (${version})`);
      process.exit(1);
    }
    if (!res.ok) {
      console.error(`[claude-validate] FAIL ${dir} (${version})`);
      failed = true;
    }
  }
  if (failed) process.exit(1);
  console.log(`[claude-validate] ok (${version})`);
})();
