#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

/**
 * no-as-never — flags `as never` type assertions used as a hidden universal cast.
 *
 * WHY: `as never` casts a value to the bottom type `never`, which is then
 * assignable to EVERY type — so it silently disables type checking on the
 * value's downstream use and hides the intended target type. The explicit,
 * idiomatic equivalent is `as unknown as T` (which names the target type T).
 *
 * `as never` is LEGITIMATE only where the TARGET type is itself `never`:
 *   - 2nd argument of vi.spyOn(obj, key) / sinon.spy(obj, key) / spyOn(obj, key)
 *     (the keyof-union typing collapses the accepted argument to `never`)
 *   - argument of vitest/jest mock methods .mockImplementation / .mockReturnValue /
 *     .mockResolvedValue / .mockRejectedValue (+ Once) — the mock-fn union collapses
 *     the parameter to `never`, so `as unknown as T` does NOT compile there
 *   - argument of exhaustive-check helpers assertNever / unreachable / exhaustive /
 *     assertUnreachable (whose parameter is explicitly typed `never`)
 * Everywhere else — assignment, return, object-property value, or a call argument
 * whose target is a concrete type T — `as never` is the lazy form of
 * `as unknown as T` and is flagged.
 *
 * PROPERTY-ACCESS NOTE: `(x as never).foo` is a compile error (TS2339: Property
 * does not exist on type 'never'), which is why real `as never` only ever sits in
 * pass/store/return position — it physically cannot be member-accessed.
 *
 * SUPPRESSION: a line may be exempted with `// as-never: allow`. The mechanism
 * exists for rare human-approved cases, but it is INTENTIONALLY NOT advertised in
 * lint output — advertising it would invite agents (and humans) to use it as an
 * escape hatch instead of fixing the cast, recreating the very problem this rule
 * exists to prevent. Prefer fixing the cast or extending the allowlist below
 * (SPY_CALLEES / MOCK_METHODS / NEVER_PARAM_FNS).
 *
 * Usage:
 *   node scripts/no-as-never.cjs [files-or-dirs...]
 *
 * Exits 1 if any non-allowed `as never` is found. Skips .d.ts, node_modules;
 * blanks strings/comments/regex before analysis (so prose like "was never" in
 * error messages or comments never creates a false match — a naive regex scanner
 * would otherwise false-positive on "spawn was never called").
 */

const fs = require("node:fs");
const path = require("node:path");

// ---------------------------------------------------------------------------
// Allowlist: callees where `as never` is the legitimate (never-targeted) form
// ---------------------------------------------------------------------------

/** Callables whose 2nd argument may legitimately be `as never`. */
const SPY_CALLEES = new Set(["vi.spyOn", "sinon.spy", "spyOn"]);

/**
 * Method names (matched by last segment of the callee) whose argument may
 * legitimately be `as never` — vitest/jest mock-function unions collapse the
 * parameter type to `never`, so `as unknown as T` does NOT compile there.
 */
const MOCK_METHODS = new Set([
  "mockImplementation",
  "mockImplementationOnce",
  "mockReturnValue",
  "mockReturnValueOnce",
  "mockResolvedValue",
  "mockResolvedValueOnce",
  "mockRejectedValue",
  "mockRejectedValueOnce",
]);

/** Functions whose parameter is explicitly typed `never` (exhaustive checks). */
const NEVER_PARAM_FNS = new Set([
  "assertNever",
  "assertUnreachable",
  "unreachable",
  "exhaustive",
  "assertExhaustive",
  "assertIsNever",
]);

const KEYWORDS = new Set([
  "if",
  "for",
  "while",
  "switch",
  "catch",
  "with",
  "function",
  "return",
  "typeof",
  "instanceof",
  "in",
  "of",
  "do",
  "else",
  "throw",
  "delete",
  "void",
  "await",
  "yield",
  "class",
  "extends",
  "super",
  "import",
  "export",
  "default",
]);

// ===========================================================================
// File walking
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
// Source stripping: blank comments / string contents / regex, preserve newlines
// 1:1 so line numbers stay accurate. Ported from no-bare-literals.cjs.
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
// Call-site analysis
// ===========================================================================

const CALL_RE = /\b(new\s+)?([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\s*(\()/g;
const AS_NEVER_RE = /\bas never\b/g;

function lastSegment(callee) {
  return callee.includes(".") ? callee.split(".").pop() : callee;
}

function isNeverTargetedCallee(callee, argIndex) {
  if (SPY_CALLEES.has(callee) && argIndex === 1) return true;
  const last = lastSegment(callee);
  if (MOCK_METHODS.has(last)) return true;
  if (NEVER_PARAM_FNS.has(callee) || NEVER_PARAM_FNS.has(last)) return true;
  return false;
}

function findMatchingParen(s, openIdx) {
  let depth = 0;
  for (let i = openIdx; i < s.length; i++) {
    const ch = s[i];
    if (ch === "(") depth++;
    else if (ch === ")") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

// Split a call's argument list by top-level commas; record each segment's
// absolute start offset (in the stripped source) so we can map back to line numbers.
function splitTopLevelWithOffsets(s, base) {
  const out = [];
  let depth = 0;
  let segStartRel = null;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === "(" || ch === "[" || ch === "{") {
      if (depth === 0 && segStartRel === null) segStartRel = i;
      depth++;
    } else if (ch === ")" || ch === "]" || ch === "}") {
      depth--;
    } else if (ch === "," && depth === 0) {
      if (segStartRel !== null) out.push({ text: s.slice(segStartRel, i), start: base + segStartRel });
      segStartRel = null;
    } else if (depth === 0 && segStartRel === null && !/\s/.test(ch)) {
      segStartRel = i;
    }
  }
  if (segStartRel !== null) out.push({ text: s.slice(segStartRel), start: base + segStartRel });
  return out;
}

function lineOf(stripped, pos) {
  let line = 1;
  for (let i = 0; i < pos && i < stripped.length; i++) {
    if (stripped[i] === "\n") line++;
  }
  return line;
}

/**
 * Compute the absolute start indices of `as never` casts that are ALLOWED:
 * a whole-argument `EXPR as never` whose call's callee is never-targeted.
 */
function computeAllowedStarts(stripped) {
  const allowed = new Set();
  let m;
  CALL_RE.lastIndex = 0;
  for (m = CALL_RE.exec(stripped); m !== null; m = CALL_RE.exec(stripped)) {
    const callee = m[2];
    const parenIdx = m.index + m[0].length - 1; // index of "("
    const firstSeg = callee.includes(".") ? callee.split(".")[0] : callee;
    if (KEYWORDS.has(firstSeg)) continue;

    const closeIdx = findMatchingParen(stripped, parenIdx);
    if (closeIdx === -1) continue;

    // skip function/method definitions: ")" followed by "{" (body) or ":" (return type)
    let k = closeIdx + 1;
    while (k < stripped.length && /\s/.test(stripped[k])) k++;
    const after = stripped[k];
    if (after === "{" || after === ":") continue;

    const argsInner = stripped.slice(parenIdx + 1, closeIdx);
    if (!argsInner.trim()) continue;

    const segs = splitTopLevelWithOffsets(argsInner, parenIdx + 1);
    segs.forEach((seg, i) => {
      // is this whole argument an `EXPR as never` cast?
      if (!/\bas never\b$/.test(seg.text.trim())) return;
      const rel = seg.text.search(/\bas never\b/);
      if (rel === -1) return;
      if (isNeverTargetedCallee(callee, i)) allowed.add(seg.start + rel);
    });
  }
  return allowed;
}

// Per-line exemption. Kept intentionally undocumented in lint output (see header).
function hasSuppression(srcLine) {
  return /\/\/\s*as[-_ ]?never\s*:\s*allow/i.test(srcLine);
}

function analyzeFile(filePath) {
  const src = fs.readFileSync(filePath, "utf8");
  const stripped = stripSource(src);
  const allowedStarts = computeAllowedStarts(stripped);
  const srcLines = src.split("\n");
  const findings = [];
  let m;
  AS_NEVER_RE.lastIndex = 0;
  for (m = AS_NEVER_RE.exec(stripped); m !== null; m = AS_NEVER_RE.exec(stripped)) {
    if (allowedStarts.has(m.index)) continue;
    const line = lineOf(stripped, m.index);
    if (hasSuppression(srcLines[line - 1] || "")) continue;
    findings.push({ file: filePath, line });
  }
  return findings;
}

// ===========================================================================
// Main
// ===========================================================================

const targets = process.argv.slice(2);
if (targets.length === 0) {
  console.error("Usage: node scripts/no-as-never.cjs [files-or-dirs...]");
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
    for (const f of analyzeFile(file)) {
      const rel = path.relative(process.cwd(), f.file).replace(/\\/g, "/");
      console.log(
        `${rel}:${f.line} — "as never" hides the target type; use "as unknown as T" (allowed only for vi.spyOn / .mock* / assertNever).`,
      );
      total++;
    }
  }
}

if (total > 0) {
  console.log(
    `\nFound ${total} "as never" assertion(s). Replace with "as unknown as T" (names the target type) unless the target is genuinely never (vi.spyOn / .mock* / assertNever — extend the allowlist in the script if a new legitimate never-targeted API appears).`,
  );
  process.exit(1);
} else {
  console.log('✓ No disallowed "as never" assertions found.');
}
