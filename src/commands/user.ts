// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// The user-facing `/mk:*` browse commands (DISTINCT from the agent's `mk_recall`
// tool). They browse the SOURCE memory graph (the full retained graph incl.
// obsolete — independent of `renderMode`) and render via `ctx.ui.notify`
// multi-line popups — zero agent-context cost (user-facing only, never injected).
//
// They mirror the Builder's filesystem navigation (one mental model across
// Builder + user), reuse the shared render format (id-prefix n/o + importance words) and
// the agent tools' collection logic (buildCatUnits / collectFindMatches), and
// cap output at `commandResultCap` result items (a transient popup can't paginate — so
// a render cap + drill footer, NOT cursor pagination).

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { getMemkeeperSettings } from "../config/schema.js";
import { formatNodeLine, formatObservationLine, indent, NON_BUILDER, type RenderViewer } from "../format/render.js";
import {
  buildCatUnits,
  collectFindMatches,
  directChildren,
  type IncludeSuperseded,
  nodeLineOptions,
  nonObsoleteRoots,
  orderActiveSetRoots,
  renderCatUnit,
  tryCompileFindRegex,
} from "../graph/read-tools.js";
import { toStoreContext } from "../lifecycle.js";
import { log } from "../log.js";
import { notify } from "../notify.js";
import { getGraphStore, resetGraphForRescan } from "../store/graph-store.js";
import { onTurnEnd } from "../triggers.js";
import type { NodeId, ObsId } from "../types.js";

// --- named constants (no bare literals at call sites) ----------------------

const VIEWER: RenderViewer = NON_BUILDER;
const CHILD_DEPTH = 1;
const EXCLUDE_SUPERSEDED: IncludeSuperseded = false;
const INCLUDE_SUPERSEDED: IncludeSuperseded = true;
/** Trim a raw positional-args string into the single token (or null when
 *  blank/whitespace). Shared by the id commands (ls/cat) and the regex commands
 *  (find/find-all). */
function trimArg(args: string): string | null {
  const trimmed = args.trim();
  return trimmed === "" ? null : trimmed;
}

// --- cap helper ------------------------------------------------------------

/** Apply the user-commands render cap: keep the first `cap` lines, and when
 *  truncated append a drill footer. `cap === null` means no limit. Returns the
 *  joined text + the number of lines dropped (0 when nothing dropped). Pure. */
export function formatList(lines: string[], cap: number | null): { text: string; truncated: number } {
  if (lines.length === 0) return { text: "", truncated: 0 };
  if (cap === null || lines.length <= cap) {
    return { text: lines.join("\n"), truncated: 0 };
  }
  const truncated = lines.length - cap;
  const kept = lines.slice(0, cap);
  kept.push(`… +${truncated} more — drill with /mk:ls <id> or narrow with /mk:find`);
  return { text: kept.join("\n"), truncated };
}

/** Resolve the live cap from settings (commandResultCap; default 50). */
function resolveCap(): number | null {
  return getMemkeeperSettings().commandResultCap;
}

// --- result channel --------------------------------------------------------

const DISABLED_MESSAGE = "memkeeper is disabled.";

/** Master-switch guard: when `enabled=false`, reply once and return true so the
 *  caller short-circuits (the off-path contract — mirrors /mk:status). */
async function replyIfDisabled(ctx: ExtensionCommandContext): Promise<boolean> {
  if (!getMemkeeperSettings().enabled) {
    notify(ctx, DISABLED_MESSAGE, "info");
    return true;
  }
  return false;
}

/** Info notify (results render in the popup). */
async function notifyInfo(ctx: ExtensionCommandContext, text: string): Promise<void> {
  notify(ctx, text, "info");
}

/** Error notify (invalid id, empty/invalid regex, usage). */
async function notifyError(ctx: ExtensionCommandContext, text: string): Promise<void> {
  notify(ctx, text, "error");
}

// --- /mk:ls ----------------------------------------------------------------

/** `/mk:ls [nodeId]` — list roots (no arg) or a node's direct children. */
export async function runMkLs(args: string, ctx: ExtensionCommandContext): Promise<void> {
  if (await replyIfDisabled(ctx)) return;
  const graph = getGraphStore().graph;
  const idArg = trimArg(args);

  const lines: string[] = [];
  if (idArg === null) {
    // roots: non-obsolete only (obsolete hidden by default — use /mk:find-all).
    for (const node of orderActiveSetRoots(nonObsoleteRoots(graph))) {
      lines.push(formatNodeLine(node, nodeLineOptions(VIEWER)));
    }
    const { text } = formatList(lines, resolveCap());
    await notifyInfo(ctx, text === "" ? "No memory yet." : text);
    return;
  }

  const parent = graph.nodes.get(idArg as NodeId);
  if (parent === undefined) {
    await notifyError(ctx, `No node '${idArg}'.`);
    return;
  }
  // parent header at depth 0; children indented at depth 1.
  lines.push(formatNodeLine(parent, nodeLineOptions(VIEWER)));
  const { nodes, observations } = directChildren(graph, parent);
  for (const node of nodes) {
    lines.push(indent(formatNodeLine(node, nodeLineOptions(VIEWER)), CHILD_DEPTH));
  }
  for (const obs of observations) {
    lines.push(indent(formatObservationLine(obs, { viewer: VIEWER }), CHILD_DEPTH));
  }
  const { text } = formatList(lines, resolveCap());
  await notifyInfo(ctx, text);
}

// --- /mk:cat ---------------------------------------------------------------

const MK_CAT_USAGE = "Usage: /mk:cat <id> — give a node id or an observation id.";

/** `/mk:cat <id>` — a node's header + its direct observations' full text, or an
 *  observation's full content + header. Mirrors the Builder `cat`. */
export async function runMkCat(args: string, ctx: ExtensionCommandContext): Promise<void> {
  if (await replyIfDisabled(ctx)) return;
  const idArg = trimArg(args);
  if (idArg === null) {
    await notifyError(ctx, MK_CAT_USAGE);
    return;
  }
  const graph = getGraphStore().graph;
  // Resolve the id directly (no string-prefix coupling to buildCatUnits' error
  // wording): an unknown node OR observation id → error notify naming the id.
  const node = graph.nodes.get(idArg as NodeId);
  const obs = graph.observations.get(idArg as ObsId);
  if (node === undefined && obs === undefined) {
    await notifyError(ctx, `No node or observation with id '${idArg}'.`);
    return;
  }
  const units = buildCatUnits(graph, [idArg], VIEWER);
  const lines = units.map(renderCatUnit);
  const { text } = formatList(lines, resolveCap());
  await notifyInfo(ctx, text);
}

// --- /mk:find + /mk:find-all ----------------------------------------------

const MK_FIND_USAGE = "Usage: /mk:find <query> — give a JS regex to search node summaries and observation content.";

/** Shared body for /mk:find (non-obsolete) and /mk:find-all (all statuses). */
async function runFind(
  args: string,
  ctx: ExtensionCommandContext,
  includeSuperseded: IncludeSuperseded,
): Promise<void> {
  if (await replyIfDisabled(ctx)) return;
  const query = trimArg(args);
  if (query === null) {
    await notifyError(ctx, MK_FIND_USAGE);
    return;
  }
  const compiled = tryCompileFindRegex(query);
  if ("error" in compiled) {
    await notifyError(ctx, compiled.error);
    return;
  }
  const graph = getGraphStore().graph;
  const collected = await collectFindMatches(graph, [compiled.regex], includeSuperseded, VIEWER);
  if ("error" in collected) {
    await notifyError(ctx, collected.error);
    return;
  }
  if (collected.matches.length === 0) {
    await notifyInfo(ctx, collected.note ?? "No matches.");
    return;
  }
  const lines = collected.matches.map((m) => m.render);
  if (collected.note !== undefined) lines.push(collected.note);
  const { text } = formatList(lines, resolveCap());
  await notifyInfo(ctx, text);
}

/** `/mk:find <query>` — JS regex search, default NON-obsolete (active + archived;
 *  new renders as active; obsolete/superseded excluded). */
export async function runMkFind(args: string, ctx: ExtensionCommandContext): Promise<void> {
  await runFind(args, ctx, EXCLUDE_SUPERSEDED);
}

/** `/mk:find-all <query>` — same as /mk:find but ALL statuses incl obsolete
 *  (shown with 🪦 + → supersededBy) — for digging dead ends. */
export async function runMkFindAll(args: string, ctx: ExtensionCommandContext): Promise<void> {
  await runFind(args, ctx, INCLUDE_SUPERSEDED);
}

// --- registration ----------------------------------------------------------

/** The registered command names. */
export const MK_LS_COMMAND = "mk:ls";
export const MK_CAT_COMMAND = "mk:cat";
export const MK_FIND_COMMAND = "mk:find";
export const MK_FIND_ALL_COMMAND = "mk:find-all";
export const MK_RESCAN_COMMAND = "mk:rescan";

/** Register all four `/mk:*` user browse commands. */
export function registerUserCommands(pi: ExtensionAPI): void {
  pi.registerCommand(MK_LS_COMMAND, {
    description: "List memory — roots, or a node's children. Usage: /mk:ls [nodeId]",
    handler: runMkLs,
  });
  pi.registerCommand(MK_CAT_COMMAND, {
    description: "Show a node's full observations, or one observation's full text. Usage: /mk:cat <id>",
    handler: runMkCat,
  });
  pi.registerCommand(MK_FIND_COMMAND, {
    description: "Search memory by regex (non-obsolete). Usage: /mk:find <query>",
    handler: runMkFind,
  });
  pi.registerCommand(MK_FIND_ALL_COMMAND, {
    description: "Search memory by regex (incl. obsolete/superseded). Usage: /mk:find-all <query>",
    handler: runMkFindAll,
  });
  pi.registerCommand(MK_RESCAN_COMMAND, {
    description: "Discard the current memory graph and re-observe the entire session from the start.",
    handler: async (_args: string, ctx: ExtensionCommandContext): Promise<void> => {
      const settings = getMemkeeperSettings();
      if (!settings.enabled) {
        notify(ctx, "memkeeper is disabled (enable it first).", "warning");
        return;
      }
      const ok = await ctx.ui.confirm(
        "Rescan memory",
        "Discard the current memory graph (observations, nodes, selected tree) and re-observe the entire session from the start? This cannot be undone.",
      );
      if (!ok) return;
      resetGraphForRescan(toStoreContext(pi, ctx));
      notify(ctx, "Rescanning — observing the session from the start…", "info");
      // fire-and-forget the Observer catch-up (frontier is now null → the whole
      // branch is unobserved); the chained Builder/Selector fire after per mode.
      void (async () => {
        try {
          await onTurnEnd({ ctx, settings: getMemkeeperSettings() });
        } catch (err) {
          log.error("rescan: observer catch-up failed", err);
        }
      })();
    },
  });
}
