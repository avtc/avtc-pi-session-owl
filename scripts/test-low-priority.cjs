// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

/**
 * Test runner wrapper that lowers process priority.
 * Prevents test suites from hogging CPU and freezing the desktop.
 *
 * Usage in package.json:
 *   "test": "node scripts/test-low-priority.cjs vitest run"
 *   "test": "node scripts/test-low-priority.cjs tsx --test <glob>"
 *
 * Sets the current process to BELOW_NORMAL priority via os.setPriority()
 * (cross-platform Node.js API). Children inherit the lowered priority.
 * On Windows, spawns via cmd.exe to support .cmd binaries.
 * On other OSes, spawns with shell:true.
 */
const os = require("node:os");
const cp = require("node:child_process");
const path = require("node:path");
const fs = require("node:fs");

const command = process.argv.slice(2);
if (command.length === 0) {
  console.error("Usage: node test-low-priority.cjs <command> [args...]");
  process.exit(1);
}

const isWindows = os.platform() === "win32";
const BELOW_NORMAL = os.constants.priority.PRIORITY_BELOW_NORMAL;

// Lower THIS process's priority — children will inherit it
try {
  os.setPriority(BELOW_NORMAL);
} catch {
  // Priority setting is best-effort; don't fail the test run
}

// Ensure node_modules/.bin is on PATH so local CLIs (vitest, tsx) resolve
const localBin = path.join(process.cwd(), "node_modules", ".bin");
if (fs.existsSync(localBin)) {
  const pathSep = isWindows ? ";" : ":";
  process.env.PATH = localBin + pathSep + process.env.PATH;
}

// On Windows: spawn via cmd.exe /c so .cmd binaries (vitest, tsx) resolve.
// Priority is inherited because we set it on THIS process first.
// On other OSes: spawn directly with shell:true.
const spawnOptions = { stdio: "inherit", windowsHide: true };
let spawnCmd, spawnArgs;
if (isWindows) {
  spawnCmd = "cmd.exe";
  spawnArgs = ["/c", command.join(" ")];
} else {
  spawnCmd = command[0];
  spawnArgs = command.slice(1);
  spawnOptions.shell = true;
}

const child = cp.spawn(spawnCmd, spawnArgs, spawnOptions);

child.on("exit", (code) => {
  process.exit(code ?? 1);
});

process.on("SIGINT", () => child.kill("SIGINT"));
process.on("SIGTERM", () => child.kill("SIGTERM"));
