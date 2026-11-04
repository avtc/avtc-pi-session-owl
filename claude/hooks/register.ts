// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// The plugin's single hooks entry (hooks.json names exactly this module):
// the event wiring for the whole port. `$` and every `$.noun.method(...)`
// call site are spelled literally INSIDE handler bodies — the engine's
// scanner (2.1.291+) refuses `$` itself, its nouns, and non-literal hook
// arguments crossing call boundaries, and `claude plugin validate ./claude`
// checks it offline. Each handler ARMS the bridge with capsule closures
// (created in the handler, literal calls in their bodies) so deep host code
// reaches the engine without ever seeing `$`; the handlers otherwise stay
// thin, delegating decisions and path math to the data-only claude/host/*
// modules.
import type { Register } from "claude-code";
import { log } from "../core/src/log.js";
import { captureAppend, getCapture, releaseAllCaptures, releaseCapture } from "../host/capture/append-handler.js";
import { flushTurn } from "../host/capture/flush.js";
import type { ClaudeRow } from "../host/capture/grouper.js";
// FIRST IMPORT — installs the claude-logger default backend the vendored
// core's log.ts needs at ITS module load (createLogger at top level). This
// module's own imports pull nothing but the logger library, so its body
// (setDefaultBackend) runs before any later import can evaluate log.ts.
import {
  type OwlCommandDeps,
  runOwlCat,
  runOwlFind,
  runOwlFindAll,
  runOwlLs,
  runOwlReobserve,
  runOwlRescan,
  runOwlStatus,
} from "../host/commands/handlers.js";
import { buildViewerTree, setViewerContent, VIEWER_PANE_ID } from "../host/commands/viewer.js";
import {
  AWAIT_STAGE_TOOL,
  joinStageRunSliced,
  raceTakeoverWithSignal,
  STAGE_SLICE_MS,
  withBudgetFreeWait,
} from "../host/compaction/budget-free.js";
import { type CompactEvent, compactionTakeover } from "../host/compaction/hook.js";
import { setRematExpectation } from "../host/compaction/remat.js";
import { recomputePauseSet, runConflictActivation } from "../host/conflicts/activation.js";
import { recordBWitness, recordFoldList } from "../host/conflicts/channel-a-prime.js";
import { handlePluginRegisterEnvelope, recordLiveOutcome, resetWaveLiveHits } from "../host/conflicts/channel-b.js";
import { observeCompactionRow, recordCompactAnswer } from "../host/conflicts/channel-c.js";
import {
  conflictPauseLogLine,
  conflictsDetectedLogLine,
  getConflictHits,
  isConflictPaused,
} from "../host/conflicts/pause.js";
import type { TimelineEvent } from "../host/conflicts/timeline.js";
import { parseTimelines } from "../host/conflicts/timeline.js";
import { evictResidentConversation, getCore, reloadCoreFor } from "../host/core-instances.js";
import * as bridge from "../host/engine-bridge.js";
import { mergePaneKeybindings } from "../host/keys/pane-bindings.js";
import { initLogConsumer } from "../host/log/consumer.js";
import { errDetail, guarded, sayError } from "../host/log/err-detail.js";
import { installUnhandledRejectionLogging } from "../host/log/unhandled.js";
import { sessionOwlNoun } from "../host/noun.js";
import { handleOwlRecallCall, type OwlRecallCallEvent } from "../host/recall/handler.js";
import { restyleToolResultProps } from "../host/recall/render.js";
import { OWL_RECALL_FULL_NAME } from "../host/recall/spec.js";
import { runPruneHelper } from "../host/retention/prune-caller.js";
import { checkpointService } from "../host/rewind/checkpoint-service.js";
import { LiveChainProcessor } from "../host/rewind/live-chain.js";
import { applyLiveRewind } from "../host/rewind/live-rewind.js";
import { readTail } from "../host/rewind/tail-read.js";
import { getBinding, releaseAllBindings, releaseBinding, StoreLoadingError, setSessionCwd } from "../host/runs/bind.js";
import { installRunsLogSink } from "../host/runs/seams.js";
import { getInstalledSettingsHandle, initSettingsConsumer } from "../host/settings/consumer.js";
import {
  ensureSettingsPane,
  getSettingsPaneController,
  manualJsonNoticeTree,
  SETTINGS_PANE_ID,
  takeSettingsPaneFirstRingOffer,
} from "../host/settings/pane.js";
import { noStageModelSettings, STAGE_AGENT_NAMES, stageAgentSpecs } from "../host/stage/agents.js";
import { shouldDropPeerMessage } from "../host/stage/delivery.js";
import { recordDumpOutputRow } from "../host/stage/dumps.js";
import { createLaunchBroker, STAGE_LAUNCHED_TOOL } from "../host/stage/launch.js";
import { getStagePrompts } from "../host/stage/prompts.js";
import { relayTurnStep } from "../host/stage/relay.js";
import { clearAllStageRuns, getStageRun } from "../host/stage/runs.js";
import { handleStageToolCall, resetStageToolExecutors, stageToolShortName } from "../host/stage/tools.js";
import { completionUsageOf } from "../host/stage/usage.js";
import { runBackfill } from "../host/start/backfill.js";
import { manualBootstrapCommand, runBootstrapHelper } from "../host/start/bootstrap-caller.js";
import { copyBranchLineageStore } from "../host/start/branch-copy.js";
import { onePerSession, runMirrorCompact } from "../host/start/compact-mirror.js";
import { launchGoalExtract, registerGoalExtractLauncher } from "../host/start/goal-extract.js";
import { runLedgerHeal } from "../host/start/ledger-heal.js";
import { corePendingEvaluator } from "../host/start/pending.js";
import { detailsWarmPending, markDetailsWarmDone, markDetailsWarmPending } from "../host/start/readiness.js";

/** The band's not-ready line: the store read and the details warm are still
 *  in flight — the owl draws its loading state instead of the store line. */
const OWL_LOADING_LINE = "🦉 loading memory — please wait before you proceed";

import { warmDetailsCache } from "../host/start/warm-details.js";
import * as state from "../host/state.js";
import {
  flushAllSessionStorage,
  flushSessionStorage,
  getSessionStorage,
  releaseAllSessionStorage,
  releaseSessionStorage,
} from "../host/storage/session-storage.js";
import { newestAssistantUuid, shouldFireBoundary } from "../host/triggers/boundary-gate.js";
import { recordMeasure, seedWindow } from "../host/triggers/context.js";
import { onStepBoundary, onTurnCompleteBoundary } from "../host/triggers/eval.js";
import { abortActiveFor, abortAllForSessionEnd, awaitIdle } from "../host/triggers/run-locks.js";
import { composeBand, decideBand } from "../host/widget/band.js";
import { consumeIdleRefresh } from "../host/widget/line-store.js";
import { formatPauseLine } from "../host/widget/pause-line.js";
import { buildPaneTree } from "../node_modules/avtc-claude-settings-ui/dist/index.js";

// runsLog → the file logger: one sink swap at load, so trigger/chain/run
// diagnostics land in the session-owl log instead of engine --debug only.
installRunsLogSink((message, cause) => {
  if (cause === undefined) {
    log.info(message);
  } else {
    log.warn(`${message}: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
});

// The process-level net FIRST (before any wiring can float a promise): a
// rejection nobody catches lands in the file log with its stack instead of
// the engine's transient "mod .catch" warning, with the stack attached.
installUnhandledRejectionLogging();

// Event inputs are structural (the engine's envelopes); handler params stay
// permissive where the shapes are wide — the validator + kit specs pin them.
type AnyEvent = Record<string, any>;
type Next = any;

function report(kind: string, err: unknown): void {
  // The one error transport: the FILE log AND the
  // engine's $.ui.log (a dim transcript row the user sees — the engine's
  // debug log carries it either way), console only when neither channel
  // exists yet (module-load / pre-arm). The stack rides along via errDetail.
  // The ui copy drops the manual prefix — the engine's row attribution
  // already names the plugin (no "session-owl: session-owl: " doubling).
  sayError(`session-owl: ${kind}: ${errDetail(err)}`, { uiText: `${kind}: ${errDetail(err)}` });
}

/** A diagnostic line: the file log carries it (info — the live-session
 *  evidence surface), the engine's debug log duplicates it via uiLog.
 *  Degrades to the file alone before the first arm — and NEVER throws:
 *  a throw at the top of a hook makes the engine skip the whole hook. */
function diag(message: string): void {
  try {
    log.info(message);
  } catch (err) {
    // diagnostics never throw — the file logger itself failed: sayError
    // retries the transports, console only when both refuse
    try {
      sayError(`session-owl: file log failed: ${errDetail(err)}`);
    } catch {
      // nothing exists to say it with
    }
  }
  try {
    const svcs = bridge.currentServices();
    if (typeof svcs.uiLog === "function") svcs.uiLog(message, { to: "debug" });
  } catch (err) {
    // never let diagnostics throw — but never lose the reason either:
    // sayError retries both transports and consoles only when both refuse
    try {
      sayError(`session-owl: diagnostics failed: ${errDetail(err)}`);
    } catch {
      // nothing exists to say it with
    }
  }
}

// --- engine + plugin lifecycle ------------------------------------------------

async function onEngineCreate(_$: any, e: AnyEvent, next: Next) {
  // `$` here is the EMPTY table — build first, then fold the noun in.
  const built = await next(e);
  // Channel A-prime input: the COMPLETE module list of the load in chain
  // order (mods that loaded before owl are invisible to plugin.register).
  // engine.create refires on any reload when a module hooks it (owl does),
  // so this doubles as the Channel-B wave reset: the envelopes that follow
  // repopulate the live hit set (the pause auto-recovers on reload).
  const plugins = (e as { plugins?: unknown }).plugins;
  if (Array.isArray(plugins)) {
    recordFoldList(
      plugins
        .map((p) =>
          typeof p === "string"
            ? p
            : typeof (p as { name?: unknown })?.name === "string"
              ? (p as { name: string }).name
              : "",
        )
        .filter((n) => n !== ""),
    );
  }
  resetWaveLiveHits();
  return { ...built, sessionOwl: sessionOwlNoun() };
}

/** The last pause state mirrored into the timeline (transition detection:
 *  recompute sites call syncPauseIntoTimeline so the Channel C windows
 *  close exactly when a pause lifts, not on stale evidence). */
let timelinePausedMirror = false;

/** Recompute the effective pause set and mirror any FLIP into the timeline
 *  (pause opens the not-active boundary; resume closes it). Fire-and-forget
 *  like every timeline append — the timeline is best-effort evidence. */
function syncPauseIntoTimeline(): void {
  const paused = isConflictPaused(() => ({
    enabled: state.isOwlEnabled(),
    ignoreConflicts: state.isOwlIgnoreConflicts(),
  }));
  if (paused !== timelinePausedMirror) {
    timelinePausedMirror = paused;
    guarded(appendTimelineEvent({ t: paused ? "pause" : "resume", at: Date.now() }), "timeline append");
  }
}

async function onPluginRegister($: any, e: AnyEvent, next: Next) {
  // Channel B — the live envelope listener: session.compact matched against
  // uses.events as patterns, then the bounded scan over the envelope's root
  // separates overriders from passive registrants. A hit pauses immediately
  // (the live predicate reads the merged set); builtin tier is witnessed but
  // never scanned (inner — cannot override).
  try {
    const name = typeof (e as { name?: unknown }).name === "string" ? (e as { name: string }).name : null;
    if (name !== null) {
      const tier = typeof (e as { tier?: unknown }).tier === "string" ? (e as { tier: string }).tier : "user";
      const root = typeof (e as { root?: unknown }).root === "string" ? (e as { root: string }).root : "";
      const uses = (e as { uses?: { events?: unknown } }).uses;
      const events =
        uses && Array.isArray(uses.events) ? uses.events.filter((x): x is string => typeof x === "string") : [];
      const result = await handlePluginRegisterEnvelope(
        { name, tier, root, events },
        {
          list: (d) => $.fs.list(d),
          read: (p) => $.fs.read(p),
          stat: (p) => $.fs.stat(p),
        },
        { selfName: "session-owl", familyPrefix: "avtc-claude-" },
      );
      recordBWitness(result.witness);
      recordLiveOutcome(result.hit, result.advisory);
      if (result.hit !== null) {
        log.warn(`conflict: ${result.hit.name} registers session.compact (${result.hit.evidence}) — pausing`);
      } else if (result.advisory !== null) {
        log.info(
          `advisory: ${result.advisory.name} registers only classic compaction hooks (${result.advisory.evidence}) — no pause`,
        );
      }
      // EVERY envelope recomputes the effective set (hit or not): the wave
      // started at engine.create with a cleared live set, so envelopes that
      // never re-fire (a removed mod) drop out and the pause auto-recovers
      // as the wave settles — strictly before any compaction can run (the
      // envelope IS the registration). Channel A's STATIC hits re-enumerate
      // at process start only: their recovery stays restart-only — pi's
      // parity, honestly bounded.
      recomputePauseSet();
      syncPauseIntoTimeline();
    }
  } catch (err) {
    report("conflict channel B failed", err);
  }
  return next(e);
}

// --- session lifecycle ----------------------------------------------------------

/** Register owl's surfaces that need `$` capsules: the tools, the commands,
 *  the three stage agent types. Shared by both
 *  session-start arms (idempotence lives in state's pending* queues). */
async function registerSurfaces($: any): Promise<void> {
  // One queue at a time: a source the engine REFUSES (the startup classic
  // start fires before the session binds, so $.tool.register is unavailable
  // there) must not burn the queue's read-once gate — a queue that served
  // NOTHING reopens for the bound source that follows — and must never
  // abort the caller's remaining bootstrap work (a warning replaces the
  // throw; a partially served queue stays consumed, no duplicate service).
  await serveQueue(
    "tools",
    () => state.pendingToolSpecs(),
    (tool) => $.tool.register(tool),
    state.reopenToolRegistrationGate,
  );
  await serveQueue(
    "stage tools",
    () => state.pendingStageToolSpecs(),
    (tool) => $.tool.register(tool),
    state.reopenStageToolRegistrationGate,
  );
  await serveQueue(
    "commands",
    () => state.pendingCommandSpecs(),
    (command) => $.command.register(command),
    state.reopenCommandRegistrationGate,
  );
  await serveQueue(
    "stage agents",
    () => state.pendingAgentSpecs(stageAgentSpecs({ ...getStagePrompts(), settings: noStageModelSettings() })),
    (spec) => $.agent.register(spec),
    state.reopenAgentRegistrationGate,
  );
}

/** Serve one registration queue: item by item; the first REFUSAL (with
 *  nothing served yet) reopens the queue's gate so the next start source
 *  retries, then resolves — registration is best-effort and bootstraps
 *  depend on it never throwing. The gate read itself runs through the same
 *  promise: whatever it raises is a defer, never an abort. */
async function serveQueue<T>(
  label: string,
  gate: () => T[],
  serve: (item: T) => Promise<void>,
  reopen: () => void,
): Promise<void> {
  let items: T[] = [];
  try {
    items = gate();
  } catch (err) {
    log.warn(`${label}: registration deferred (gate read failed): ${err instanceof Error ? err.message : String(err)}`);
    return;
  }
  let served = 0;
  for (const item of items) {
    try {
      await serve(item);
      served += 1;
    } catch (err) {
      if (served === 0) reopen();
      log.warn(
        `${label}: registration deferred to the next start source: ${err instanceof Error ? err.message : String(err)}`,
      );
      return;
    }
  }
}

/** The ONE bridge arm table, shared by every handler. arm() REPLACES the
 *  whole service table, so any handler arming a subset would strip services
 *  other consumers reach through currentServices() at call time (the
 *  settings after-change capsules, the stage spawn path) — the full
 *  superset from every handler keeps them alive across re-arms. */
/** The spawn answer as one log line: the full raw shape, whatever it is. */
function describeSpawnAnswer(handle: unknown): string {
  try {
    return JSON.stringify(handle) ?? String(handle);
  } catch {
    return String(handle);
  }
}

function armAll(dollar: any) {
  // the launch broker's capsules (re-armed with the fresh dollar, the same
  // replace-on-arm rule as the bridge table below)
  stageLaunchBroker.arm({
    launchViaCompanion: (spec: Record<string, unknown>) =>
      dollar.tool.call({ tool: "mcp__session-owl-subagent-support__launch", ...spec }),
    spawnDirect: async (input: Record<string, unknown>) => {
      const handle = (await dollar.agent.spawn(input as never)) as { model?: unknown; agentId?: unknown };
      const agentId = (handle as { agentId?: unknown }).agentId;
      if (typeof agentId !== "string" || agentId.length === 0) {
        // the full answer, verbatim: an id-less resolve differs per surface
        // (a permission deny resolves rather than rejecting), and the raw
        // shape tells them apart
        log.warn(`stage spawn answer without an agentId: ${describeSpawnAnswer(handle)}`);
        throw new Error("stage spawn resolved without an agentId");
      }
      return { model: typeof handle.model === "string" ? handle.model : "", agentId };
    },
    warn: (message: string) => log.warn(message),
  });
  bridge.arm({
    envGetConfigDir: () => dollar.env.get("CLAUDE_CONFIG_DIR"),
    envGetHome: () => dollar.env.get("HOME"),
    envGetSessionOwlSettings: () => dollar.env.get("CLAUDE_SETTINGS_SESSION_OWL"),
    envSetSessionOwlSettings: (v: string) => dollar.env.set("CLAUDE_SETTINGS_SESSION_OWL", v),
    fsWrite: (p: string, t: string) => dollar.fs.write(p, t),
    fsRead: (p: string) => dollar.fs.read(p),
    fsList: (d: string) => dollar.fs.list(d),
    fsStat: (p: string) => dollar.fs.stat(p),
    uiLog: (text: string, opts?: { to?: string }) => dollar.ui.log(text, opts),
    uiOpen: (args: unknown) => dollar.ui.open(args),
    uiClose: () => dollar.ui.close({ id: SETTINGS_PANE_ID }),
    uiInvalidate: () => dollar.ui.invalidate("ui.render"),
    toolRegister: (s: unknown) => dollar.tool.register(s),
    commandRegister: (s: unknown) => dollar.command.register(s),
    agentRegister: (spec: unknown) => dollar.agent.register(spec),
    // stage launches route through the companion (a refused launch or a
    // missing callback degrades to this direct spawn — the broker's
    // capsules are re-armed per surface arm like every service here)
    agentSpawn: (input: unknown) => stageLaunchBroker.spawn(input as Record<string, unknown>),
    // The over-cap bootstrap ladder for lanes that run inside a hook
    // budget (the conversation binding): the ladder itself runs on the
    // timer lane — off every hook budget — through the SAME per-session
    // rewrite lane the boot's inline run uses, and the conversation
    // re-prepares over the ladder's batches once it lands
    armBootstrap: (transcriptPath: string) => {
      const configDir = state.getCachedConfigDir();
      const sessionId = state.getCurrentSession();
      if (configDir === null || sessionId === null) return;
      try {
        dollar.clock.after(0, () => {
          void (async () => {
            try {
              const result = await onePerSession(configDir, sessionId, () =>
                runBootstrapHelper(
                  {
                    runProcess: (argv) => bridge.currentServices().processRun(argv),
                    log: (m, err) =>
                      log.warn(
                        `${m}${err instanceof Error ? `: ${err.message}` : err !== undefined ? `: ${String(err)}` : ""}`,
                      ),
                  },
                  {
                    surface: lastStartSurface,
                    transcriptPath,
                    configDir,
                    sessionId,
                    pluginRoot: bridge.currentServices().pluginRoot(),
                  },
                ),
              );
              if (result.ok) {
                // the ladder's batches are on disk — the live binding must
                // re-derive over them (sweep + adopt + re-prepare), or the
                // main conversation serves its pre-ladder stump until the
                // next process start
                getBinding(sessionId, sessionId, null).reprepareStore();
              }
            } catch (err) {
              log.warn(`bootstrap ladder (timer lane) failed: ${err instanceof Error ? err.message : String(err)}`);
            }
          })();
        });
      } catch (err) {
        log.warn(`bootstrap ladder arm failed — the rung waits for the next start: ${errText(err)}`);
      }
    },
    sessionSurfaces: () => dollar.session.surfaces(),
    agentList: () => dollar.agent.list(),
    configList: () => dollar.config.list(),
    widgetLog: (message: string) => log.info(message),
    pluginRoot: () => dollar.plugin.root,
    processRun: (argv: string[]) => dollar.process.run(argv),
    sessionAppend: (input: unknown) => dollar.session.append(input as never),
    modelComplete: (req: unknown, opts: unknown) => dollar.model.complete(req, opts),
    uiStatus: (text: string | undefined) => dollar.ui.status(text),
    avtcTodoGetItems: () => dollar.avtcTodo.getItems(),
    // $.tool.call takes ONE input object ({tool, ...args}) — a (name, args)
    // pair is rejected ("input must be an object")
    toolCall: (name: string, args?: unknown) => dollar.tool.call({ tool: name, ...(args as Record<string, unknown>) }),
    clockAfter: (ms: number, fn: () => void) => dollar.clock.after(ms, fn),
    clockEvery: (ms: number, fn: () => void) => dollar.clock.every(ms, fn),
    log: (m: string) => log.warn(m),
  });
}

// The last engine session.start surface (null = CLI -p): the retention
// sweep runs only where processes can (CLI); the desktop defers.
let lastStartSurface: string | null = null;

async function onSessionStart($: any, e: AnyEvent, next: Next) {
  armAll($);
  lastStartSurface =
    typeof (e as { surface?: unknown }).surface === "string" ? (e as { surface: string }).surface : null;
  // lifecycle trace: the modern start's identity — its
  // absence next to a classic pulse is itself the finding
  diag(
    `session.start surface=${lastStartSurface ?? "-"} session=${String((e as { session_id?: unknown } | null)?.session_id ?? "?")} cwd=${e != null && typeof e.cwd === "string" ? e.cwd : "<absent>"}`,
  );
  try {
    // Registration first: surfaces never depend on the config dir, and a
    // missing-dir environment must not silently unregister the mod.
    await registerSurfaces($);
    const cfg = await $.env.get("CLAUDE_CONFIG_DIR");
    const home = await $.env.get("HOME");
    const profile = await $.env.get("USERPROFILE");
    const configDir = state.resolveConfigDir(cfg, home ?? profile);
    // the pane's shipped keybindings (pi's Tab-pages / Ctrl+S save): a
    // merge-only-if-absent install into the person's keybindings.json —
    // their own bindings always win; failures log and never block. The
    // RESOLVED dir (the env var is unset in normal terminals — the home
    // fallback is the real ~/.claude)
    try {
      await mergePaneKeybindings(
        {
          readTextFile: (path) => $.fs.read(path),
          writeTextFile: (path, text) => $.fs.write(path, text),
          // the merge's own outcomes are INFORMATIONAL (a success trace or
          // "current (no changes)") — the diag channel (file INFO + the
          // debug-only ui copy), never the user-visible error transport
          log: (message) => diag(`pane keybindings: ${message}`),
        },
        configDir,
      );
    } catch (err) {
      report("pane keybindings merge failed", err);
    }
  } catch (err) {
    // registration failures must never block the session — the engine log
    // names the plugin; the session continues without our surfaces
    report("registration failed", err);
  }
  return next(e);
}

// --- the conflict activation (once per process) ---------------------------------------

let conflictActivationDone = false;

/** Channels A + A-prime over the live B merge, once per process, with pi's
 *  log ladder. Every $ touch is spelled literally here (the scanner's
 *  rule); the five settings reads enumerate the sources the engine itself
 *  applies (policy > flag > local > project > user). */
async function runConflictActivationOnce($: any, configDir: string, selfRoot: string): Promise<void> {
  if (conflictActivationDone) return;
  conflictActivationDone = true;
  try {
    const root = configDir.replace(/[\\/]+$/, "");
    const readInstalled = async (): Promise<unknown> => {
      try {
        const text = await $.fs.read(`${root}/plugins/installed_plugins.json`);
        return JSON.parse(text) as unknown;
      } catch (err) {
        log.info(`installed-plugins registry unreadable — degrade to empty: ${errText(err)}`);
        return null; // missing/malformed registry — degrade to empty
      }
    };
    const pluck = (v: unknown): Record<string, boolean> | null => {
      const map = (v as { enabledPlugins?: unknown }).enabledPlugins;
      return typeof map === "object" && map !== null ? (map as Record<string, boolean>) : null;
    };
    const userSettings = await $.settings.read({ source: "user" });
    const projectSettings = await $.settings.read({ source: "project" });
    const localSettings = await $.settings.read({ source: "local" });
    const flagSettings = await $.settings.read({ source: "flag" });
    const policySettings = await $.settings.read({ source: "policy" });
    const maps = {
      user: pluck(userSettings),
      project: pluck(projectSettings),
      local: pluck(localSettings),
      flag: pluck(flagSettings),
      policy: pluck(policySettings),
    };
    const out = await runConflictActivation(
      {
        readInstalledPlugins: () => readInstalled(),
        readEnabledPlugins: (source) => Promise.resolve(maps[source]),
        list: (d) => $.fs.list(d),
        read: (p) => $.fs.read(p),
        stat: (p) => $.fs.stat(p),
      },
      {
        selfName: "session-owl",
        selfRoot,
        familyPrefix: "avtc-claude-",
        enabled: state.isOwlEnabled(),
        ignoreConflicts: state.isOwlIgnoreConflicts(),
      },
    );
    if (out.log === "pause") {
      log.info(conflictPauseLogLine());
    } else if (out.log === "ignore-conflicts") {
      log.warn(conflictsDetectedLogLine());
    }
  } catch (err) {
    report("conflict activation failed", err);
  }
}

async function onClassicSessionStart($: any, e: AnyEvent, next: Next) {
  armAll($);
  // released by the failure catch below when a start dies before the
  // warm is ever scheduled (nothing else would clear the gate)
  let warmGateArmed = false;
  // lifecycle trace: which start pulse actually fires, with
  // what source, and whether the envelope carries its cwd — every settings,
  // backfill and boundary decision below keys off these three facts
  diag(
    `classic SessionStart source=${String((e as { source?: unknown } | null)?.source ?? "?")} session=${String(
      (e as { session_id?: unknown } | null)?.session_id ?? "?",
    )} cwd=${e != null && typeof e.cwd === "string" ? e.cwd : "<absent>"}`,
  );
  try {
    // The module-load arming of the warm latch releases here: a start that
    // will not run the warm (every early return below — a compact re-fire,
    // a sessionless envelope, a disabled owl) must not leave the band on
    // the loading line forever. The active path re-arms below before the
    // backfill resolves.
    markDetailsWarmDone();
    warmGateArmed = false;
    // The {compact} source takes NO action (the union's fifth start
    // source): a native compaction re-fires classic.SessionStart after the
    // summary row — re-running the bootstrap would rebuild the settings
    // library, re-anchor the timeline, and append a redundant CHECK.
    if (e && (e as { source?: unknown }).source === "compact") {
      return next(e);
    }
    if (e && typeof e.session_id === "string") {
      // The session cwd rides the envelope: the dumps' per-project dir stem
      // + the goal-extract launcher's conversation lookup.
      if (typeof e.cwd === "string") setSessionCwd(e.cwd);
      // The goal-extract launcher (the boot backfill's fresh-capture hook):
      // the real extraction over the conversation binding (the one-shot
      // model capsule + the don't-clobber run; a missing model skips with a
      // log — the Builder is the backstop, pi's degraded behavior).
      registerGoalExtractLauncher((verbatim: string, sessionId: string) => {
        void getBinding(sessionId, sessionId, null)
          .launchGoalExtract(verbatim)
          .catch((cause: unknown) => {
            log.warn(`goal extract failed: ${cause instanceof Error ? cause.message : String(cause)}`);
          });
      });
      // Registration first (same rule as session.start).
      const cfg = await $.env.get("CLAUDE_CONFIG_DIR");
      const home = await $.env.get("HOME");
      const profile = await $.env.get("USERPROFILE");
      state.resolveConfigDir(cfg, home ?? profile);
      // The family-library runtimes land BEFORE the surfaces register (the
      // enable gate reads live settings; the surfaces consult it).
      const configDir = state.getCachedConfigDir() ?? "";
      initLogConsumer({
        configDir,
        fs: {
          read: (p) => bridge.currentServices().fsRead(p),
          write: (p, t) => bridge.currentServices().fsWrite(p, t),
          list: (d) => bridge.currentServices().fsList(d),
        },
      });
      await initSettingsConsumer({
        configDir,
        cwd: typeof e.cwd === "string" ? e.cwd : "",
        fs: {
          read: async (p) => {
            try {
              const text = await bridge.currentServices().fsRead(p);
              if (p.includes("avtc-session-owl-settings")) {
                log.info(
                  `settings fs.read probe path=${p} bytes=${text === null || text === undefined ? "null" : String(text).length}`,
                );
              }
              return text;
            } catch (err) {
              log.info(`settings pane fs read failed (${p}): ${errText(err)}`);
              return null;
            }
          },
          write: (p, c) => bridge.currentServices().fsWrite(p, c),
          exists: async (p) => {
            try {
              await bridge.currentServices().fsRead(p);
              return true;
            } catch (err) {
              log.info(`settings pane fs exists=false (${p}): ${errText(err)}`);
              return false;
            }
          },
        },
        env: {
          // EnvStore contract: get(name) / set(name, value). The NAME the
          // library passes is IGNORED on purpose — the bridge capsules pin
          // the literal (the env validator enumerates per-variable sites),
          // so only the VALUE crosses this seam. A set that passed the NAME
          // as the value would write a variable name where the value
          // belongs: every later load then fails its JSON.parse and falls
          // back to full defaults (the resume/branch settings reset).
          get: async (name: string) => {
            void name; // pinned literal inside the capsule, never the argument
            let raw: string | undefined;
            try {
              const value = await bridge.currentServices().envGetSessionOwlSettings();
              raw = typeof value === "string" || value === undefined ? value : String(value);
            } catch (err) {
              log.info(`settings env.get probe THREW: ${errText(err)}`);
              throw err;
            }
            log.info(
              `settings env.get probe = ${raw === undefined ? "undefined" : JSON.stringify(String(raw).slice(0, 200))}`,
            );
            return raw;
          },
          set: (name: string, value: string) => {
            void name; // pinned literal inside the capsule, never the argument
            log.info(`settings env.set probe name=${name} valueHead=${JSON.stringify(String(value).slice(0, 80))}`);
            return bridge.currentServices().envSetSessionOwlSettings(value);
          },
        },
        capsules: {
          toolRegister: (s) => bridge.currentServices().toolRegister(s),
          uiInvalidate: () => bridge.currentServices().uiInvalidate(),
          uiStatus: (text) => bridge.currentServices().uiStatus(text),
          appendTimeline: (t) => guarded(appendTimelineEvent({ t, at: Date.now() }), "timeline append"),
        },
      });
      await registerSurfaces($);
      // Prime the main conversation's binding here: the band's idle line
      // gains its provider and the store's counts before any frame that
      // outlives the opening one (turns, compaction and recall would each
      // have created this same instance on first use).
      void getBinding(e.session_id, e.session_id, null);
      // Branch/fork lineage: under this new id the engine
      // copied a /branch or /fork's TRANSCRIPT (the first row's
      // forkedFrom.sessionId names the origin) — copy the origin's owl
      // store too, BEFORE the marker write and any storage assembly touch
      // this directory, so derived observations, checkpoints and watermarks
      // survive the branch. Source-gated to fork; every guard inside keeps
      // the helper inert on a normal start or a populated target.
      if ((e as { source?: unknown }).source === "fork") {
        await copyBranchLineageStore({
          sessionId: e.session_id,
          transcriptPath: typeof e.transcript_path === "string" ? e.transcript_path : "",
          targetDir: state.sessionDirPath(state.getCachedConfigDir() ?? "", e.session_id, null),
          originDirPathFor: (id) => state.sessionDirPath(state.getCachedConfigDir() ?? "", id, null),
          io: {
            read: async (path) => await $.fs.read(path),
            list: async (dir) => await $.fs.list(dir),
            write: async (path, text) => await $.fs.write(path, text),
          },
          log: (line) => log.info(line),
        });
      }
      // The .session.json marker: facts from the envelope, never derived
      // from cwd (a /cd mid-session must not move it). An absent or
      // corrupt marker is simply replaced (tolerant read).
      await $.fs.write(state.sessionMarkerPath(e.session_id), state.sessionMarkerJson(e.session_id, e.transcript_path));
      state.setCurrentSession(e.session_id);
      state.setCurrentTranscriptPath(typeof e.transcript_path === "string" ? e.transcript_path : null);
      state.ensureConversation(e.session_id, null);
      // The engine's live session model — `$.session.model()` answers the
      // main loop's model with a CONCRETE id at start, before any message
      // (the /config row would carry the default-model display label, which
      // no API request accepts). Best-effort: a rejected read leaves the
      // slot empty (goalModelSetting skips with the Builder backstop), and
      // the setter discards any label-shaped value regardless.
      try {
        state.setSessionModel(await $.session.model());
      } catch (err) {
        log.info(`session model read failed — the slot stays unset: ${errText(err)}`);
        // the read is an optimization, never a gate
      }
      // The widget's context-window denominator: pi resolves the slot's
      // window from its model registry the moment a stage's first message
      // lands; the port has no registry, so read the engine's own window
      // here — before any turn produces a `session.measure` row — and a
      // rescan started at startup already shows {fill}/{window}. Best-effort
      // like the model read: a failed pull leaves the map as it was.
      try {
        const usage = await $.session.usage();
        const session = state.getCurrentSession();
        if (session !== null && typeof usage.context.window === "number") {
          seedWindow(session, usage.context.window);
        }
      } catch (err) {
        log.info(`session usage lookup failed — the widget window stays unseeded: ${errText(err)}`);
        // the read is an optimization, never a gate
      }
      // Restart persistence for the rewind alignment's compaction exemption
      // + the resume exemption — BOTH must precede the process-start
      // checkpoint below: that check adjudicates the resumed view against
      // the mirror, and these boundaries change what it expects.
      // The conflict activation (Channels A + A-prime over the live B merge):
      // deterministic, activation-time, precedes-all-LLM-cost self-restraint.
      // Runs once per process (the installed set cannot change mid-process;
      // reload waves recompute through Channel B).
      await runConflictActivationOnce($, configDir, $.plugin.root);
      // The per-process timeline anchor: an enabled owl records its enable
      // transition (and a pause mirror when the activation found conflicts),
      // so Channel C's owl-active windows cover this process from the start.
      if (state.isOwlEnabled()) {
        guarded(appendTimelineEvent({ t: "enable", at: Date.now() }), "timeline append");
        if (
          isConflictPaused(() => ({
            enabled: state.isOwlEnabled(),
            ignoreConflicts: state.isOwlIgnoreConflicts(),
          }))
        ) {
          guarded(appendTimelineEvent({ t: "pause", at: Date.now() }), "timeline append");
        }
      }
      // Restart persistence for the rewind alignment's compaction exemption
      // was moved ABOVE the process-start checkpoint (the start check
      // adjudicates against these boundaries). Loop keys re-arm through
      // their own answers.
      // The start sequence (runBackfill): sweep + transcript read +
      // crash-window re-mirror + store reconstruction + initial prompt
      // capture + the pending-backlog derivation. The storage assembly
      // owns the conversation's live writers — appends after this start
      // flow into the same mirror/ledger. The enabled gate folds the
      // conflict pause (a paused owl persists no observations; the graph
      // still reconstructs read-only — pi's dormant parity).
      const owlActive =
        state.isOwlEnabled() &&
        !isConflictPaused(() => ({
          enabled: state.isOwlEnabled(),
          ignoreConflicts: state.isOwlIgnoreConflicts(),
        }));
      const convKey = state.conversationKey(e.session_id, null);
      const storage = getSessionStorage(convKey, e.session_id, null);
      // the readiness gate opens only after the store read AND the details
      // warm — the owl line waits for a system that can serve queries from
      // cache. The warm is scheduled AFTER the backfill resolves (the core
      // exists by then — an early getCore would materialize an empty one)
      // and runs on the timer lane, away from every hook budget. A start
      // that fails before the warm is scheduled releases the gate here —
      // nothing else would ever clear it.
      if (owlActive) {
        markDetailsWarmPending();
        warmGateArmed = true;
      }
      const bootResult = await runBackfill(storage.mirror, storage.ledger, {
        key: convKey,
        sessionId: e.session_id,
        agentId: null,
        fs: storage.fs,
        transcriptPath: state.getCurrentTranscriptPath(),
        enabled: owlActive,
        fireGoalExtract: (verbatim: string) => launchGoalExtract(verbatim, e.session_id),
        forkParentSessionId: null,
        computePending: corePendingEvaluator,
        bootstrapOverCap:
          state.getCurrentTranscriptPath() !== null
            ? async (transcriptPath) => {
                // the ladder's automatic rung: CLI surfaces stream the
                // over-cap transcript through the node helper before the
                // sweep; anything else defers and /owl-status documents
                // the manual command. The run rides the per-session lane —
                // the same lane the mirror compact and every other
                // store-rewriting helper uses — so an inline boot run and a
                // timer-armed run can never rewrite the directory in
                // parallel
                const result = await onePerSession(configDir, e.session_id, () =>
                  runBootstrapHelper(
                    {
                      runProcess: (argv) => bridge.currentServices().processRun(argv),
                      log: (m, err) =>
                        log.warn(
                          `${m}${err instanceof Error ? `: ${err.message}` : err !== undefined ? `: ${String(err)}` : ""}`,
                        ),
                    },
                    {
                      surface: lastStartSurface,
                      transcriptPath,
                      configDir,
                      sessionId: e.session_id,
                      pluginRoot: bridge.currentServices().pluginRoot(),
                    },
                  ),
                );
                return result.ok;
              }
            : undefined,
        compactMirror:
          state.getCurrentTranscriptPath() !== null
            ? async () => {
                // the resume-time rewrite when the duplicate census crosses:
                // real unlink needs the node process seam (a surface without
                // it keeps the duplicates — disk cost only, never correctness)
                const result = await runMirrorCompact(
                  {
                    runProcess: (argv) => bridge.currentServices().processRun(argv),
                    log: (m, err) =>
                      log.warn(
                        `${m}${err instanceof Error ? `: ${err.message}` : err !== undefined ? `: ${String(err)}` : ""}`,
                      ),
                  },
                  {
                    pluginRoot: bridge.currentServices().pluginRoot(),
                    configDir,
                    sessionId: e.session_id,
                    transcriptPath: state.getCurrentTranscriptPath(),
                  },
                );
                return result.done;
              }
            : undefined,
        healLedger:
          state.getCurrentTranscriptPath() !== null
            ? async () => {
                // restated lineage storage heals through the node process
                // seam (a surface without it loads the redundant stream and
                // a later load retries — correctness never depends on it)
                return runLedgerHeal(
                  {
                    runProcess: (argv) => bridge.currentServices().processRun(argv),
                    log: (m, err) =>
                      log.warn(
                        `${m}${err instanceof Error ? `: ${err.message}` : err !== undefined ? `: ${String(err)}` : ""}`,
                      ),
                  },
                  {
                    pluginRoot: bridge.currentServices().pluginRoot(),
                    sessionDir: state.sessionDirPath(configDir, e.session_id, null),
                  },
                );
              }
            : undefined,
      })
        .then((backfillResult) => {
          // the blocked-backlog note for /owl-status (the ladder's rung 2 hint
          // " + EM + " the exact manual command, cleared on every clean start)
          state.setBootstrapBlockedCommand(
            backfillResult.bootstrapBlocked && state.getCurrentTranscriptPath() !== null
              ? manualBootstrapCommand({
                  surface: "terminal",
                  transcriptPath: state.getCurrentTranscriptPath() ?? "",
                  configDir,
                  sessionId: e.session_id,
                  pluginRoot: bridge.currentServices().pluginRoot(),
                })
              : null,
          );
          return backfillResult;
        })
        .then(async (backfillResult) => {
          // the backfill created the core — the warm renders every
          // observation's verbatim source into the conversation's cache so
          // the first query serves from it instead of inside a
          // budget-capped serve hook. It runs on the TIMER lane: pure JS
          // never freezes the hook clock (only engine-served calls do), so
          // an awaited warm would burn the start budget — the timer lane
          // carries multi-second verdict applications already. The owl
          // line (gated on readiness) appears when the warm completes.
          if (owlActive) {
            try {
              $.clock.after(0, () => {
                void (async () => {
                  try {
                    const handle = await getCore(convKey);
                    const store = handle.store.getGraphStore();
                    const resolver = store.resolveEntries;
                    if (resolver !== null) {
                      const report = await warmDetailsCache({
                        key: convKey,
                        graph: store.graph,
                        resolver,
                        detailsWrite: handle.details.computeDetailsAndCacheFor,
                        // the hooks sandbox has no setImmediate — the engine's
                        // own timer is the sanctioned event-loop yield (a
                        // microtask lane starves the host heartbeat and the
                        // worker is respawned with the plugin unloaded)
                        yieldLane: () =>
                          new Promise<void>((resolve) => {
                            $.clock.after(0, () => resolve());
                          }),
                      });
                      // the cross-lane stamp: the boot lane's derivation is THE state for
                      // this session in this process — the conversation binding re-checks
                      // it under its lock and fast-exits instead of re-deriving (the boot
                      // re-runs on every session start, so a resume/switch re-stamps)
                      storage.sharedPrepared = { context: bootResult.prepared, sessionId: e.session_id };

                      log.info(
                        `owl ready — details cache warmed: ${report.warmed} observation(s) (${report.failed} failed) in ${report.ms}ms`,
                      );
                    } else {
                      log.info("owl ready — no entry resolver yet (the cache warms on first serve)");
                    }
                  } catch (err) {
                    log.warn(
                      `details cache warm failed (queries render inline until the cache fills): ${errText(err)}`,
                    );
                  } finally {
                    markDetailsWarmDone();
                    try {
                      $.ui.invalidate("ui.render");
                    } catch {
                      // the pane may not exist yet — the next engine render picks the line up
                    }
                  }
                })();
              });
            } catch (err) {
              log.warn(`details warm scheduling failed: ${errText(err)}`);
              markDetailsWarmDone();
            }
          }
          return backfillResult;
        });
      // The mirror-retention sweep (the S5 read path): planned from the LIVE
      // settings (mirrorRetentionDays — keep-forever by default), run on CLI
      // surfaces via $.process.run, and never blocking the start sequence.
      try {
        const live = getInstalledSettingsHandle()?.getSettings() as { mirrorRetentionDays?: unknown } | undefined;
        const retentionDays = typeof live?.mirrorRetentionDays === "number" ? live.mirrorRetentionDays : null;
        await runPruneHelper(
          {
            runProcess: (argv) => bridge.currentServices().processRun(argv),
            log: (message, err) =>
              log.warn(
                `${message}${err instanceof Error ? `: ${err.message}` : err !== undefined ? `: ${String(err)}` : ""}`,
              ),
          },
          {
            surface: lastStartSurface,
            retentionDays,
            followCleanupPeriodDays: false,
            configDir,
            pluginRoot: bridge.currentServices().pluginRoot(),
          },
        );
      } catch (err) {
        report("mirror retention sweep failed", err);
      }
    }
  } catch (err) {
    if (warmGateArmed) markDetailsWarmDone();
    report("session bootstrap failed", err);
  }
  return next(e);
}

// --- the conflict timeline (Channel C's substrate) -------------------------------------
//
// Per-process timeline-<tag>.jsonl INSIDE the main session directory
// (<configDir>/session-owl/sessions/<sessionId>/) — enable/disable and
// pause/resume transitions plus compaction answers/skips with coordinates;
// the union read across processes feeds the owl-active windows and the
// adjudicated-row set. Living in the session dir means the retention prune
// collects the timeline with the session's own data.

const TIMELINE_TAG = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

function timelineDir(): string | null {
  const cfg = state.getCachedConfigDir();
  const sid = state.getCurrentSession();
  if (cfg === null || sid === null) return null;
  // the storage layout: the per-process timeline files live
  // INSIDE the main session directory — the retention sweep collects them
  // with the session's own data, and the id sanitizes exactly like the dir
  // itself
  return state.sessionDirPath(cfg, sid, null);
}

async function readTimelineUnion(): Promise<TimelineEvent[]> {
  const dir = timelineDir();
  if (dir === null) return [];
  try {
    const svcs = bridge.currentServices();
    const entries = (await svcs.fsList(dir)) as Array<{ name?: unknown; kind?: unknown }>;
    const events: TimelineEvent[] = [];
    for (const ent of entries) {
      if (typeof ent?.name !== "string" || !ent.name.startsWith("timeline-") || !ent.name.endsWith(".jsonl")) continue;
      try {
        const text = await svcs.fsRead(`${dir}/${ent.name}`);
        events.push(...parseTimelines(text.split("\n").filter((l: string) => l !== "")));
      } catch (err) {
        log.info(`timeline file unreadable, skipped (${ent.name}): ${errText(err)}`);
        // unreadable timeline file — skip
      }
    }
    return events;
  } catch (err) {
    log.info(`timeline dir unreadable — empty union: ${errText(err)}`);
    return []; // no timeline dir yet — empty union
  }
}

// Appends serialize through one chain per process (the timeline is ONE
// file per process): two fire-and-forget appends that interleave at the
// fsRead await would both observe the same previous content and the later
// write would drop the earlier event (a deterministic in-process RMW race
// — the enable→pause pair at session start hits it).
let timelineAppendChain: Promise<void> = Promise.resolve();

function appendTimelineEvent(event: TimelineEvent): Promise<void> {
  const run = timelineAppendChain.then(() => appendTimelineEventNow(event));
  timelineAppendChain = run.then(
    () => undefined,
    () => undefined, // the body catches its own errors; the chain never breaks
  );
  return run;
}

async function appendTimelineEventNow(event: TimelineEvent): Promise<void> {
  try {
    const dir = timelineDir();
    if (dir === null) return;
    const svcs = bridge.currentServices();
    const own = `${dir}/timeline-${TIMELINE_TAG}.jsonl`;
    let prev = "";
    try {
      prev = await svcs.fsRead(own);
    } catch (err) {
      log.info(`timeline own file not readable yet (${own}): ${errText(err)}`);
      prev = ""; // not created yet
    }
    await svcs.fsWrite(own, `${prev}${prev.endsWith("\n") || prev === "" ? "" : "\n"}${JSON.stringify(event)}\n`);
  } catch (err) {
    report("conflict timeline append failed", err);
  }
}

/** The machinery probe: one roster look-up per unknown agent id. Machinery
 *  is a plugin-typed loop — the roster shows a plugin-namespaced type
 *  (`<plugin>:<name>`, present from the loop's first row — ours are
 *  `session-owl:observer` & co). A spawn through a builtin or anonymous type
 *  (a mod passing `general-purpose`, or no name → `teammate`) is treated as
 *  a legitimate subagent under subagentMode; a model/person spawn mirrors as
 *  before. Fails OPEN — a probe that errors or misses must never drop a real
 *  subagent's rows. */
async function isPluginSpawnedLoop(agentId: string): Promise<boolean> {
  if (bridge.isKnownPluginSpawned(agentId)) return true;
  if (bridge.isRosterProbed(agentId)) return false;
  bridge.markRosterProbed(agentId);
  try {
    const roster = (await bridge.currentServices().agentList()) as Array<{ id?: unknown; type?: unknown }>;
    const entry = Array.isArray(roster)
      ? roster.find((candidate) => candidate != null && candidate.id === agentId)
      : undefined;
    const pluginNamespaced =
      entry !== undefined &&
      typeof entry.type === "string" &&
      entry.type.includes(":") &&
      entry.type.length > ":".length;
    diag(
      `machinery probe agent=${agentId} found=${String(entry !== undefined)} type=${String(entry?.type ?? "<absent>")}`,
    );
    if (entry !== undefined && pluginNamespaced) {
      bridge.markPluginSpawned(agentId);
      return true;
    }
    return false;
  } catch (err) {
    report("agent roster lookup failed", err);
    return false;
  }
}

async function onSessionAppend($: any, e: AnyEvent, next: Next) {
  armAll($);
  try {
    // Channel C — the integrity net: a door-"compaction" row inside an
    // owl-active window of this session is a foreign override (the hit
    // adjudicates its row; re-ingest is inert). Runs even while paused
    // (paused windows are closed — the check is inert there by construction).
    if (e && (e as { door?: unknown }).door === "compaction" && typeof (e as { uuid?: unknown }).uuid === "string") {
      checkpointService()
        .tripwires()
        .noteCompactionRow((e as { uuid: string }).uuid);
      const boundarySession = state.getCurrentSession();
      const compactionAgentId =
        e && typeof (e as { agentId?: unknown }).agentId === "string" ? (e as { agentId: string }).agentId : null;
      const rowUuid = (e as { uuid: string }).uuid;
      const rowAt =
        typeof (e as { timestamp?: unknown }).timestamp === "number"
          ? (e as { timestamp: number }).timestamp
          : Date.now();
      // owl's own compaction rows: every row inside the claim window is
      // owl-known (skip = owl was consulted; answer = owl's own verdict) —
      // claim its coordinate BEFORE the net reads the union, so the row
      // adjudicates instead of hitting as foreign. The claim is
      // PER-CONVERSATION (the compact event and the rows both carry
      // agentId): main + subagent loops compacting concurrently each
      // consume their own claim. NON-one-shot: the platform persists one
      // compaction as up to TWO rows — each adjudicates on its own
      // coordinate and the claim itself stays until it expires.
      const claimKey = compactClaimKey(boundarySession, compactionAgentId);
      const claim = compactClaims.get(claimKey);
      if (claim !== undefined && rowAt >= claim.at && Date.now() - claim.at <= COMPACT_SKIP_CLAIM_MS) {
        if (claim.kind === "answer") {
          await recordCompactAnswer(
            rowUuid,
            {
              readTimelines: () => readTimelineUnion(),
              appendEvent: (event) => appendTimelineEvent(event),
            },
            Date.now(),
          );
        } else {
          await appendTimelineEvent({ t: "compact-skip", at: Date.now(), uuid: rowUuid });
        }
      }
      const cHit = await observeCompactionRow(
        {
          uuid: rowUuid,
          at: rowAt,
          door: "compaction",
        },
        {
          readTimelines: () => readTimelineUnion(),
          appendEvent: (event) => appendTimelineEvent(event),
        },
        Date.now(),
      );
      if (cHit !== null) {
        log.warn(`conflict: foreign compaction row observed (${cHit.evidence}) — pausing`);
        recordLiveOutcome(cHit, null);
        // the safety net actually pauses: the live set recomputes from the
        // recorded C hit (the predicate reads the merged set) and any flip
        // mirrors into the timeline
        recomputePauseSet();
        syncPauseIntoTimeline();
      }
    }
    // The capture body: a row from a subagent loop bootstraps that loop's
    // key; the verbatim event payload files into the loop's row cache +
    // pending list + mirror buffer. Owl's own stage loops (spawn registry)
    // are skipped — the stage dump is their record. Conflict-paused: the
    // pause is dormant-not-absent — no observations collected (pi parity).
    // Bootstrap-paused: an old session without an owl mirror pauses EVERYTHING
    // — no silent mirroring either (the transcript is the source of truth;
    // the later bootstrap recovers the whole conversation from it).
    const sessionId = state.getCurrentSession();
    if (
      sessionId !== null &&
      e &&
      typeof e.uuid === "string" &&
      !state.isBootstrapBlocked() &&
      !isConflictPaused(() => ({ enabled: state.isOwlEnabled(), ignoreConflicts: state.isOwlIgnoreConflicts() }))
    ) {
      const agentId = typeof e.agentId === "string" ? e.agentId : null;
      if (agentId !== null && bridge.spawnRegistry.has(agentId)) {
        // A stage run's rows are its dump's <output>, never the mirror
        // (the stage dump is their record).
        const run = getStageRun(agentId);
        if (run !== undefined)
          recordDumpOutputRow(run, e, (detail) => {
            log.warn(`stage ${run.stage}: model-side error — ${detail}`);
          });
      } else if (agentId !== null && (await isPluginSpawnedLoop(agentId))) {
        // Machinery (any mod's roster-attributed spawn): no conversation is
        // ensured, no rows mirror, no store dir is ever created. The roster
        // is engine-side, so the verdict holds from the loop's first row —
        // the window our own registry can't cover (it fills only after the
        // spawn promise resolves).
      } else if (agentId !== null && state.subagentsFullyDisabled()) {
        // subagentMode "disabled": a foreign subagent loop collects NOTHING —
        // no conversation is ensured, no rows mirror, no store churn. The
        // loop's compaction is declined the same way (onSessionCompact).
        // Owl's own stage runs were handled above; the main loop has no agentId.
      } else {
        const conv = state.ensureConversation(sessionId, agentId);
        const captured = captureAppend(
          conv.key,
          e as unknown as ClaudeRow,
          (key, row) => getSessionStorage(key, sessionId, row?.agentId ?? null).mirror,
        );
        // the live chain verifier's zero-latency queue (main loop only —
        // subagent transcripts are separate files); the deferred tick reads
        // the file tail and verifies the chain
        if (agentId === null && state.isOwlEnabled() && typeof e.uuid === "string" && typeof e.door === "string") {
          ensureLiveChain($, sessionId).enqueue({ uuid: e.uuid, door: e.door, captured });
        }
      }
    }
  } catch (err) {
    report("append registry failed", err);
  }
  return next(e);
}

async function onSessionEnd(_$: any, _e: AnyEvent, next: Next) {
  // lifecycle trace: why the session ended decides whether
  // the resident-state teardown follows a resume, a clear, an exit, …
  diag(
    `session.end reason=${String((_e as { reason?: unknown } | null)?.reason ?? "?")} session=${String(
      (_e as { sessionId?: unknown } | null)?.sessionId ?? (_e as { session_id?: unknown } | null)?.session_id ?? "?",
    )}`,
  );
  try {
    // The user's exit cancels every live gate: an in-flight compaction wait
    // (the looped await_stage) unwinds at its next signal check and settles
    // — its takeover degrades to a skip, never a stale answer.
    abortAllForSessionEnd();
    await state.sessionEndBody();
    // durability before teardown: any still-buffered ledger records (a run
    // that outlived its last turn flush) are written, THEN the assemblies go
    await flushAllSessionStorage();
    releaseAllCaptures();
    releaseAllSessionStorage();
    releaseAllBindings();
    clearAllStageRuns();
    resetStageToolExecutors();
    bridge.clearAllForSessionEnd();
    // the checkpoint maps follow the session out (main-key dead sets,
    // boundaries, prepared registrations, watermarks, skip marks — never
    // leak across sessions)
    checkpointService().releaseAll();
    if (liveChain !== null) liveChain.dispose();
    liveChain = null;
    liveChainKey = null;
  } catch (err) {
    report("teardown failed", err);
  }
  return next(_e);
}

// --- the layered rewind checkpoint ---------------------------------------------------
//
// Every $ literal of the rewind check lives in this helper's closures; the
// modules under host/rewind/ stay platform-free. The api-fingerprint thunk
// reads the canonical view; the transcript thunk reads the file when the
// path is armed and readable (the verifier layer).

function errText(err: unknown): string {
  // the shared detail shape: message + stack when one exists (never a
  // message-only log line for a thrown Error)
  return errDetail(err);
}

// The live chain verifier (main loop only — subagent loops keep the
// checkpoint path): append events queue zero-latency; a deferred tick (or
// the turn-complete flush) reads the transcript tail and feeds the file's
// true parent edges to the mirror, detecting rewinds by anchor mismatch.
// Built lazily at the first flush/enqueue of a session; released at
// session end with the other per-session state.
let liveChain: LiveChainProcessor | null = null;
let liveChainKey: string | null = null;

function ensureLiveChain($: any, sessionId: string): LiveChainProcessor {
  const key = state.conversationKey(sessionId, null);
  if (liveChain !== null && liveChainKey === key) return liveChain;
  if (liveChain !== null) liveChain.dispose();
  liveChainKey = key;
  const storage = getSessionStorage(key, sessionId, null);
  const checkpointDeps = checkpointService().buildDeps(key, storage, {
    logLine: (line: string) => log.info(line),
  });
  let lastStatSize: number | null = null;
  liveChain = new LiveChainProcessor({
    statSize: async () => {
      const path = state.getCurrentTranscriptPath();
      if (path === null) return null;
      try {
        const st = (await bridge.currentServices().fsStat(path)) as { size?: unknown } | null;
        lastStatSize = st !== null && typeof st.size === "number" ? st.size : null;
        return lastStatSize;
      } catch (err) {
        log.warn(`live chain stat failed: ${errText(err)}`);
        lastStatSize = null;
        return null;
      }
    },
    readTail: (maxRows) => {
      const path = state.getCurrentTranscriptPath();
      if (path === null) return Promise.resolve(null);
      const svcs = bridge.currentServices();
      return readTail(
        {
          fsRead: (p: string) => svcs.fsRead(p),
          runProcess: (argv: string[]) => svcs.processRun(argv),
          log: (m: string, e?: unknown) => log.warn(m + (e === undefined ? "" : `: ${errText(e)}`)),
        },
        { size: lastStatSize, transcriptPath: path, pluginRoot: svcs.pluginRoot(), maxRows },
      );
    },
    owlTailExcluding: (exclude: ReadonlySet<string>): string | null => {
      const tail = checkpointDeps.knownTailExcluding?.(exclude);
      if (tail !== undefined) return tail;
      const path = checkpointDeps.knownPath();
      for (let i = path.length - 1; i >= 0; i -= 1) {
        const uuid = path[i]?.uuid;
        if (uuid !== undefined && !exclude.has(uuid)) return uuid;
      }
      return null;
    },
    isKnownRow: (uuid: string) => storage.mirror.rowByUuid(uuid) !== undefined,
    patchEdges: (edges) => {
      // the file's verified edges are DURABLE (ledger lineage) before any
      // refold walks them — the ledger owns the chain the refold resolves
      // live sets through; the same call true-ups the mirror. Without the
      // ledger seam the mirror still gets the file's truth.
      if (edges.length === 0) return;
      const feed = checkpointDeps.appendEdges;
      if (feed !== undefined) {
        feed(
          edges.map((e) => ({ uuid: e.uuid, parent: e.parent, exact: true })),
          edges[edges.length - 1]?.uuid ?? "",
        );
      } else {
        storage.mirror.patchEdges(edges);
      }
    },
    onRewind: async (verdict) => {
      // one live-set fold per verdict: the order and the dead path share it
      let liveMemo: { settle: string | null; order: string[] } | null = null;
      const liveOrder = async (settle: string | null): Promise<string[]> => {
        if (liveMemo !== null && liveMemo.settle === settle) return liveMemo.order;
        const order = await checkpointDeps.liveSetFor(settle);
        liveMemo = { settle, order };
        return order;
      };
      await applyLiveRewind(
        {
          abortAndAwaitInFlight: checkpointDeps.abortAndAwaitInFlight,
          liveOrderFor: liveOrder,
          deadPath: async (settle) => {
            const live = new Set(await liveOrder(settle));
            return checkpointDeps
              .knownPath()
              .filter((r) => !live.has(r.uuid))
              .map((r) => r.uuid);
          },
          knownOrder: () => checkpointDeps.knownPath().map((r) => r.uuid),
          refold: checkpointDeps.refold,
          onDivergence: checkpointDeps.onDivergence,
          log: (line: string) => log.info(line),
        },
        verdict,
      );
      const reloaded = await reloadCoreFor(key).catch((err: unknown) => {
        report("graph reload after live rewind", err);
        return false;
      });
      if (reloaded) log.info(`graph reloaded after live rewind refold for ${key}`);
    },
    dormant: () =>
      !state.isOwlEnabled() ||
      isConflictPaused(() => ({ enabled: state.isOwlEnabled(), ignoreConflicts: state.isOwlIgnoreConflicts() })),
    schedule: (ms, fn) => {
      try {
        const pending = $.clock.after(ms, fn) as unknown;
        if (typeof pending === "function") return pending as () => void;
        const cancel = (pending as { cancel?: unknown } | null)?.cancel;
        return typeof cancel === "function" ? () => (cancel as () => void)() : () => {};
      } catch (err) {
        log.warn(`live chain timer arm failed — the tick is lost until the next event: ${errText(err)}`);
        return () => {};
      }
    },
    log: (line: string) => log.info(`${line} — conv ${key}`),
  });
  return liveChain;
}

/** The main loop's turn-boundary verification: the live chain flush (the
 *  engine's forced drain has made the turn durable). Dormant while
 *  disabled or conflict-paused. `deferVerdicts` parks a detected verdict's
 *  application on the timer lane — the hook returns inside its budget and
 *  the refold (a whole-ledger re-fold; seconds on a multi-GB store) runs
 *  free of it. */
async function liveChainFlush($: any, sessionId: string, deferVerdicts = false): Promise<void> {
  if (!state.isOwlEnabled()) return;
  if (isConflictPaused(() => ({ enabled: state.isOwlEnabled(), ignoreConflicts: state.isOwlIgnoreConflicts() }))) {
    return;
  }
  try {
    await ensureLiveChain($, sessionId).flush({ deferVerdicts });
  } catch (err) {
    report("live chain flush failed", err);
  }
}

/** The stage launch broker: stage agents spawn THROUGH the subagent
 *  companion (the engine re-entry-skips a plugin's hooks for its own
 *  spawned agents — rooting the spawn at the companion keeps our tool.call
 *  hooks answering them). armAll arms it with fresh capsules. */
const stageLaunchBroker = createLaunchBroker();

/** The assistant row the last stage LAUNCH fired on, per conversation — the
 *  boundary gate's history. A resumed session's dangling completion (no
 *  new assistant content) must not launch stages. */
const lastFiredAssistantByKey = new Map<string, string | null>();

// --- turns ------------------------------------------------------------------------

async function* onTurnStep($: any, e: AnyEvent, next: any) {
  // The main loop's resolved model — the freshest truth about what the
  // session actually serves. turn.step carries the model as the engine
  // RESOLVED it for THIS request (a fallback hop included), so every
  // main-loop dispatch refreshes the slot the goal extractor reads —
  // richer than the start-time $.session.model() seed.
  if (
    e &&
    typeof (e as { agentId?: unknown }).agentId !== "string" &&
    typeof (e as { model?: unknown }).model === "string"
  ) {
    try {
      state.setSessionModel((e as { model: string }).model);
    } catch (err) {
      log.info(`turn-step model refresh failed: ${errText(err)}`);
      // best-effort refresh — never blocks the step chain
    }
  }
  // Dispatch trace for subagent loops: the engine routes a spawned agent's
  // model requests PAST the hook that spawned it (measured live — zero
  // dispatches reach this handler for our stage agents), so the trace
  // documents the routing for any future run-control lever that would sit
  // here.
  if (e && typeof (e as { agentId?: unknown }).agentId === "string") {
    const traceAgentId = (e as { agentId: string }).agentId;
    log.info(
      `turn.step dispatch: agent ${traceAgentId} turn ${String(
        (e as { turnId?: unknown }).turnId ?? "?",
      )} step ${String((e as { index?: unknown }).index ?? "?")}`,
    );
  }
  // The mid-turn trigger matrix: after each model cycle, the cheap
  // synchronous evaluation over the pending rows (a fired tripwire defers
  // the launch to the turn boundary). Owl's own stage loops never
  // re-trigger (the spawn registry predicate — pi's own-run exclusion).
  try {
    const boundarySessionId = state.getCurrentSession();
    const boundaryAgentId = e && typeof e.agentId === "string" ? e.agentId : null;
    if (
      boundarySessionId !== null &&
      (boundaryAgentId === null || (!bridge.isMachineryLoop(boundaryAgentId) && !state.subagentsFullyDisabled()))
    ) {
      const boundaryKey = state.conversationKey(boundarySessionId, boundaryAgentId);
      // A subagent loop seeds + captures at ITS step boundary too: its
      // observer/builder runs before the first turn.complete ever arrives
      // (pi parity — a subagent process starts its session seeded). Owl's
      // own stage loops never reach this branch (the registry predicate).
      if (boundaryAgentId !== null && state.isOwlEnabled() && !state.isBootstrapBlocked()) {
        try {
          await getBinding(boundaryKey, boundarySessionId, boundaryAgentId).captureInitialPromptForTurn();
        } catch (err) {
          report("initial-prompt capture failed", err);
        }
      }
      onStepBoundary(getBinding(boundaryKey, boundarySessionId, boundaryAgentId).triggerDeps(), {
        agentId: boundaryAgentId ?? undefined,
      });
    }
  } catch (err) {
    report("turn-step trigger arm failed", err);
  }
  // The stage-run relay: abort fabrication, the per-step stall race, the
  // per-step output cap, and the no-progress rule. Non-stage
  // loops pass straight through.
  const clockAfter = (ms: number, fn: () => void) => $.clock.after(ms, fn);
  const relay = relayTurnStep(e as { turnId: unknown; index: number; agentId?: string }, next, {
    clockAfter,
  }) as unknown as AsyncGenerator<AnyEvent, AnyEvent>;
  const r = yield* relay;
  return r;
}

async function onTurnComplete($: any, e: AnyEvent, next: Next) {
  armAll($);
  try {
    // Completion routing is ENGINE MECHANICS (resolving a parked
    // awaitAgentCompletion promise), not owl policy — it runs even while
    // conflict-paused: a run that was already in flight when the pause
    // flipped mid-run (Channel B envelope / Channel C row) must still
    // complete, or the awaiting orchestration hangs until session.end
    // holding the conversation's run-lock.
    if (e && typeof e.agentId === "string") {
      const reason = typeof e.reason === "string" ? e.reason : undefined;
      bridge.routeAgentCompletion({
        answer: e.answer,
        isAborted: e.isAborted,
        agentId: e.agentId,
        usage: completionUsageOf(e.usage),
        reason,
      });
    }
    // Dormant-not-absent: while conflict-paused the turn flush is skipped
    // (no observations were collected — pi parity); the band's pause line
    // still renders (the ui.render arm reads the live predicate). The
    // TERMINAL-loop teardown still runs on the paused branch: rows are
    // durable on disk (the sweep tier owns them), so an agentId-bearing
    // loop completing while paused must not hold its capture/storage/
    // checkpoint state in memory until session.end — only the flush and
    // the rewind checkpoint are owl policy.
    if (isConflictPaused(() => ({ enabled: state.isOwlEnabled(), ignoreConflicts: state.isOwlIgnoreConflicts() }))) {
      const pausedSessionId = state.getCurrentSession();
      if (pausedSessionId !== null && e && typeof e.agentId === "string") {
        const pausedKey = state.conversationKey(pausedSessionId, e.agentId);
        // durability before release: the paused loop's buffered rows and
        // records reach disk (its turn flush never ran — paused windows
        // collect no observations, but rows still file into the mirror)
        await flushSessionStorage(pausedKey);
        releaseCapture(pausedKey);
        releaseSessionStorage(pausedKey);
        checkpointService().releaseKey(pausedKey);
        releaseBinding(pausedKey); // the binding follows its loop out
      }
      return next(e);
    }
    // The turn flush: rows durable first (mirror), then the CHECK record —
    // only for loops that actually captured rows this process. An
    // agentId-bearing loop is TERMINAL at its completion: release its
    // in-memory capture + storage (rows are durable on disk; the sweep tier
    // owns them). The main loop lives for the session.
    const sessionId = state.getCurrentSession();
    if (sessionId !== null) {
      const agentId = e && typeof e.agentId === "string" ? e.agentId : null;
      const key = state.conversationKey(sessionId, agentId);
      // The layered rewind check runs BEFORE the turn's mirror flush (the
      // ordering that makes the alignment junction the rewind point rather
      // than the new live tip) and scopes to THIS loop's conversation. At a
      // turn boundary persist rides the flush's own CHECK record right
      // after; only divergence-verify persists its own. Owl's own stage
      // loops are not conversations to reconcile — their turn ends open no
      // storage and run no checkpoint (the own-run exclusion, the same
      // spawn-registry predicate the trigger matrix and the capture skip
      // use).
      // (the own-run exclusion, the same spawn-registry predicate the trigger
      // matrix and the capture skip use; a fully-disabled foreign subagent
      // loop has no mirrored rows to reconcile — skipping also keeps its
      // storage dir from ever being created).
      if (agentId === null) {
        // the main loop verifies through the live chain (the file tail);
        // subagent loops keep no per-turn verifier (their transcripts are
        // separate files, their stores short-lived). The verdict's
        // APPLICATION defers to the timer lane: the refold re-folds the
        // whole ledger and must not blow the turn.complete hook budget.
        await liveChainFlush($, sessionId, true);
      }
      const cap = getCapture(key);
      if (cap !== undefined) {
        await flushTurn(cap.mirror, getSessionStorage(key, sessionId, agentId).ledger, cap.mirror.tipUuid(), {
          // the live chain's verified edges (written before any verdict)
          // are this turn's provenance — the flush's CHECK seals them
          check: true,
        });
      }
      // pi parity: the initial-prompt capture runs at EVERY turn end of
      // the main loop (idempotent) — a live session's first prompt arrives
      // after the session-start backfill, and it belongs to oInitialPrompt
      // + the one-shot goal extraction, never to the Observer (whose
      // trigger fires next). Failure never suppresses the turn's trigger.
      // A subagent loop runs the same capture against ITS OWN state (pi
      // runs a subagent as its own process, where the session start seeds
      // the goal natively); owl's own stage loops keep the own-run
      // exclusion — their rows are dump output, never mirrored conversation.
      if (
        state.isOwlEnabled() &&
        !state.isBootstrapBlocked() &&
        (agentId === null || (!bridge.isMachineryLoop(agentId) && !state.subagentsFullyDisabled()))
      ) {
        try {
          await getBinding(key, sessionId, agentId).captureInitialPromptForTurn();
        } catch (err) {
          report("initial-prompt capture failed", err);
        }
      }
      // The wrap-up trigger evaluation: the turn is durable, the layered
      // check has run — the matrix decides whether the observe/build/select
      // chain launches now. Owl's own stage loops never re-trigger (the
      // spawn registry predicate); fire-and-forget (the run-lock serializes
      // the actual launch). Placed BEFORE a loop's teardown so the loop's
      // boundary reads its still-live capture (pi's per-loop turn end); a
      // race past the release self-heals through the coverage union.
      if (agentId === null || !bridge.isMachineryLoop(agentId)) {
        // A parked rewind verdict defers this boundary's stages: the store
        // is about to refold onto the verified chain — observing over the
        // pre-verdict state would target a dying world. The next boundary
        // runs on the folded state.
        const chain = agentId === null ? ensureLiveChain($, sessionId) : null;
        if (chain?.hasPendingRewind()) {
          log.info(
            `trigger [${key}]: observe=skip (reason=rewind verdict application pending — this boundary's stages defer to the next)`,
          );
        } else {
          // The boundary gate: launch stages only at a completion that
          // concluded a real round — new assistant rows since the last
          // launch. The engine completes a resumed session's dangling turn
          // as the continuation prompt arrives; that boundary fires nothing.
          const capture = getCapture(key);
          const gateRows = (capture?.mirror.arrivalOrder() ?? []).map((uuid) => {
            const message = capture?.mirror.rowByUuid(uuid)?.row as
              | { message?: { role?: unknown; type?: unknown } }
              | undefined;
            const role = message?.message?.role;
            const type = message?.message?.type;
            const kind = typeof role === "string" ? role : typeof type === "string" ? type : undefined;
            return { uuid, kind };
          });
          if (!state.isBootstrapBlocked() && shouldFireBoundary(gateRows, lastFiredAssistantByKey.get(key) ?? null)) {
            lastFiredAssistantByKey.set(key, newestAssistantUuid(gateRows));
            onTurnCompleteBoundary(getBinding(key, sessionId, agentId).triggerDeps(), {
              agentId: agentId ?? undefined,
            });
          }
        }
      }
      if (agentId !== null) {
        releaseCapture(key);
        releaseSessionStorage(key);
        checkpointService().releaseKey(key);
        releaseBinding(key); // the binding follows its loop out
      }
    }
  } catch (err) {
    report("completion routing failed", err);
  }
  return next(e);
}

// --- measure / compaction -----------------------------------------------------------

async function onSessionMeasure(_$: any, e: AnyEvent, next: Next) {
  // The context snapshot: the on-session-context-threshold arms' data source
  // (session-scoped — the MAIN conversation's fill; loop keys read unknown
  // and their context arms skip — the unknown-context rule).
  const sessionId = state.getCurrentSession();
  const ctx =
    e && typeof e === "object" && "context" in e
      ? (e as { context?: { tokens?: number; window?: number } }).context
      : undefined;
  // Single-live-pointer assumption: the measure envelope carries no session
  // id, so the snapshot files under the process's current-session pointer
  // (set at classic.SessionStart) — the same assumption the append capture
  // rides. A host process serving two interleaved live sessions would
  // mis-file the second's fills; the platform's session grouping makes that
  // unreachable in practice (verified against the envelope shape).
  if (sessionId !== null && ctx != null && typeof ctx.window === "number") {
    recordMeasure(sessionId, { window: ctx.window, ...(typeof ctx.tokens === "number" ? { tokens: ctx.tokens } : {}) });
  }
  // The rewind tripwire series: the main conversation's fill (measure
  // envelopes carry no agent id — the same single-live-pointer assumption
  // the snapshot above rides).
  if (sessionId !== null && ctx != null && typeof ctx.tokens === "number") {
    checkpointService().tripwires().observeMeasure(state.conversationKey(sessionId, null), ctx.tokens);
  }
  // The boundary trigger arms themselves ride turn.step/turn.complete (the
  // trigger matrix over the keyed run-lock, onStepBoundary/
  // onTurnCompleteBoundary) — this handler only records the measure
  // snapshot + tripwire fill they read.
  return next(e);
}

async function onSessionCompact(_$: any, e: AnyEvent, next: Next) {
  // The Channel C claim runs FIRST, unconditionallly, for every outcome the
  // gate below may choose (answer, skip, or pass): the next door row of
  // this conversation inside the claim window — including owl's own answer
  // row, which lands through the same ingest → observe path inside an
  // active window — must not be adjudicated as a compaction foreign to the
  // session. Without the claim, the first native /compact of an owl-enabled
  // session would spuriously conflict-pause (the timeline net cannot
  // distinguish an owl-declined compaction from a foreign one on its own).
  // A compaction the event reaches without a live session pointer leaves
  // its coordinate unclaimed for that pointer and still hits.
  const compactAgentId =
    typeof (e as { agentId?: unknown }).agentId === "string" ? (e as { agentId: string }).agentId : null;
  const compactSessionId = state.getCurrentSession();
  const claimKey = compactClaimKey(compactSessionId, compactAgentId);
  // prune expired entries while we are here (the map stays bounded by the
  // process's conversation count)
  for (const [k, claim] of compactClaims) {
    if (Date.now() - claim.at > COMPACT_SKIP_CLAIM_MS) compactClaims.delete(k);
  }
  compactClaims.set(claimKey, { at: Date.now(), kind: "skip" });
  guarded(appendTimelineEvent({ t: "compact-skip", at: Date.now() }), "timeline append");
  // The disabled master switch passes native compaction through — the same
  // live predicate every other gate in this closure reads (the settings
  // flip path mirrors it; the claim above stands for this outcome too).
  if (!state.isOwlEnabled()) return next(e);
  // subagentMode "disabled": EVERY agent-scoped compaction is declined —
  // native compaction runs, owl answers nothing (session-owl is off for
  // subagents; their compaction belongs to the
  // engine). Own stage loops included — under disabled a stage run that
  // crosses its window simply takes the engine's native compaction. The
  // main conversation has no agentId.
  if (compactAgentId !== null && state.subagentsFullyDisabled()) {
    return next(e);
  }
  // No live session ⇒ no conversation to gate on: claim recorded, native
  // compaction proceeds (the pass-through path).
  if (compactSessionId === null) return next(e);
  // The takeover gate: pause → enabled → cut → lock → ensure-ready →
  // render → snapshot → answer, fixed internally. "answer" / "skip" are
  // owl's verdicts and replace the platform's own compaction; "pass" hands
  // the event to the engine unchanged.
  // The gate deps are built once so the user-cancel wire can name the
  // conversation: when the engine aborts THIS dispatch's signal (the user
  // pressed Esc — the compaction is cancelled), the gate's controller
  // unwinds that conversation's stages (chunk in flight finishes; the next
  // chunk's signal check aborts) and the wait loop stops re-dispatching.
  const gateDeps = getBinding(claimKey, compactSessionId, compactAgentId).compactionDeps({
    // The layered rewind check's compaction entry — a serve-class call
    // (/compact is user-initiated, latency-tolerant): a rewind since the
    // last check-point re-folds BEFORE the gate reads the store. Machinery
    // loops skip it (own-run exclusion, the same predicate the turn
    // boundary uses).
    // the main loop verifies through the live chain before the gate reads
    // the store; machinery loops and subagent loops check nothing
    rewindCheck: compactAgentId === null ? () => liveChainFlush(_$, compactSessionId) : async () => {},
  });
  const compactSignal = next && typeof next.signal === "object" && next.signal !== null ? next.signal : undefined;
  const outcome = await raceTakeoverWithSignal(
    compactionTakeover(
      e as unknown as CompactEvent,
      withBudgetFreeWait(gateDeps, {
        call: (tool, args) => bridge.currentServices().toolCall(tool, args),
        onError: (message, err) => report(message, err),
        signal: compactSignal,
        onStall: (key) => {
          // a stalled dispatch = a queued user gesture (Esc serializes behind
          // the in-flight hook on this build): abort the gate's controller so
          // the stages unwind and the hook returns — the engine then processes
          // the gesture and the compaction is cancelled around us
          try {
            abortActiveFor(key);
          } catch (cause) {
            report("compaction stall wire failed", cause);
          }
        },
      }),
    ),
    compactSignal,
    (key) => {
      try {
        abortActiveFor(key);
      } catch (cause) {
        report("compaction cancel wire failed", cause);
      }
    },
    gateDeps.key,
  );
  if (outcome.kind !== "pass") {
    // owl ANSWERED (its verdict replaced the native compaction): the rows
    // the platform persists for it are owl's own — refresh the claim at the
    // VERDICT (the gate above may have run for many minutes; an entry-time
    // claim would already be expired when the rows land)
    compactClaims.set(claimKey, { at: Date.now(), kind: "answer" });
    // the fold's materialized rows arrive right after, in order — arm the
    // in-order matcher with the answer's own messages so they are stamped
    // remat (never re-observed; the originals' entries stay the sources)
    if (outcome.kind === "answer") {
      setRematExpectation(claimKey, outcome.result.messages);
    }
    // The engine writes NO row for a hook-answered compaction, so the
    // timeline's compact-answer row is what records where the summarized
    // prefix ends (the uuid-less row is inert for row adjudication — only
    // uuid-bearing events index a row).
    if (outcome.kind === "answer" && typeof outcome.cut === "string" && outcome.cut !== "") {
      const answerAt = Date.now();
      guarded(appendTimelineEvent({ t: "compact-answer", at: answerAt, cut: outcome.cut }), "timeline append");
    }
    return outcome.result;
  }
  return next(e);
}

/** The per-conversation claim key (the compact event and the compaction row
 *  must land on the SAME key for the claim to be consumed). */
function compactClaimKey(sessionId: string | null, agentId: string | null): string {
  return state.conversationKey(sessionId ?? "", agentId);
}

/** When owl last touched a compaction of this conversation: PER
 *  CONVERSATION, with the outcome's kind. kind "skip" is set when the
 *  compact event arrives (owl was consulted — whatever it decides, the
 *  compaction rows that follow are owl-known); kind "answer" REFRESHES the
 *  claim at the verdict (the ensure-ready gate can run arbitrarily long
 *  before owl answers — the claim window must start at the answer, not at
 *  the entry). While a claim is inside its window, EVERY door-compaction
 *  row of the conversation adjudicates as owl-known — the platform
 *  persists a compaction as up to TWO rows (kickoff cell 3), so a one-shot
 *  claim would hit owl's own second row. */
const compactClaims = new Map<string, { at: number; kind: "skip" | "answer" }>();
/** How long a claim stays open: the compaction's rows land within seconds
 *  of the verdict; a compaction that never produced rows (aborted) must
 *  not swallow a much-later foreign row. */
const COMPACT_SKIP_CLAIM_MS = 60_000;

// --- tools / commands / agents / ui (shells) -----------------------------------------

async function onToolRegister(_$: any, _e: AnyEvent, next: Next) {
  return next(_e);
}

// The deferral pins ride the registered specs (register-time isDeferred):
// owl_recall pins isDeferred:false in host/recall/spec.ts, the stage tools
// pin isDeferred:true in host/stage/tools.ts — the static facts carry the
// discoverability pin (verified live).

async function onToolCall($: any, e: AnyEvent, next: Next) {
  // arrival evidence FIRST: every dispatch this plugin owns lands here, so
  // a live session's file log shows what the engine offered (and with which
  // agent id) before any answer decides.
  diag(
    `tool.call dispatch: ${typeof e?.tool === "string" ? e.tool : String(e?.tool)} agent=${
      typeof e?.agentId === "string" ? e.agentId : "-"
    }`,
  );
  // A stage agent's handback call is its last act: the report is already
  // in the stage run's hands, so the agent is stopped mid-call — its
  // completion message would otherwise arrive as a peer prompt the drop
  // path must refuse, printing the engine's "Prompt dropped by a hook"
  // notice. The stop is marked deliberate (the run layer forgives an abort
  // we initiate as a clean finish) and the completion routing runs here,
  // because a stopped loop raises no turn.complete of its own. A stop
  // that fails changes nothing: the agent finishes normally and the
  // prompt.submit drop still catches the delivery.
  if (
    e &&
    typeof e.tool === "string" &&
    e.tool === "SubagentHandback" &&
    typeof e.agentId === "string" &&
    bridge.spawnRegistry.has(e.agentId)
  ) {
    const agentId = e.agentId;
    try {
      bridge.markDeliberateAbort(agentId);
      const stop = await $.tool.call({ tool: "TaskStop", task_id: agentId });
      diag(`stage handback: agent stopped (${JSON.stringify(stop).slice(0, 160)})`);
      bridge.routeAgentCompletion({
        answer: "",
        isAborted: true,
        agentId,
        usage: undefined,
        reason: "stopped-after-handback",
      });
    } catch (err) {
      bridge.clearDeliberateAbort(agentId);
      report("stage handback: stop failed — the drop path stays the fallback", err);
    }
    return next(e);
  }
  // The stage tools are served only to owl's stage agents (the caller gate);
  // their executors are installed per run by the stage-run modules. A THROW
  // here would be SKIPPED by the engine ("no tool.call hook answered this
  // call") — teardown races must answer in-band, as the model-visible error
  // pi's isError tool results carry.
  // The companion's ambient launch callback (its caller is the companion's
  // module code, never a stage agent — the broker validates the launchId)
  if (e && typeof e.tool === "string" && e.tool === STAGE_LAUNCHED_TOOL) {
    return stageLaunchBroker.settle(e as Record<string, unknown>);
  }
  // The compaction gate's budget-free wait: the compact hook parks its
  // ensure-ready phases under the conversation key and rides THIS dispatch
  // ($.tool.call keeps the hook-budget clock paused for the whole stage
  // wait — plugin-hosted "sdk" tools carry no engine-side duration limit).
  if (e && typeof e.tool === "string" && e.tool === AWAIT_STAGE_TOOL) {
    const key = typeof (e as { key?: unknown }).key === "string" ? (e as { key: string }).key : "";
    if (key === "") return { deny: "await_stage: key missing" };
    // START the parked work or JOIN the run already in flight: each slice
    // answers at ~9s (BEFORE the engine's ~10s per-call ceiling — a hook
    // still running after the cut's abort signal lingers, and two
    // consecutive linger reports respawn the worker with the plugin
    // unloaded). The gate's loop re-dispatches on the non-done answer; the
    // run executes once (joinStageRun). Failures never ride this channel:
    // the wrapper's closure owns the verdict and re-throws so the gate's
    // catch builds the skip.
    const answer = joinStageRunSliced(
      key,
      STAGE_SLICE_MS,
      next && typeof next.signal === "object" && next.signal !== null ? next.signal : undefined,
    );
    if (answer === undefined) return { deny: `await_stage: no prepared work for ${key}` };
    return await answer;
  }
  if (e && typeof e.tool === "string" && stageToolShortName(e.tool) !== null) {
    try {
      // awaited: an async rejection must answer in-band here — unwrapped it
      // fails the whole hook and the engine skips it (the model then reads
      // its generic no-hook-answered fallback). The FULL event goes to the
      // executor: call arguments ride top-level on e and the executor body
      // reads them (an observations-less event would validate nothing and
      // ack 'accepted: all' with zero pushes).
      return await handleStageToolCall(
        e as { tool: string; agentId?: string },
        (agentId) => getStageRun(agentId) !== undefined,
      );
    } catch (err) {
      const message = `Error: session-owl stage tool failed: ${err instanceof Error ? err.message : String(err)}`;
      diag(`stage tool.call failed: ${message}`);
      return { result: message };
    }
  }
  // The owl_recall serve: the gate order, the layered check, and the
  // vendored dispatch live host-side; the deps below bind them to THIS
  // closure's session facts — the current conversation (a subagent loop
  // composes its own key from the envelope's agentId), the live switch and
  // pause predicates, the canonical check before the serve (a non-persisting
  // checkpoint scoped to the calling loop — the recall-entry boundary), and
  // the core pin. Nothing is caught here: an in-band error result (and the
  // disabled reject) answer {deny: <exact text>}, which the engine delivers
  // to the model as an error result — a throw would be SKIPPED instead and
  // its text would stay in the debug log only.
  if (e && e.tool === OWL_RECALL_FULL_NAME) {
    const sessionId = state.getCurrentSession();
    // No current conversation ⇒ nothing to pin (the registration gate only
    // ever registers the tool inside a session).
    if (sessionId === null) return next(e);
    armAll($);
    const agentId = typeof e.agentId === "string" ? e.agentId : null;
    const key = state.conversationKey(sessionId, agentId);
    const call: OwlRecallCallEvent = {
      tool: e.tool,
      ...(agentId !== null ? { agentId } : {}),
      input: recallInputOf(e),
    };
    // The serve NEVER waits on the rewind check: on a large resumed
    // conversation the check's api-view fingerprints run tens of seconds,
    // and a tool.call hook that outlives the engine's ~10s per-call ceiling
    // lingers — two linger reports respawn the worker with the plugin
    // UNLOADED (the whole mod goes dark for the session). The canonical
    // view is checked at the turn/process boundaries instead; between a
    // rewind and the next turn-end check a serve may answer from the
    // pre-rewind graph (bounded staleness, the accepted trade).
    // The try/catch is belt-and-braces: a throw out of the serve would be
    // SKIPPED by the engine ("no tool.call hook answered") — the same
    // linger/unload trap — so any unexpected failure answers in-band.
    try {
      return await handleOwlRecallCall(call, {
        resolveKey: (loopId: string | null) => state.conversationKey(sessionId, loopId),
        isDisabled: () => !state.isOwlEnabled(),
        subagentsDisabled: () => state.subagentsFullyDisabled(),
        isConflictPaused: () =>
          isConflictPaused(() => ({ enabled: state.isOwlEnabled(), ignoreConflicts: state.isOwlIgnoreConflicts() })),
        checkThenServe: SKIP_REWIND_CHECK_IN_SERVE,
        pinCore: async () => {
          await getBinding(key, sessionId, agentId).pinCore();
        },
      });
    } catch (err) {
      report("owl_recall serve failed", err);
      if (err instanceof StoreLoadingError) {
        // the store's first load outran the tool-call budget: deny with a
        // retryable text instead of dying with the worker — the load keeps
        // running in the background and the next call serves
        return {
          deny: "session-owl is still loading this session's memory — the store is being reconstructed. Try again in a moment.",
        };
      }
      return { deny: `Error: session-owl recall failed: ${err instanceof Error ? err.message : String(err)}` };
    }
  }
  return next(e);
}

/** The tool.call-served surfaces' checkThenServe: a no-op, never the
 *  rewind checkpoint (see the owl_recall call site for the linger/unload
 *  trap it avoids; the turn/process boundaries own the canonical view). */
const SKIP_REWIND_CHECK_IN_SERVE: () => Promise<void> = async () => {};

/** The tool.call envelope's reserved keys — everything else on the event IS
 *  the model's arguments (the engine spreads them beside `tool`). */
const RECALL_ENVELOPE_KEYS = new Set(["tool", "tool_use_id", "agentId"]);

/** Peel the recall call's input off the envelope (loop id excluded: the
 *  subagent axis rides the handler's own key resolution, never the params). */
function recallInputOf(e: AnyEvent): Record<string, unknown> {
  const input: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(e as Record<string, unknown>)) {
    if (!RECALL_ENVELOPE_KEYS.has(k)) input[k] = v;
  }
  return input;
}

async function onCommandRegister(_$: any, _e: AnyEvent, next: Next) {
  return next(_e);
}

/** The seven browse/maintenance bodies (host/commands, Node-tested) —
 *  owl-settings stays on the inline pane branch (the re-enable path runs
 *  while disabled; the pane is its own surface). */
const OWL_COMMAND_BODIES: Record<string, (args: string, deps: OwlCommandDeps) => Promise<void>> = {
  "owl-ls": runOwlLs,
  "owl-cat": runOwlCat,
  "owl-find": runOwlFind,
  "owl-find-all": runOwlFindAll,
  "owl-rescan": runOwlRescan,
  "owl-reobserve-0-obs-chunks": runOwlReobserve,
  "owl-status": runOwlStatus,
};

async function onCommandRun($: any, e: AnyEvent, next: Next) {
  // The command's name: the real engine stamps `command` on the event
  // (CommandRunInput); the testing kit passes the caller's own object
  // through, where the $.command.run input spells it `name` — read both,
  // the real field first.
  const commandName =
    typeof (e as { command?: unknown }).command === "string"
      ? (e as { command: string }).command
      : typeof (e as { name?: unknown }).name === "string"
        ? (e as { name: string }).name
        : undefined;
  // /owl-settings opens the settings pane (the family library's pane stack
  // over the consumer's installed handle) — unconditionally: a disabled
  // owl must stay re-enableable through its own settings command.
  if (commandName === "owl-settings") {
    await ensureSettingsPane({
      uiLog: (text: string) => $.ui.log(text),
      uiOpen: (args) => $.ui.open(args),
      uiClose: () => $.ui.close({ id: SETTINGS_PANE_ID }),
      uiInvalidate: () => $.ui.invalidate("ui.render"),
      uiFocus: (key) => $.ui.focus({ requestId: SETTINGS_PANE_ID, key }),
      // the engine's merged settings snapshot — the model-row enrichment
      // reads availableModels/modelPicker from it (literal call, per the
      // pre-load scanner's rules)
      settingsRead: () => $.settings.read(),
    });
    return {};
  }
  // The seven browse/maintenance bodies: the binding's deps (notify
  // adapter, pinned store, locks, stage runs, the status report), the
  // confirm capsule over ui.ask, and the same rewind checkpoint the
  // recall entry runs before serving. A body throw degrades to a logged
  // {} — the command surface never crashes the session.
  const body = commandName !== undefined ? OWL_COMMAND_BODIES[commandName] : undefined;
  if (body !== undefined) {
    const sessionId = state.getCurrentSession();
    if (sessionId === null) return next(e); // commands only run inside a session
    armAll($);
    const key = state.conversationKey(sessionId, null);
    const deps = getBinding(key, sessionId, null).commandDeps({
      confirm: async (title, message) => {
        const answer = await $.ui.ask(`${title}\n${message}`, ["Yes", "No"]);
        return answer === "Yes";
      },
      checkThenServe: SKIP_REWIND_CHECK_IN_SERVE,
      openViewer: (title: string, text: string) => {
        setViewerContent(title, text);
        void $.ui.open({ id: VIEWER_PANE_ID, title, focus: true, closeOnEscape: true, rows: 20 });
      },
    });
    try {
      await body(typeof (e as { args?: unknown }).args === "string" ? ((e as { args?: string }).args ?? "") : "", deps);
    } catch (err) {
      report("command body failed", err);
    }
    return {};
  }
  return next(e);
}

function onToolCheck(_$: any, e: AnyEvent, next: Next) {
  // The stage spawns' self-approval on the permission decision: auto-mode
  // desktop sessions put the ambient mod-initiated Agent spawn to the
  // server-side classifier, which gives no verdict for a call no request
  // produced, denying the stage launch. The plugin answers the decision
  // itself for exactly its own registered agent types (they run ungated in
  // every other mode); every other call keeps the engine's verdict.
  const tool = (e as { tool?: unknown }).tool;
  const input = (e as { input?: unknown }).input as { subagent_type?: unknown; task_id?: unknown } | null | undefined;
  const type = input != null && typeof input === "object" ? input.subagent_type : undefined;
  if (tool === "Agent" && typeof type === "string" && STAGE_AGENT_NAMES.some((n) => `session-owl:${n}` === type)) {
    log.info(`tool.check: stage spawn self-approved (${type})`);
    return { decision: "allow" };
  }
  // The same approval for the handback stop: the ambient TaskStop names
  // one of the spawns above, and auto mode would otherwise put it to the
  // classifier that gives no verdict for a call no request produced.
  const taskId = input != null && typeof input === "object" ? input.task_id : undefined;
  if (tool === "TaskStop" && typeof taskId === "string" && bridge.spawnRegistry.has(taskId)) {
    log.info(`tool.check: stage stop self-approved (${taskId})`);
    return { decision: "allow" };
  }
  return next(e);
}

async function onAgentOffer(_$: any, e: AnyEvent, next: Next) {
  // The stage types are hidden from the model's agent picker: the
  // main model never sees owl's stages as spawnable (a plugin's own
  // $.agent.spawn of a type is no offer, so only the listing is affected).
  if (e && typeof e.agent === "string" && STAGE_AGENT_NAMES.some((n) => e.agent === `session-owl:${n}`)) {
    return { isOffered: false };
  }
  return next(e);
}

/** The surface the settings pane last drew on (set by its ui.render):
 *  the desktop drives the pane with the pointer, and its focus offers are
 *  the pointer's own landings (hover, click) rather than arrow walks. */
let settingsPaneSurface: "desktop" | "keyboard" = "keyboard";

/** The focus ring moved inside the settings pane: the described row follows
 *  it (pi's selected-row description area tracks the arrows' selection), and
 *  a move OFF our elements — to one of the engine's own stops (another
 *  pane's tab, the pane chrome) — is DENIED so the ring stays on our rows
 *  (pi's modal is exclusive: the arrows never leave it; Esc still closes). */
function onPaneFocus(_$: any, e: AnyEvent, next: Next) {
  const controller = getSettingsPaneController();
  const element = (e as { element?: unknown }).element;
  if (controller === null) return next(e);
  // A surface that never takes the keyboard (the desktop pane) ignores
  // autoFocus and lands its ring on the pane's LAST actable at mount; the
  // first offer after an open rewrites that landing onto the first tab, so
  // the pane starts where it starts everywhere else. Keyboard surfaces'
  // own first offer — the filter field's autoFocus — passes untouched.
  if (takeSettingsPaneFirstRingOffer()) {
    const seat = typeof element === "string" ? element.split(":")[0] : "";
    if (seat !== "settings-filter" && seat !== "picker-filter" && element !== "picker-custom") {
      return next({ ...e, element: "settings-tab-0" });
    }
  }
  // A pointer-driven surface has no keyboard to anchor: every offer is the
  // pointer's own landing (hover, click), so it passes through — the
  // anchored model would read each as an arrow signal (phantom selection
  // walks on every click and hover) and its deny would swallow the first
  // press of anything below the rows (the Close button needed two)
  if (settingsPaneSurface === "desktop") {
    return next(e);
  }
  // The input-anchored keyboard model: the filter Input holds the ring.
  // Every person-origin move attempt onto anything but our own text
  // inputs is denied — the controller reads the offered target as the
  // navigation signal (arrows/Tab walk its internal selection) while the
  // typed characters stay in the field (the engine would route them to
  // the composer with the ring on a Button — the platform gap).
  const anchored = (
    controller as {
      anchorFocusAttempt?: (key: string | null) => "allow" | "deny" | `redirect:${string}`;
    }
  ).anchorFocusAttempt;
  if (anchored !== undefined) {
    const verdict = anchored.call(controller, typeof element === "string" ? element : null);
    if (verdict === "deny") {
      return { deny: "the filter field keeps the keyboard — arrows walk the selection" } as never;
    }
    if (typeof verdict === "string" && verdict.startsWith("redirect:")) {
      // the walk fell off the picker's last option: land the ring on the
      // custom value field — the engine's own element rewrite (typing
      // follows the ring into the field; its Enter submits the value)
      return next({ ...e, element: verdict.slice("redirect:".length) });
    }
    return next(e);
  }
  if (typeof element !== "string") {
    // a ring stranded on pane chrome (a vanished picker element dropped it
    // there) must be allowed back — denying every move from chrome locked
    // the ring AND the ring-driven description box in place
    if (controller.isRingOnRow()) {
      return { deny: "the settings pane keeps the ring on its rows" } as never; // an engine stop — keep the ring
    }
    return next(e);
  }
  controller.setDescribedFromKey(element);
  return next(e);
}

/** The pane's close key (Escape) or close mark: while the value picker is
 *  open, Esc RETURNS to the settings list (pi's picker Esc) — answering
 *  { deny } keeps the pane open; otherwise the close proceeds. */
function onPaneClose(_$: any, e: AnyEvent, next: Next) {
  const controller = getSettingsPaneController();
  const origin = (e as { origin?: { kind?: unknown } }).origin;
  if (controller !== null && controller.state().pickingRow !== null && origin?.kind !== "unload") {
    controller.closePicker();
    return { deny: "the value picker is open \u2014 Escape returns to the settings list" } as never;
  }
  return next(e);
}

async function onUiRender($: any, e: AnyEvent, next: Next) {
  // The idle line's post-fold refresh rides this dispatch: the band's
  // opening frame drew before the store fold landed, and an out-of-frame
  // invalidation does not redraw the band — the request is consumed here,
  // IN frame, so the engine re-renders with the counts now servable
  if (consumeIdleRefresh()) {
    try {
      $.ui.invalidate("ui.render");
    } catch {
      /* an engine that refuses mid-render invalidation draws the line at
       * its next natural frame — the counts are already servable */
    }
  }
  // The settings pane (the family library's tree over the pane controller —
  // surfaces with field elements get the full tabbed pane; mobile draws a
  // text-only manual-JSON notice instead of a broken tree).
  if (e && (e as { component?: unknown }).component === "Pane") {
    const requestId = (e as { requestId?: unknown }).requestId;
    if (requestId === VIEWER_PANE_ID) {
      // the command-output viewer: the stored listing drawn whole, one Text
      // per line inside the pane's scrollable body (no drawing cap)
      await next(e);
      const table = $.ui.resolve(e) as never;
      return buildViewerTree(table as never) as never;
    }
    if (requestId === SETTINGS_PANE_ID) {
      const inner = await next(e);
      const table = $.ui.resolve(e) as never;
      settingsPaneSurface = (e as { surface?: unknown }).surface === "desktop" ? "desktop" : "keyboard";
      if ((e as { surface?: unknown }).surface === "mobile") {
        return manualJsonNoticeTree(table as never) as never;
      }
      const controller = getSettingsPaneController();
      if (controller === null) return inner;
      const props = (e as { props?: { bodyColumns?: number } }).props;
      return buildPaneTree(table, controller, {
        bodyColumns: props?.bodyColumns ?? 80,
        surface: (e as { surface?: unknown }).surface === "desktop" ? "desktop" : undefined,
      }) as never;
    }
    return next(e);
  }
  // The AbovePrompt band — the widget's one-line status on the surfaces that
  // raise the band (terminal + desktop only; the mobile/vscode fallback rides
  // the status capsule from the tracker bridge). A survey holding the band
  // yields; a live line composes UNDER whatever else the band carries
  // (next(e) preserved — every other mod's band content stays alive). The
  // composition reads only the closure-safe line store; the tracker bridge
  // (Node-side) publishes into it and asks for the re-render.
  if (e && (e as { component?: unknown }).component === "AbovePrompt") {
    const inner = await next(e);
    // disabled owl draws nothing on the band: the widget line must not
    // outlive the Enabled switch
    if (!state.isOwlEnabled()) return inner;
    // The conflict-pause line (live — mid-session flips re-render): wins
    // over the store's stage line while paused (a stale stage line must
    // not outlive the pause); the survey still holds the band either way.
    const pausedNow = isConflictPaused(() => ({
      enabled: state.isOwlEnabled(),
      ignoreConflicts: state.isOwlIgnoreConflicts(),
    }));
    const pauseLine =
      pausedNow && getConflictHits() !== null
        ? formatPauseLine(
            (getConflictHits() ?? []).map((h) => h.name),
            (e as { props?: { bodyColumns?: number } }).props?.bodyColumns ?? 80,
          )
        : null;
    const decision = decideBand(
      (e as { hasSurvey?: boolean }).hasSurvey === true,
      inner,
      pauseLine,
      detailsWarmPending() ? OWL_LOADING_LINE : null,
    );
    if (decision.kind === "passthrough") return inner;
    const table = $.ui.resolve(e);
    return composeBand(table as never, decision) as never;
  }
  // The owl_recall render restyle (human-facing only): the result rows cap
  // at the collapsed limit with the expand hint (error rows draw in full).
  // The compact call line's render site rides the same element-tree idiom.
  if (e && (e as { component?: unknown }).component === "ToolResult") {
    const props = (e as { props?: unknown }).props;
    if (props !== undefined && props !== null) {
      const restyled = restyleToolResultProps(props as never);
      if (restyled !== props) {
        return next({ ...e, props: restyled });
      }
    }
  }
  return next(e);
}

/** The tool.call guard: asked in the hook's place where a throw/overrun —
 *  or a RE-ENTRY (the event rose beneath our own frame, so the engine
 *  refuses to run the hook beneath itself) — kept the hook from answering.
 *  Stage tools are host-free (their executors need no `$`) and answer here
 *  exactly as the main path would; everything else falls through to what
 *  runs beneath (the engine's own fallback). */
async function onToolCallFailure(_$: any, e: AnyEvent, next: Next) {
  const kind = typeof next?.error?.kind === "string" ? next.error.kind : "?";
  diag(
    `tool.call guard: kind=${kind} tool=${e && typeof e.tool === "string" ? e.tool : "?"} agent=${
      typeof e?.agentId === "string" ? e.agentId : "-"
    }`,
  );
  if (kind === "re-entry" && e && typeof e.tool === "string" && stageToolShortName(e.tool) !== null) {
    try {
      return await handleStageToolCall(
        e as { tool: string; agentId?: string },
        (agentId) => getStageRun(agentId) !== undefined,
      );
    } catch (err) {
      const message = `Error: session-owl stage tool failed: ${err instanceof Error ? err.message : String(err)}`;
      diag(`stage tool.call failed (guard): ${message}`);
      return { result: message };
    }
  }
  return next(e);
}

async function onPromptSubmit(_$: any, e: AnyEvent, next: Next) {
  // The delivery drop: a stage agent's handback report reaches the
  // main conversation as a peer agent-message — owl's stages are internal,
  // so exactly those are dropped (the stage dump is their record).
  const drop = shouldDropPeerMessage(e, bridge.spawnRegistry);
  if (drop !== null) {
    return { drop };
  }
  return next(e);
}

/**
 * Keep session-owl out of the MAIN agent's injected MCP text (the answer
 * holds per attachment for the process). The engine names deferred tools and
 * prints server-instruction blocks for every registered tool, while a spawned
 * stage's own request carries only its allowlist — so the two audiences split
 * on `agentId`: absent (main) is filtered here, a subagent's stays whole.
 * Text-only: `tools[]` itself no hook in the platform can reach.
 */
async function onPromptAttachment(_$: any, e: AnyEvent, next: Next) {
  if (e?.agentId !== undefined) return next(e);
  const type = String((e as { type?: unknown }).type ?? "");
  const raw = (e as { text?: unknown }).text;
  if (typeof raw !== "string" || !raw.includes("session-owl")) return next(e);
  let stripped: string;
  if (type === "mcp_instructions_delta") {
    // one "## <server>\n<instructions>" block per server
    stripped = raw.replace(/## session-owl[^#]*/g, "");
  } else if (type === "deferred_tools_delta") {
    // one tool name per line
    stripped = raw
      .split("\n")
      .filter((line) => !line.includes("session-owl"))
      .join("\n");
  } else {
    return next(e);
  }
  if (stripped === raw) return next(e);
  return { text: stripped.trim() ? stripped : null };
}

async function onSessionReceive(_$: any, e: AnyEvent, next: Next) {
  // the arrival shape BEFORE the predicate: the live file log then carries
  // the origin kind, sender agent id and text head of every delivery — the
  // evidence needed when a handback does or does not consume.
  diag(
    `session.receive: kind=${String(e?.origin?.kind ?? e?.origin)} agent=${
      typeof e?.agentId === "string" ? e.agentId : "-"
    } head=${JSON.stringify(String(e?.text ?? "").slice(0, 120))}`,
  );
  // Take a stage agent's handback HERE, before it is queued: a consumed
  // delivery is never queued, never written to the transcript and never
  // reaches the model — and the engine prints no drop notice for it (its
  // prompt.submit drop never fires). The identical predicate keys off the
  // same peer-origin wrapper + spawn-registry gate; the prompt.submit drop
  // stays as the backstop for any delivery that slips past this gate.
  const consumed = shouldDropPeerMessage(e, bridge.spawnRegistry);
  if (consumed !== null) {
    diag(`session.receive: stage handback consumed — ${consumed}`);
    return { consumed };
  }
  // Cross-session receive guard (Channel A): messages from other sessions'
  // agents are observed, never treated as this session's rows.
  return next(e);
}

// A subagent hands off (classic.SubagentStop): its conversation's resident
// state drops once its own run-lock releases — a still-draining stage run
// keeps its store until then. The key is the same `sessionId|agentId` shape
// sidechain rows build, so the eviction names exactly the loop that left; a
// key we never hydrated evicts nothing, and a resumed subagent re-hydrates
// cold on its next arrival (the ordinary miss path). Fire-and-forget: the
// hook answers within its budget no matter how long the draining run holds.
async function onClassicSubagentStop(_$: any, e: AnyEvent, next: Next) {
  const agentId = typeof e.agent_id === "string" ? e.agent_id : "";
  const sessionId = typeof e.session_id === "string" ? e.session_id : "";
  if (agentId !== "" && sessionId !== "") {
    const key = `${sessionId}|${agentId}`;
    void (async () => {
      try {
        await awaitIdle(key);
        evictResidentConversation(key);
      } catch (cause) {
        diag(`subagent handoff: eviction failed key=${key} cause=${String(cause)}`);
      }
    })();
  }
  return next(e);
}

// --- the wiring -----------------------------------------------------------------------

export const register: Register = (on) => {
  on("engine.create", onEngineCreate);
  on("plugin.register", onPluginRegister);
  on("session.start", onSessionStart);
  on("classic.SessionStart", onClassicSessionStart);
  on("classic.SubagentStop", onClassicSubagentStop);
  on("session.end", onSessionEnd);
  on("session.append", onSessionAppend);
  // The relay's generator shape is runtime-checked by the kit specs; the
  // typed chunk union fights the AnyEvent envelope, so the call site casts.
  on("turn.step", onTurnStep as never);
  on("turn.complete", onTurnComplete);
  on("session.measure", onSessionMeasure);
  on("session.compact", onSessionCompact);
  on("tool.register", onToolRegister);
  on("tool.call", onToolCall).catch(onToolCallFailure);
  on("tool.check", { tool: "Agent" }, onToolCheck);
  on("tool.check", { tool: "TaskStop" }, onToolCheck);
  on("command.register", onCommandRegister);
  on("command.run", onCommandRun);
  on("agent.offer", onAgentOffer);
  on("ui.render", onUiRender);
  on("ui.focus", { requestId: SETTINGS_PANE_ID }, onPaneFocus);
  // the press trace: which of the pane's controls actually fire (the
  // keybinding dispatch debuggability — a chord that never lands here was
  // consumed by an engine handler before reaching the pane)
  on("ui.press", { requestId: SETTINGS_PANE_ID }, (_pe$: any, pe: AnyEvent, peNext: Next) => {
    log.info(
      `pane press: ${String((pe as { element?: unknown }).element)} (${String((pe as { surface?: unknown }).surface)})`,
    );
    return peNext(pe);
  });
  on("ui.close", { id: SETTINGS_PANE_ID }, onPaneClose);
  on("prompt.submit", onPromptSubmit);
  on("prompt.attachment", onPromptAttachment);
  on("session.receive", onSessionReceive);
};
