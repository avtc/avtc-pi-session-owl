// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarensenkov@gmail.com>

import { describe, expect, it } from "vitest";
import { SELECTOR_SYSTEM } from "../../src/prompts/selector.js";

describe("SELECTOR_SYSTEM prompt", () => {
  it("is a non-empty string", () => {
    expect(typeof SELECTOR_SYSTEM).toBe("string");
    expect(SELECTOR_SYSTEM.length).toBeGreaterThan(0);
  });

  it("opens with the stakes framing the approved text carries", () => {
    expect(SELECTOR_SYSTEM.startsWith("You build the active-set")).toBe(true);
  });

  it("names the Selector tools (8 graph tools, no supersede/set_meta)", () => {
    for (const tool of ["ls", "cat", "find", "mkdir", "mv", "merge", "set_summary", "try_finish"]) {
      expect(SELECTOR_SYSTEM).toContain(tool);
    }
    // supersede / set_meta are Builder-only (excluded from the Selector toolset).
    expect(SELECTOR_SYSTEM).not.toContain("supersede");
    expect(SELECTOR_SYSTEM).not.toContain("set_meta");
  });

  it("includes the fs_* file-read tool mention (the actionable-tasks sentence)", () => {
    for (const tool of ["fs_read", "fs_grep", "fs_find", "fs_ls"]) {
      expect(SELECTOR_SYSTEM).toContain(tool);
    }
  });

  it("includes the drill-in line (decision #7)", () => {
    expect(SELECTOR_SYSTEM).toContain("Drill into any node to inspect its children and detail");
    expect(SELECTOR_SYSTEM).toContain("ls");
    expect(SELECTOR_SYSTEM).toContain("cat");
    expect(SELECTOR_SYSTEM).toContain("find");
  });

  // String-equality snapshot guard: the prompt is approved protected text from
  // the design doc. Any change must be a deliberate re-approval, not a drift.
  it("matches the approved text exactly (drift guard)", () => {
    expect(SELECTOR_SYSTEM).toBe(
      [
        "You build the active-set — the task-focused memory the agent continues its work from",
        "after a compaction. The active-set top level becomes the summary, so it must read",
        "clearly and fit the budget.",
        "",
        "Legend — the working tree uses these marks:",
        "📁 node · 📄 observation · crit high med low · 📦archived",
        "(no mark = active)",
        "The recent tail is tagged blocks: U user, A assistant, C tool-call, R tool-result,",
        "T thinking.",
        "",
        "You're given the working tree (the memory graph at its roots), the recent tail, the",
        "todo (in-progress + pending), and the files touched since the last compaction. Read",
        "them to grasp the current task; read the project files (`fs_read`/`fs_grep`/`fs_find`/`fs_ls`) to see the actionable tasks planned beyond the current one — the agent may reach several of them before the next compaction, so the active-set should ready it for those too.",
        "",
        "The tree is 📁 nodes (concept folders) holding 📄 observations and sub-nodes. `nGoal`",
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
        "- Condense verbose summaries (`set_summary`).",
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
        "- Promote — a decision (\"chose JWT for auth\") sits buried under an old branch, but the",
        "  current task is the auth migration: `mv` it to the top.",
        "- Set aside — a folder of early exploratory spikes has no bearing on the current task:",
        "  `mv` it into `nIrrelevant`.",
      ].join("\n"),
    );
  });
});
