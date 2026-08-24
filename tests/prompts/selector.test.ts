// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../../src/config/schema.js";
import { builderSystemPrompt } from "../../src/prompts/builder.js";
import type { RootShapeSettings } from "../../src/prompts/root-shape.js";
import { selectorSystemPrompt } from "../../src/prompts/selector.js";

const shape = (over: Partial<RootShapeSettings>): RootShapeSettings => ({ ...DEFAULT_CONFIG, ...over });

describe("selectorSystemPrompt", () => {
  it("opens with the stakes framing the approved text carries", () => {
    expect(selectorSystemPrompt(shape({})).startsWith("You build the active-set")).toBe(true);
  });

  it("names the Selector tools (8 graph tools, no supersede)", () => {
    const prompt = selectorSystemPrompt(shape({}));
    for (const tool of ["ls", "cat", "find", "mkdir", "mv", "merge", "set_meta", "try_finish"]) {
      expect(prompt).toContain(tool);
    }
    // supersede is Builder-only (excluded from the Selector toolset). The
    // Selector's set_meta edits importance + summary only (no archived/obsolete).
    expect(prompt).not.toContain("supersede");
  });

  it("includes the fs_* file-read tool mention (the actionable-tasks sentence)", () => {
    const prompt = selectorSystemPrompt(shape({}));
    for (const tool of ["fs_read", "fs_grep", "fs_find", "fs_ls"]) {
      expect(prompt).toContain(tool);
    }
  });

  it("includes the drill-in line", () => {
    const prompt = selectorSystemPrompt(shape({}));
    expect(prompt).toContain("Drill into any node to inspect its children and detail");
    expect(prompt).toContain("ls");
    expect(prompt).toContain("cat");
    expect(prompt).toContain("find");
  });

  // String-equality snapshot guard: the no-advice baseline (null target,
  // balanced strategy) is approved protected text. Any change must be a
  // deliberate re-approval, not a drift.
  it("matches the approved baseline exactly (null target + balanced, drift guard)", () => {
    expect(selectorSystemPrompt(shape({}))).toBe(
      [
        "You build the active-set — the task-focused memory the agent continues its work from",
        "after a compaction. The active-set top level becomes the summary, so it must read",
        "clearly. The agent resumes with these lines alone: keep the",
        "load-bearing facts in each line and say what stays below it, so the agent sees",
        "what memory holds and what opening an id adds.",
        "",
        "Legend — the working tree uses these marks:",
        "📁 n.. node · 📄 o.. observation (obs) · importance crit high med low (how much it matters if lost) · 📦archived",
        "(no mark = active)",
        "2nodes 3obs (direct children) · 34lines 412tokens (direct children observations full details size)",
        "Importance is how much a node matters if lost: crit — a hard, persistent constraint or correction; high — a decision, choice, or unresolved blocker; med — meaningful context, not itself a decision or constraint; low — routine activity or minor detail. Set it when you make a node (`mkdir`/`merge`) or re-rate it (`set_meta`).",
        "The recent tail is tagged blocks: <USER> · <ASSISTANT> · <THINKING> ·",
        "<TOOLCALL:name> · <TOOLRESULT>.",
        "",
        "You're given the working tree (the memory graph at its roots), the recent tail, the",
        "todo (in-progress + pending), and the files touched since the last compaction. Read",
        "them to grasp the current task; read the project files (`fs_read`/`fs_grep`/`fs_find`/`fs_ls`) to see the actionable tasks planned beyond the current one — the agent may reach several of them before the next compaction, so the active-set should ready it for those too.",
        "",
        "The tree is n.. nodes (concept folders) holding o.. observations and sub-nodes. `nGoal`",
        "is the session goal — leave it at the top. `nIrrelevant` (already present) is the bin",
        "for what doesn't bear on the task — set things aside there, kept visible and terse.",
        "Archived nodes are included; promote one if it bears on the task again.",
        "",
        "Drill into any node to inspect its children and detail (`ls`, `cat`, `find`).",
        "",
        "Shape the tree for the task:",
        "- Promote the nodes that matter now to the top level (`mv`).",
        "- Group related ones into task-focused folders (`mkdir` + `mv`).",
        "- Consolidate overlapping nodes (`merge`).",
        "- Condense verbose summaries or re-rate importance (`set_meta`).",
        "- Set the rest aside into `nIrrelevant` (`mv`).",
        "",
        "Surface the durable context the agent needs to continue — the goal, hard constraints,",
        "decisions and their rationale, progress, and failed approaches. The recent activity",
        "tail you see will be visible to agent after compaction as well.",
        "",
        "Work until `try_finish` accepts — it checks the rendered root view fits the budget and",
        "either accepts (done) or asks for more trimming; if it asks, keep shaping and call it",
        "again. Stop when it accepts, or when you can make no further progress.",
        "",
        "Your job is to build the active-set; the work itself resumes after compaction.",
        "",
        "Examples:",
        '- Promote — a decision ("chose JWT for auth") sits buried under an old branch, but the',
        "  current task is the auth migration: `mv` it to the top.",
        "- Set aside — a folder of early exploratory spikes has no bearing on the current task:",
        "  `mv` it into `nIrrelevant`.",
      ].join("\n"),
    );
  });

  it("no target → the lean/budget opening clause is dropped (agent shapes the root on its own)", () => {
    const prompt = selectorSystemPrompt(shape({}));
    expect(prompt).not.toContain("and fit the budget");
    expect(prompt).not.toContain("Aim to have no more than");
  });

  it("a target → the approved count-hint sentence follows the opening clause", () => {
    const prompt = selectorSystemPrompt(shape({ rootViewTargetNodes: 40 }));
    expect(prompt).toContain("clearly. Aim to have no more than 40 nodes at root level. The agent resumes");
    expect(prompt).not.toContain("and fit the budget");
  });

  it("balanced → no strategy paragraph", () => {
    expect(selectorSystemPrompt(shape({}))).not.toContain("Organize roots by");
    expect(selectorSystemPrompt(shape({}))).not.toContain("Scale granularity with");
  });

  it("a strategy → its clause sits between the shape bullets and Surface", () => {
    const prompt = selectorSystemPrompt(shape({ rootViewStrategy: "by-category" }));
    const clause = "Organize roots by category — group memory by the kind of thing it is.";
    const bullets = prompt.indexOf("- Set the rest aside into `nIrrelevant` (`mv`).");
    const at = prompt.indexOf(clause);
    const surface = prompt.indexOf("Surface the durable context");
    expect(at).toBeGreaterThan(bullets);
    expect(surface).toBeGreaterThan(at);
  });

  it("builder and selector share the same strategy clause and count hint (one source)", () => {
    const builder = builderSystemPrompt(shape({ rootViewTargetNodes: 80, rootViewStrategy: "by-recency" }));
    const selector = selectorSystemPrompt(shape({ rootViewTargetNodes: 80, rootViewStrategy: "by-recency" }));
    expect(selector).toContain("Aim to have no more than 80 nodes at root level.");
    for (const p of [builder, selector]) {
      expect(p).toContain(
        "Organize roots by recency: the newest material keeps fine-grained roots; as observations age, fold their roots into coarser ones. The recent past stays granular; the distant past compacts.",
      );
    }
  });
});
