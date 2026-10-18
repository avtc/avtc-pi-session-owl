#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>
//
// Inertness smoke gate: with hooks disabled engine-wide, a full offline
// `claude -p` session with the plugin loaded must exit cleanly AND leave
// zero session-owl footprint. Two disable modes run in sequence:
//   1. settings `disableAllHooks: true` (the policy class — same family as
//      managed allowManagedModsOnly policies: the engine skips ALL hooks)
//   2. `--safe-mode` (the CLI kill switch — same inert outcome expected)
// Assertions per mode: session answered; the debug log EXISTS and carries NO
// hooks-module load line; no session-owl directory anywhere under the config
// root (sessions, timeline) and no settings files (global or project scope).
// Absent claude binary => explicit skip-with-warning (the live-smoke
// degradation).

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runClaude, startMockServer, typesGuard } from "./lib/smoke-kit.mjs";

const here = fileURLToPath(new URL(".", import.meta.url));
const pluginDir = resolve(here, "../claude");

const probe = spawnSync("claude", ["--version"], { encoding: "utf8", timeout: 15_000 });
if (probe.error || probe.status !== 0) {
  console.warn("[inertness-smoke] claude binary not available — skipping (install Claude Code to run this gate)");
  process.exit(0);
}

const { server, base } = await startMockServer();
const restoreTypes = typesGuard(pluginDir);
let failed = false;

/** One inertness run: a temp config root + one disable mode. */
async function runMode(label, { safeMode = false } = {}) {
  const cfg = mkdtempSync(join(tmpdir(), "owl-inert-"));
  const debugFile = join(cfg, "debug.log");
  mkdirSync(cfg, { recursive: true });
  if (!safeMode) {
    // mode 1 disables hooks engine-wide via settings; mode 2 (--safe-mode)
    // carries NO settings kill switch — the flag alone must make the mod
    // inert (mode isolation: each leg attributes its outcome to its lever)
    writeFileSync(join(cfg, "settings.json"), JSON.stringify({ disableAllHooks: true }), "utf8");
  }
  // the session cwd: a project dir whose .claude/ is the PROJECT settings
  // root owl would write to if it were live
  const projectDir = join(cfg, "proj");
  mkdirSync(projectDir, { recursive: true });

  const args = ["-p", "say ok", "--plugin-dir", pluginDir, "--debug-file", debugFile];
  if (safeMode) args.push("--safe-mode");
  const r = await runClaude(args, {
    env: {
      ...process.env,
      CLAUDE_CONFIG_DIR: cfg,
      ANTHROPIC_BASE_URL: base,
      ANTHROPIC_AUTH_TOKEN: "smoke",
      ANTHROPIC_MODEL: "mock-model",
    },
    cwd: projectDir,
  });

  // the debug file must EXIST — an absent log would make the no-load leg
  // vacuously true (we assert we actually looked)
  const logExists = existsSync(debugFile);
  const log = logExists ? readFileSync(debugFile, "utf8") : "";
  const loaded = log.includes("hooks module session-owl@inline loaded");
  const owlDir = existsSync(join(cfg, "session-owl"));
  const globalSettings = existsSync(join(cfg, "avtc-session-owl-settings.json"));
  const projectSettings = existsSync(join(projectDir, ".claude", "avtc-session-owl-settings.json"));
  const answered = String(r.stdout).trim().length > 0;
  const ok = r.status === 0 && answered && logExists && !loaded && !owlDir && !globalSettings && !projectSettings;
  if (!ok) failed = true;
  console.log(
    `[inertness-smoke] ${label}: ${ok ? "ok" : "FAIL"} (exit=${r.status}, answered=${answered}, logExists=${logExists}, hooksLoaded=${loaded}, owlWrites=${owlDir || globalSettings || projectSettings})`,
  );
  rmSync(cfg, { recursive: true, force: true });
}

await runMode("disableAllHooks");
await runMode("--safe-mode", { safeMode: true });

server.close();
restoreTypes();
process.exit(failed ? 1 : 0);
