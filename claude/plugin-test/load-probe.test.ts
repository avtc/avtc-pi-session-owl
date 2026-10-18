// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>
//
// Load probe: the hooks entry's FULL import closure under the engine loader.
// The kit loads test files with the same loader as real hooks modules, so
// importing register.ts here answers the only question that matters at
// runtime: does the closure resolve at all?

import { describe, expect, test } from "claude-code/testing";
import * as registerModule from "../hooks/register.js";

describe("hooks entry closure", () => {
  test("register.ts loads and exports register", () => {
    expect(typeof (registerModule as { register?: unknown }).register).toBe("function");
  });
});
