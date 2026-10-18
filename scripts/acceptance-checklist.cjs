#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>
//
// The acceptance checklist: prints PASS/FAIL per done-condition area (1-14)
// by running the acceptance suite, whose per-test output carries the area
// verdicts. Exit 0 only when every area passes.
//
// Usage: node scripts/acceptance-checklist.cjs

"use strict";

const { spawnSync } = require("node:child_process");
const path = require("node:path");

const r = spawnSync(
  process.execPath,
  ["node_modules/vitest/vitest.mjs", "run", "claude/tests/acceptance/acceptance.spec.ts"],
  { cwd: path.join(__dirname, ".."), encoding: "utf8", timeout: 300_000 },
);

const lines = `${r.stdout}\n${r.stderr}`.split("\n");
console.log(
  "[acceptance-checklist] index gate — the areas assert owning-suite presence and named pins; run npm test for the suites themselves",
);
const areas = lines.filter((l) => l.includes("[acceptance] area"));
for (const line of areas) console.log(line.trim());

const sawAll = areas.filter((l) => l.includes(": PASS")).length;
console.log(`[acceptance-checklist] ${sawAll}/14 areas PASS`);
if (r.status !== 0 || sawAll < 14) {
  const fails = lines.filter((l) => l.includes("×") || l.includes("FAIL"));
  for (const f of fails.slice(0, 10)) console.log(f.trim());
  process.exit(1);
}
process.exit(0);
