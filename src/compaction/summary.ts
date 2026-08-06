// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// renderSummary: the mechanical compaction-summary renderer. Produces the
// text Pi injects post-compaction — the agent's memory. Sections: a # Memory
// header + legend + mk_recall hint, the verbatim initial prompt, the active-set
// root one-liners (selected tree or observations root), and recently-touched
// files. Non-Builder viewer (new→active, no 🆕); obsolete roots excluded; never
// truncated (bounded by the Selector/Builder try_finish, not here).

import { formatNodeLine, NON_BUILDER, RENDER_LEGEND, type RenderableNode } from "../format/render.js";
import { orderedNonObsoleteRoots } from "../graph/read-tools.js";
import type { SerializedObservation, SerializedSelection } from "../store/codecs.js";
import { renderTouchedFiles, type TouchedFile } from "./touched-files.js";

/** Which tree the active-set renders. */
export type SummaryRenderMode = "selected-root" | "observations-root";

/** The structural graph shape renderSummary reads (source roots for
 *  observations-root mode + the selected-root null-tree fallback). */
export interface SummaryGraph {
  nodes: ReadonlyMap<string, RenderableNode>;
  /** Observation content by id (used to render a bare `new` node's first obs
   *  line in observations-root mode). Omitted when the caller has no access. */
  observations?: ReadonlyMap<string, { readonly summary: string }>;
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
}

const MEMORY_HEADING = "# Memory";
const PREAMBLE = "Your session memory. Each item cites an id — use mk_recall for detail.";
const LEGEND_PREFIX = "Legend: ";
const INITIAL_PROMPT_HEADING = "## Initial prompt";
const ACTIVE_SET_HEADING = "## Active set";
const NO_TOUCHED = 0;
const NO_TOUCHED_PLACEHOLDER = "(none)";

const TOUCHED_HEADING = "## Recently touched";
const NO_INITIAL_PROMPT = "(none captured yet)";
const EMPTY_OBS_MAP: ReadonlyMap<string, { readonly summary: string }> = new Map();

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
  // resolve a bare `new` node's first-observation line. Observations are
  // immutable + shared (the selected tree carries only obs-id refs), so the
  // source graph's observation store is authoritative in both modes.
  const obsContent = args.graph.observations ?? EMPTY_OBS_MAP;
  const resolveObs = (id: string): string | undefined => obsContent.get(id)?.summary;
  for (const root of activeSetRoots(args)) {
    lines.push(formatNodeLine(root, { viewer: NON_BUILDER, observationContent: resolveObs }));
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

/** Non-obsolete source roots, nGoal first then importance/recency. */
function sourceRoots(graph: SummaryGraph): RenderableNode[] {
  // nGoal first, the rest by importance/recency (nIrrelevant is source-absent).
  return orderedNonObsoleteRoots(graph.nodes.values());
}

/** Non-obsolete selected-tree roots, nGoal first, nIrrelevant last. */
function selectedRoots(tree: SerializedSelection): RenderableNode[] {
  // nGoal first, nIrrelevant last, the rest by importance/recency.
  return orderedNonObsoleteRoots(tree.nodes);
}
