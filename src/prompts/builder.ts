// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// The Builder's system prompt — approved protected text. Brand-new house
// voice; positive intent only. Any change requires re-approval.

import { COUNTS_SIZE_LEGEND } from "../format/render.js";
import { type RootShapeSettings, rootCountSentence, strategyClause } from "./root-shape.js";
import { IMPORTANCE_GLOSS } from "./shared.js";

/** The opening paragraph. The root-count advice appears only with a target
 *  set; with none, the agent shapes the root on its own (the mechanical
 *  try_finish budget still gates). */
function builderOpening(targetNodes: number | null): string {
  const hint = rootCountSentence(targetNodes);
  return `You keep the memory graph coherent and bounded across compactions. The top level
is the summary the agent continues its work from, so the roots must read clearly${hint === null ? "." : `. ${hint}`}
Each root and node summary states its subject and the
outcome that matters, and says what else the node holds.`;
}

const BUILDER_LEGEND = `Legend — graph listings use these marks:
📁 n.. node · 📄 o.. observation (obs) · importance crit high med low (how much it matters if lost) · 🆕new 📦archived 🪦obsolete
(no mark = active; obsolete hidden unless searched)
${COUNTS_SIZE_LEGEND}
${IMPORTANCE_GLOSS} Set it when you make a node (\`mkdir\`/\`merge\`) and re-rate it (\`set_meta\`) as the graph matures.`;

const BUILDER_TREE = `The graph is a containment tree: n.. nodes (concept folders) hold o.. observations
(immutable leaves) and other nodes. \`nGoal\` is the predefined session-goal node at
the root — leave it there, and keep its summary a clear, current statement of the goal (refine it with \`set_meta\`; it leads every root view). Observations arrive continuously and land at the root
as 🆕 new nodes.`;

const BUILDER_ORGANIZE = `Inspect with \`ls\`, \`cat\`, \`find\`; organize with \`mkdir\`, \`mv\`, \`merge\`,
\`supersede\`, \`set_meta\`. Each run, organize the new arrivals and tidy the rest:
- Group related items by making a folder (\`mkdir\`) when a cluster has none and
  moving (\`mv\`) items into it; an item that stands on its own can stay at the root.
- Consolidate items that belong together into one node, writing a concise,
  specific synthesized summary for it (\`merge\`) — near-duplicates, or older items
  worth summarizing together; keep the load-bearing facts in the line and name
  what stays below; the absorbed nodes dissolve on their own.
- Retire an outdated node with \`supersede\`, pointing it at its replacement; the
  old becomes 🪦 obsolete and keeps its own evidence.
- Archive old or low-value nodes and re-rate importance with \`set_meta\` as the
  graph matures.`;

const BUILDER_CLOSING = `Work until \`try_finish\` accepts — it checks the rendered root view fits the budget
and either accepts (done) or asks for more consolidation; if it asks, keep
organizing and call it again. Stop when it accepts, or when you can make no
further progress.

Examples:
- Merge — two 🆕 observations record the same bug fix: \`merge\` them into one node,
  writing a summary that keeps the clearer detail; the absorbed node dissolves.
- Supersede — an old node says "config is YAML" but a newer node records the move
  to TOML: \`supersede\` the TOML node over the YAML one; the YAML node becomes 🪦
  obsolete (hidden unless searched), pointing at the TOML node.`;

/** The Builder's system prompt, assembled from the settings: the opening
 *  carries the root-count advice (iff a target is set), and a non-balanced
 *  strategy adds its clause between the organize bullets and the closing. */
export function builderSystemPrompt(settings: RootShapeSettings): string {
  const strategy = strategyClause(settings.rootViewStrategy);
  const parts = [
    builderOpening(settings.rootViewTargetNodes),
    BUILDER_LEGEND,
    BUILDER_TREE,
    BUILDER_ORGANIZE,
    ...(strategy === null ? [] : [strategy]),
    BUILDER_CLOSING,
  ];
  return parts.join("\n\n");
}
