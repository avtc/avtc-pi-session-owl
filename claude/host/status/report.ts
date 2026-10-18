// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

//  /owl:status — the pure report builder, a host-side verbatim port of
// src/status/command.ts's pure half (pi's module imports notify + pi host
// state, so it is not vendored; the output text is pinned fixture-identical
// in the test). The paused report lives in the conflicts module (the ported
// wording — approval-owed there); this module serves it FIRST when the
// pause is active (pi's paused-first ordering), else gathers StatusInput
// from the port state and notifies through the commands' notify adapter.
import { BUILDER, NON_BUILDER, treeLevels } from "../../core/src/format/render.js";
import { formatCost, formatCount, formatDuration, formatTokens } from "../../core/src/format/tokens.js";
import { nonObsoleteRootsOf, renderRootViewFromRoots } from "../../core/src/graph/read-tools.js";
import { sinceLastCompaction, sinceSessionStart } from "../../core/src/status/usage-ledger.js";
import {
  cloneLedger,
  decodeNode,
  EMPTY_LEDGER,
  type SerializedNode,
  type UsageLedger,
} from "../../core/src/store/codecs.js";
import { estimateContentTokens, type Node, type Observation } from "../../core/src/types.js";
import { buildPausedStatusReport, isConflictPaused } from "../conflicts/pause.js";

/** The data sources /owl:status reads, as plain values (pi's StatusInput
 *  verbatim — testable without the host). */
export interface StatusInput {
  enabled: boolean;
  settings: {
    renderMode: "selected-root" | "observations-root";
    builderRootViewThreshold: number;
    selectorRootViewThreshold: number;
  };
  /** The first entry's timestamp on the active branch (ms since epoch). */
  sessionStartMs: number;
  /** Compaction entries on the active branch. */
  compactionCount: number;
  nodes: Node[];
  observations: Pick<Observation, "summaryTokens" | "detailsTokens" | "detailsLines">[];
  /** Max tree depth in levels (roots = 1) — the tree-total footer's count. */
  levels: number;
  /** Non-obsolete root count — the exact root set the Builder view renders. */
  rootsCount: number;
  /** The non-obsolete root-view tokens (chars/4 of the rendered root view). */
  rootsViewTokens: number;
  /** The persisted selected tree's root count + view tokens, or null when
   *  there is no selected tree / renderMode is observations-root. */
  selectedView: { rootsCount: number; viewTokens: number } | null;
  usageLedger: UsageLedger;
  /** The last-compaction ledger baseline (null until the first compaction). */
  lastCompactionLedger: UsageLedger | null;
}

const PHASES = ["observe", "build", "select"] as const;
const PHASE_LABEL_WIDTH = 7; // "observe" is the longest phase label
const REPORT_HEADER = "🦉 session-owl — status";
const DISABLED_MESSAGE = "session-owl is disabled.";

/** Build the multi-line status report (pure — pi's builder verbatim).
 *  Mirrors the pi footer token format shared with the widget. */
export function buildStatusReport(input: StatusInput): string {
  if (!input.enabled) return DISABLED_MESSAGE;

  const lines: string[] = [REPORT_HEADER, ""];

  // --- Session line ---
  const durationMs = Date.now() - input.sessionStartMs;
  lines.push(
    `Session  ${formatDuration(durationMs)} · ${formatCount(input.compactionCount)} compaction${input.compactionCount === 1 ? "" : "s"}`,
  );

  // --- Memory section (labels padded into one column; Observations/Nodes
  //  counts right-aligned so the two count columns line up; style mirrors
  //  the root-view tree-total footer — plain counts, · separators) ---
  const obsCount = input.observations.length;
  const nodeCount = input.nodes.length;
  const rawTokens = sum(input.observations, (o) => o.detailsTokens ?? 0); // verbatim source size
  const rawLines = sum(input.observations, (o) => o.detailsLines ?? 0);
  const summarizedTokens = sum(input.observations, (o) => o.summaryTokens) + sum(input.nodes, (n) => n.summaryTokens); // node + obs summaries
  const LABEL_WIDTH = 14; // "Selector roots" is the longest label
  const obsCountStr = String(obsCount);
  const nodeCountStr = String(nodeCount);
  const countWidth = Math.max(obsCountStr.length, nodeCountStr.length);
  lines.push("", "Memory");
  lines.push(`  ${"Observations".padStart(LABEL_WIDTH)}  ${obsCountStr.padStart(countWidth)}`);
  lines.push(
    `  ${"Nodes".padStart(LABEL_WIDTH)}  ${nodeCountStr.padStart(countWidth)} (${input.levels} level${input.levels === 1 ? "" : "s"})`,
  );
  lines.push(`  ${"Details".padStart(LABEL_WIDTH)}  ${formatTokens(rawTokens)} tokens ${formatTokens(rawLines)} lines`);
  lines.push(`  ${"Summaries".padStart(LABEL_WIDTH)}  ${formatTokens(summarizedTokens)} tokens (node + obs)`);
  lines.push(
    `  ${"Builder roots".padStart(LABEL_WIDTH)}  ${input.rootsCount} · ${formatTokens(input.rootsViewTokens)} / ${formatTokens(input.settings.builderRootViewThreshold)} tokens`,
  );
  if (input.settings.renderMode === "selected-root" && input.selectedView !== null) {
    lines.push(
      `  ${"Selector roots".padStart(LABEL_WIDTH)}  ${input.selectedView.rootsCount} · ${formatTokens(input.selectedView.viewTokens)} / ${formatTokens(input.settings.selectorRootViewThreshold)} tokens`,
    );
  }

  // --- Usage sections ---
  lines.push("", "Usage since session start");
  appendPhaseLines(lines, sinceSessionStart(input.usageLedger));
  lines.push("", "Usage since last compaction");
  const baseline = input.lastCompactionLedger ?? cloneLedger(EMPTY_LEDGER);
  appendPhaseLines(lines, sinceLastCompaction(input.usageLedger, baseline));

  return lines.join("\n");
}

function sum<T>(items: T[], pick: (item: T) => number): number {
  let total = 0;
  for (const item of items) total += pick(item);
  return total;
}

function appendPhaseLines(lines: string[], ledger: UsageLedger): void {
  for (const phase of PHASES) {
    const p = ledger[phase];
    lines.push(
      `  ${phase.padEnd(PHASE_LABEL_WIDTH)}  in ${formatTokens(p.input)} · out ${formatTokens(p.output)} · cache ${formatTokens(p.cacheRead)} · ${formatCost(p.cost)} · ${formatDuration(p.elapsedMs)}`,
    );
  }
}

// --- gathering over the port state -----------------------------------------

/** The port state the gather reads (the pi gather reads the module-global
 *  graph store + the session branch; the port's seams inject both — no host
 *  API beyond Date.now, pi parity). */
export interface StatusGatherDeps {
  enabled: boolean;
  settings: StatusInput["settings"] & { ignoreConflicts?: boolean };
  /** The live graph store view (the core instances' pinned store). */
  graph: {
    nodes: Map<string, Node>;
    observations: Map<string, Observation>;
  };
  /** The persisted selected tree (structure only), or null. */
  selectedTreeNodes: SerializedNode[] | null;
  /** The session bounds from the active branch. */
  session: { sessionStartMs: number; compactionCount: number };
  usageLedger: UsageLedger;
  lastCompactionLedger: UsageLedger | null;
}

/** Gather all /owl:status data sources (pi's gatherStatusInput mapped onto
 *  the port seams). Pure over the deps. */
export function gatherStatusInput(deps: StatusGatherDeps): StatusInput {
  const nodes = [...deps.graph.nodes.values()];
  const observations = [...deps.graph.observations.values()];
  const nonObsoleteRoots = nonObsoleteRootsOf(nodes);
  const rootsViewTokens = estimateContentTokens(
    renderRootViewFromRoots(nonObsoleteRoots, BUILDER, deps.graph.observations),
  );
  return {
    enabled: deps.enabled,
    settings: {
      renderMode: deps.settings.renderMode,
      builderRootViewThreshold: deps.settings.builderRootViewThreshold,
      selectorRootViewThreshold: deps.settings.selectorRootViewThreshold,
    },
    sessionStartMs: deps.session.sessionStartMs,
    compactionCount: deps.session.compactionCount,
    nodes,
    observations,
    levels: treeLevels(deps.graph.nodes),
    rootsCount: nonObsoleteRoots.length,
    rootsViewTokens,
    selectedView: measureSelectedView(deps.settings.renderMode, deps.selectedTreeNodes, deps.graph.observations),
    usageLedger: deps.usageLedger,
    lastCompactionLedger: deps.lastCompactionLedger,
  };
}

/** Decode a persisted selected tree's roots + measure the rendered view
 *  tokens (pi's measureSelectedView verbatim). Null when there is no tree
 *  or renderMode is observations-root. */
function measureSelectedView(
  renderMode: "selected-root" | "observations-root",
  serializedNodes: SerializedNode[] | null,
  observations: ReadonlyMap<string, Observation>,
): { rootsCount: number; viewTokens: number } | null {
  if (renderMode !== "selected-root" || serializedNodes === null) return null;
  const decoded = nonObsoleteRootsOf(serializedNodes.map(decodeNode).filter((n): n is Node => n !== null));
  if (decoded.length === 0) return null;
  return {
    rootsCount: decoded.length,
    viewTokens: estimateContentTokens(renderRootViewFromRoots(decoded, NON_BUILDER, observations)),
  };
}

// --- the serve seam (the /owl-status command body) --------------------------

/** Build the report the command serves: the paused report FIRST when the
 *  conflict pause is active (pi's paused-first ordering — no graph/session
 *  state exists to report), else the gathered status report. */
export async function serveStatusReport(deps: StatusGatherDeps): Promise<string> {
  if (isConflictPaused(() => ({ enabled: deps.enabled, ignoreConflicts: deps.settings.ignoreConflicts ?? false }))) {
    return buildPausedStatusReport();
  }
  return buildStatusReport(gatherStatusInput(deps));
}
