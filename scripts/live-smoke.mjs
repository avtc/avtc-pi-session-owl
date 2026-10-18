#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// Live smoke gate: the REAL plugin loads and fires hooks in a full offline
// `claude -p` session. A local mock answers the Anthropic messages endpoint,
// so no gateway, keys, or network are needed — only the claude binary itself
// (absent binary => explicit skip-with-warning, same degradation as
// claude-validate).
//
// Phase 1 (load/fire): fixed "ok" reply — session exits 0; the debug log
// carries the plugin's "hooks module session-owl@inline loaded" line; no
// "did not load" refusal; the model answer arrived.
//
// Phase 2 (serve round-trip): a sequenced mock forces ONE owl_recall
// tool_use — the debug log must show the tool REGISTERED (visible after
// <N>ms) and the transcript's tool_result row must carry the real serve
// (non-empty content, not an error row).

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runClaude, startMockServer, startSequencedMock, typesGuard } from "./lib/smoke-kit.mjs";

const here = fileURLToPath(new URL(".", import.meta.url));
// the REPO ROOT as one --plugin-dir: the engine loads every child folder
// with a .claude-plugin/ under it — claude/ (session-owl) and
// claude-subagent-support/ (the stage spawner companion) together, and the
// local companion copy satisfies session-owl's declared dependency
const pluginDir = resolve(here, "..");

// skip-with-warning when the binary is missing (dev boxes without claude)
const probe = spawnSync("claude", ["--version"], { encoding: "utf8", timeout: 15_000 });
if (probe.error || probe.status !== 0) {
  console.warn("[live-smoke] claude binary not available — skipping (install Claude Code to run this gate)");
  process.exit(0);
}

const { server, base } = await startMockServer();
const cfg = mkdtempSync(join(tmpdir(), "owl-live-smoke-"));
const debugFile = join(cfg, "debug.log");

// the committed generated types of BOTH plugin trees must survive the run
const restoreOwlTypes = typesGuard(resolve(here, "../claude"));
const restoreCompanionTypes = typesGuard(resolve(here, "../claude-subagent-support"));
const restoreTypes = () => {
  restoreOwlTypes();
  restoreCompanionTypes();
};
const t0 = Date.now();

const r = await runClaude(["-p", "say ok", "--plugin-dir", pluginDir, "--debug-file", debugFile], {
  env: {
    ...process.env,
    CLAUDE_CONFIG_DIR: cfg,
    ANTHROPIC_BASE_URL: base,
    ANTHROPIC_AUTH_TOKEN: "smoke",
    ANTHROPIC_MODEL: "mock-model",
  },
  cwd: cfg,
});

const log = existsSync(debugFile) ? readFileSync(debugFile, "utf8") : "";
const loaded = log.includes("hooks module session-owl@inline loaded");
const companionLoaded = log.includes("hooks module session-owl-subagent-support@inline loaded");
const refused = log.includes("did not load");
const answered = String(r.stdout).trim().length > 0;
const ok1 = r.status === 0 && loaded && companionLoaded && !refused && answered;

// --- phase 2: the serve round-trip (a forced owl_recall call) -----------------
const RECALL = "mcp__session-owl__owl_recall";
const TU = "tu_smoke_recall";
const seq = await startSequencedMock(RECALL, { take: 0 }, TU);
const cfg2 = mkdtempSync(join(tmpdir(), "owl-live-smoke-serve-"));
const debug2 = join(cfg2, "debug.log");
const t1 = Date.now();
const r2 = await runClaude(["-p", "use the memory tool", "--plugin-dir", pluginDir, "--debug-file", debug2], {
  env: {
    ...process.env,
    CLAUDE_CONFIG_DIR: cfg2,
    ANTHROPIC_BASE_URL: seq.base,
    ANTHROPIC_AUTH_TOKEN: "smoke",
    ANTHROPIC_MODEL: "mock-model",
  },
  cwd: cfg2,
});
const log2 = existsSync(debug2) ? readFileSync(debug2, "utf8") : "";
const registered = new RegExp(`${RECALL} visible after \\d+ms`).test(log2);
// the model's tool_result row for the forced call (the serve's truth)
let servedRow = null;
const projectsDir = join(cfg2, "projects");
if (existsSync(projectsDir)) {
  for (const dir of readdirSync(projectsDir)) {
    const full = join(projectsDir, dir);
    for (const f of readdirSync(full)) {
      const p = join(full, f);
      if (!existsSync(p) || statSync(p).size === 0) continue;
      for (const line of readFileSync(p, "utf8").split("\n")) {
        if (!line.includes(TU)) continue;
        try {
          const row = JSON.parse(line);
          if (row.type === "user" && Array.isArray(row.message?.content)) {
            for (const block of row.message.content) {
              if (block.type === "tool_result" && block.tool_use_id === TU) servedRow = block;
            }
          }
        } catch {
          // non-json line
        }
      }
    }
  }
}
const served = servedRow !== null && servedRow.is_error !== true && String(servedRow.content ?? "").length > 0;
const ok2 = r2.status === 0 && registered && served;
const ms = Date.now() - t0;
const ms2 = Date.now() - t1;

const ok = ok1 && ok2;
console.log(
  `[live-smoke] ${ok ? "ok" : "FAIL"} (exit=${r.status}, loadLine=${loaded}, refused=${refused}, answered=${answered}, ${ms}ms)`,
);
console.log(
  `[live-smoke] serve: ${ok2 ? "ok" : "FAIL"} (exit=${r2.status}, registered=${registered}, served=${served}, ${ms2}ms, claude ${String(probe.stdout).trim()})`,
);
if (!ok2 && servedRow === null) console.log("[live-smoke] serve: no tool_result row found for the forced call");
if (!ok1 || !ok2) {
  console.log(
    "[live-smoke] stderr tail:",
    String(r2.stderr ?? r.stderr)
      .split("\n")
      .filter(Boolean)
      .slice(-4)
      .join(" | ")
      .slice(0, 500),
  );
}
server.close();
seq.server.close();
restoreTypes();
rmSync(cfg, { recursive: true, force: true });
rmSync(cfg2, { recursive: true, force: true });
process.exit(ok ? 0 : 1);
