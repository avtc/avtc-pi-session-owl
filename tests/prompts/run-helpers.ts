// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// Shared helper for the prompt assembly tests: an override-able RootShapeSettings
// seeded from DEFAULT_CONFIG (full run configs satisfy the slice structurally).

import { DEFAULT_CONFIG } from "../../src/config/schema.js";
import type { RootShapeSettings } from "../../src/prompts/root-shape.js";

export const shapeSettings = (over: Partial<RootShapeSettings>): RootShapeSettings => ({
  ...DEFAULT_CONFIG,
  ...over,
});
