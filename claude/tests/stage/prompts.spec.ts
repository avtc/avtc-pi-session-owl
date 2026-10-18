// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// The stage prompts' supply: the vendored prompt modules verbatim, with the
// RootShapeSettings slice defaulted to the core's DEFAULT_CONFIG values
// (spelled locally — config/schema.js bare-imports the settings library and
// cannot ride into the hooks closure; parity with the core defaults is
// pinned by the spec suite). The settings wiring passes the real
// slice; the defaults stand only when it does not.
import { describe, expect, test } from "vitest";
import { DEFAULT_CONFIG } from "../../core/src/config/schema.js";
import { builderSystemPrompt } from "../../core/src/prompts/builder.js";
import { OBSERVER_SYSTEM } from "../../core/src/prompts/observer.js";
import { selectorSystemPrompt } from "../../core/src/prompts/selector.js";
import { defaultRootShapeSettings, getStagePrompts } from "../../host/stage/prompts.js";

describe("stage prompts supply", () => {
  test("the local defaults equal the core's DEFAULT_CONFIG slice", () => {
    expect(defaultRootShapeSettings()).toEqual({
      rootViewTargetNodes: DEFAULT_CONFIG.rootViewTargetNodes,
      rootViewStrategy: DEFAULT_CONFIG.rootViewStrategy,
    });
  });

  test("getStagePrompts returns the vendored prompts (defaults; override)", () => {
    const defaults = getStagePrompts();
    expect(defaults.observerPrompt).toBe(OBSERVER_SYSTEM);
    expect(defaults.builderPrompt).toBe(builderSystemPrompt(defaultRootShapeSettings()));
    expect(defaults.selectorPrompt).toBe(selectorSystemPrompt(defaultRootShapeSettings()));
    const target = { rootViewTargetNodes: 5, rootViewStrategy: "by-task" as const };
    const overridden = getStagePrompts(target);
    expect(overridden.builderPrompt).toBe(builderSystemPrompt(target));
    expect(overridden.builderPrompt).not.toBe(defaults.builderPrompt);
  });
});
