// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// The no-silent-catch gate: every catch in the
// port's runtime code must SAY what went wrong — an empty catch block or a
// literal-swallow `.catch(() => …)` arrow fails this suite. The judgment
// calls (a catch whose fallback return IS the surfaced answer, an expected
// absent-file degrade that logs) are covered by review; THIS
// gate catches the unambiguous shapes so they never come back:
//   - `catch {}` / `catch (e) {}` empty blocks
//   - `.catch(() => {})` empty arrows
//   - `.catch(() => null|undefined|true|false|0|"")` literal-only arrows
// Scope: claude/hooks, claude/host, claude/shims, claude-subagent-support
// (runtime code only — tests and generated .d.ts are out of scope).

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

const ROOTS = ["claude/hooks", "claude/host", "claude/shims", "claude-subagent-support"];
const LITERAL_SWALLOW = /^(\{\}|null|undefined|true|false|0|"")$/;

function* walk(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* walk(p);
    else if ((name.endsWith(".ts") || name.endsWith(".js")) && !name.endsWith(".d.ts")) yield p;
  }
}

function violations(): string[] {
  const out: string[] = [];
  for (const root of ROOTS) {
    for (const file of walk(root)) {
      const src = readFileSync(file, "utf8");
      // empty catch blocks (any binding form)
      for (const m of src.matchAll(/catch\s*(?:\(\s*\w+\s*\))?\s*\{\s*\}/g)) {
        const line = src.slice(0, m.index ?? 0).split("\n").length;
        out.push(`${file}:${line} empty catch block`);
      }
      // .catch arrows whose whole body is a bare literal
      for (const m of src.matchAll(/\.catch\(\s*\(\s*\)?\s*=>\s*([^)]*?)\s*\)\s*;?/g)) {
        const body = (m[1] ?? "").trim().replace(/;$/, "");
        if (LITERAL_SWALLOW.test(body)) {
          const line = src.slice(0, m.index ?? 0).split("\n").length;
          out.push(`${file}:${line} literal-swallow .catch(() => ${body})`);
        }
      }
    }
  }
  return out;
}

describe("no-silent-catch gate (every catch says what went wrong)", () => {
  test("runtime code carries no empty catch and no literal-swallow .catch arrow", () => {
    expect(violations()).toEqual([]);
  });
});
