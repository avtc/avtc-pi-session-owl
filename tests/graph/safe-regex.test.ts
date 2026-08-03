// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import { describe, expect, it } from "vitest";
import { isSafeRegex } from "../../src/graph/safe-regex.js";

describe("isSafeRegex", () => {
  it("accepts ordinary patterns (literals, classes, simple quantifiers)", () => {
    expect(isSafeRegex("jwt")).toBe(true);
    expect(isSafeRegex("Chose.*JWT")).toBe(true);
    expect(isSafeRegex("[Jj]wt|auth")).toBe(true);
    expect(isSafeRegex("\\bconfig\\b")).toBe(true);
    expect(isSafeRegex("a+b*c?")).toBe(true);
    expect(isSafeRegex("(foo|bar)")).toBe(true);
    expect(isSafeRegex("2026-07-\\d{2}")).toBe(true);
  });

  it("accepts a quantified group whose body has NO inner quantifier (no nesting)", () => {
    expect(isSafeRegex("(abc)+")).toBe(true);
    expect(isSafeRegex("(foo)*")).toBe(true);
  });

  it("rejects nested quantifiers — the classic exponential-backtracking shape", () => {
    expect(isSafeRegex("(a+)+")).toBe(false);
    expect(isSafeRegex("(a*)*")).toBe(false);
    expect(isSafeRegex("(a+)*")).toBe(false);
    expect(isSafeRegex("(a*)+")).toBe(false);
    expect(isSafeRegex("(\\d+)+")).toBe(false);
  });

  it("rejects nested quantifiers inside a non-capturing/lookahead group", () => {
    expect(isSafeRegex("(?:a+)+")).toBe(false);
    expect(isSafeRegex("(?:a*)*")).toBe(false);
    expect(isSafeRegex("(?:a+)*")).toBe(false);
    expect(isSafeRegex("(?=a+)+")).toBe(false);
    expect(isSafeRegex("(?!a*)*+")).toBe(false);
  });

  it("rejects nested quantifiers inside lookbehind, named, and flag groups", () => {
    expect(isSafeRegex("(?<=a+)+")).toBe(false);
    expect(isSafeRegex("(?<!a*)*+")).toBe(false);
    expect(isSafeRegex("(?<x>a+)+")).toBe(false);
    expect(isSafeRegex("(?<name>a*)*+")).toBe(false);
    expect(isSafeRegex("(?i:a+)+")).toBe(false);
  });

  it("accepts safe lookbehind/named/flag groups under a quantifier", () => {
    expect(isSafeRegex("(?<=ab)cd")).toBe(true);
    expect(isSafeRegex("(?<x>ab)+")).toBe(true);
    expect(isSafeRegex("(?i:ab)+")).toBe(true);
    expect(isSafeRegex("(?<word>foo|bar)*")).toBe(true);
  });

  it("rejects overlapping alternation under a quantifier", () => {
    expect(isSafeRegex("(a|a)+")).toBe(false);
    expect(isSafeRegex("(a|ab)*")).toBe(false);
    expect(isSafeRegex("(.*a){10}")).toBe(false);
  });

  it("rejects overlapping alternation inside a non-capturing group", () => {
    expect(isSafeRegex("(?:a|a)+")).toBe(false);
    expect(isSafeRegex("(?:a|ab)*")).toBe(false);
  });

  it("rejects overlapping alternation nested one group deep under a quantifier", () => {
    // wrapping the evil alternation in one extra group hid it from the old
    // top-level-only check
    expect(isSafeRegex("((a|a))+")).toBe(false);
    expect(isSafeRegex("((a|ab))+")).toBe(false);
    expect(isSafeRegex("((?:a|a))+")).toBe(false);
    expect(isSafeRegex("((a?))+")).toBe(false);
    expect(isSafeRegex("((.+a))+")).toBe(false);
  });

  it("rejects an imprecise alternation nested under a plain (non-capturing-free) quantified group", () => {
    // the inner (a|a)+ is itself quantified but sits inside a non-quantified
    // outer group — the old scanner skipped past the outer group's contents
    expect(isSafeRegex("((a|a)+)")).toBe(false);
    expect(isSafeRegex("((a|ab)+)x")).toBe(false);
    expect(isSafeRegex("x((?:a|a)*)y")).toBe(false);
  });

  it("rejects a non-overlapping alternation that becomes overlapping via a nullable branch, nested", () => {
    expect(isSafeRegex("((a|))+")).toBe(false); // nullable branch under quantifier
  });

  it("accepts a quantified group with a SAFE nested alternation (no false positive)", () => {
    // distinct first chars — no ambiguity even though nested + repeated
    expect(isSafeRegex("((a|b)(c|d))+")).toBe(true);
    expect(isSafeRegex("((foo|bar))+")).toBe(true);
    expect(isSafeRegex("((ab|cd))+")).toBe(true);
  });

  it("rejects overlapping alternation where a branch starts with a wildcard/class", () => {
    // firstLiteralChar returned null for . / [..] / \d / \w so these evaded the
    // literal-overlap check, yet each is catastrophic backtracking.
    expect(isSafeRegex("(a|.)+")).toBe(false); // . overlaps a
    expect(isSafeRegex("(a|\\w)+")).toBe(false); // \w overlaps a
    expect(isSafeRegex("(\\d|[0-9])+")).toBe(false); // \d overlaps [0-9]
    expect(isSafeRegex("([a-z]|[a-m])+")).toBe(false); // [a-m] subset of [a-z]
    expect(isSafeRegex("(.|a)+")).toBe(false); // order reversed
    expect(isSafeRegex("(\\w|\\d)+")).toBe(false); // \w overlaps \d (both match digits)
  });

  it("does NOT over-reject a class branch whose first chars are disjoint from the other branch", () => {
    // safe alternations — no overlap between the branches' first chars
    expect(isSafeRegex("(apple|\\d)+")).toBe(true); // 'a' vs digit — disjoint
    expect(isSafeRegex("(yes|no)+")).toBe(true); // distinct literals
    expect(isSafeRegex("([a-z]|\\d)+")).toBe(true); // letters vs digits — disjoint
  });

  it("accepts a safe non-capturing group under a quantifier", () => {
    expect(isSafeRegex("(?:ab)+")).toBe(true);
    expect(isSafeRegex("(?:foo|bar)*")).toBe(true);
    expect(isSafeRegex("(?i)abc")).toBe(true);
  });

  it("treats a safe pattern as safe regardless of flags (flags are caller's concern)", () => {
    expect(isSafeRegex("hello")).toBe(true);
  });

  it("rejects a quantified backreference (a distinct ReDoS shape the star-height/alternation checks miss)", () => {
    expect(isSafeRegex("(a+)\\1+")).toBe(false);
    expect(isSafeRegex("(a*)\\1*")).toBe(false);
    expect(isSafeRegex("(ab)\\1{3}")).toBe(false);
  });

  it("accepts a safe (non-quantified) backreference", () => {
    expect(isSafeRegex("(foo)\\1")).toBe(true);
    expect(isSafeRegex("(a|b)\\1bar")).toBe(true);
  });

  it("rejects a chain of imprecise quantifiers (polynomial backtracking)", () => {
    // k imprecise quantifiers in one path cost O(n^k); these hang V8 on
    // realistic content lengths even though star-height is only 1.
    expect(isSafeRegex(".*a.*a.*a.*b")).toBe(false); // 4 wildcard quantifiers
    expect(isSafeRegex("\\d+\\s+\\d+")).toBe(false); // 3 shorthand quantifiers
    expect(isSafeRegex("[0-9]+[a-z]+[0-9]+")).toBe(false); // 3 class quantifiers
    expect(isSafeRegex("\\w+\\w+\\w+")).toBe(false); // 3 shorthand quantifiers
    expect(isSafeRegex(".+.+.+")).toBe(false); // 3 wildcard quantifiers
  });

  it("does NOT over-reject a short imprecise chain or precise quantifiers", () => {
    expect(isSafeRegex("a+a+a+")).toBe(true); // literal-operand quantifiers (bounded)
    expect(isSafeRegex("foo.*bar")).toBe(true); // 1 imprecise
    expect(isSafeRegex(".*foo.*bar")).toBe(true); // 2 imprecise
    expect(isSafeRegex("a.*b.*c")).toBe(true); // 2 imprecise
    expect(isSafeRegex("\\d+")).toBe(true); // 1 imprecise
    expect(isSafeRegex("^.*$")).toBe(true); // anchors reset the chain
  });

  it("rejects a polynomial chain split across capturing groups (boundary bypass)", () => {
    // Capturing groups are transparent to a matching path: each group holds one
    // imprecise quantifier and the groups are sequential, so the chain must
    // accumulate across the `(`/`)` boundaries. `(.+a)(.+a)(.+a)b` takes ~1s at
    // 400 chars and ~29s at 800 — catastrophic if it slips through.
    expect(isSafeRegex("(.+a)(.+a)(.+a)b")).toBe(false);
    expect(isSafeRegex("(.*a)(.*a)(.*a)b")).toBe(false);
    expect(isSafeRegex("(.+)(.+)(.+)")).toBe(false);
    // k=2 across groups stays safe (consistent with the ungrouped >=3 policy)
    expect(isSafeRegex("(.+a)(.+a)b")).toBe(true);
  });

  it("rejects overlapping alternation with a complement (negated) class branch", () => {
    // complement CharClasses (\D/\W/\S/[^…]) are load-bearing overlap
    // detectors; a regression would silently let evil patterns through.
    expect(isSafeRegex("(\\D|\\W)+")).toBe(false); // complement-vs-complement (universal overlap)
    expect(isSafeRegex("(a|\\D)+")).toBe(false); // explicit-vs-complement
    expect(isSafeRegex("(\\D|a)+")).toBe(false); // reversed complement-vs-explicit
    expect(isSafeRegex("([a-z]|[^0-9])+")).toBe(false); // letters overlap a negated-digit set
  });

  it("does NOT over-reject a complement branch disjoint from the other", () => {
    // [0-9] and [^0-9] are complementary (no char matches both) → no ambiguity
    expect(isSafeRegex("([0-9]|[^0-9])+")).toBe(true);
  });
});
