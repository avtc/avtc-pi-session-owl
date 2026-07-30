#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

/**
 * no-design-refs — enforce the "comments & product docs describe current state,
 * not history or design-doc references" convention (see AGENTS.md).
 *
 * Flags implementation-leftover references in:
 *   - comment regions of .ts/.tsx/.js/.mjs files (line and block comments, incl. JSDoc)
 *   - the FIRST string argument of it()/test()/describe() calls (test names)
 *   - product-doc .md files passed explicitly (README, CONFIGURATION — NOT AGENTS.md,
 *     which is a convention doc that legitimately quotes the forbidden patterns)
 *
 * Refs flagged: design-doc sections (§N, §2B.2), decisions (D27, D27 line 849),
 * requirements (R2-8), acceptance criteria (AC6b), tasks (Task 2.1), phases
 * (P2-1), WN2, "Section N", "Design ref…", and commit-hash refs (commit deadbeef).
 *
 * NOT flagged (the legitimate home for these refs): design docs and `.featyard/`
 * artifact docs (plans, research, reviews) — excluded by path. Skill/agent
 * prompts that *instruct* writing refs (e.g. fy-design "label decisions D1, D2")
 * live under skills//agents/ and are also excluded.
 *
 * Usage:
 *   node scripts/no-design-refs.cjs [--fix] [files-or-dirs...]
 *
 * Default = check (exit 1 on any violation). --fix = rewrite in place (strip
 * refs from comments + test names). Exits 0 if clean.
 */

const fs = require("node:fs");
const path = require("node:path");

const FIX = process.argv.includes("--fix");
const TARGETS = process.argv.slice(2).filter((a) => !a.startsWith("--"));

// ---------------------------------------------------------------------------
// Ref token patterns (applied to COMMENT bodies, test-name strings, and .md)
// ---------------------------------------------------------------------------
const TOKEN_RES = [
  /see commit [0-9a-f]{7,40}\b/gi,
  /\bcommit [0-9a-f]{7,40}\b/gi,
  /\bDesign ref: Section \d+[^\n]*/gi,
  /\bDesign ref\b[^\n]*/gi,
  /\bdesign ref\b[^\n]*/gi,
  /design §[\w/-]+(?:\.[\w/-]+)*(?: step \d+)?/gi,
  /(?<!\w)§[\w/-]+(?:\.[\w/-]+)*(?: step \d+)?/g,
  /design D\d{1,2}(?: line \d+)?\b/gi,
  /\bD\d{1,2}(?: line \d+)?\b/g,
  /\bR\d{1,2}-\d{1,3}\b/g,
  /\bAC\d+\w?\b/g,
  /\bTask \d+\.\d+\b/g,
  /\bWN\d+\b/g,
  /\bP\d-\d\b/g,
  /\bSection \d+\b/g,
  // single-letter-prefix design-doc IDs (acceptance A#/B#, test-case C#, E#, feature
  // F#, G#) the two-letter patterns above miss; phase/iteration labels. [1-9]\d? avoids
  // the 'C0' control-character-set false positive (design-doc IDs never start at 0).
  // The negative lookahead skips 'C1 control' (the C1 control-char block) — another
  // legitimate technical term that collides with criterion 'C1'. Scoped to comments +
  // test names + product .md by the tokenizer.
  /\b[ABCEFG][1-9]\d?\b(?!\s*control\b)/gi,
  /\biter-\d+\b/gi,
  /\bPhase [AB]\b/g,
];

/** Does `text` contain any ref token? Returns the first match or null. */
function firstRef(text) {
  for (const re of TOKEN_RES) {
    re.lastIndex = 0;
    const m = re.exec(text);
    if (m) return m[0];
  }
  return null;
}

// ===========================================================================
// File walking — .ts/.tsx/.js/.mjs/.md, skipping deps/build/artifacts/design-docs
// ===========================================================================
const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "coverage",
  ".featyard",
  ".pi",
  "reviews",
  // agent-instruction prompts: legitimately contain design-ref EXAMPLES that
  // teach the agent to label decisions / cite sections in the artifacts it produces.
  "skills",
  "agents",
]);
const SKIP_PATH_PARTS = ["docs/ff", "designs", "docs/design"];

function* walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name) || entry.name.startsWith(".")) continue;
      yield* walk(full);
    } else if (entry.isFile()) {
      if (!/\.(ts|tsx|js|mjs|md)$/.test(entry.name)) continue;
      yield full;
    }
  }
}

function shouldSkip(p) {
  const norm = p.replace(/\\/g, "/");
  // convention/meta docs that legitimately quote the forbidden patterns as examples
  if (/(^|\/)AGENTS\.md$/i.test(norm)) return true;
  return SKIP_PATH_PARTS.some((part) => norm.includes(`/${part}/`) || norm.includes(`${part}/`));
}

function collectTargets() {
  const files = [];
  for (const t of TARGETS) {
    let st;
    try {
      st = fs.statSync(t);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      for (const f of walk(t)) if (!shouldSkip(f)) files.push(f);
    } else if (!shouldSkip(t)) {
      files.push(t);
    }
  }
  return files;
}

// ===========================================================================
// Tokenizer: classify .ts source into code / comments / strings, so refs are
// detected ONLY inside comments (never code/strings — those are passed through).
// Regex literals are recognized (via isRegexStart) so they never cause drift.
// ===========================================================================

function isRegexStart(prevSig) {
  return prevSig === null || /[=(,[{:;!&|?%~^<>\s]/.test(prevSig);
}

/**
 * Extract comment regions with their start line numbers. Returns
 * [{line, text}] where text is the full comment text including markers.
 * Strings (', ", `) and regex literals are skipped verbatim so comment
 * detection never drifts (the bug that naive scanners hit on template strings).
 */
function extractComments(src) {
  const out = [];
  const n = src.length;
  let i = 0;
  let line = 1;
  let prevSig = null;
  while (i < n) {
    const c = src[i];
    const next = src[i + 1];
    if (c === "\n") {
      line++;
      i++;
      continue;
    }
    // block comment
    if (c === "/" && next === "*") {
      const startLine = line;
      let text = "/*";
      i += 2;
      while (i < n && !(src[i] === "*" && src[i + 1] === "/")) {
        if (src[i] === "\n") line++;
        text += src[i];
        i++;
      }
      text += "*/";
      i += 2;
      out.push({ line: startLine, text });
      prevSig = null;
      continue;
    }
    // line comment
    if (c === "/" && next === "/") {
      const startLine = line;
      let text = "";
      while (i < n && src[i] !== "\n") text += src[i++];
      out.push({ line: startLine, text });
      continue;
    }
    // strings
    if (c === "'" || c === '"') {
      const q = c;
      i++;
      while (i < n && src[i] !== q) {
        if (src[i] === "\\" && i + 1 < n) i += 2;
        else if (src[i] === "\n") break;
        else i++;
      }
      i++;
      prevSig = "x";
      continue;
    }
    if (c === "`") {
      i++;
      while (i < n && src[i] !== "`") {
        if (src[i] === "\\" && i + 1 < n) i += 2;
        else if (src[i] === "$" && src[i + 1] === "{") {
          let depth = 1;
          i += 2;
          while (i < n && depth > 0) {
            if (src[i] === "{") depth++;
            else if (src[i] === "}") depth--;
            if (depth === 0) break;
            if (src[i] === "\n") line++;
            i++;
          }
          i++;
          continue;
        }
        if (src[i] === "\n") line++;
        i++;
      }
      i++;
      prevSig = "x";
      continue;
    }
    // regex literal
    if (c === "/" && next !== "/" && next !== "*" && isRegexStart(prevSig)) {
      i++;
      let depth = 0;
      while (i < n) {
        const ch = src[i];
        if (ch === "\\" && i + 1 < n) i += 2;
        else if (ch === "[") {
          depth++;
          i++;
        } else if (ch === "]" && depth > 0) {
          depth--;
          i++;
        } else if (ch === "/" && depth === 0) {
          i++;
          while (i < n && /[gimsuyvd]/.test(src[i])) i++;
          break;
        } else if (ch === "\n") break;
        else i++;
      }
      prevSig = "x";
      continue;
    }
    prevSig = c.trim() === "" ? prevSig : c;
    i++;
  }
  return out;
}

// ===========================================================================
// Test-name first-arg extraction (it/test/describe) — for check & fix
// ===========================================================================
const CALL_RE = /\b(it|test|describe)\b\s*\(/g;

function findTestNameStrings(src) {
  const out = [];
  CALL_RE.lastIndex = 0;
  for (let m = CALL_RE.exec(src); m !== null; m = CALL_RE.exec(src)) {
    let j = m.index + m[0].length;
    while (j < src.length && /\s/.test(src[j])) j++;
    if (src[j] !== '"' && src[j] !== "'" && src[j] !== "`") continue;
    const q = src[j];
    const start = j;
    const startLine = src.slice(0, j).split("\n").length;
    j++;
    let content = "";
    while (j < src.length && src[j] !== q) {
      if (src[j] === "\\" && j + 1 < src.length) {
        content += src[j] + src[j + 1];
        j += 2;
        continue;
      }
      if (q === "`" && src[j] === "$" && src[j + 1] === "{") break; // interpolation: skip
      content += src[j];
      if (src[j] === "\n") break;
      j++;
    }
    out.push({ line: startLine, quote: q, content, start, end: j });
  }
  return out;
}

// ===========================================================================
// Check
// ===========================================================================
function checkFile(file) {
  const src = fs.readFileSync(file, "utf8");
  const rel = path.relative(process.cwd(), file).replace(/\\/g, "/");
  const findings = [];
  if (file.endsWith(".md")) {
    // product-doc markdown: scan whole file
    const lines = src.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const r = firstRef(lines[i]);
      if (r) findings.push(`${rel}:${i + 1} — design-doc ref "${r}" in product doc`);
    }
    return findings;
  }
  // .ts: comments + test-name strings
  for (const c of extractComments(src)) {
    const r = firstRef(c.text);
    if (r) findings.push(`${rel}:${c.line} — design-doc ref "${r}" in comment`);
  }
  for (const t of findTestNameStrings(src)) {
    const r = firstRef(t.content);
    if (r) findings.push(`${rel}:${t.line} — design-doc ref "${r}" in test name`);
  }
  return findings;
}

// ===========================================================================
// Fix (port of the proven tokenizer rewriter)
// ===========================================================================
const LEAD_GLUE = /^(?:[\s,;:./\-—]+|(?:design|see|step|line|row|per|via)\s+)/;
const TRAIL_GLUE = /[\s,;:./\-—]+$/;

function stripTokens(text) {
  let prev;
  do {
    prev = text;
    for (const re of TOKEN_RES) {
      re.lastIndex = 0;
      text = text.replace(re, "");
    }
  } while (text !== prev);
  return text;
}

function cleanBody(body) {
  let b = stripTokens(body);
  // parentheticals: trim glue, drop if only separators remain
  let prev;
  do {
    prev = b;
    b = b.replace(/\(([^()]*?)\)/g, (_m, inner) => {
      let s = inner;
      let p;
      do {
        p = s;
        s = s.replace(LEAD_GLUE, "");
        s = s.replace(TRAIL_GLUE, "");
      } while (s !== p);
      return /^[\s,;:./\-—]*$/.test(s) ? "__EMPTY__" : `(${s})`;
    });
  } while (b !== prev);
  b = b.replace(/ *__EMPTY__/g, "");
  b = b.replace(/ *\(\s*\)/g, "");
  b = b.replace(/[ \t]{2,}/g, " ");
  b = b.replace(/ +([,;:])/g, "$1");
  b = b.replace(/ *— *$/g, "");
  b = b.replace(/ +$/, "");
  b = b.replace(/^[ \t]*—[ \t]*/, "");
  b = b.replace(/— +/g, "— ");
  b = b.replace(/ +—/g, " —");
  b = b.replace(/ ;\./g, ".");
  b = b.replace(/\s+\./g, ".");
  b = b.replace(/\s+,/g, ",");
  return b;
}

function cleanTestName(s) {
  let r = stripTokens(s);
  r = r.replace(/\(\s*[\s,;:/.\-—]*\s*\)/g, "");
  r = r.replace(/^[—\-/.,;: \s]+/, "");
  r = r.replace(/[\s,;:/.\-—]+$/, "");
  r = r.replace(/\(\s+/g, "(").replace(/\s+\)/g, ")");
  r = r.replace(/\(\s*\)/g, "");
  r = r.replace(/[ \t]{2,}/g, " ");
  r = r
    .replace(/ *— *$/g, "")
    .replace(/\s+\./g, ".")
    .replace(/\s+,/g, ",");
  r = r.replace(/\s+—/g, " —").replace(/— +/g, "— ");
  return r.trim();
}

function fixFile(file) {
  let src = fs.readFileSync(file, "utf8");
  let changed = false;
  if (file.endsWith(".md")) {
    // markdown: strip refs line by line from the whole line
    const next = src
      .split("\n")
      .map((ln) => {
        if (!firstRef(ln)) return ln;
        const fixed = cleanBody(ln);
        return fixed;
      })
      .join("\n");
    if (next !== src) {
      src = next;
      changed = true;
    }
  } else {
    // .ts: rewrite comment regions + test-name strings in place.
    // SURGICAL: a comment/test-name is rewritten ONLY when it actually contains a
    // ref token (firstRef). Comments with no ref are left byte-identical — without
    // this guard, cleanBody/cleanTestName whitespace-normalization would reformat
    // untouched comments (misaligning JSDoc, collapsing deliberate spacing),
    // polluting diffs and mangling code that has no design-doc refs at all.
    // Comment regions: re-tokenize and rebuild by splicing.
    const comments = extractCommentsWithRange(src);
    for (let k = comments.length - 1; k >= 0; k--) {
      const c = comments[k];
      if (!firstRef(c.text)) continue;
      const fixed = rewriteComment(c.text);
      if (fixed !== c.text) {
        src = src.slice(0, c.start) + fixed + src.slice(c.end);
        changed = true;
      }
    }
    // test-name strings
    const names = findTestNameStringsWithRange(src);
    for (let k = names.length - 1; k >= 0; k--) {
      const t = names[k];
      if (!firstRef(t.content)) continue;
      const fixed = cleanTestName(t.content);
      if (fixed !== t.content) {
        src = src.slice(0, t.start + 1) + fixed + src.slice(t.end);
        changed = true;
      }
    }
  }
  if (changed) fs.writeFileSync(file, src);
  return changed;
}

// variant of extractComments that also records char ranges (for splicing)
function extractCommentsWithRange(src) {
  const out = [];
  const n = src.length;
  let i = 0;
  let prevSig = null;
  while (i < n) {
    const c = src[i];
    const next = src[i + 1];
    if (c === "/" && next === "*") {
      const start = i;
      i += 2;
      while (i < n && !(src[i] === "*" && src[i + 1] === "/")) i++;
      i += 2;
      out.push({ start, end: i, text: src.slice(start, i) });
      prevSig = null;
      continue;
    }
    if (c === "/" && next === "/") {
      const start = i;
      while (i < n && src[i] !== "\n") i++;
      out.push({ start, end: i, text: src.slice(start, i) });
      continue;
    }
    if (c === "'" || c === '"') {
      const q = c;
      i++;
      while (i < n && src[i] !== q) {
        if (src[i] === "\\" && i + 1 < n) i += 2;
        else if (src[i] === "\n") break;
        else i++;
      }
      i++;
      prevSig = "x";
      continue;
    }
    if (c === "`") {
      i++;
      while (i < n && src[i] !== "`") {
        if (src[i] === "\\" && i + 1 < n) i += 2;
        else if (src[i] === "$" && src[i + 1] === "{") {
          let depth = 1;
          i += 2;
          while (i < n && depth > 0) {
            if (src[i] === "{") depth++;
            else if (src[i] === "}") depth--;
            if (depth === 0) break;
            i++;
          }
          i++;
          continue;
        }
        i++;
      }
      i++;
      prevSig = "x";
      continue;
    }
    if (c === "/" && next !== "/" && next !== "*" && isRegexStart(prevSig)) {
      i++;
      let depth = 0;
      while (i < n) {
        const ch = src[i];
        if (ch === "\\" && i + 1 < n) i += 2;
        else if (ch === "[") {
          depth++;
          i++;
        } else if (ch === "]" && depth > 0) {
          depth--;
          i++;
        } else if (ch === "/" && depth === 0) {
          i++;
          while (i < n && /[gimsuyvd]/.test(src[i])) i++;
          break;
        } else if (ch === "\n") break;
        else i++;
      }
      prevSig = "x";
      continue;
    }
    prevSig = c.trim() === "" ? prevSig : c;
    i++;
  }
  return out;
}

function findTestNameStringsWithRange(src) {
  const out = [];
  CALL_RE.lastIndex = 0;
  for (let m = CALL_RE.exec(src); m !== null; m = CALL_RE.exec(src)) {
    let j = m.index + m[0].length;
    while (j < src.length && /\s/.test(src[j])) j++;
    const q = src[j];
    if (q !== '"' && q !== "'" && q !== "`") continue;
    const start = j;
    j++;
    let content = "";
    while (j < src.length && src[j] !== q) {
      if (src[j] === "\\" && j + 1 < src.length) {
        content += src[j] + src[j + 1];
        j += 2;
        continue;
      }
      if (q === "`" && src[j] === "$" && src[j + 1] === "{") break;
      content += src[j];
      if (src[j] === "\n") break;
      j++;
    }
    out.push({ start, end: j, content });
  }
  return out;
}

// rewrite a comment's body while preserving markers/delimiters
function rewriteComment(text) {
  // block comment
  if (text.startsWith("/*")) {
    const openDelim = text.startsWith("/**") ? "/**" : text.startsWith("/*!") ? "/*! " : "/*";
    const closeDelim = "*/";
    const inner = text.slice(openDelim.length, text.length - closeDelim.length);
    if (!inner.includes("\n")) {
      let cb = cleanBody(inner);
      if (cb && !cb.startsWith(" ")) cb = ` ${cb}`;
      if (cb && !cb.endsWith(" ")) cb += " ";
      return `${openDelim}${cb}${closeDelim}`;
    }
    const lines = inner.split("\n");
    const newLines = lines.map((ln, idx) => {
      const mm = /^(\s*\*\s?)(.*)$/s.exec(ln);
      if (mm) {
        let bodyPart = cleanBody(mm[2]);
        if (idx === lines.length - 1 && bodyPart && !bodyPart.endsWith(" ")) bodyPart += " ";
        return mm[1] + bodyPart;
      }
      let cb = cleanBody(ln);
      if (idx === 0 && cb && !cb.startsWith(" ") && !cb.startsWith("\n")) cb = ` ${cb}`;
      if (idx === lines.length - 1 && cb && !cb.endsWith(" ") && !cb.endsWith("\n")) cb += " ";
      return cb;
    });
    // ensure a space before the closing */ (standalone-close lines: "\n*/" -> "\n */")
    return `${openDelim}${newLines.join("\n")} */`.replace(/\n\*\//, "\n */");
  }
  // line comment
  const mm = /^(\/\/+!?)(\s*)(.*)$/s.exec(text);
  if (mm) {
    const fixed = cleanBody(mm[3]);
    return mm[1] + mm[2] + fixed;
  }
  return text;
}

// ===========================================================================
// Main
// ===========================================================================
if (TARGETS.length === 0) {
  console.error("Usage: node scripts/no-design-refs.cjs [--fix] [files-or-dirs...]");
  process.exit(2);
}

const files = collectTargets();
if (FIX) {
  let n = 0;
  for (const f of files) if (fixFile(f)) n++;
  console.log(n > 0 ? `Fixed design-doc references in ${n} file(s).` : "✓ No design-doc references found.");
  process.exit(0);
}

let total = 0;
for (const f of files) {
  const msgs = checkFile(f);
  for (const msg of msgs) {
    console.log(msg);
    total++;
  }
}
if (total > 0) {
  console.log(
    `\nFound ${total} design-doc reference(s) in comments/product-docs. Move them to design docs or .featyard/ artifact docs, or strip them. (Run: node scripts/no-design-refs.cjs --fix <paths>)`,
  );
  process.exit(1);
}
console.log("✓ No design-doc references in comments or product docs.");
