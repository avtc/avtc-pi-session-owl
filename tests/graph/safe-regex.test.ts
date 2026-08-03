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

  it("rejects adjacent overlapping unbounded-quantifier runs (polynomial backtracking)", () => {
    // Two (or more) unbounded quantifiers that partition a common span cost
    // O(n^k) when a later part fails. EMPIRICALLY catastrophic: `a+a+a+b`
    // freezes V8 ~29s @1000 chars, `\w+\w+\w+b` ~20s @500. Literal-operand
    // quantifiers DO chain when their operand overlaps the prior one (`a+a+b`).
    expect(isSafeRegex("a+a+b")).toBe(false); // literal operands overlap (a,a)
    expect(isSafeRegex("a+a+a+b")).toBe(false); // 3 overlapping literal-operand quantifiers
    expect(isSafeRegex(".*.*b")).toBe(false); // 2 adjacent wildcard quantifiers
    expect(isSafeRegex("[a-z]+[a-z]+b")).toBe(false); // 2 overlapping class-quantifiers
    expect(isSafeRegex("\\w+\\w+\\w+")).toBe(false); // 3 adjacent shorthand-quantifiers (overlap)
    expect(isSafeRegex(".+.+.+")).toBe(false); // 3 adjacent wildcard quantifiers
  });

  it("does NOT over-reject disjoint or literal-separated quantifiers", () => {
    // A literal atom between two unbounded quantifiers fails fast and BREAKS the
    // partition, so these common search patterns stay safe even though they have
    // multiple quantifiers. Disjoint operands (`[0-9]+[a-z]+`) can't share a span.
    expect(isSafeRegex("foo.*bar")).toBe(true); // 1 unbounded
    expect(isSafeRegex(".*foo.*bar")).toBe(true); // 2 unbounded, literal `foo` between
    expect(isSafeRegex("a.*b.*c")).toBe(true); // 2 unbounded, literals between
    expect(isSafeRegex("a+b+a+")).toBe(true); // 2 unbounded, disjoint operands (a vs b)
    expect(isSafeRegex("[0-9]+[a-z]+[0-9]+")).toBe(true); // disjoint class-operand quantifiers
    expect(isSafeRegex(".*a.*a.*a.*b")).toBe(true); // literals `a` between the .* (fail fast)
    expect(isSafeRegex("\\d+\\s+\\d+")).toBe(true); // shorthand operands separated by literal-free fail
    expect(isSafeRegex("\\d+\\.\\d+")).toBe(true); // version-number search (disjoint: digit vs dot)
    expect(isSafeRegex("\\d+")).toBe(true); // 1 unbounded
    expect(isSafeRegex("^.*$")).toBe(true); // anchors reset the run
  });

  it("accumulates an adjacent-overlapping run across capturing-group boundaries", () => {
    // Capturing groups are transparent to a matching path: two adjacent
    // overlapping quantifiers split across `(`/`)` (`(.+)(.+)b`) are the same
    // polynomial shape as `.*.*b` and must be rejected. `(.+)(.+)b` is
    // EMPIRICALLY catastrophic (timed out >25s @2000).
    expect(isSafeRegex("(.+)(.+)b")).toBe(false); // 2 adjacent wildcards across groups
    expect(isSafeRegex("(.+)(.+)(.+)b")).toBe(false); // 3 adjacent wildcards across groups
    expect(isSafeRegex("([a-z]+)([a-z]+)b")).toBe(false); // 2 overlapping class-quantifiers across groups
    // a single quantifier (even in a group) is fine
    expect(isSafeRegex("(.+)foo")).toBe(true);
    expect(isSafeRegex("(foo)+")).toBe(true);
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
