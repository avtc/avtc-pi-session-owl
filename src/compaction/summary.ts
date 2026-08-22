// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// renderSummary: the mechanical compaction-summary renderer. Produces the
// text Pi injects post-compaction — the agent's memory. Sections: a # Memory
// header + legend + mk_recall hint, the verbatim initial prompt, the active-set
// root one-liners (selected tree or observations root), and recently-touched
// files. Non-Builder viewer (a `new` node renders like active — no 🆕); obsolete roots excluded; never
// truncated (bounded by the Selector/Builder try_finish, not here).

import {
  directObsSizeHint,
  formatNodeLine,
  NON_BUILDER,
  RENDER_LEGEND,
  type RenderableNode,
  renderTreeTotal,
  type SizeHintObservation,
} from "../format/render.js";
import { orderedNonObsoleteRoots } from "../graph/read-tools.js";
import type { SerializedObservation, SerializedSelection } from "../store/codecs.js";
import { renderTouchedFiles, type TouchedFile } from "./touched-files.js";

/** Which tree the active-set renders. */
export type SummaryRenderMode = "selected-root" | "observations-root";

/** The structural graph shape renderSummary reads (source roots for
 *  observations-root mode + the selected-root null-tree fallback). */
export interface SummaryGraph {
  nodes: ReadonlyMap<string, RenderableNode>;
  /** Observations by id — the root one-liners' direct-obs size hints resolve
   *  here (both modes: the selected tree carries structure only, its observation
   *  ids belong to the source graph). Omitted when the caller has no access
   *  (no size segments then). */
  observations?: ReadonlyMap<string, SizeHintObservation>;
}

/** Inputs to renderSummary. */
export interface RenderSummaryArgs {
  /** The source graph (read for observations-root mode + selected-root fallback). */
  graph: SummaryGraph;
  /** The Selector's persisted selected tree (null = not built yet / failed). */
  selectedTree: SerializedSelection | null;
  /** The verbatim initial prompt observation (null = never captured). */
  oInitialPrompt: SerializedObservation | null;
  /** The active render mode. */
  renderMode: SummaryRenderMode;
  /** Recently-touched files (already extracted + deduped). */
  touchedFiles: readonly TouchedFile[];
  /** Compactions so far this session (the tree-total footer's maturity signal). */
  compactionCount: number;
}

const MEMORY_HEADING = "# Memory";
const PREAMBLE =
  "Your session memory — the top level of a tree; each id opens deeper detail via mk_recall. Before redoing or assuming something about earlier work, search memory for it — past decisions, approaches, and results live there.";
const LEGEND_PREFIX = "Legend: ";
const INITIAL_PROMPT_HEADING = "## Initial prompt";
const ACTIVE_SET_HEADING = "## Active set";
const NO_TOUCHED = 0;
const NO_TOUCHED_PLACEHOLDER = "(none)";

const TOUCHED_HEADING = "## Recently touched";
const NO_INITIAL_PROMPT = "(none captured yet)";
const NO_NODES = 0;

/** Stand-in observations map when the caller passes no observation access —
 *  direct-obs size lookups simply miss (no size segments). */
const EMPTY_OBSERVATIONS: ReadonlyMap<string, SizeHintObservation> = new Map();

/**
 * Render the compaction summary text. Mechanical, never truncated. The
 * active-set roots: selected-root mode renders the selected tree (falling back
 * to the source roots when no selected tree exists yet); observations-root mode
 * renders the source graph's non-obsolete roots. nGoal is always first.
 */
export function renderSummary(args: RenderSummaryArgs): string {
  const lines: string[] = [];
  lines.push(MEMORY_HEADING);
  lines.push(PREAMBLE);
  lines.push(`${LEGEND_PREFIX}${RENDER_LEGEND}`);
  lines.push("");

  lines.push(INITIAL_PROMPT_HEADING);
  lines.push(args.oInitialPrompt === null ? NO_INITIAL_PROMPT : args.oInitialPrompt.summary);
  lines.push("");

  lines.push(ACTIVE_SET_HEADING);
  const sizeHints = args.graph.observations ?? EMPTY_OBSERVATIONS;
  for (const root of activeSetRoots(args)) {
    lines.push(formatNodeLine(root, { viewer: NON_BUILDER, obsSize: directObsSizeHint(root, sizeHints) }));
  }
  // The tree-total footer: the scale of everything retained (the source graph,
  // incl. obsolete) behind this top level. Skipped when the tree is empty
  // (nothing to total).
  if (args.graph.nodes.size > NO_NODES) {
    lines.push(renderTreeTotal({ nodes: args.graph.nodes, observations: sizeHints }, args.compactionCount));
  }
  lines.push("");

  lines.push(TOUCHED_HEADING);
  if (args.touchedFiles.length === NO_TOUCHED) {
    lines.push(NO_TOUCHED_PLACEHOLDER);
  } else {
    for (const line of renderTouchedFiles(args.touchedFiles)) {
      lines.push(line);
    }
  }

  return lines.join("\n");
}

/** The root nodes to render in the active-set section, per renderMode. */
function activeSetRoots(args: RenderSummaryArgs): RenderableNode[] {
  if (args.renderMode === "selected-root" && args.selectedTree !== null) {
    return selectedRoots(args.selectedTree);
  }
  // observations-root mode, OR selected-root with no selected tree yet (fall
  // back to the source roots so the summary is never empty on the first run).
  return sourceRoots(args.graph);
}

/** Non-obsolete source roots, nGoal first then time (oldest first). */
function sourceRoots(graph: SummaryGraph): RenderableNode[] {
  // nGoal first, the rest by time (oldest first; nIrrelevant is source-absent).
  return orderedNonObsoleteRoots(graph.nodes.values());
}

/** Non-obsolete selected-tree roots, nGoal first, nIrrelevant last. */
function selectedRoots(tree: SerializedSelection): RenderableNode[] {
  // nGoal first, nIrrelevant last, the rest by time (oldest first).
  return orderedNonObsoleteRoots(tree.nodes);
}
