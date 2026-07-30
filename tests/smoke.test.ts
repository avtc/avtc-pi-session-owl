// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import { describe, expect, it } from "vitest";

describe("memkeeper scaffold", () => {
  it("exposes the extension factory as a default export", async () => {
    const mod = await import("../src/index.ts");
    expect(typeof mod.default).toBe("function");
  });
});
