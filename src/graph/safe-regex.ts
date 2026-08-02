// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// A lightweight static analyzer that rejects regexes prone to catastrophic
// backtracking (ReDoS) BEFORE they are executed against observation content —
// `find` / `mk_recall` / `/mk:find` accept user/agent-supplied patterns.
//
// It approximates the well-known "star-height" + "imprecise alternation under
// repetition" heuristics (the same shape the `safe-regex` library checks):
//   1. nested quantifiers (star height ≥ 2): `(a+)+`, `(a*)*`, `(\d+)*` … these
//      force an exponential number of ways to split a long run of the same char.
//   2. alternation under a quantifier where two branches can match overlapping
//      input (`(a|a)+`, `(a|ab)*`) or a branch is nullable (`(a?)+`,
//      `(a*)+`): the engine can take either branch for the same char.
//
// False positives (rejecting a safe-but-tricky pattern) are acceptable here —
// the user/agent can always rephrase — but false negatives (letting an evil
// pattern through) are not, so the analyzer stays conservative.

/** Given `pattern` and `i` pointing just past the `(?` of a `(?…)`, return the
 *  index where the group BODY starts. Lookahead/lookbehind (`(?=`, `(?!`,
 *  `(?<=`, `(?<!`) have the body right after the marker char; `(?:` / `(?i:`
 *  start after `:`; `(?<name>` starts after `>`; flag-only `(?i)` returns the
 *  index of the closing `)` (empty body). */
function groupBodyStart(pattern: string, i: number): number {
  if (i >= pattern.length) return i;
  const c = pattern[i];
  // lookahead: body right after the single `=`/`!`
  if (c === "=" || c === "!") return i + 1;
  // lookbehind / named group start with `<`
  if (c === "<") {
    const next = pattern[i + 1];
    // lookbehind `(?<=` / `(?<!`: body after the assertion char
    if (next === "=" || next === "!") return i + 2;
    // named group `(?<name>`: body after the closing `>`
    let k = i + 1;
    while (k < pattern.length && pattern[k] !== ">" && pattern[k] !== ")") k += 1;
    return k < pattern.length && pattern[k] === ">" ? k + 1 : k;
  }
  // `(?` then flag chars up to ':' (body) or ')' (flag-only group, empty body)
  while (i < pattern.length && pattern[i] !== ":" && pattern[i] !== ")") i += 1;
  if (i < pattern.length && pattern[i] === ":") return i + 1;
  return i; // flag-only group: index of ')'
}

/**
 * Star-height check: returns the max quantifier-nesting depth of the pattern.
 * Height ≥ 2 means a quantifier applies to something that already contains a
 * quantifier (e.g. `(a+)+`) — the classic exponential-backtracking shape.
 *
 * Model: walk the pattern tracking the star-height of the most recent complete
 * operand (char / class / closed group). A quantifier raises that operand's
 * height by 1; a group records the max height reached inside it so a quantifier
 * after the group close uses the group's inner height as its operand.
 */
function starHeight(pattern: string): number {
  let maxHeight = 0;
  let operandHeight = 0; // star-height of the last complete operand
  const groupMaxima: number[] = []; // max height seen inside each open group
  let inClass = false;
  let escaped = false;
  let i = 0;
  while (i < pattern.length) {
    const ch = pattern[i];
    if (escaped) {
      escaped = false;
      operandHeight = 0;
      i += 1;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      i += 1;
      continue;
    }
    if (inClass) {
      if (ch === "]") {
        inClass = false;
        operandHeight = 0;
      }
      i += 1;
      continue;
    }
    if (ch === "[") {
      inClass = true;
      i += 1;
      continue;
    }
    if (ch === "(") {
      // A non-capturing/lookahead/lookbehind/named group `(?…)`, `(?<…>)` is
      // still a group for backtracking: its body can nest quantifiers. Skip the
      // type marker, then process the body as a normal group (so `(?:a+)+` is
      // detected as star-height 2, NOT treated as an opaque atom).
      if (i + 1 < pattern.length && pattern[i + 1] === "?") {
        groupMaxima.push(0);
        operandHeight = 0;
        // skip the `(?…)` marker to the body start (lookahead/lookbehind/named/
        // non-capturing), then process the body as a normal group so nested
        // quantifiers inside it raise the star height (e.g. `(?:a+)+` → 2).
        i = groupBodyStart(pattern, i + 2);
        continue;
      }
      groupMaxima.push(0);
      operandHeight = 0;
      i += 1;
      continue;
    }
    if (ch === ")") {
      const innerMax = groupMaxima.pop() ?? 0;
      operandHeight = innerMax;
      i += 1;
      continue;
    }
    if (ch === "|") {
      // alternation resets the operand; the branch maxima are merged at the group
      operandHeight = 0;
      i += 1;
      continue;
    }
    if (ch === "*" || ch === "+" || ch === "?" || ch === "{") {
      const newHeight = operandHeight + 1;
      if (newHeight > maxHeight) maxHeight = newHeight;
      const top = groupMaxima.length > 0 ? groupMaxima[groupMaxima.length - 1] : undefined;
      if (top !== undefined && newHeight > top) groupMaxima[groupMaxima.length - 1] = newHeight;
      operandHeight = newHeight;
      // consume the quantifier body
      if (ch === "{") {
        i += 1;
        while (i < pattern.length && /[\d,]/.test(pattern[i])) i += 1;
        if (i < pattern.length && pattern[i] === "}") i += 1;
      } else {
        i += 1;
      }
      if (i < pattern.length && pattern[i] === "?") i += 1; // non-greedy
      continue;
    }
    // ordinary char
    operandHeight = 0;
    i += 1;
  }
  return maxHeight;
}

/**
 * Imprecise-alternation-under-quantifier check: returns true if any quantified
 * group contains an alternation whose branches can match the same input
 * (`(a|a)+`, `(a|ab)*`) — making the repetition ambiguous.
 *
 * Conservative: only flags a literal-char prefix overlap between the first
 * token of two branches (covers the common evil shapes) and nullable-branch
 * cases.
 */
function hasImpreciseAlternationUnderQuantifier(pattern: string): boolean {
  // Find each quantified group `( … )*|+|{n,}` and inspect its top-level
  // alternations. This is a best-effort scan; false negatives are tolerated but
  // the common `(a|a)+` and `(a|ab)*` shapes are caught.
  for (let i = 0; i < pattern.length; i += 1) {
    if (pattern[i] !== "(") continue;
    // locate the matching close, then the trailing quantifier
    let depth = 1;
    let j = i + 1;
    let inClass = false;
    let escaped = false;
    while (j < pattern.length && depth > 0) {
      const c = pattern[j];
      if (escaped) {
        escaped = false;
        j += 1;
        continue;
      }
      if (c === "\\") {
        escaped = true;
        j += 1;
        continue;
      }
      if (inClass) {
        if (c === "]") inClass = false;
        j += 1;
        continue;
      }
      if (c === "[") inClass = true;
      else if (c === "(") depth += 1;
      else if (c === ")") depth -= 1;
      if (depth === 0) break;
      j += 1;
    }
    if (j >= pattern.length || pattern[j] !== ")") continue;
    const after = j + 1;
    const quantified =
      after < pattern.length && (pattern[after] === "*" || pattern[after] === "+" || pattern[after] === "{");
    if (!quantified) {
      i = j;
      continue;
    }
    // the group body, skipping any non-capturing/lookahead/lookbehind/named
    // marker so `(?:a|a)+` is inspected as `a|a`.
    let bodyStart = i + 1;
    if (bodyStart < j && pattern[bodyStart] === "?") {
      bodyStart = groupBodyStart(pattern, bodyStart + 1);
    }
    const body = pattern.slice(bodyStart, j);
    if (topLevelAlternationOverlaps(body)) return true;
    i = j;
  }
  return false;
}

/** Split a group body on top-level `|` (ignoring `|` inside nested groups/classes). */
function splitTopLevelAlternatives(body: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let inClass = false;
  let escaped = false;
  let start = 0;
  for (let k = 0; k < body.length; k += 1) {
    const c = body[k];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (c === "\\") {
      escaped = true;
      continue;
    }
    if (inClass) {
      if (c === "]") inClass = false;
      continue;
    }
    if (c === "[") inClass = true;
    else if (c === "(") depth += 1;
    else if (c === ")") depth -= 1;
    else if (c === "|" && depth === 0) {
      out.push(body.slice(start, k));
      start = k + 1;
    }
  }
  out.push(body.slice(start));
  return out;
}

/** First literal char of a branch (skipping a leading quantifier/anchor), or null. */
function firstLiteralChar(branch: string): string | null {
  for (let k = 0; k < branch.length; k += 1) {
    const c = branch[k];
    if (c === "\\") {
      const next = branch[k + 1];
      if (next !== undefined && !/^[0-9dDsSwWbB]/.test(next)) return next;
      k += 1;
      continue;
    }
    if (c === "[" || c === "(" || c === "." || c === "^" || c === "$") return null;
    return c;
  }
  return null;
}

/** A branch is nullable if it can match the empty string (e.g. `a?`, `a*`, empty). */
function branchIsNullable(branch: string): boolean {
  const trimmed = branch.trim();
  if (trimmed === "") return true;
  if (trimmed.length === 2 && trimmed[1] === "?") return true;
  if (trimmed.length === 2 && trimmed[1] === "*") return true;
  return false;
}

function topLevelAlternationOverlaps(body: string): boolean {
  const alts = splitTopLevelAlternatives(body);
  if (alts.length < 2) return false;
  // any nullable branch under a quantifier is ambiguous (matches empty)
  if (alts.some(branchIsNullable)) return true;
  // two branches sharing a first literal char overlap
  const firsts = new Set<string>();
  for (const a of alts) {
    const f = firstLiteralChar(a);
    if (f !== null) {
      if (firsts.has(f)) return true;
      firsts.add(f);
    }
  }
  return false;
}

/** A quantified backreference (`\1+`, `(a+)\1*`) is a distinct ReDoS shape the
 *  star-height + alternation checks miss: the engine must try every split of a
 *  run between the capture and the backreference. Conservative: any backref
 *  (`\1`–`\9`) directly followed by a quantifier is rejected. */
function hasQuantifiedBackreference(pattern: string): boolean {
  let escaped = false;
  for (let i = 0; i < pattern.length; i += 1) {
    const ch = pattern[i];
    if (escaped) {
      escaped = false;
      // a backreference is \ followed by a non-zero digit
      if (ch >= "1" && ch <= "9") {
        const next = pattern[i + 1];
        if (next === "*" || next === "+" || next === "?" || next === "{") return true;
      }
      continue;
    }
    if (ch === "\\") escaped = true;
  }
  return false;
}

/** True iff `pattern` passes the safe-regex heuristics (no nested quantifiers,
 *  no imprecise alternation under a quantifier, no quantified backreference).
 *  Conservative. */
export function isSafeRegex(pattern: string): boolean {
  if (starHeight(pattern) >= 2) return false;
  if (hasImpreciseAlternationUnderQuantifier(pattern)) return false;
  if (hasQuantifiedBackreference(pattern)) return false;
  return true;
}
