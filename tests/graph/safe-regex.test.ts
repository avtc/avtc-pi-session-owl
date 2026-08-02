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

  it("rejects nested quantifiers inside a non-capturing/lookahead group (R1-1 bypass fix)", () => {
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
});
