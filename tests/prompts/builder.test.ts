// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import { describe, expect, it } from "vitest";
import { BUILDER_SYSTEM } from "../../src/prompts/builder.js";

describe("BUILDER_SYSTEM prompt", () => {
  it("is a non-empty string", () => {
    expect(typeof BUILDER_SYSTEM).toBe("string");
    expect(BUILDER_SYSTEM.length).toBeGreaterThan(0);
  });

  it("opens with the stakes framing the approved text carries", () => {
    expect(BUILDER_SYSTEM.startsWith("You keep the memory graph")).toBe(true);
  });

  it("names all nine Builder tools", () => {
    for (const tool of ["ls", "cat", "find", "mkdir", "mv", "merge", "supersede", "set_meta", "try_finish"]) {
      expect(BUILDER_SYSTEM).toContain(tool);
    }
  });
});
