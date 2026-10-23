// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// Pins the tracked-temp-dir contract the whole suite sits on: tempDir hands
// out a real dir under the requested prefix, and one sweep drains the pool.
// The per-file afterAll registration lives in tests/setup.ts (same pool per
// worker); this spec only pins the seam itself.

import { existsSync } from "node:fs";
import { basename } from "node:path";
import { describe, expect, it } from "vitest";
import { sweepTempDirs, tempDir } from "./temp-dir.js";

describe("tempDir", () => {
  it("hands out existing dirs under the requested prefix; the sweep removes them all", () => {
    const first = tempDir("owl-tempdir-self");
    const second = tempDir("owl-tempdir-self");
    expect(existsSync(first)).toBe(true);
    expect(existsSync(second)).toBe(true);
    expect(basename(first).startsWith("owl-tempdir-self-")).toBe(true);
    sweepTempDirs();
    expect(existsSync(first)).toBe(false);
    expect(existsSync(second)).toBe(false);
  });

  it("sweeping an empty pool is a no-op", () => {
    expect(() => sweepTempDirs()).not.toThrow();
  });
});
