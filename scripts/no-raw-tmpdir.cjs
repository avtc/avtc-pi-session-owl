#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

/**
 * no-raw-tmpdir — flags direct `mkdtemp*` / `os.tmpdir()` use in test files.
 *
 * WHY: a temp dir a test creates by itself is an UNREGISTERED dir — nothing
 * removes it, so every suite run litters %TEMP% (the vitest projects re-run
 * each suite two to three times, so the litter multiplies fast: over a
 * weekend of gated runs this reached ~1.5k leftover dirs). Tests create
 * temp dirs exclusively through tests/temp-dir.ts's tempDir(), which
 * registers the dir for the per-file sweep tests/setup.ts runs.
 *
 * Both tokens are flagged — `mkdtemp*` (the creation call, sync or promise)
 * and `tmpdir` (the location; catching it blocks hand-rolled
 * mkdirSync(join(tmpdir(), ...)) variants too).
 *
 * Out of scope: scripts/*.mjs smoke scripts (not vitest files — they clean
 * up inline after themselves) and production src/ (never touches tmpdir).
 *
 * SUPPRESSION: `// raw-tmpdir: allow` on a line exempts it — for rare
 * human-approved cases where a suite needs a dir the sweep must NOT own.
 *
 * Usage:
 *   node scripts/no-raw-tmpdir.cjs [files-or-dirs...]
 *
 * Exits 1 listing file:line for every flagged token outside tests/temp-dir.ts.
 * Skips .d.ts, node_modules; blanks strings/comments/regex before analysis
 * (so prose mentioning the tokens never creates a false match).
 */

const fs = require("node:fs");
const path = require("node:path");

/** The one file allowed to touch the raw APIs — the tracked helper itself. */
const ALLOWED_FILES = new Set(["tests/temp-dir.ts"].map((p) => p.replaceAll("/", path.sep)));

const TOKEN_RE = /\b(mkdtemp\w*|tmpdir)\b/g;

// ===========================================================================
// File walking (ported from no-as-never.cjs)
// ===========================================================================

function* walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory() && !entry.name.startsWith(".") && entry.name !== "node_modules") {
      yield* walk(full);
    } else if (entry.isFile() && /\.(ts|tsx|mjs|js|cjs)$/.test(entry.name) && !entry.name.endsWith(".d.ts")) {
      yield full;
    }
  }
}

// ===========================================================================
// Source stripping: blank comments / string contents / regex, preserve
// newlines 1:1 so line numbers stay accurate. Ported from no-bare-literals.cjs.
// ===========================================================================

function isRegexStart(prevSignificant) {
  return prevSignificant === null || /[=(,[{:;!&|?%~^<>\s]/.test(prevSignificant);
}

function stripSource(src) {
  let out = "";
  const n = src.length;
  let i = 0;
  let prevSig = null;

  while (i < n) {
    const c = src[i];
    const next = src[i + 1];

    if (c === "/" && next === "/") {
      while (i < n && src[i] !== "\n") {
        out += " ";
        i++;
      }
      continue;
    }
    if (c === "/" && next === "*") {
      out += "  ";
      i += 2;
      while (i < n && !(src[i] === "*" && src[i + 1] === "/")) {
        out += src[i] === "\n" ? "\n" : " ";
        i++;
      }
      if (i < n) {
        out += "  ";
        i += 2;
      }
      prevSig = null;
      continue;
    }
    if (c === "'" || c === '"') {
      const res = readString(src, i, c);
      out += res.token;
      prevSig = "x";
      i = res.end;
      continue;
    }
    if (c === "`") {
      const res = readTemplate(src, i);
      out += res.token;
      prevSig = "x";
      i = res.end;
      continue;
    }
    if (c === "/" && next !== "/" && next !== "*" && isRegexStart(prevSig)) {
      const res = readRegex(src, i);
      out += res.token;
      prevSig = "x";
      i = res.end;
      continue;
    }
    out += c;
    if (c !== "\n" && c.trim() !== "") prevSig = c;
    i++;
  }
  return out;
}

function spacesFor(start, end) {
  let s = "";
  for (let k = start; k < end; k++) s += " ";
  return s;
}

function readString(src, i, quote) {
  const start = i;
  const n = src.length;
  let j = i + 1;
  while (j < n && src[j] !== quote) {
    if (src[j] === "\\" && j + 1 < n) {
      j += 2;
      continue;
    }
    if (src[j] === "\n") break;
    j++;
  }
  const end = j < n ? j + 1 : j;
  return { token: spacesFor(start, end), end };
}

function readTemplate(src, i) {
  const n = src.length;
  let j = i + 1;
  let token = "";
  while (j < n && src[j] !== "`") {
    if (src[j] === "\\" && j + 1 < n) {
      j += 2;
      continue;
    }
    if (src[j] === "$" && src[j + 1] === "{") {
      let depth = 1;
      j += 2;
      while (j < n && depth > 0) {
        if (src[j] === "{") depth++;
        else if (src[j] === "}") depth--;
        if (depth === 0) break;
        j++;
      }
      j++;
      continue;
    }
    token += src[j] === "\n" ? "\n" : " ";
    j++;
  }
  const end = j < n ? j + 1 : j;
  return { token, end };
}

function readRegex(src, i) {
  const n = src.length;
  let j = i + 1;
  let depth = 0;
  while (j < n) {
    const c = src[j];
    if (c === "\\" && j + 1 < n) {
      j += 2;
      continue;
    }
    if (c === "[") depth++;
    else if (c === "]" && depth > 0) depth--;
    else if (c === "/" && depth === 0) {
      j++;
      while (j < n && /[gimsuyvd]/.test(src[j])) j++;
      break;
    }
    if (c === "\n") break;
    j++;
  }
  return { token: spacesFor(i, j), end: j };
}

// ===========================================================================
// Analysis
// ===========================================================================

function hasSuppression(srcLine) {
  return /\/\/\s*raw[-_ ]?tmpdir\s*:\s*allow/i.test(srcLine);
}

function analyzeFile(filePath) {
  const src = fs.readFileSync(filePath, "utf8");
  const stripped = stripSource(src);
  const srcLines = src.split("\n");
  const findings = [];
  let m;
  TOKEN_RE.lastIndex = 0;
  for (m = TOKEN_RE.exec(stripped); m !== null; m = TOKEN_RE.exec(stripped)) {
    let line = 1;
    for (let i = 0; i < m.index && i < stripped.length; i++) {
      if (stripped[i] === "\n") line++;
    }
    if (hasSuppression(srcLines[line - 1] || "")) continue;
    findings.push({ file: filePath, line, token: m[1] });
  }
  return findings;
}

// ===========================================================================
// Main
// ===========================================================================

const targets = process.argv.slice(2);
if (targets.length === 0) {
  console.error("Usage: node scripts/no-raw-tmpdir.cjs [files-or-dirs...]");
  process.exit(2);
}

let total = 0;
for (const target of targets) {
  let stat;
  try {
    stat = fs.statSync(target);
  } catch {
    continue;
  }
  const files = stat.isDirectory() ? [...walk(target)] : [target];
  for (const file of files) {
    const rel = path.relative(process.cwd(), file);
    if (ALLOWED_FILES.has(rel) || ALLOWED_FILES.has(rel.replaceAll("\\", "/"))) continue;
    for (const f of analyzeFile(file)) {
      const relShown = path.relative(process.cwd(), f.file).replace(/\\/g, "/");
      console.log(
        `${relShown}:${f.line} — "${f.token}" creates an unregistered temp dir; use tempDir() from tests/temp-dir.ts (swept per test file).`,
      );
      total++;
    }
  }
}

if (total > 0) {
  console.log(
    `\nFound ${total} raw temp-dir call(s). Tests create temp dirs via tempDir(prefix) from tests/temp-dir.ts — the dir is then swept automatically by the afterAll in tests/setup.ts. Smoke scripts under scripts/ are out of scope (they clean up inline).`,
  );
  process.exit(1);
} else {
  console.log("✓ No raw temp-dir calls found — all suite temp dirs go through tests/temp-dir.ts.");
}
