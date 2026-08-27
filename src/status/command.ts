// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// /mk:status — a user-facing slash command that prints a full memkeeper status
// report to the user via ui.notify (multi-line; does NOT consume the agent
// context window). User-facing only; not injected, not part of any graph.

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { getMemkeeperSettings, type MemkeeperConfig } from "../config/schema.js";
import { getConflictPause } from "../conflicts/pause.js";
import { BUILDER, NON_BUILDER, type SizeHintObservation, treeLevels } from "../format/render.js";
import { formatCost, formatCount, formatDuration, formatTokens } from "../format/tokens.js";
import { nonObsoleteRootsOf, renderRootViewFromRoots } from "../graph/read-tools.js";
import { notify } from "../notify.js";
import { cloneLedger, decodeNode, EMPTY_LEDGER, type SerializedNode, type UsageLedger } from "../store/codecs.js";
import { getGraphStore } from "../store/graph-store.js";
import { estimateContentTokens, type Node, type Observation } from "../types.js";
import { sinceLastCompaction, sinceSessionStart } from "./usage-ledger.js";

// --- pure report builder ---------------------------------------------------

/** The data sources /mk:status reads, as plain values (testable without pi). */
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
  /** Max tree depth in levels (roots = 1) — the same count the tree-total footer shows. */
  levels: number;
  /** Non-obsolete root count — the exact root set the Builder view renders. */
  rootsCount: number;
  /** The non-obsolete root-view tokens (chars/4 of the rendered root view). */
  rootsViewTokens: number;
  /** The persisted selected tree's root count + view tokens, or null when there
   *  is no selected tree / renderMode is observations-root. */
  selectedView: { rootsCount: number; viewTokens: number } | null;
  usageLedger: UsageLedger;
  /** The last-compaction ledger baseline (null until the first compaction). */
  lastCompactionLedger: UsageLedger | null;
}

const PHASES = ["observe", "build", "select"] as const;
const PHASE_LABEL_WIDTH = 7; // "observe" is the longest phase label
const REPORT_HEADER = "🦉 memkeeper — status";
const DISABLED_MESSAGE = "memkeeper is disabled.";

/** The conflict-pause report (approved text): which packages conflicted and
 *  how to recover. Pure over the activation-time conflict hits. */
export function buildPausedStatusReport(hits: Array<{ entry: string; matched: string }>): string {
  const nameWidth = Math.max(...hits.map((h) => h.matched.length));
  const listed = hits.map((h) => `  ${h.matched.padEnd(nameWidth)} ${h.entry}`).join("\n");
  return [
    REPORT_HEADER,
    "",
    "Paused — another compaction-handling extension is installed:",
    "",
    listed,
    "",
    "Pi's compaction hook is last-registration-wins, so memkeeper registered no",
    "hooks or tools this session. Remove the other package and restart pi to",
    "re-enable memkeeper — or see README → Conflicts.",
  ].join("\n");
}

/** Build the multi-line status report (pure). Mirrors the pi footer token
 *  format shared with the widget (formatTokens). */
export function buildStatusReport(input: StatusInput): string {
  if (!input.enabled) return DISABLED_MESSAGE;

  const lines: string[] = [REPORT_HEADER, ""];

  // --- Session line ---
  const durationMs = Date.now() - input.sessionStartMs;
  lines.push(
    `Session  ${formatDuration(durationMs)} · ${formatCount(input.compactionCount)} compaction${input.compactionCount === 1 ? "" : "s"}`,
  );

  // --- Memory section (labels padded into one column; Observations/Nodes
  //  counts right-aligned so the two count columns line up; style mirrors the
  //  root-view tree-total footer — plain counts, · separators) ---
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

// --- command handler (gathers live data + notifies) ------------------------

/** `/mk:status` (no args) → build the report from live state → notify the user. */
export async function runMkStatus(_args: string, ctx: ExtensionCommandContext): Promise<void> {
  try {
    // conflict-pause first: no graph/session state exists to report
    const paused = getConflictPause();
    if (paused !== null) {
      notify(ctx, buildPausedStatusReport(paused), "info");
      return;
    }
    const settings = getMemkeeperSettings();
    const { sessionStartMs, compactionCount } = readSessionBounds(ctx.sessionManager);
    const report = buildStatusReport(gatherStatusInput(settings, { sessionStartMs, compactionCount }));
    notify(ctx, report, "info");
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    notify(ctx, `memkeeper status failed: ${reason}`, "error");
  }
}

/** Count the compaction entries on the active branch — shared by the status
 *  report, the compaction summary's tree-total footer, and the Builder/Selector
 *  pass views. */
export function countCompactions(sessionManager: {
  getBranch(fromId?: string): { timestamp: string; type: string }[];
  getLeafId(): string | null;
}): number {
  const branch = sessionManager.getBranch(sessionManager.getLeafId() ?? undefined);
  let count = 0;
  for (const entry of branch) {
    if (entry.type === "compaction") count += 1;
  }
  return count;
}

/** Read the session-start timestamp + compaction count from the active branch. */
function readSessionBounds(sessionManager: {
  getBranch(fromId?: string): { timestamp: string; type: string }[];
  getLeafId(): string | null;
}): { sessionStartMs: number; compactionCount: number } {
  const branch = sessionManager.getBranch(sessionManager.getLeafId() ?? undefined);
  const first = branch[0];
  const sessionStartMs = first === undefined ? Date.now() : Date.parse(first.timestamp);
  return {
    sessionStartMs: Number.isNaN(sessionStartMs) ? Date.now() : sessionStartMs,
    compactionCount: countCompactions(sessionManager),
  };
}

/** Gather all /mk:status data sources from the live store (the session-derived
 *  bounds are passed in — they need ctx.sessionManager, which buildStatusReport
 *  stays free of). */
export function gatherStatusInput(
  config: MemkeeperConfig,
  session: { sessionStartMs: number; compactionCount: number },
): StatusInput {
  const store = getGraphStore();
  const graph = store.graph;
  const nodes = [...graph.nodes.values()];
  const observations = [...graph.observations.values()];
  const nonObsoleteRoots = nonObsoleteRootsOf(nodes);
  const rootsViewTokens = estimateContentTokens(renderRootViewFromRoots(nonObsoleteRoots, BUILDER, graph.observations));
  const selectedView = measureSelectedView(config.renderMode, store.selectedTree?.nodes ?? null, graph.observations);
  return {
    enabled: config.enabled,
    settings: {
      renderMode: config.renderMode,
      builderRootViewThreshold: config.builderRootViewThreshold,
      selectorRootViewThreshold: config.selectorRootViewThreshold,
    },
    sessionStartMs: session.sessionStartMs,
    compactionCount: session.compactionCount,
    nodes,
    observations,
    levels: treeLevels(graph.nodes),
    rootsCount: nonObsoleteRoots.length,
    rootsViewTokens,
    selectedView,
    usageLedger: store.usageLedger,
    lastCompactionLedger: store.lastCompactionLedger,
  };
}

/** Decode a persisted selected tree's roots + measure the rendered view tokens.
 *  Returns null when there is no tree or renderMode is observations-root. The
 *  tree carries structure only — the single-obs size hints resolve against the
 *  source graph's observations. */
function measureSelectedView(
  renderMode: "selected-root" | "observations-root",
  serializedNodes: SerializedNode[] | null,
  observations: ReadonlyMap<string, SizeHintObservation>,
): { rootsCount: number; viewTokens: number } | null {
  if (renderMode !== "selected-root" || serializedNodes === null) return null;
  const decoded = nonObsoleteRootsOf(serializedNodes.map(decodeNode).filter((n): n is Node => n !== null));
  if (decoded.length === 0) return null;
  return {
    rootsCount: decoded.length,
    viewTokens: estimateContentTokens(renderRootViewFromRoots(decoded, NON_BUILDER, observations)),
  };
}

// --- registration ----------------------------------------------------------

/** The registered command name. */
export const MK_STATUS_COMMAND = "mk:status";

/** Register the /mk:status command. */
export function registerStatusCommand(pi: ExtensionAPI): void {
  pi.registerCommand(MK_STATUS_COMMAND, {
    description: "Show memory stats and per-phase token/cost usage. Usage: /mk:status",
    handler: runMkStatus,
  });
}
