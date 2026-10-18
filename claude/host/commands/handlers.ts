// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// The eight `/owl-*` command bodies — pi's src/commands/user.ts, reobserve.ts
// and status/command.ts arms, ported. Every handler runs the disabled guard
// with pi's exact notice (the SETTINGS shell's guard is interim-only — see
// its own note), the browse arms run the canonical-view check BEFORE serving
// (the same layered-check entry the recall handler uses) and pin the
// conversation's core before the vendored singleton reads, and every
// user-visible line flows through the notify adapter (the ui.log mapping:
// split-in-order, level dropped). Texts are pi's verbatim except the
// adapter-authored interim degrades (status/settings enabled-path, recorded
// in the known-issues file); only the command names swap `/owl:` for
// `/owl-` (the platform refuses colons in names). A handler throw propagates
// to the dispatcher's caller — the wiring logs it and answers {} (the user
// never sees a raw stack; the command surface degrades, the session lives).
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { SessionOwlConfig } from "../../core/src/config/schema.js";
import {
  directObsSizeHint,
  formatNodeLine,
  formatObservationLine,
  indent,
  NON_BUILDER,
  type RenderViewer,
} from "../../core/src/format/render.js";
import type { IncludeSuperseded } from "../../core/src/graph/read-tools.js";
import {
  buildCatUnits,
  collectFindMatches,
  directChildren,
  nodeLineOptions,
  nonObsoleteRoots,
  orderActiveSetRoots,
  renderCatUnit,
  tryCompileFindRegex,
} from "../../core/src/graph/read-tools.js";
import type { GraphStore } from "../../core/src/store/graph-store.js";
import { computeUncoveredRanges, makeMaybeBuilder } from "../../core/src/triggers.js";
import { type NodeId, O_INITIAL_PROMPT, type ObsId } from "../../core/src/types.js";
import type { ConfirmFn, NotifyFn } from "../notify/adapter.js";
import { runsLog } from "../runs/seams.js";
import { makeTriggerCtx } from "../triggers/context.js";
import type { RunHandle } from "../triggers/run-locks.js";
import { routeOutput } from "./viewer.js";

// --- shared input types -------------------------------------------------------

/** The commands' injected services — everything but the command event,
 *  bound by the register wiring (tests supply fakes). */
export interface OwlCommandDeps {
  /** The bootstrap pause predicate (optional — kit contexts leave it
   *  unset; production wires state.isBootstrapBlocked). */
  isBootstrapBlocked?: () => boolean;
  /** The conversation key (sessionId — commands run in the main loop). */
  key: string;
  /** The notify adapter (every user-visible line — the ui.log mapping). */
  notify: NotifyFn;
  /** The viewer-pane opener (eligible multi-line output; optional — the
   *  unwired kit contexts keep everything on the notify transport). */
  openViewer?: (title: string, text: string) => void;
  /** The confirm port (pi's ui.confirm → $.ui.ask mapping). */
  confirm: ConfirmFn;
  /** The live master switch. */
  isEnabled: () => boolean;
  /** Live settings (the render cap, the stage models). */
  getSettings: () => SessionOwlConfig;
  /** The canonical-view check awaited BEFORE every browse serve (the
   *  layered rewind check's interactive entry — latency-tolerant). */
  checkThenServe: (key: string) => Promise<void>;
  /** Pins the conversation's core before the vendored singleton reads. */
  pinCore: () => Promise<void>;
  /** The conversation's graph store (post-pin). */
  getGraphStore: () => GraphStore;
  /** The conversation's branch view (the reobserve range scan). The MIXED
   *  pi-shaped view: message entries AND owl's coverage customs interleaved
   *  (the wiring unwraps the store's session-owl.row markers to their
   *  message entries and keeps the observation customs — pi's
   *  sessionManager.getBranch shape; the raw store branch does NOT fit). */
  getLeafId: () => string | null;
  getBranch: (leafId: string | null) => SessionEntry[];
  /** Void the graph + observations for a full re-observe (plain rescan). */
  resetGraphForRescan: () => void;
  /** Fire-and-forget the turn-boundary trigger chain (plain rescan's
   *  catch-up launch — the evaluateAndLaunch entry, async like pi's
   *  onTurnEnd).
   */
  relaunchMaintenance: () => void | Promise<void>;
  /** Abort + await in-flight runs, hold until release (rescan reuse mode). */
  acquireForCompaction: () => Promise<RunHandle>;
  /** Try to acquire the observe lock — null means a run is in flight. */
  acquireOrSkipObserve: () => RunHandle | null;
  /** Resolves once every in-flight goal extraction settles (the goal-first
   *  stage sequencing — awaited BEFORE acquiring, never while holding). */
  goalExtractSettled?: () => Promise<void>;
  /** The reuse-rebuild run body (the caller owns the lock + signal). */
  runReuseRebuild: (signal: AbortSignal) => Promise<void>;
  /** The raw Observer run body (the reobserve repair drives per range). */
  runObserver: (args: {
    unobserved: SessionEntry[];
    signal: AbortSignal;
    maybeBuild: () => Promise<boolean>;
    /** Optional per-persist ledger flush (durability seam — same shape as
     *  ObserverRunInput.flushLedger; the wiring passes it per conversation). */
    flushLedger?: () => Promise<void>;
  }) => Promise<void>;
  /** The Builder stage run (the repair's mid-run folding + the reuse
   *  rebuild's cadence gate — pi's scope:null turn-boundary shape). */
  runBuilder: (args: { signal: AbortSignal }) => Promise<void>;
  /** The status report body; absent ⇒ the interim degrade. */
  serveStatusReport?: () => Promise<string>;
  /** The settings pane body; absent ⇒ the interim degrade. */
  serveSettings?: () => Promise<void>;
  /** Test seam: receives each fire-and-forget launch promise. */
  onLaunched?: (promise: Promise<void>) => void;
}

// --- named constants (pi's, kebab-swapped where the name appears) -------------

const VIEWER: RenderViewer = NON_BUILDER;
const CHILD_DEPTH = 1;
const EXCLUDE_SUPERSEDED: IncludeSuperseded = false;
const INCLUDE_SUPERSEDED: IncludeSuperseded = true;
const NO_OBSERVATIONS = 0;
const BROWSE_DISABLED_MESSAGE = "session-owl is disabled.";
const MAINTENANCE_DISABLED_MESSAGE = "session-owl is disabled (enable it first).";
const BOOTSTRAP_PAUSED_MESSAGE =
  "session-owl is paused — history bootstrap pending (see /owl-status; or turn it off in /owl-settings)";
const OWL_CAT_USAGE = "Usage: /owl-cat <id> — give a node id or an observation id.";
const OWL_FIND_USAGE = "Usage: /owl-find <query> — give a JS regex to search node summaries and observation content.";
const NO_MEMORY_YET = "No memory yet.";
const NO_MATCHES = "No matches.";
const REUSE_FLAG = "--reuse-observations";
const REBUILD_TITLE = "Rebuild memory";
const RESCAN_TITLE = "Rescan memory";
const NOTHING_TO_REBUILD = "Nothing to rebuild — no collected observations yet.";
const REBUILD_FAILED_LOG = "rescan --reuse-observations: rebuild failed";
const RESCAN_FAILED_LOG = "rescan: observer catch-up failed";
const REOBSERVE_NOTHING_TO_DO = "No skipped or unobserved ranges — nothing to re-observe.";
const REOBSERVE_IN_FLIGHT = "A maintenance run is in flight — try again once it finishes.";
const REOBSERVE_FAILED = "Re-observe failed — see the session-owl log for the error.";
const REOBSERVE_FAILED_LOG = "reobserve: run failed";
const STATUS_DISABLED_MESSAGE = "session-owl is disabled.";
const STATUS_FAILED_LOG = "status: report failed";
/** The status/settings degrade answers when their deps are unwired —
 *  visible answers, never silent no-ops. */
const STATUS_INTERIM = "session-owl status failed: status report unavailable in this build";
const SETTINGS_INTERIM = "session-owl settings: the pane is unavailable in this build.";
const TRUNCATION_FOOTER = "… +{count} more — drill with /owl-ls <id> or narrow with /owl-find";

// --- pi's pure helpers, ported -------------------------------------------------

/** Trim a raw positional-args string into the single token (or null when
 *  blank/whitespace) — pi's trimArg, shared by every argument command. */
function trimArg(args: string): string | null {
  const trimmed = args.trim();
  return trimmed === "" ? null : trimmed;
}

/** Apply the user-commands render cap: keep the first `cap` lines, and when
 *  truncated append the drill footer (pi's formatList; `cap === null` means
 *  no limit). Pure. */
function formatList(lines: string[], cap: number | null): { text: string; truncated: number } {
  if (lines.length === 0) return { text: "", truncated: 0 };
  if (cap === null || lines.length <= cap) {
    return { text: lines.join("\n"), truncated: 0 };
  }
  const truncated = lines.length - cap;
  const kept = lines.slice(0, cap);
  kept.push(TRUNCATION_FOOTER.replace("{count}", String(truncated)));
  return { text: kept.join("\n"), truncated };
}

/** The disabled guard for the browse arms (pi's replyIfDisabled — info). */
function replyIfDisabled(deps: OwlCommandDeps): boolean {
  if (!deps.isEnabled()) {
    deps.notify(BROWSE_DISABLED_MESSAGE, "info");
    return true;
  }
  return false;
}

// --- /owl-ls --------------------------------------------------------------------

/** `/owl-ls [nodeId]` — list roots (no arg) or a node's direct children. */
export async function runOwlLs(args: string, deps: OwlCommandDeps): Promise<void> {
  if (replyIfDisabled(deps)) return;
  await deps.checkThenServe(deps.key);
  await deps.pinCore();
  const graph = deps.getGraphStore().graph;
  const idArg = trimArg(args);

  const lines: string[] = [];
  if (idArg === null) {
    // roots: non-obsolete only (obsolete hidden by default — use /owl-find-all).
    for (const node of orderActiveSetRoots(nonObsoleteRoots(graph))) {
      lines.push(
        formatNodeLine(node, { ...nodeLineOptions(VIEWER), obsSize: directObsSizeHint(node, graph.observations) }),
      );
    }
    const { text } = formatList(lines, deps.getSettings().commandResultCap);
    if (text === "") {
      deps.notify(NO_MEMORY_YET, "info");
      return;
    }
    routeOutput(deps, "owl-ls — roots", text);
    return;
  }

  const parent = graph.nodes.get(idArg as NodeId);
  if (parent === undefined) {
    deps.notify(`No node '${idArg}'.`, "error");
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
  const { text } = formatList(lines, deps.getSettings().commandResultCap);
  routeOutput(deps, `owl-ls — ${idArg}`, text);
}

// --- /owl-cat ---------------------------------------------------------------------

/** `/owl-cat <id>` — a node's header + its direct observations' full text, or
 *  an observation's full content + header (pi's cat over the vendored
 *  buildCatUnits/renderCatUnit). */
export async function runOwlCat(args: string, deps: OwlCommandDeps): Promise<void> {
  if (replyIfDisabled(deps)) return;
  const idArg = trimArg(args);
  if (idArg === null) {
    deps.notify(OWL_CAT_USAGE, "error");
    return;
  }
  await deps.checkThenServe(deps.key);
  await deps.pinCore();
  const graph = deps.getGraphStore().graph;
  // Resolve the id directly: an unknown node OR observation id → the error
  // notify naming the id (pi's wording).
  const node = graph.nodes.get(idArg as NodeId);
  const obs = graph.observations.get(idArg as ObsId);
  if (node === undefined && obs === undefined) {
    deps.notify(`No node or observation with id '${idArg}'.`, "error");
    return;
  }
  const units = buildCatUnits(graph, [idArg], VIEWER);
  const lines = units.map(renderCatUnit);
  const { text } = formatList(lines, deps.getSettings().commandResultCap);
  routeOutput(deps, `owl-cat — ${idArg}`, text);
}

// --- /owl-rescan ------------------------------------------------------------------

/** Count the collected observation records (everything but the verbatim
 *  oInitialPrompt — that one re-seeds under nGoal mechanically; pi's rule). */
function collectedCount(deps: OwlCommandDeps): number {
  let count = 0;
  for (const id of deps.getGraphStore().graph.observations.keys()) {
    if (id !== O_INITIAL_PROMPT) count += 1;
  }
  return count;
}

/** `/owl-rescan [--reuse-observations]` — discard the memory graph. Plain:
 *  void everything and re-observe the entire session (the maintenance
 *  relaunch; frontier is now null ⇒ the whole branch is unobserved). With
 *  the reuse flag: void the STRUCTURE only and rebuild it from the collected
 *  records in the background under the compaction lock (aborts + awaits any
 *  in-flight run; the ledger, frontier, and usage are kept). */
export async function runOwlRescan(args: string, deps: OwlCommandDeps): Promise<void> {
  if (!deps.isEnabled()) {
    deps.notify(MAINTENANCE_DISABLED_MESSAGE, "warning");
    return;
  }
  if (deps.isBootstrapBlocked?.()) {
    deps.notify(BOOTSTRAP_PAUSED_MESSAGE, "warning");
    return;
  }
  const reuse = args.trim().includes(REUSE_FLAG);
  // pin before the singleton reads (the count below and the reset later);
  // the confirm awaits between them can swap the singleton mid-command
  await deps.pinCore();

  if (reuse) {
    const collected = collectedCount(deps);
    if (collected === NO_OBSERVATIONS) {
      deps.notify(NOTHING_TO_REBUILD, "info");
      return;
    }
    const ok = await deps.confirm(
      REBUILD_TITLE,
      `Discard the current graph structure and rebuild it from the ${collected} collected observations without re-observing the session? The observation ledger, frontier, and usage are kept. This cannot be undone.`,
    );
    if (!ok) return;
    deps.notify(`Rebuilding — re-wrapping ${collected} collected observations into a fresh graph…`, "info");
    // fire-and-forget the rebuild under the compaction lock (aborts + awaits
    // any in-flight maintenance run, holds until done)
    const launch = (async () => {
      const handle = await deps.acquireForCompaction();
      const signal = handle.abortController.signal;
      try {
        await deps.pinCore(); // the lock acquire awaited — re-pin for the run
        await deps.runReuseRebuild(signal);
      } catch (err) {
        runsLog(REBUILD_FAILED_LOG, err);
      } finally {
        handle.release();
      }
    })();
    deps.onLaunched?.(launch);
    return;
  }

  const ok = await deps.confirm(
    RESCAN_TITLE,
    "Discard the current memory graph (observations, nodes, selected tree) and re-observe the entire session from the start? This cannot be undone.",
  );
  if (!ok) return;
  await deps.pinCore(); // the confirm await may have swapped the singleton
  // goal-first stage sequencing: settle any in-flight goal extraction BEFORE
  // the reset wipes the graph it writes into and the catch-up chain acquires
  // the run-lock (await before acquiring — never while holding).
  await deps.goalExtractSettled?.();
  deps.resetGraphForRescan();
  deps.notify("Rescanning — observing the session from the start…", "info");
  // fire-and-forget the Observer catch-up (frontier is now null → the whole
  // branch is unobserved); the chained Builder/Selector fire after per mode.
  const launch = (async () => {
    try {
      await deps.relaunchMaintenance();
    } catch (err) {
      runsLog(RESCAN_FAILED_LOG, err);
    }
  })();
  deps.onLaunched?.(launch);
}

// --- /owl-reobserve-0-obs-chunks ---------------------------------------------------

/** `/owl-reobserve-0-obs-chunks` — compute the zero-observation ranges on
 *  the active branch and re-observe each oldest-first under one observe-lock
 *  acquire. Additive only: nothing is discarded; recovered observations
 *  persist per-chunk as usual. The mid-repair Builder folding follows the
 *  catch-up semantics (compaction-scope root-view safeguard on top of the
 *  mode-aware cadence) — the same maybeBuild the compaction gate builds. */
export async function runOwlReobserve(_args: string, deps: OwlCommandDeps): Promise<void> {
  if (!deps.isEnabled()) {
    deps.notify(MAINTENANCE_DISABLED_MESSAGE, "warning");
    return;
  }
  if (deps.isBootstrapBlocked?.()) {
    deps.notify(BOOTSTRAP_PAUSED_MESSAGE, "warning");
    return;
  }
  await deps.pinCore();
  const branch = deps.getBranch(deps.getLeafId());
  const ranges = computeUncoveredRanges(branch, deps.getGraphStore().observerFrontier);
  if (ranges.length === 0) {
    deps.notify(REOBSERVE_NOTHING_TO_DO, "info");
    return;
  }
  // goal-first stage sequencing: an in-flight goal extraction settles FIRST
  // (await before acquiring — never while holding the lock)
  await deps.goalExtractSettled?.();
  const handle = deps.acquireOrSkipObserve();
  if (handle === null) {
    deps.notify(REOBSERVE_IN_FLIGHT, "warning");
    return;
  }
  const entryCount = ranges.reduce((sum, range) => sum + range.entries.length, 0);
  deps.notify(`Re-observing ${ranges.length} skipped range(s) (${entryCount} entries)…`, "info");

  const signal = handle.abortController.signal;
  // Mid-repair Builder folding, catch-up semantics (pi's scope shape):
  // each check re-pins first — the Observer's long awaits let other
  // conversations' swaps re-point the singletons in between
  const bareMaybeBuild = makeMaybeBuilder({
    ctx: makeTriggerCtx({
      key: deps.key,
      getLeafId: () => deps.getLeafId(),
      getBranch: () => deps.getBranch(deps.getLeafId()),
      thinkingLevel: null,
    }) as unknown as Parameters<typeof makeMaybeBuilder>[0]["ctx"],
    settings: deps.getSettings(),
    signal,
    scope: { firstKeptEntryId: null },
    runBuilder: () => deps.runBuilder({ signal }),
  });
  const maybeBuild = async (): Promise<boolean> => {
    await deps.pinCore();
    return bareMaybeBuild();
  };
  const launch = (async () => {
    let recovered = 0;
    try {
      for (const range of ranges) {
        if (signal.aborted) break;
        // the previous run's awaits let other conversations' swaps re-point
        // the singletons — re-pin before each range's reads and run
        await deps.pinCore();
        const before = deps.getGraphStore().graph.observations.size;
        await deps.runObserver({ unobserved: range.entries, signal, maybeBuild });
        // the run's long awaits may have swapped the singleton — re-pin
        // before the recovered-delta read (the count is user-visible)
        await deps.pinCore();
        recovered += deps.getGraphStore().graph.observations.size - before;
      }
      deps.notify(`Re-observe done — ${recovered} observation(s) recovered into new roots.`, "info");
    } catch (cause) {
      runsLog(REOBSERVE_FAILED_LOG, cause);
      deps.notify(REOBSERVE_FAILED, "error");
    } finally {
      handle.release();
    }
  })();
  deps.onLaunched?.(launch);
}

// --- /owl-status + /owl-settings (shells) ------------------------------------------

/** `/owl-status` — the report shell. Disabled ⇒ pi's exact notice; the
 *  report body (`serveStatusReport` — pi's runOwlStatus gathers +
 *  notifies) answers when wired; the interim degrade keeps the command
 *  answered otherwise (never a silent no-op). */
export async function runOwlStatus(_args: string, deps: OwlCommandDeps): Promise<void> {
  if (!deps.isEnabled()) {
    deps.notify(STATUS_DISABLED_MESSAGE, "info");
    return;
  }
  if (deps.serveStatusReport === undefined) {
    deps.notify(STATUS_INTERIM, "error");
    return;
  }
  try {
    const report = await deps.serveStatusReport();
    routeOutput(deps, "owl-status — report", report);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    runsLog(STATUS_FAILED_LOG, err);
    deps.notify(`session-owl status failed: ${reason}`, "error");
  }
}

/** `/owl-settings` — the pane shell. The pane binds via `serveSettings`;
 *  unwired, the interim degrade answers. When bound, the shell
 *  delegates and stays silent itself (the pane speaks for itself — pi
 *  parity). NO disabled guard — pi's settings command opens the pane
 *  unconditionally (it is the re-enable path); the live /owl-settings
 *  dispatch uses the guardless inline pane branch for the same reason. */
export async function runOwlSettings(_args: string, deps: OwlCommandDeps): Promise<void> {
  if (deps.serveSettings === undefined) {
    deps.notify(SETTINGS_INTERIM, "info");
    return;
  }
  await deps.serveSettings();
}

// --- /owl-find + /owl-find-all ------------------------------------------------------

/** Shared body for /owl-find (non-obsolete) and /owl-find-all (all statuses). */
async function runFind(args: string, deps: OwlCommandDeps, includeSuperseded: IncludeSuperseded): Promise<void> {
  if (replyIfDisabled(deps)) return;
  const query = trimArg(args);
  if (query === null) {
    deps.notify(OWL_FIND_USAGE, "error");
    return;
  }
  const compiled = tryCompileFindRegex(query);
  if ("error" in compiled) {
    deps.notify(compiled.error, "error");
    return;
  }
  await deps.checkThenServe(deps.key);
  await deps.pinCore();
  const graph = deps.getGraphStore().graph;
  const collected = await collectFindMatches(graph, [compiled.regex], includeSuperseded, VIEWER);
  if ("error" in collected) {
    deps.notify(collected.error, "error");
    return;
  }
  if (collected.matches.length === 0) {
    deps.notify(collected.note ?? NO_MATCHES, "info");
    return;
  }
  const lines = collected.matches.map((m) => m.render);
  if (collected.note !== undefined) lines.push(collected.note);
  const { text } = formatList(lines, deps.getSettings().commandResultCap);
  deps.notify(text, "info");
}

/** `/owl-find <query>` — JS regex search, default NON-obsolete. */
export async function runOwlFind(args: string, deps: OwlCommandDeps): Promise<void> {
  await runFind(args, deps, EXCLUDE_SUPERSEDED);
}

/** `/owl-find-all <query>` — same as find but ALL statuses incl. obsolete. */
export async function runOwlFindAll(args: string, deps: OwlCommandDeps): Promise<void> {
  await runFind(args, deps, INCLUDE_SUPERSEDED);
}
