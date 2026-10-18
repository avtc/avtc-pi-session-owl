// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// The fs-adapter seam: guard constants, surrogate-safe slicing, and the
// in-memory adapter's platform-faithful semantics.
import { describe, expect, test } from "vitest";
import {
  byteLength,
  CAP,
  createMemoryFs,
  PART_SLICE,
  ROLL_MARGIN,
  sliceRangeSafe,
  sliceToByteParts,
} from "../../host/storage/fs-adapter.js";

describe("fs-adapter — byte length (the platform's size unit)", () => {
  test("ASCII 1 byte/char, latin 2, CJK 3, astral pairs 4", async () => {
    const { byteLength } = await import("../../host/storage/fs-adapter.js");
    expect(byteLength("abcd")).toBe(4);
    expect(byteLength("\u00e9")).toBe(2);
    expect(byteLength("\u4e2d")).toBe(3);
    expect(byteLength("\ud83d\ude00")).toBe(4);
    expect(byteLength("a\u4e2d\ud83d\ude00")).toBe(8);
  });
});

describe("fs-adapter — guards", () => {
  test("the guard constants hold the validated platform margins", () => {
    expect(CAP).toBe(4 * 1024 * 1024);
    expect(ROLL_MARGIN).toBe(3 * 1024 * 1024);
    expect(PART_SLICE).toBe(2_621_440);
    expect(ROLL_MARGIN).toBeLessThan(CAP);
    expect(PART_SLICE).toBeLessThan(ROLL_MARGIN);
  });
});

describe("fs-adapter — surrogate-safe slicing", () => {
  test("a cut inside a surrogate pair moves one code unit left", () => {
    const text = "ab😀cd"; // a,b,<surrogate pair>,c,d — length 6
    const sliced = sliceRangeSafe(text, 0, 3); // cuts between the pair's halves
    expect(sliced).toBe("ab");
    expect(Array.from(sliced).length).toBe(2);
  });

  test("a cut at a clean boundary stays exact", () => {
    const text = "ab😀cd";
    expect(sliceRangeSafe(text, 0, 2)).toBe("ab");
    expect(sliceRangeSafe(text, 0, 5)).toBe("ab😀c");
    expect(sliceRangeSafe(text, 0, 6)).toBe(text);
    expect(sliceRangeSafe(text, 0, 100)).toBe(text);
  });

  test("a cut at position 0 or 1 yields at most the empty string", () => {
    expect(sliceRangeSafe("😀x", 0, 1)).toBe("");
    expect(sliceRangeSafe("😀x", 0, 0)).toBe("");
  });
});

describe("fs-adapter — in-memory adapter semantics", () => {
  test("write replaces whole files; read throws ENOENT on missing", async () => {
    const mem = createMemoryFs();
    const fs = mem.adapter;
    await fs.writeText("/d/a.txt", "one");
    await fs.writeText("/d/a.txt", "two");
    expect(await fs.readText("/d/a.txt")).toBe("two");
    await expect(fs.readText("/d/missing.txt")).rejects.toThrow(/ENOENT/);
  });

  test("listDir names direct children only (files and dirs interleaved)", async () => {
    const mem = createMemoryFs();
    const fs = mem.adapter;
    await fs.writeText("/sess/m1-a.jsonl", "{}");
    await fs.writeText("/sess/m2-a.jsonl", "{}");
    await fs.writeText("/sess/sub/deep.txt", "{}");
    await fs.writeText("/other/x.txt", "{}");
    expect(await fs.listDir("/sess")).toEqual(["m1-a.jsonl", "m2-a.jsonl", "sub"]);
    expect(await fs.listDir("/never/touched")).toEqual([]);
  });

  test("stat reports sizes or null", async () => {
    const mem = createMemoryFs();
    const fs = mem.adapter;
    await fs.writeText("/d/a.txt", "hello");
    expect(await fs.stat("/d/a.txt")).toEqual({ size: 5 });
    expect(await fs.stat("/d/nope.txt")).toBeNull();
  });
});

describe("fs-adapter — sliceToByteParts (the shared byte-budget slicer)", () => {
  test("every part fits the byte budget; joining reproduces the text (CJK inflates over code units)", () => {
    const cjk = "\u6f22".repeat(2000); // 3 bytes/char: 6000 bytes over a 1024 budget
    const parts = sliceToByteParts(cjk, 1024);
    expect(parts.length).toBeGreaterThan(1);
    for (const p of parts) expect(byteLength(p)).toBeLessThanOrEqual(1024);
    expect(parts.join("")).toBe(cjk);
  });

  test("surrogate pairs never split mid-pair", () => {
    const emoji = "\ud83d\ude00".repeat(600); // surrogate pairs, 4 bytes each
    const parts = sliceToByteParts(emoji, 1000);
    const dangling = new RegExp(`[${String.fromCharCode(0xd800)}-${String.fromCharCode(0xdbff)}]$`);
    for (const p of parts) expect(dangling.test(p)).toBe(false);
    expect(parts.join("")).toBe(emoji);
  });

  test("an empty input yields one empty part; a fitting input yields one part", () => {
    expect(sliceToByteParts("", 512)).toEqual([""]);
    expect(sliceToByteParts("abc", 512)).toEqual(["abc"]);
  });
});
