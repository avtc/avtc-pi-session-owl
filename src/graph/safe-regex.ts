// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// A lightweight static analyzer that rejects regexes prone to catastrophic
// backtracking (ReDoS) BEFORE they are executed against observation content —
// `find` / `owl_recall` / `/owl:find` accept user/agent-supplied patterns.
//
// It approximates the well-known "star-height" + "imprecise alternation under
// repetition" heuristics (the same shape the `safe-regex` library checks):
//   1. nested quantifiers (star height ≥ 2): `(a+)+`, `(a*)*`, `(\d+)*` … these
//      force an exponential number of ways to split a long run of the same char.
//   2. alternation under a quantifier where two branches can match overlapping
//      input (`(a|a)+`, `(a|ab)*`) or a branch is nullable (`(a?)+`,
//      `(a*)+`): the engine can take either branch for the same char.
//
//   3. a chain of imprecise quantifiers (`.`, `[...]`, `\d`/`\w`/`\s`) in one
//      matching path — k such quantifiers cost O(n^k); `.*a.*a.*a.*b` is
//      polynomially catastrophic even at star-height 1.
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
      // propagate this group's max star-height into the parent group's max slot,
      // so a quantifier nested one group deep (e.g. the `?` in `((a?))+`) is
      // not lost when the inner group closes — the outer `+` must see height 2.
      if (groupMaxima.length > 0) {
        const parent = groupMaxima[groupMaxima.length - 1];
        if (innerMax > parent) groupMaxima[groupMaxima.length - 1] = innerMax;
      }
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

/** Return the index of the `)` matching the `(` at `openIdx`, or -1 if
 *  unbalanced. Tracks nesting, escapes, and char classes. */
function findMatchingClose(pattern: string, openIdx: number): number {
  let depth = 1;
  let j = openIdx + 1;
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
    else if (c === ")") {
      depth -= 1;
      if (depth === 0) return j;
    }
    j += 1;
  }
  return -1;
}

/** Body of the group whose `(` is at `groupOpen`: skips a `(?…)`, `(?<name>)`,
 *  or `(?<=)`/`(?<!)` marker so the body is the alternation-bearing content.
 *  Returns the substring between the marker and the matching `)`. */
function groupBody(pattern: string, groupOpen: number): string {
  const closeIdx = findMatchingClose(pattern, groupOpen);
  if (closeIdx === -1) return "";
  let bodyStart = groupOpen + 1;
  if (bodyStart < closeIdx && pattern[bodyStart] === "?") {
    bodyStart = groupBodyStart(pattern, bodyStart + 1);
  }
  return pattern.slice(bodyStart, closeIdx);
}

/** True if `body` contains an imprecise alternation at ANY nesting depth: a
 *  top-level `|` with overlapping/nullable branches, OR such a shape inside any
 *  nested group within `body`. The enclosing quantifier repeats everything in
 *  body, so a buried ambiguous alternation (e.g. the inner `(a|a)` in
 *  `((a|a))+`) is still dangerous. */
function bodyHasImpreciseAlternation(body: string): boolean {
  if (topLevelAlternationOverlaps(body)) return true;
  let k = 0;
  while (k < body.length) {
    const c = body[k];
    if (c === "\\") {
      k += 2;
      continue;
    }
    if (c === "[") {
      // skip the char class
      k += 1;
      while (k < body.length) {
        if (body[k] === "\\") k += 1;
        if (body[k] === "]") break;
        k += 1;
      }
      k += 1;
      continue;
    }
    if (c === "(") {
      if (bodyHasImpreciseAlternation(groupBody(body, k))) return true;
      // skip past this group so its internals aren't re-scanned linearly
      const close = findMatchingClose(body, k);
      k = close === -1 ? k + 1 : close + 1;
      continue;
    }
    k += 1;
  }
  return false;
}

/**
 * Imprecise-alternation-under-quantifier check: returns true if any quantified
 * group contains (at any nesting depth) an alternation whose branches can match
 * the same input (`(a|a)+`, `(a|ab)*`, `((a|a))+`) or a nullable branch
 * (`(a?)+`). The enclosing quantifier repeats the whole body, so a buried
 * ambiguous alternation is dangerous.
 *
 * Scans every `(` in the pattern — does NOT skip the contents of non-quantified
 * groups, so a quantified group nested inside a plain group (`((a|a)+)`) is
 * still found.
 */
function hasImpreciseAlternationUnderQuantifier(pattern: string): boolean {
  for (let i = 0; i < pattern.length; i += 1) {
    if (pattern[i] !== "(") continue;
    const closeIdx = findMatchingClose(pattern, i);
    if (closeIdx === -1) continue;
    const after = closeIdx + 1;
    const quantified =
      after < pattern.length && (pattern[after] === "*" || pattern[after] === "+" || pattern[after] === "{");
    if (!quantified) continue; // do not skip: a nested quantified group may follow
    if (bodyHasImpreciseAlternation(groupBody(pattern, i))) return true;
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

/** A character class describing what a branch can match at its first position:
 *  universal (`.` / `[^]`), an explicit finite set (literal, `\d`/`\w`/`\s`, `[abc]`,
 *  `[a-z]`), or a complement of a finite set (`[^abc]`, `\D`/`\W`/`\S`). Used to
 *  detect alternation overlap — two branches under a quantifier whose first-char
 *  classes intersect (`(a|.)+`, `(\d|[0-9])+`) are a ReDoS shape. */
type CharClass =
  | { kind: "universal" }
  | { kind: "explicit"; chars: ReadonlySet<string> }
  | { kind: "complement"; exclude: ReadonlySet<string> }
  | { kind: "unknown" }; // can't statically classify → conservative overlap

const DIGIT_CHARS = "0123456789";
const WORD_CHARS = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_";
const SPACE_CHARS =
  " \f\n\r\t\v\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff";
/** Frozen char Sets for the \d/\w/\s shorthand classes, built once and reused
 *  across firstCharClass + polynomialQuantifierChain (read-only: classesIntersect
 *  never mutates). Hoisting avoids rebuilding the same Set on every call in the
 *  per-alternation / per-character hot paths. */
const DIGIT_CHAR_SET: ReadonlySet<string> = new Set(DIGIT_CHARS);
const WORD_CHAR_SET: ReadonlySet<string> = new Set(WORD_CHARS);
const SPACE_CHAR_SET: ReadonlySet<string> = new Set(SPACE_CHARS);

/** Reject a run of this many (or more) ADJACENT OVERLAPPING unbounded
 *  quantifiers in one path — k such quantifiers that partition a common span
 *  cost O(n^k) when a later part fails to match. k≥2 is the danger threshold:
 *  `a+a+b` (2) freezes V8 for ~0.8s at 2000 chars, `a+a+a+b` (3) for ~29s at
 *  1000. Conservative per the stated policy (false positives acceptable, false
 *  negatives not). */
const IMPRECISE_CHAIN_MAX = 2;

/** Expand a `[...]` class body (without the brackets) into an explicit char set,
 *  applying ranges (`a-z`) and the standard shorthand escapes. */
function expandClassBody(classBody: string): Set<string> {
  const chars = new Set<string>();
  let i = 0;
  while (i < classBody.length) {
    const c = classBody[i];
    if (c === "\\") {
      const next = classBody[i + 1];
      if (next === "d") for (const ch of DIGIT_CHARS) chars.add(ch);
      else if (next === "w") for (const ch of WORD_CHARS) chars.add(ch);
      else if (next === "s") for (const ch of SPACE_CHARS) chars.add(ch);
      else if (next !== undefined) chars.add(next); // any other escape → that char
      i += 2;
      continue;
    }
    // range a-z (only when both endpoints are literals and a `-` follows)
    if (classBody[i + 1] === "-" && i + 2 < classBody.length && classBody[i + 2] !== "]") {
      const lo = c.charCodeAt(0);
      const hi = classBody.charCodeAt(i + 2);
      for (let code = lo; code <= hi; code += 1) chars.add(String.fromCharCode(code));
      i += 3;
      continue;
    }
    chars.add(c);
    i += 1;
  }
  return chars;
}

/** Parse a `[...]` character class starting at the `[` (index `start`) into a
 *  CharClass, returning the class and the index just past the closing `]`
 *  (or past the scanned body if no `]` closes it). Shared by `firstCharClass`
 *  and the operand scanner in `polynomialQuantifierChain`. */
function parseCharClass(s: string, start: number): { cls: CharClass; next: number } {
  let end = start + 1;
  while (end < s.length) {
    if (s[end] === "\\") end += 1;
    if (s[end] === "]") break;
    end += 1;
  }
  const inner = s.slice(start + 1, end);
  const negated = inner.startsWith("^");
  const body = negated ? inner.slice(1) : inner;
  const cls: CharClass =
    body === ""
      ? { kind: "universal" }
      : negated
        ? { kind: "complement", exclude: expandClassBody(body) }
        : { kind: "explicit", chars: expandClassBody(body) };
  return { cls, next: end + 1 };
}

/** First character class a branch can match (skipping zero-width anchors `^$` and
 *  `\b`/`\B`). Recurses one level into a leading `(` group. Returns `unknown`
 *  when the leading element can't be statically classified (e.g. a backreference
 *  or a lookahead group) so the caller treats it conservatively. */
function firstCharClass(branch: string): CharClass {
  for (let k = 0; k < branch.length; k += 1) {
    const c = branch[k];
    if (c === "^" || c === "$") continue; // zero-width anchors
    if (c === "\\") {
      const next = branch[k + 1];
      if (next === "b" || next === "B") continue; // word-boundary assertions (zero-width)
      if (next === "d") return { kind: "explicit", chars: DIGIT_CHAR_SET };
      if (next === "w") return { kind: "explicit", chars: WORD_CHAR_SET };
      if (next === "s") return { kind: "explicit", chars: SPACE_CHAR_SET };
      if (next === "D") return { kind: "complement", exclude: DIGIT_CHAR_SET };
      if (next === "W") return { kind: "complement", exclude: WORD_CHAR_SET };
      if (next === "S") return { kind: "complement", exclude: SPACE_CHAR_SET };
      if (next !== undefined) return { kind: "explicit", chars: new Set([next]) }; // any other escaped char
      return { kind: "unknown" };
    }
    if (c === ".") return { kind: "universal" };
    if (c === "[") {
      // parse the char class up to its closing ]
      const { cls } = parseCharClass(branch, k);
      return cls;
    }
    if (c === "(") return { kind: "unknown" }; // group/lookahead — recurse not worth it here
    return { kind: "explicit", chars: new Set([c]) }; // literal char
  }
  return { kind: "unknown" }; // empty / all-zero-width branch
}

/** True if two char classes can match a common character. Conservative: unknown
 *  or complement-vs-complement defaults to overlap (reject) since their match
 *  sets are large and intersect in practice. */
function classesIntersect(a: CharClass, b: CharClass): boolean {
  if (a.kind === "unknown" || b.kind === "unknown") return true;
  if (a.kind === "universal" || b.kind === "universal") return true;
  if (a.kind === "complement" && b.kind === "complement") return true; // both match almost everything
  if (a.kind === "explicit" && b.kind === "explicit") {
    for (const ch of a.chars) if (b.chars.has(ch)) return true;
    return false;
  }
  // explicit vs complement (either order): overlap iff the explicit set has a char NOT excluded
  if (a.kind === "explicit" && b.kind === "complement") {
    for (const ch of a.chars) if (!b.exclude.has(ch)) return true;
    return false;
  }
  if (b.kind === "explicit" && a.kind === "complement") {
    for (const ch of b.chars) if (!a.exclude.has(ch)) return true;
    return false;
  }
  return false;
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
  // two branches whose first-char classes intersect can match the same input
  const classes = alts.map(firstCharClass);
  for (let i = 0; i < classes.length; i += 1) {
    for (let j = i + 1; j < classes.length; j += 1) {
      if (classesIntersect(classes[i], classes[j])) return true;
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

/** New adjacent-overlapping run length after seeing an unbounded quantifier
 *  over `operand`: extend the prior run (`chain + 1`) when the previous
 *  quantifier is exactly one operand atom away with an intersecting operand
 *  class, else start a fresh run (1). Pure — no shared mutable state. */
function adjacentOverlapChain(
  chain: number,
  lastQuant: { operand: CharClass; atomsSince: number } | null,
  operand: CharClass,
): number {
  if (lastQuant && lastQuant.atomsSince === 1 && classesIntersect(lastQuant.operand, operand)) return chain + 1;
  return 1;
}

/** Detect a polynomial-backtracking shape the star-height + alternation
 *  checks miss: a run of ADJACENT unbounded quantifiers whose operands can
 *  match a common character (e.g. `a+a+b`, `.*.*b`, `[a-z]+[a-z]+b`,
 *  `(.+)(.+)b`). Two unbounded quantifiers that partition a common span let
 *  the engine try O(n^k) ways to split the input among them when a later part
 *  fails to match; empirically `a+a+a+b` freezes V8 for ~7 minutes at 2000
 *  chars. Returns the longest adjacent-overlapping unbounded-quantifier run.
 *
 *  ADJACENCY: the two quantifiers must be separated by only the second's
 *  operand (and transparent group boundaries) — exactly one operand atom
 *  between them. A literal atom between the quantifiers (`.*foo.*bar`, `a+b+a+`)
 *  fails fast and BREAKS the run, so those stay safe. OVERLAP: the operands'
 *  char-classes must intersect (both can consume the same char); disjoint
 *  operands (`a+b+`) can't partition a common span. Literal-operand quantifiers
 *  (`a+`) DO extend the run when their operand overlaps the prior quantifier's
 *  operand — `a+a+b` is evil even though each operand is a single literal char.
 *  Conservative: `unknown` operand classes (groups, backreferences) count as
 *  overlapping; alternation `|` and anchors `^`/`$` reset the run. */
function polynomialQuantifierChain(pattern: string): number {
  let longest = 0;
  let chain = 0;
  // operand class of the atom immediately preceding the cursor (what a
  // following quantifier would bind to); null after a quantifier / boundary.
  let pendingOperand: CharClass | null = null;
  // the most recent unbounded quantifier, tracked to detect an adjacent-
  // overlapping continuation; `atomsSince` counts operand atoms scanned since
  // it (group boundaries are transparent and don't count).
  let lastQuant: { operand: CharClass; atomsSince: number } | null = null;
  let i = 0;
  while (i < pattern.length) {
    const ch = pattern[i];
    if (ch === "\\") {
      const next = pattern[i + 1];
      if (next === "d") pendingOperand = { kind: "explicit", chars: DIGIT_CHAR_SET };
      else if (next === "w") pendingOperand = { kind: "explicit", chars: WORD_CHAR_SET };
      else if (next === "s") pendingOperand = { kind: "explicit", chars: SPACE_CHAR_SET };
      else if (next === "D") pendingOperand = { kind: "complement", exclude: DIGIT_CHAR_SET };
      else if (next === "W") pendingOperand = { kind: "complement", exclude: WORD_CHAR_SET };
      else if (next === "S") pendingOperand = { kind: "complement", exclude: SPACE_CHAR_SET };
      else if (next !== undefined) pendingOperand = { kind: "explicit", chars: new Set([next]) };
      else pendingOperand = null;
      if (lastQuant) lastQuant.atomsSince += 1;
      i += 2;
      continue;
    }
    if (ch === "[") {
      const { cls, next } = parseCharClass(pattern, i);
      pendingOperand = cls;
      if (lastQuant) lastQuant.atomsSince += 1;
      i = next;
      continue;
    }
    if (ch === ".") {
      pendingOperand = { kind: "universal" };
      if (lastQuant) lastQuant.atomsSince += 1;
      i += 1;
      continue;
    }
    if (ch === "(" || ch === ")") {
      // transparent to an adjacent-quantifier run (groups don't change the
      // matching path); don't touch pendingOperand or atomsSince.
      i += 1;
      continue;
    }
    if (ch === "|" || ch === "^" || ch === "$") {
      if (chain > longest) longest = chain;
      chain = 0;
      lastQuant = null;
      pendingOperand = null;
      i += 1;
      continue;
    }
    const operand = pendingOperand;
    if ((ch === "*" || ch === "+") && operand) {
      chain = adjacentOverlapChain(chain, lastQuant, operand);
      if (chain > longest) longest = chain;
      lastQuant = { operand, atomsSince: 0 };
      pendingOperand = null;
      i += 1;
      if (pattern[i] === "?") i += 1; // non-greedy marker
      continue;
    }
    if (ch === "{") {
      let j = i + 1;
      while (j < pattern.length && /[\d,]/.test(pattern[j])) j += 1;
      const closed = pattern[j] === "}";
      const unbounded =
        closed && pattern.slice(i + 1, j).includes(",") && !/\d/.test(pattern.slice(i + 1, j).split(",")[1] ?? "");
      if (closed && unbounded && operand) {
        chain = adjacentOverlapChain(chain, lastQuant, operand);
        if (chain > longest) longest = chain;
        lastQuant = { operand, atomsSince: 0 };
      } else {
        // bounded {n}/{n,m} or a malformed { : a bounded quantifier breaks the
        // adjacency between two unbounded quantifiers (it can't partition a
        // span the way an unbounded one can).
        lastQuant = null;
      }
      pendingOperand = null;
      i = closed ? j + 1 : j;
      if (pattern[i] === "?") i += 1;
      continue;
    }
    if (ch === "*" || ch === "+" || ch === "?") {
      // quantifier with no scannable operand, or a bounded `?` — breaks adjacency
      lastQuant = null;
      pendingOperand = null;
      i += 1;
      if (pattern[i] === "?") i += 1;
      continue;
    }
    // ordinary literal char
    pendingOperand = { kind: "explicit", chars: new Set([ch]) };
    if (lastQuant) lastQuant.atomsSince += 1;
    i += 1;
  }
  if (chain > longest) longest = chain;
  return longest;
}

/** True iff `pattern` passes the safe-regex heuristics (no nested quantifiers,
 *  no imprecise alternation under a quantifier, no quantified backreference,
 *  no long chain of imprecise quantifiers). Conservative. */
export function isSafeRegex(pattern: string): boolean {
  if (starHeight(pattern) >= 2) return false;
  if (hasImpreciseAlternationUnderQuantifier(pattern)) return false;
  if (hasQuantifiedBackreference(pattern)) return false;
  if (polynomialQuantifierChain(pattern) >= IMPRECISE_CHAIN_MAX) return false;
  return true;
}
