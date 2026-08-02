// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import { describe, expect, it } from "vitest";
import { formatCost, formatCount, formatDuration, formatTokens } from "../../src/format/tokens.js";

describe("formatTokens", () => {
  it("renders raw integers below 1000", () => {
    expect(formatTokens(245)).toBe("245");
    expect(formatTokens(0)).toBe("0");
    expect(formatTokens(999)).toBe("999");
  });

  it("renders sub-10k as k with one decimal", () => {
    expect(formatTokens(1200)).toBe("1.2k");
    expect(formatTokens(9800)).toBe("9.8k");
  });

  it("keeps the trailing .0 on sub-10k k values", () => {
    expect(formatTokens(8000)).toBe("8.0k");
    expect(formatTokens(1000)).toBe("1.0k");
  });

  it("rounds 10k up to 1M as k with no decimals", () => {
    expect(formatTokens(10000)).toBe("10k");
    expect(formatTokens(253000)).toBe("253k");
    expect(formatTokens(999999)).toBe("1000k");
  });

  it("renders sub-10M as M with one decimal", () => {
    expect(formatTokens(1_100_000)).toBe("1.1M");
    expect(formatTokens(7_600_000)).toBe("7.6M");
    expect(formatTokens(9_900_000)).toBe("9.9M");
  });

  it("rounds 10M up to 1B as M with no decimals", () => {
    expect(formatTokens(10_000_000)).toBe("10M");
    expect(formatTokens(156_000_000)).toBe("156M");
    expect(formatTokens(245_000_000)).toBe("245M");
  });

  it("renders sub-10B as B with one decimal", () => {
    expect(formatTokens(1_100_000_000)).toBe("1.1B");
    expect(formatTokens(7_600_000_000)).toBe("7.6B");
  });

  it("rounds 10B and above as B with no decimals", () => {
    expect(formatTokens(10_000_000_000)).toBe("10B");
    expect(formatTokens(12_000_000_000)).toBe("12B");
    expect(formatTokens(245_000_000_000)).toBe("245B");
  });

  it("hits the exact tier crossovers", () => {
    expect(formatTokens(9999)).toBe("10.0k");
    expect(formatTokens(1_000_000)).toBe("1.0M");
    expect(formatTokens(1_000_000_000)).toBe("1.0B");
    // the riskiest pair: just under 1M rounds up to 1000k; exactly 1M flips to M
    expect(formatTokens(999999)).toBe("1000k");
  });
});

describe("formatCost", () => {
  it("uses 4 decimals below $0.01", () => {
    expect(formatCost(0.0082)).toBe("$0.0082");
    expect(formatCost(0.0001)).toBe("$0.0001");
  });

  it("uses 3 decimals from $0.01 up to $1", () => {
    expect(formatCost(0.082)).toBe("$0.082");
    expect(formatCost(0.01)).toBe("$0.010");
    expect(formatCost(0.999)).toBe("$0.999");
  });

  it("uses 2 decimals at $1 and above", () => {
    expect(formatCost(1)).toBe("$1.00");
    expect(formatCost(1.23)).toBe("$1.23");
    expect(formatCost(12.345)).toBe("$12.35");
  });
});

describe("formatDuration", () => {
  it("renders sub-day durations as HH:MM:SS", () => {
    expect(formatDuration(0)).toBe("00:00:00");
    expect(formatDuration(90000)).toBe("00:01:30");
    expect(formatDuration(3_661_000)).toBe("01:01:01");
  });

  it("renders day-or-more durations as Nd HH:MM:SS", () => {
    expect(formatDuration(86_400_000)).toBe("1d 00:00:00");
    expect(formatDuration(90_000_000)).toBe("1d 01:00:00");
  });
});

describe("formatCount", () => {
  it("renders integers with thousands separators", () => {
    expect(formatCount(0)).toBe("0");
    expect(formatCount(245)).toBe("245");
    expect(formatCount(1245)).toBe("1,245");
    expect(formatCount(1_000_000)).toBe("1,000,000");
  });

  it("renders negatives with a leading sign and truncates fractions", () => {
    expect(formatCount(-1245)).toBe("-1,245");
    expect(formatCount(-12.9)).toBe("-12");
  });
});
