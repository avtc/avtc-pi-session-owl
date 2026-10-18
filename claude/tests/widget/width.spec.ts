// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// The width helpers' contract: ANSI-free measurement, grapheme clusters,
// wide-char double cells — the same numbers pi-tui yields for the strings
// the widget draws, and the band-surface predicate.
import { describe, expect, test } from "vitest";
import {
  hasBandSurface,
  hasFallbackSurface,
  stripAnsi,
  truncateToWidth,
  visibleWidth,
} from "../../host/widget/width.js";

describe("visibleWidth", () => {
  test("plain ASCII counts one cell per character", () => {
    expect(visibleWidth("hello")).toBe(5);
    expect(visibleWidth("")).toBe(0);
  });

  test("the owl and the arrow measure like pi-tui: emoji wide, arrow narrow", () => {
    expect(visibleWidth("🦉")).toBe(2);
    expect(visibleWidth("→")).toBe(1);
    expect(visibleWidth("🦉 x → y")).toBe(8); // 2+1+1+1+1+1+1
  });

  test("CJK counts two cells; combining marks ride their base", () => {
    expect(visibleWidth("中文")).toBe(4);
    expect(visibleWidth("e\u0301")).toBe(1); // e + combining acute = one cell
  });

  test("ANSI sequences are invisible (defensive — measurement is pre-theme)", () => {
    expect(visibleWidth("\x1b[31mred\x1b[0m")).toBe(3);
  });
});

describe("truncateToWidth", () => {
  test("under the width: untouched", () => {
    expect(truncateToWidth("abc", 10)).toBe("abc");
  });

  test("over the width: cut at a grapheme boundary with the ellipsis", () => {
    expect(truncateToWidth("abcdef", 4, "…")).toBe("abc…");
  });

  test("wide chars never split mid-cluster", () => {
    expect(truncateToWidth("🦉🦉🦉", 5, "…")).toBe("🦉🦉…"); // 2+2+1
  });

  test("zero budget: empty", () => {
    expect(truncateToWidth("abc", 0)).toBe("");
    expect(truncateToWidth("abc", -1)).toBe("");
  });

  test("ellipsis wider than the budget: ellipsis alone clips", () => {
    expect(truncateToWidth("abcdef", 1, "..")).toBe(".");
  });
});

describe("stripAnsi", () => {
  test("removes CSI sequences, keeps the text", () => {
    expect(stripAnsi("\x1b[1;32mx\x1b[0m")).toBe("x");
  });
});

describe("the band-surface predicate", () => {
  test("terminal and desktop raise the band; mobile/vscode do not", () => {
    expect(hasBandSurface(["terminal"])).toBe(true);
    expect(hasBandSurface(["desktop"])).toBe(true);
    expect(hasBandSurface(["terminal", "mobile"])).toBe(true);
    expect(hasBandSurface(["mobile"])).toBe(false);
    expect(hasBandSurface(["vscode"])).toBe(false);
    expect(hasBandSurface([])).toBe(false);
  });

  test("the fallback predicate: mobile and vscode, nothing else", () => {
    expect(hasFallbackSurface(["mobile"])).toBe(true);
    expect(hasFallbackSurface(["vscode"])).toBe(true);
    expect(hasFallbackSurface(["terminal"])).toBe(false);
    expect(hasFallbackSurface(["desktop"])).toBe(false);
    expect(hasFallbackSurface([])).toBe(false);
  });
});
