// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// The user-facing `/owl:*` browse commands (DISTINCT from the agent's `owl_recall`
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
import { getSessionOwlSettings } from "../config/schema.js";
import {
  directObsSizeHint,
  formatNodeLine,
  formatObservationLine,
  indent,
  NON_BUILDER,
  type RenderViewer,
} from "../format/render.js";
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
import type { ObserverRunInput } from "../observer/run.js";
import { acquireForCompaction } from "../runtime/run-lock.js";
import { getGraphStore, resetGraphForRescan } from "../store/graph-store.js";
import { onTurnEnd, type RunFn } from "../triggers.js";
import type { NodeId, ObsId } from "../types.js";
import { O_INITIAL_PROMPT } from "../types.js";
import type { WidgetController } from "../widget/tracker.js";
import { OWL_REOBSERVE_COMMAND, runOwlReobserve } from "./reobserve.js";
import { runReuseRebuild } from "./reuse-rebuild.js";

// --- named constants (no bare literals at call sites) ----------------------

const VIEWER: RenderViewer = NON_BUILDER;
const CHILD_DEPTH = 1;
const EXCLUDE_SUPERSEDED: IncludeSuperseded = false;
const INCLUDE_SUPERSEDED: IncludeSuperseded = true;
const NO_OBSERVATIONS = 0;
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
  kept.push(`… +${truncated} more — drill with /owl:ls <id> or narrow with /owl:find`);
  return { text: kept.join("\n"), truncated };
}

/** Resolve the live cap from settings (commandResultCap; default 50). */
function resolveCap(): number | null {
  return getSessionOwlSettings().commandResultCap;
}

// --- result channel --------------------------------------------------------

const DISABLED_MESSAGE = "session-owl is disabled.";

/** Master-switch guard: when `enabled=false`, reply once and return true so the
 *  caller short-circuits (the off-path contract — mirrors /owl:status). */
async function replyIfDisabled(ctx: ExtensionCommandContext): Promise<boolean> {
  if (!getSessionOwlSettings().enabled) {
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

// --- /owl:ls ----------------------------------------------------------------

/** `/owl:ls [nodeId]` — list roots (no arg) or a node's direct children. */
export async function runOwlLs(args: string, ctx: ExtensionCommandContext): Promise<void> {
  if (await replyIfDisabled(ctx)) return;
  const graph = getGraphStore().graph;
  const idArg = trimArg(args);

  const lines: string[] = [];
  if (idArg === null) {
    // roots: non-obsolete only (obsolete hidden by default — use /owl:find-all).
    for (const node of orderActiveSetRoots(nonObsoleteRoots(graph))) {
      lines.push(
        formatNodeLine(node, { ...nodeLineOptions(VIEWER), obsSize: directObsSizeHint(node, graph.observations) }),
      );
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
  lines.push(
    formatNodeLine(parent, { ...nodeLineOptions(VIEWER), obsSize: directObsSizeHint(parent, graph.observations) }),
  );
  const { nodes, observations } = directChildren(graph, parent);
  for (const node of nodes) {
    lines.push(
      indent(
        formatNodeLine(node, { ...nodeLineOptions(VIEWER), obsSize: directObsSizeHint(node, graph.observations) }),
        CHILD_DEPTH,
      ),
    );
  }
  for (const obs of observations) {
    lines.push(indent(formatObservationLine(obs, { viewer: VIEWER }), CHILD_DEPTH));
  }
  const { text } = formatList(lines, resolveCap());
  await notifyInfo(ctx, text);
}

// --- /owl:cat ---------------------------------------------------------------

const OWL_CAT_USAGE = "Usage: /owl:cat <id> — give a node id or an observation id.";

/** `/owl:cat <id>` — a node's header + its direct observations' full text, or an
 *  observation's full content + header. Mirrors the Builder `cat`. */
export async function runOwlCat(args: string, ctx: ExtensionCommandContext): Promise<void> {
  if (await replyIfDisabled(ctx)) return;
  const idArg = trimArg(args);
  if (idArg === null) {
    await notifyError(ctx, OWL_CAT_USAGE);
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

// --- /owl:find + /owl:find-all ----------------------------------------------

const OWL_FIND_USAGE = "Usage: /owl:find <query> — give a JS regex to search node summaries and observation content.";

/** Shared body for /owl:find (non-obsolete) and /owl:find-all (all statuses). */
async function runFind(
  args: string,
  ctx: ExtensionCommandContext,
  includeSuperseded: IncludeSuperseded,
): Promise<void> {
  if (await replyIfDisabled(ctx)) return;
  const query = trimArg(args);
  if (query === null) {
    await notifyError(ctx, OWL_FIND_USAGE);
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

/** `/owl:find <query>` — JS regex search, default NON-obsolete (active + archived;
 *  new renders as active; obsolete/superseded excluded). */
export async function runOwlFind(args: string, ctx: ExtensionCommandContext): Promise<void> {
  await runFind(args, ctx, EXCLUDE_SUPERSEDED);
}

/** `/owl:find-all <query>` — same as /owl:find but ALL statuses incl obsolete
 *  (shown with 🪦 + → supersededBy) — for digging dead ends. */
export async function runOwlFindAll(args: string, ctx: ExtensionCommandContext): Promise<void> {
  await runFind(args, ctx, INCLUDE_SUPERSEDED);
}

// --- /owl:rescan -----------------------------------------------------------

/** The reuse-mode flag: rebuild the graph structure from the collected
 *  observation records instead of re-observing the session (no Observer LLM). */
const REUSE_FLAG = "--reuse-observations";

/** Dependencies the rescan handler needs beyond the command ctx: the api
 *  (entry appends), the widget (rebuild progress), the Builder stage run, and
 *  an optional test hook collecting the fire-and-forget launch promise. */
export interface RescanDeps {
  pi: ExtensionAPI;
  widget: WidgetController;
  runBuilderStage: RunFn;
  /** The raw Observer run (no mid-run Builder) — the re-observe repair command
   *  drives it per uncovered range; recovered roots fold via normal triggers. */
  runObserver: (input: ObserverRunInput) => Promise<void>;
  /** Test seam: receives the background launch promise (production omits). */
  onLaunched?: (promise: Promise<void>) => void;
}

/** Count the collected observation records (everything but the verbatim
 *  oInitialPrompt — that one re-seeds under nGoal mechanically). */
function collectedCount(): number {
  let count = 0;
  for (const id of getGraphStore().graph.observations.keys()) {
    if (id !== O_INITIAL_PROMPT) count += 1;
  }
  return count;
}

/** `/owl:rescan [--reuse-observations]` — discard the memory graph. Plain: void
 *  everything and re-observe the entire session (Observer LLM). With the reuse
 *  flag: void the STRUCTURE only and rebuild it from the collected records in
 *  the background (batched re-wrap + Builder cadence; the ledger, frontier, and
 *  usage are kept — no re-observing). */
export async function runOwlRescan(args: string, ctx: ExtensionCommandContext, deps: RescanDeps): Promise<void> {
  const settings = getSessionOwlSettings();
  if (!settings.enabled) {
    notify(ctx, "session-owl is disabled (enable it first).", "warning");
    return;
  }
  const reuse = args.trim().includes(REUSE_FLAG);

  if (reuse) {
    const collected = collectedCount();
    if (collected === NO_OBSERVATIONS) {
      notify(ctx, "Nothing to rebuild — no collected observations yet.", "info");
      return;
    }
    const ok = await ctx.ui.confirm(
      "Rebuild memory",
      `Discard the current graph structure and rebuild it from the ${collected} collected observations without re-observing the session? The observation ledger, frontier, and usage are kept. This cannot be undone.`,
    );
    if (!ok) return;
    notify(ctx, `Rebuilding — re-wrapping ${collected} collected observations into a fresh graph…`, "info");
    // fire-and-forget the rebuild under the run-lock (aborts + awaits any
    // in-flight maintenance run, holds until done; the remainder parks on abort
    // and a re-run continues)
    const launch = (async () => {
      const handle = await acquireForCompaction();
      const signal = handle.abortController.signal;
      try {
        await runReuseRebuild({
          ctx,
          pi: deps.pi,
          settings: getSessionOwlSettings(),
          signal,
          widget: deps.widget,
          runBuilder: () =>
            deps.runBuilderStage({ ctx, settings: getSessionOwlSettings(), signal, scope: null, unobserved: null }),
        });
      } catch (err) {
        log.error("rescan --reuse-observations: rebuild failed", err);
      } finally {
        handle.release();
      }
    })();
    deps.onLaunched?.(launch);
    return;
  }

  const ok = await ctx.ui.confirm(
    "Rescan memory",
    "Discard the current memory graph (observations, nodes, selected tree) and re-observe the entire session from the start? This cannot be undone.",
  );
  if (!ok) return;
  resetGraphForRescan(toStoreContext(deps.pi, ctx));
  notify(ctx, "Rescanning — observing the session from the start…", "info");
  // fire-and-forget the Observer catch-up (frontier is now null → the whole
  // branch is unobserved); the chained Builder/Selector fire after per mode.
  void (async () => {
    try {
      await onTurnEnd({ ctx, settings: getSessionOwlSettings() });
    } catch (err) {
      log.error("rescan: observer catch-up failed", err);
    }
  })();
}

// --- registration ----------------------------------------------------------

/** The registered command names. */
export const OWL_LS_COMMAND = "owl:ls";
export const OWL_CAT_COMMAND = "owl:cat";
export const OWL_FIND_COMMAND = "owl:find";
export const OWL_FIND_ALL_COMMAND = "owl:find-all";
export const OWL_RESCAN_COMMAND = "owl:rescan";

/** Register all the `/owl:*` user browse commands. `deps` carries the widget,
 *  the Builder stage run the rescan reuse-rebuild drives, and the raw Observer
 *  run the re-observe repair command drives. */
export function registerUserCommands(pi: ExtensionAPI, deps: RescanDeps): void {
  pi.registerCommand(OWL_LS_COMMAND, {
    description: "List memory — roots, or a node's children. Usage: /owl:ls [nodeId]",
    handler: runOwlLs,
  });
  pi.registerCommand(OWL_CAT_COMMAND, {
    description: "Show a node's full observations, or one observation's full text. Usage: /owl:cat <id>",
    handler: runOwlCat,
  });
  pi.registerCommand(OWL_FIND_COMMAND, {
    description: "Search memory by regex (non-obsolete). Usage: /owl:find <query>",
    handler: runOwlFind,
  });
  pi.registerCommand(OWL_FIND_ALL_COMMAND, {
    description: "Search memory by regex (incl. obsolete/superseded). Usage: /owl:find-all <query>",
    handler: runOwlFindAll,
  });
  pi.registerCommand(OWL_RESCAN_COMMAND, {
    description:
      "Discard the memory graph and re-observe the session from the start. --reuse-observations rebuilds from collected observations.",
    handler: async (args: string, ctx: ExtensionCommandContext): Promise<void> => runOwlRescan(args, ctx, deps),
  });
  pi.registerCommand(OWL_REOBSERVE_COMMAND, {
    description:
      "Re-observe session ranges that were skipped with zero observations (repair after a degraded model run). Usage: /owl:reobserve-0-obs-chunks",
    handler: async (args: string, ctx: ExtensionCommandContext): Promise<void> => runOwlReobserve(args, ctx, deps),
  });
}
