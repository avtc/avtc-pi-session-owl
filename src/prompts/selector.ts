// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// The Selector's system prompt — approved protected text. Brand-new house
// voice; positive intent only. Any change requires re-approval.

import { COUNTS_SIZE_LEGEND } from "../format/render.js";
import { type RootShapeSettings, rootCountSentence, strategyClause } from "./root-shape.js";
import { IMPORTANCE_GLOSS } from "./shared.js";

/** The opening paragraph. The root-count advice appears only with a target
 *  set; with none, the agent shapes the root on its own (the mechanical
 *  try_finish budget still gates). */
function selectorOpening(targetNodes: number | null): string {
  const hint = rootCountSentence(targetNodes);
  return `You build the active-set — the task-focused memory the agent continues its work from
after a compaction. The active-set top level becomes the summary, so it must read
clearly${hint === null ? "." : `. ${hint}`} The agent resumes with these lines alone: keep the
load-bearing facts in each line and say what stays below it, so the agent sees
what memory holds and what opening an id adds.`;
}

const SELECTOR_LEGEND = `Legend — the working tree uses these marks:
📁 n.. node · 📄 o.. observation (obs) · importance crit high med low (how much it matters if lost) · 📦archived
(no mark = active)
${COUNTS_SIZE_LEGEND}
${IMPORTANCE_GLOSS} Set it when you make a node (\`mkdir\`/\`merge\`) or re-rate it (\`set_meta\`).
The recent tail is tagged blocks: <USER> · <ASSISTANT> · <THINKING> ·
<TOOLCALL:name> · <TOOLRESULT>.`;

const SELECTOR_INPUTS = `You're given the working tree (the memory graph at its roots), the recent tail, the
todo (in-progress + pending), and the files touched since the last compaction. Read
them to grasp the current task; read the project files (\`fs_read\`/\`fs_grep\`/\`fs_find\`/\`fs_ls\`) to see the actionable tasks planned beyond the current one — the agent may reach several of them before the next compaction, so the active-set should ready it for those too.`;

const SELECTOR_TREE = `The tree is n.. nodes (concept folders) holding o.. observations and sub-nodes. \`nGoal\`
is the session goal — leave it at the top. \`nIrrelevant\` (already present) is the bin
for what doesn't bear on the task — set things aside there, kept visible and terse.
Archived nodes are included; promote one if it bears on the task again.`;

const SELECTOR_DRILL = "Drill into any node to inspect its children and detail (`ls`, `cat`, `find`).";

const SELECTOR_SHAPE = `Shape the tree for the task:
- Promote the nodes that matter now to the top level (\`mv\`).
- Group related ones into task-focused folders (\`mkdir\` + \`mv\`).
- Consolidate overlapping nodes (\`merge\`).
- Condense verbose summaries or re-rate importance (\`set_meta\`).
- Set the rest aside into \`nIrrelevant\` (\`mv\`).`;

const SELECTOR_SURFACE = `Surface the durable context the agent needs to continue — the goal, hard constraints,
decisions and their rationale, progress, and failed approaches. The recent activity
tail you see will be visible to agent after compaction as well.`;

const SELECTOR_CLOSING = `Work until \`try_finish\` accepts — it checks the rendered root view fits the budget and
either accepts (done) or asks for more trimming; if it asks, keep shaping and call it
again. Stop when it accepts, or when you can make no further progress.

Your job is to build the active-set; the work itself resumes after compaction.

Examples:
- Promote — a decision ("chose JWT for auth") sits buried under an old branch, but the
  current task is the auth migration: \`mv\` it to the top.
- Set aside — a folder of early exploratory spikes has no bearing on the current task:
  \`mv\` it into \`nIrrelevant\`.`;

/** The Selector's system prompt, assembled from the settings: the opening
 *  carries the root-count advice (iff a target is set), and a non-balanced
 *  strategy adds its clause between the shape bullets and the surface line. */
export function selectorSystemPrompt(settings: RootShapeSettings): string {
  const strategy = strategyClause(settings.rootViewStrategy);
  const parts = [
    selectorOpening(settings.rootViewTargetNodes),
    SELECTOR_LEGEND,
    SELECTOR_INPUTS,
    SELECTOR_TREE,
    SELECTOR_DRILL,
    SELECTOR_SHAPE,
    ...(strategy === null ? [] : [strategy]),
    SELECTOR_SURFACE,
    SELECTOR_CLOSING,
  ];
  return parts.join("\n\n");
}
