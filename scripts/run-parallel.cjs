// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

/**
 * Run multiple commands concurrently; exit non-zero if any fail.
 *
 * Keeps the desktop responsive: sets THIS process to BELOW_NORMAL priority
 * (children inherit it), matching test-low-priority.cjs. Intended for
 * short, single-core checks (typecheck, knip) — NOT for vitest, which
 * already saturates all CPUs.
 *
 * Usage:
 *   node scripts/run-parallel.cjs "<cmd1> :: <cmd2> [:: <cmd3> ...]"
 * Commands are passed as ONE argument, separated by " :: " (space-colon-colon-space),
 * so they survive the single cmd.exe string used by the npm test chain.
 *
 * Output is buffered per command and printed grouped, in input order, after all
 * finish. Silent commands (tsc --noEmit, knip) produce no output on success.
 */
const os = require("node:os");
const cp = require("node:child_process");

const SEP = " :: ";
const arg = process.argv.slice(2).join(" ");
if (!arg) {
  console.error('Usage: node scripts/run-parallel.cjs "<cmd1> :: <cmd2>"');
  process.exit(1);
}
const commands = arg
  .split(SEP)
  .map((c) => c.trim())
  .filter(Boolean);
if (commands.length === 0) {
  console.error('Usage: node scripts/run-parallel.cjs "<cmd1> :: <cmd2>"');
  process.exit(1);
}

// Defensive: lower priority so concurrent checks never freeze the desktop.
try {
  os.setPriority(os.constants.priority.PRIORITY_BELOW_NORMAL);
} catch {
  // best-effort
}

const isWindows = os.platform() === "win32";

function spawnCommand(cmd, idx) {
  return new Promise((resolve) => {
    const child = isWindows ? cp.spawn("cmd.exe", ["/c", cmd], { windowsHide: true }) : cp.spawn(cmd, { shell: true });
    let out = "";
    const collect = (chunk) => {
      out += chunk.toString();
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    child.on("error", (err) => {
      out += `\n[run-parallel spawn error] ${err.message}\n`;
      resolve({ idx, cmd, ok: false, code: 1, out });
    });
    child.on("exit", (code) => {
      resolve({ idx, cmd, ok: code === 0, code: code ?? 1, out });
    });
  });
}

Promise.all(commands.map((cmd, idx) => spawnCommand(cmd, idx))).then((results) => {
  results
    .sort((a, b) => a.idx - b.idx)
    .forEach((r) => {
      const status = r.ok ? "ok" : `FAIL(exit ${r.code})`;
      process.stdout.write(`\n[run-parallel ${r.idx + 1}/${results.length} ${status}] ${r.cmd}\n`);
      if (r.out) process.stdout.write(r.out);
    });
  const failed = results.filter((r) => !r.ok);
  process.exit(failed.length ? 1 : 0);
});
