// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// Stub-guard: verifies the T7 no-op onTurnEnd contract. T9 replaces the stub with
// the real trigger evaluation and replaces this test with the real suite.

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import type { MemkeeperConfig } from "../src/config/schema.js";
import { onTurnEnd } from "../src/triggers.js";

describe("onTurnEnd stub (T7; T9 replaces)", () => {
  it("is a no-op that does not throw", () => {
    expect(() =>
      onTurnEnd({ ctx: {} as unknown as ExtensionContext, settings: {} as unknown as MemkeeperConfig }),
    ).not.toThrow();
  });
});
