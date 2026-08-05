// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// /mk:status — a user-facing slash command that prints a full memkeeper status
// report to the user via ui.notify (multi-line; does NOT consume the agent
// context window). User-facing only; not injected, not part of any graph.

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { getMemkeeperSettings, type MemkeeperConfig } from "../config/schema.js";
import { formatCost, formatCount, formatDuration, formatTokens } from "../format/tokens.js";
import { nodeLineOptions, nonObsoleteRootsOf, renderRootViewFromRoots } from "../graph/read-tools.js";
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
  observations: Pick<Observation, "summaryTokens" | "detailsTokens">[];
  /** The non-obsolete root-view tokens (chars/4 of the rendered root view). */
  rootsViewTokens: number;
  /** The selected-tree root-view tokens, or null when there is no selected tree
   *  / renderMode is observations-root. */
  selectedViewTokens: number | null;
  usageLedger: UsageLedger;
  /** The last-compaction ledger baseline (null until the first compaction). */
  lastCompactionLedger: UsageLedger | null;
}

const PHASES = ["observe", "build", "select"] as const;
const PHASE_LABEL_WIDTH = 7; // "observe" is the longest phase label
const REPORT_HEADER = "🦉 memkeeper — status";
const DISABLED_MESSAGE = "memkeeper is disabled.";

/** Build the multi-line status report (pure). Mirrors the pi footer token
 *  format shared with the widget (formatTokens). */
export function buildStatusReport(input: StatusInput): string {
  if (!input.enabled) return DISABLED_MESSAGE;

  const lines: string[] = [REPORT_HEADER, ""];

  // --- Session line ---
  const durationMs = Date.now() - input.sessionStartMs;
  lines.push(
    `Session  ${formatDuration(durationMs)} — ${formatCount(input.compactionCount)} compaction${input.compactionCount === 1 ? "" : "s"}`,
  );

  // --- Memory section (counts with separators; columns aligned: labels +
  //  counts right-aligned so the token column lines up) ---
  const obsCount = input.observations.length;
  const rawTokens = sum(input.observations, (o) => o.detailsTokens); // verbatim source size
  const summarizedTokens = sum(input.observations, (o) => o.summaryTokens) + sum(input.nodes, (n) => n.summaryTokens); // node + obs summaries
  const nodeCount = input.nodes.length;
  const LABEL_WIDTH = 12; // "observations" is the longest label
  const obsCountStr = formatCount(obsCount);
  const nodeCountStr = formatCount(nodeCount);
  const countWidth = Math.max(obsCountStr.length, nodeCountStr.length);
  lines.push("", "Memory");
  lines.push(`  ${"observations".padStart(LABEL_WIDTH)}  ${obsCountStr.padStart(countWidth)}`);
  lines.push(`  ${"nodes".padStart(LABEL_WIDTH)}  ${nodeCountStr.padStart(countWidth)}`);
  lines.push(`  ${"Raw tokens".padStart(LABEL_WIDTH)}  ${formatTokens(rawTokens)} (verbatim source)`);
  lines.push(`  ${"Summarized".padStart(LABEL_WIDTH)}  ${formatTokens(summarizedTokens)} (node + obs summaries)`);
  lines.push(
    `  roots view  ${formatTokens(input.rootsViewTokens)} / ${formatTokens(input.settings.builderRootViewThreshold)}`,
  );
  if (input.settings.renderMode === "selected-root" && input.selectedViewTokens !== null) {
    lines.push(
      `  selected view  ${formatTokens(input.selectedViewTokens)} / ${formatTokens(input.settings.selectorRootViewThreshold)}`,
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
      `  ${phase.padEnd(PHASE_LABEL_WIDTH)}  in ${formatTokens(p.input)} — out ${formatTokens(p.output)} — cache ${formatTokens(p.cacheRead)} — ${formatCost(p.cost)}`,
    );
  }
}

// --- command handler (gathers live data + notifies) ------------------------

/** `/mk:status` (no args) → build the report from live state → notify the user. */
export async function runMkStatus(_args: string, ctx: ExtensionCommandContext): Promise<void> {
  try {
    const settings = getMemkeeperSettings();
    const { sessionStartMs, compactionCount } = readSessionBounds(ctx.sessionManager);
    const report = buildStatusReport(gatherStatusInput(settings, { sessionStartMs, compactionCount }));
    notify(ctx, report, "info");
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    notify(ctx, `memkeeper status failed: ${reason}`, "error");
  }
}

/** Read the session-start timestamp + compaction count from the active branch. */
function readSessionBounds(sessionManager: {
  getBranch(fromId?: string): { timestamp: string; type: string }[];
  getLeafId(): string | null;
}): { sessionStartMs: number; compactionCount: number } {
  const branch = sessionManager.getBranch(sessionManager.getLeafId() ?? undefined);
  const first = branch[0];
  const sessionStartMs = first === undefined ? Date.now() : Date.parse(first.timestamp);
  let compactionCount = 0;
  for (const entry of branch) {
    if (entry.type === "compaction") compactionCount += 1;
  }
  return { sessionStartMs: Number.isNaN(sessionStartMs) ? Date.now() : sessionStartMs, compactionCount };
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
  const rootsViewTokens = estimateContentTokens(
    renderRootViewFromRoots(nonObsoleteRoots, "builder", nodeLineOptions(graph, "builder").observationContent),
  );
  const selectedViewTokens = measureSelectedViewTokens(
    config.renderMode,
    store.selectedTree?.nodes ?? null,
    nodeLineOptions(graph, "nonBuilder").observationContent,
  );
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
    rootsViewTokens,
    selectedViewTokens,
    usageLedger: store.usageLedger,
    lastCompactionLedger: store.lastCompactionLedger,
  };
}

/** Decode a persisted selected tree's roots + measure the rendered view tokens.
 *  Returns null when there is no tree or renderMode is observations-root. The
 *  observation-content resolver (from the source store) wires the bare-`new`-node
 *  first-obs-line fallback so the measurement matches the displayed render. */
function measureSelectedViewTokens(
  renderMode: "selected-root" | "observations-root",
  serializedNodes: SerializedNode[] | null,
  observationContent: (obsId: string) => string | undefined,
): number | null {
  if (renderMode !== "selected-root" || serializedNodes === null) return null;
  const decoded = nonObsoleteRootsOf(serializedNodes.map(decodeNode).filter((n): n is Node => n !== null));
  if (decoded.length === 0) return null;
  return estimateContentTokens(renderRootViewFromRoots(decoded, "nonBuilder", observationContent));
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
