#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

/**
 * no-bare-literals — flags bare unnamed constant values passed as DIRECT
 * arguments to function/method calls: null, undefined, true, false, 0, 1, -1,
 * and the empty string ("").
 *
 * Goal: enforce the NO_* named-constant convention. A bare literal passed as an
 * argument is usually a sentinel/flag whose meaning is invisible at the call
 * site (e.g. `setAgentFinished(false)` — false = ?). Prefer an explicit named
 * constant (`setAgentFinished(AGENT_NOT_FINISHED)`).
 *
 * What it flags: a DIRECT argument whose entire value is one of the bare
 * literals above. Examples:
 *   createLogger("name", null)         → flag (null = sentinel, multi-arg)
 *   updateSetting("enabled", false)     → flag (false = flag, multi-arg)
 *   proc.emit("close", 0)               → flag (0 = exit code, multi-arg)
 *   configure({ timeout: 0 })           → NO flag (0 is a property value, not a direct arg)
 *   foo(bar(null))                      → flags `bar(null)` only (null is not a direct arg of foo)
 *
 * Single-argument relaxation: a SOLE argument that is a boolean, number, or
 * string is usually self-documenting via the method name (e.g. `setEnabled(true)`,
 * `select(0)`, `setText("x")`) and is NOT flagged. A sole `null`/`undefined`
 * IS flagged — those are opaque sentinels even alone (null = clear? undefined =
 * no-override?) and need a named constant.
 *   setEnabled(true)       → NO flag (sole bool)
 *   select(0)              → NO flag (sole number)
 *   createFakePi(null)     → FLAG (sole null — ambiguous sentinel)
 *
 * Exclusions: allowlisted callees — framework/stdlib APIs whose arguments are
 * data, not sentinels (Math.*, JSON.*, setTimeout, Buffer.*, test assertions
 * `.toBe`, mocks `.mockReturnValue`, array methods `.splice`/`.push`, etc.).
 *
 * KNOWN LIMITATION: a literal that is legitimate DATA (e.g. `csvQuote("")`,
 * `add(1, 2)`, `getSetting(s, k, "")`) is syntactically identical to a sentinel.
 * This rule cannot tell them apart — that distinction is a code-review concern.
 * Tune the allowlist, and accept residual data-literal noise.
 *
 * Usage:
 *   node scripts/no-bare-literals.cjs [files-or-dirs...]
 *
 * Exits with code 1 if any bare-literal arguments are found in non-allowlisted
 * calls. Skips .d.ts, node_modules; blanks strings/comments/regex contents
 * before analysis (so their tokens never create false matches).
 */

const fs = require("node:fs");
const path = require("node:path");

// ---------------------------------------------------------------------------
// Config: which literals count as "bare sentinels"
// ---------------------------------------------------------------------------

/** A trimmed DIRECT argument matching this is flagged. Tunable. */
const BARE_RE = /^(null|undefined|true|false|-?0|-?1)$/;
/** Marker substituted for empty string/template literals during stripping. */
const EMPTYSTR = "EMPTYSTR";

// ---------------------------------------------------------------------------
// Config: allowlist of callees whose arguments are data, not sentinels
// ---------------------------------------------------------------------------

const ALLOWED_CALLEES = new Set([
  // timers / scheduler
  "setTimeout",
  "setInterval",
  "setImmediate",
  "queueMicrotask",
  "clearTimeout",
  "clearInterval",
  "clearImmediate",
  // type coercion / parsing (args are data)
  "Number",
  "String",
  "Boolean",
  "Symbol",
  "parseInt",
  "parseFloat",
  "isNaN",
  "isFinite",
  // common globals
  "Array",
  "Object",
  "Promise",
  "Date",
  "RegExp",
  "Error",
  "encodeURI",
  "decodeURI",
  "encodeURIComponent",
  "decodeURIComponent",
  // TUI layout components (positional numeric/empty-string args are layout data)
  "Text",
  "textResult",
  "Box",
  "TruncatedText",
  // test-framework structure
  "describe",
  "it",
  "test",
  "beforeEach",
  "beforeAll",
  "afterEach",
  "afterAll",
  "expect",
]);

const ALLOWED_PREFIXES = [
  "vi.",
  "console.",
  "process.",
  "Math.",
  "JSON.",
  "Buffer.",
  "Promise.",
  "Number.",
  "Object.",
  "Array.",
  "Reflect.",
  "AbortSignal.",
];

const ALLOWED_METHODS = new Set([
  // vitest assertions
  "toBe",
  "toEqual",
  "toStrictEqual",
  "toBeCloseTo",
  "toContain",
  "toContainEqual",
  "toBeNull",
  "toBeUndefined",
  "toBeDefined",
  "toBeTruthy",
  "toBeFalsy",
  "toBeNaN",
  "toMatch",
  "toMatchObject",
  "toThrow",
  "toThrowError",
  "toHaveLength",
  "toHaveBeenCalled",
  "toHaveBeenCalledWith",
  "toHaveBeenCalledTimes",
  "toHaveBeenLastCalledWith",
  "toHaveBeenNthCalledWith",
  "toBeGreaterThan",
  "toBeLessThan",
  "toBeGreaterThanOrEqual",
  "toBeLessThanOrEqual",
  "toBeInstanceOf",
  "toHaveProperty",
  // vitest mocks
  "mockReturnValue",
  "mockResolvedValue",
  "mockRejectedValue",
  "mockImplementation",
  "mockReturnValueOnce",
  "mockResolvedValueOnce",
  "mockRejectedValueOnce",
  "mockImplementationOnce",
  "mockClear",
  "mockReset",
  "mockRestore",
  // array/string data operations (indices, counts, chars, separators are data)
  "splice",
  "push",
  "unshift",
  "shift",
  "pop",
  "indexOf",
  "lastIndexOf",
  "slice",
  "at",
  "with",
  "charAt",
  "charCodeAt",
  "codePointAt",
  "padStart",
  "padEnd",
  "repeat",
  "fill",
  "copyWithin",
  "subarray",
  "set",
  "substring",
  "substr",
  "join",
  // string transformation (pattern/replacement args are data)
  "replace",
  "replaceAll",
  "split",
  "trim",
  // numeric formatting / reduction (digit count / initial accumulator are data)
  "toFixed",
  "toPrecision",
  "toExponential",
  "reduce",
  "reduceRight",
  // collection add (Map/Set/Date — arg is data)
  "add",
]);

// ---------------------------------------------------------------------------
// Non-call constructs to skip
// ---------------------------------------------------------------------------

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
  "as",
  "satisfies",
  "keyof",
  "infer",
]);

// ===========================================================================
// File walking
// ===========================================================================

function* walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory() && !entry.name.startsWith(".") && entry.name !== "node_modules") {
      yield* walk(full);
    } else if (entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts")) {
      yield full;
    }
  }
}

// ===========================================================================
// Source stripping: blank comments / string contents / regex; mark empty
// strings. Preserves newlines (1:1) so line numbers stay accurate.
// ===========================================================================

function isRegexStart(prevSignificant) {
  // A "/" is a regex start if the previous significant char is an operator,
  // opening bracket, or whitespace/start-of-input.
  return prevSignificant === null || /[=(,[{:;!&|?%~^<>\s]/.test(prevSignificant);
}

function stripSource(src) {
  let out = "";
  const n = src.length;
  let i = 0;
  // last non-space char emitted (for regex/division disambiguation)
  let prevSig = null;

  while (i < n) {
    const c = src[i];
    const next = src[i + 1];

    // line comment
    if (c === "/" && next === "/") {
      while (i < n && src[i] !== "\n") {
        out += " ";
        i++;
      }
      continue;
    }

    // block comment
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

    // single- or double-quoted string
    if (c === "'" || c === '"') {
      const res = readString(src, i, c);
      out += res.token;
      prevSig = "x"; // treat as identifier-ish (string literal present)
      i = res.end;
      continue;
    }

    // template literal (backtick) — may span lines / contain ${...}
    if (c === "`") {
      const res = readTemplate(src, i);
      out += res.token;
      prevSig = "x";
      i = res.end;
      continue;
    }

    // regex literal
    if (c === "/" && next !== "/" && next !== "*" && isRegexStart(prevSig)) {
      const res = readRegex(src, i);
      out += res.token;
      prevSig = "x";
      i = res.end;
      continue;
    }

    // default: copy char, track prevSig
    out += c;
    if (c === "\n") {
      // newline doesn't change prevSig (whitespace)
    } else if (c.trim() === "") {
      // whitespace — keep prevSig
    } else {
      prevSig = c;
    }
    i++;
  }
  return out;
}

/** Read a '...' or "..." string starting at quote index i. Returns {token,end}. */
function readString(src, i, quote) {
  const start = i;
  const n = src.length;
  let j = i + 1; // past opening quote
  while (j < n && src[j] !== quote) {
    if (src[j] === "\\" && j + 1 < n) {
      // escaped char — keep the newline if it's a line continuation, else blank
      j += 2;
      continue;
    }
    if (src[j] === "\n") break; // unterminated string at EOL; bail
    j++;
  }
  // j == closing quote (or EOL)
  const isEmpty = j === start + 1;
  const end = j < n ? j + 1 : j; // consume closing quote if present
  // token preserves newlines (none inside single-line strings normally)
  const token = isEmpty ? EMPTYSTR : spacesFor(start, end);
  return { token, end };
}

/** Read a `...` template. Blanks literal text + ${...} interpolations entirely
 *  (a known blind spot: calls inside ${} are not analyzed). Preserves newlines. */
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
      // skip the interpolation up to matching }
      let depth = 1;
      j += 2;
      while (j < n && depth > 0) {
        if (src[j] === "{") depth++;
        else if (src[j] === "}") depth--;
        if (depth === 0) break;
        j++;
      }
      j++; // past closing }
      continue;
    }
    token += src[j] === "\n" ? "\n" : " ";
    j++;
  }
  const end = j < n ? j + 1 : j;
  // empty template `` → EMPTYSTR, else spaces
  const isEmpty = j === i + 1;
  return { token: isEmpty ? EMPTYSTR : token, end };
}

/** Read a /.../flags regex. Blanks content (preserves newlines). */
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
      j++; // closing slash
      // consume flags
      while (j < n && /[gimsuyvd]/.test(src[j])) j++;
      break;
    }
    if (c === "\n") break; // unterminated
    j++;
  }
  return { token: spacesFor(i, j), end: j };
}

function spacesFor(start, end) {
  // produce spaces but keep any newlines that fell inside [start,end)
  let s = "";
  for (let k = start; k < end; k++) s += " ";
  return s;
}

// ===========================================================================
// Call-site analysis on the stripped source
// ===========================================================================

const CALL_RE = /\b(new\s+)?([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\s*(\()/g;

function isAllowedCallee(callee) {
  if (ALLOWED_CALLEES.has(callee)) return true;
  for (const p of ALLOWED_PREFIXES) {
    if (callee === p.slice(0, -1) || callee.startsWith(p)) return true;
  }
  const lastSeg = callee.includes(".") ? callee.split(".").pop() : callee;
  if (ALLOWED_METHODS.has(lastSeg)) return true;
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

function splitTopLevel(s) {
  const out = [];
  let cur = "";
  let depth = 0;
  for (const ch of s) {
    if (ch === "(" || ch === "[" || ch === "{") depth++;
    else if (ch === ")" || ch === "]" || ch === "}") depth--;
    else if (ch === "," && depth === 0) {
      out.push(cur);
      cur = "";
      continue;
    }
    cur += ch;
  }
  if (cur.trim()) out.push(cur);
  return out;
}

function lineOf(stripped, pos) {
  // count newlines before pos in the stripped source (newlines are 1:1 with src)
  let line = 1;
  for (let i = 0; i < pos && i < stripped.length; i++) {
    if (stripped[i] === "\n") line++;
  }
  return line;
}

function analyzeFile(filePath) {
  const src = fs.readFileSync(filePath, "utf8");
  const stripped = stripSource(src);
  const findings = [];
  let m;
  CALL_RE.lastIndex = 0;
  for (m = CALL_RE.exec(stripped); m !== null; m = CALL_RE.exec(stripped)) {
    const callee = m[2];
    const parenIdx = m.index + m[0].length - 1; // index of "("
    const firstSeg = callee.includes(".") ? callee.split(".")[0] : callee;

    // skip control-flow / declaration keywords
    if (KEYWORDS.has(firstSeg)) continue;

    const closeIdx = findMatchingParen(stripped, parenIdx);
    if (closeIdx === -1) continue;

    // skip definitions: ")" followed by "{" (method body) or ":" (return type)
    let k = closeIdx + 1;
    while (k < stripped.length && (stripped[k] === " " || stripped[k] === "\n" || stripped[k] === "\t")) k++;
    const after = stripped[k];
    if (after === "{" || after === ":") continue;

    // skip allowlisted callees
    if (isAllowedCallee(callee)) continue;

    const argsStr = stripped.slice(parenIdx + 1, closeIdx);
    // no args → nothing to flag
    if (!argsStr.trim()) continue;

    const segs = splitTopLevel(argsStr);
    const single = segs.length === 1;
    for (const seg of segs) {
      const t = seg.trim();
      const isBare = t === EMPTYSTR || BARE_RE.test(t);
      if (!isBare) continue;
      // Single-argument relaxation: a sole bool/number/string is self-documenting
      // (setVisible(true), select(0), setText("")) and is allowed. A sole
      // null/undefined is an opaque sentinel — still flagged.
      const isNullish = t === "null" || t === "undefined";
      if (single && !isNullish) continue;
      findings.push({
        file: filePath,
        line: lineOf(stripped, m.index),
        callee,
        literal: t === EMPTYSTR ? 'empty string ""' : t,
      });
    }
  }
  return findings;
}

// ===========================================================================
// Main
// ===========================================================================

const targets = process.argv.slice(2);
if (targets.length === 0) {
  console.error("Usage: node scripts/no-bare-literals.cjs [files-or-dirs...]");
  process.exit(2);
}

let total = 0;
const byLiteral = {};
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
      console.log(`${rel}:${f.line} — bare literal ${f.literal} passed to "${f.callee}"`);
      byLiteral[f.literal] = (byLiteral[f.literal] || 0) + 1;
      total++;
    }
  }
}

if (total > 0) {
  const breakdown = Object.entries(byLiteral)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${k}=${v}`)
    .join(", ");
  console.log(
    `\nFound ${total} bare-literal argument(s). Use named constants (NO_* / EXIT_CODE_* / etc.). [${breakdown}]`,
  );
  process.exit(1);
} else {
  console.log("✓ No bare-literal arguments found.");
}
