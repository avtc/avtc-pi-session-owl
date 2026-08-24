// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import { describe, expect, it } from "vitest";
import { type RootShapeSettings, rootCountSentence, strategyClause } from "../../src/prompts/root-shape.js";

const shape = (over: Partial<RootShapeSettings>): RootShapeSettings => ({
  rootViewTargetNodes: null,
  rootViewStrategy: "balanced",
  ...over,
});

describe("rootCountSentence", () => {
  it("null target → no advice (the openings drop their lean/budget clause)", () => {
    expect(rootCountSentence(null)).toBeNull();
  });

  it("a target → the approved count-hint sentence", () => {
    expect(rootCountSentence(40)).toBe("Aim to have no more than 40 nodes at root level.");
    // singular grammar at N=1 (the schema floor)
    expect(rootCountSentence(1)).toBe("Aim to have no more than 1 node at root level.");
  });
});

describe("strategyClause", () => {
  it("balanced → no advice paragraph", () => {
    expect(strategyClause("balanced")).toBeNull();
  });

  it("carries the five approved clauses", () => {
    expect(strategyClause("by-task")).toBe(
      "Organize roots by task, in the order tasks occurred: one root per task (past, current, upcoming); merge only within a task; a completed task folds into one line.",
    );
    expect(strategyClause("by-category")).toBe(
      "Organize roots by category — group memory by the kind of thing it is. Base categories: user requests and intent, decisions and constraints, system and code understanding, work state and progress, pitfalls and dead ends, environment and commands; the list is open — add a category of its own when a distinct kind accumulates.",
    );
    expect(strategyClause("by-recency")).toBe(
      "Organize roots by recency: the newest material keeps fine-grained roots; as observations age, fold their roots into coarser ones. The recent past stays granular; the distant past compacts.",
    );
    expect(strategyClause("by-importance")).toBe(
      "Scale granularity with importance: crit and high items keep dedicated roots with rich lines; med and low items fold into coarse shared folders.",
    );
    expect(strategyClause("by-topic")).toBe("Organize roots by topic — the distinct subjects the session works on");
  });
});

describe("RootShapeSettings structural slice", () => {
  it("the DEFAULT_CONFIG-shaped object satisfies it (run inputs pass whole settings)", () => {
    const s: RootShapeSettings = shape({ rootViewTargetNodes: 20, rootViewStrategy: "by-topic" });
    expect(s.rootViewTargetNodes).toBe(20);
    expect(s.rootViewStrategy).toBe("by-topic");
  });
});
