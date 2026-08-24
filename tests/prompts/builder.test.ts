// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import { describe, expect, it } from "vitest";
import { builderSystemPrompt } from "../../src/prompts/builder.js";
import { shapeSettings } from "./run-helpers.js";

const shape = shapeSettings;

describe("builderSystemPrompt", () => {
  it("opens with the stakes framing the approved text carries", () => {
    expect(builderSystemPrompt(shape({})).startsWith("You keep the memory graph")).toBe(true);
  });

  it("names all nine Builder tools", () => {
    const prompt = builderSystemPrompt(shape({}));
    for (const tool of ["ls", "cat", "find", "mkdir", "mv", "merge", "supersede", "set_meta", "try_finish"]) {
      expect(prompt).toContain(tool);
    }
  });

  // String-equality snapshot guard: the no-advice baseline (null target,
  // balanced strategy) is approved protected text. Any change must be a
  // deliberate re-approval, not a drift.
  it("matches the approved baseline exactly (null target + balanced, drift guard)", () => {
    expect(builderSystemPrompt(shape({}))).toBe(
      [
        "You keep the memory graph coherent and bounded across compactions. The top level",
        "is the summary the agent continues its work from, so the roots must read clearly.",
        "Each root and node summary states its subject and the",
        "outcome that matters, and says what else the node holds.",
        "",
        "Legend — graph listings use these marks:",
        "📁 n.. node · 📄 o.. observation (obs) · importance crit high med low (how much it matters if lost) · 🆕new 📦archived 🪦obsolete",
        "(no mark = active; obsolete hidden unless searched)",
        "2nodes 3obs (direct children) · 34lines 412tokens (direct children observations full details size)",
        "Importance is how much a node matters if lost: crit — a hard, persistent constraint or correction; high — a decision, choice, or unresolved blocker; med — meaningful context, not itself a decision or constraint; low — routine activity or minor detail. Set it when you make a node (`mkdir`/`merge`) and re-rate it (`set_meta`) as the graph matures.",
        "",
        "The graph is a containment tree: n.. nodes (concept folders) hold o.. observations",
        "(immutable leaves) and other nodes. `nGoal` is the predefined session-goal node at",
        "the root — leave it there, and keep its summary a clear, current statement of the goal (refine it with `set_meta`; it leads every root view). Observations arrive continuously and land at the root",
        "as 🆕 new nodes.",
        "",
        "Inspect with `ls`, `cat`, `find`; organize with `mkdir`, `mv`, `merge`,",
        "`supersede`, `set_meta`. Each run, organize the new arrivals and tidy the rest:",
        "- Group related items by making a folder (`mkdir`) when a cluster has none and",
        "  moving (`mv`) items into it; an item that stands on its own can stay at the root.",
        "- Consolidate items that belong together into one node, writing a concise,",
        "  specific synthesized summary for it (`merge`) — near-duplicates, or older items",
        "  worth summarizing together; keep the load-bearing facts in the line and name",
        "  what stays below; the absorbed nodes dissolve on their own.",
        "- Retire an outdated node with `supersede`, pointing it at its replacement; the",
        "  old becomes 🪦 obsolete and keeps its own evidence.",
        "- Archive old or low-value nodes and re-rate importance with `set_meta` as the",
        "  graph matures.",
        "",
        "Work until `try_finish` accepts — it checks the rendered root view fits the budget",
        "and either accepts (done) or asks for more consolidation; if it asks, keep",
        "organizing and call it again. Stop when it accepts, or when you can make no",
        "further progress.",
        "",
        "Examples:",
        "- Merge — two 🆕 observations record the same bug fix: `merge` them into one node,",
        "  writing a summary that keeps the clearer detail; the absorbed node dissolves.",
        '- Supersede — an old node says "config is YAML" but a newer node records the move',
        "  to TOML: `supersede` the TOML node over the YAML one; the YAML node becomes 🪦",
        "  obsolete (hidden unless searched), pointing at the TOML node.",
      ].join("\n"),
    );
  });

  it("no target → the lean/budget opening clause is dropped (agent shapes the root on its own)", () => {
    const prompt = builderSystemPrompt(shape({}));
    expect(prompt).not.toContain("stay within budget");
    expect(prompt).not.toContain("Aim to have no more than");
  });

  it("a target → the approved count-hint sentence follows the opening clause", () => {
    const prompt = builderSystemPrompt(shape({ rootViewTargetNodes: 40 }));
    expect(prompt).toContain("so the roots must read clearly. Aim to have no more than 40 nodes at root level.");
    expect(prompt).not.toContain("stay within budget");
  });

  it("balanced → no strategy paragraph", () => {
    expect(builderSystemPrompt(shape({}))).not.toContain("Organize roots by");
    expect(builderSystemPrompt(shape({}))).not.toContain("Scale granularity with");
  });

  it("a strategy → its clause sits between the organize bullets and try_finish", () => {
    const prompt = builderSystemPrompt(shape({ rootViewStrategy: "by-topic" }));
    const clause = "Organize roots by topic — the distinct subjects the session works on";
    const bullets = prompt.indexOf("  graph matures.");
    const at = prompt.indexOf(clause);
    const work = prompt.indexOf("Work until `try_finish` accepts");
    expect(at).toBeGreaterThan(bullets);
    expect(work).toBeGreaterThan(at);
  });
});
