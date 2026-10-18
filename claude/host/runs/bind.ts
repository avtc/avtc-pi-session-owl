// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// The conversation binding — the runtime assembly the register wiring hands
// to the trigger boundaries, the compaction gate, and the commands. One
// instance per conversation (memoized; the conversation's dispose list
// releases it): the storage assembly's live writers, the core
// multiplexer's serialized pin, the capture pipeline's entry view, the
// live settings read, the widget bridge, and the REAL stage runs bound
// over all of it. Every external surface rides the bridge capsules (armed
// at every hook entry); this module never touches an engine object.
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { SessionOwlConfig } from "../../core/src/config/schema.js";
import { log } from "../../core/src/log.js";
import type { GraphStore } from "../../core/src/store/graph-store.js";
import { makeMaybeBuilder } from "../../core/src/triggers.js";
import { type SessionOwlGraph as GraphShape, SessionOwlGraph } from "../../core/src/types.js";
import { entriesForCache, getCapture } from "../capture/append-handler.js";
import { makeEntryResolver } from "../capture/details-bridge.js";
import { type ClaudeRow, groupRows } from "../capture/grouper.js";
import type { OwlCommandDeps } from "../commands/handlers.js";
import { type CompactionHookDeps, type CompactionRuns, countCompactions } from "../compaction/hook.js";
import { isConflictPaused } from "../conflicts/pause.js";
import { type CoreHandle, getCore } from "../core-instances.js";
import type { StageDumpLocation } from "../dumps/module.js";
import * as bridge from "../engine-bridge.js";
import { type ConfirmFn, makeNotifyAdapter } from "../notify/adapter.js";
import { checkpointService } from "../rewind/checkpoint-service.js";
import { getInstalledSettingsHandle, PORT_DEFAULTS_CONFIG } from "../settings/consumer.js";
import { PORT_KEEP_RECENT_TOKENS_DEFAULT } from "../settings/port-fields.js";
import { captureInitialPrompt } from "../start/initial-prompt.js";
import * as state from "../state.js";
import { serveStatusReport } from "../status/report.js";
import { sweepMirror } from "../storage/mirror.js";
import { getSessionStorage } from "../storage/session-storage.js";
import { newSnapshotId, persistSnapshotText } from "../storage/snapshot.js";
import { type PreparedContext, prepareStoreContext } from "../storage/store-context.js";
import { makeTodoBridge } from "../todo/bridge-consumer.js";
import { makeTriggerCtx, windowFor } from "../triggers/context.js";
import { evaluateAndLaunch, type TriggerHostDeps, type TriggerRuns } from "../triggers/eval.js";
import { acquireForCompaction, acquireForExtract, acquireOrSkip } from "../triggers/run-locks.js";
import { createWidgetBridge, type WidgetBridge } from "../widget/tracker-bridge.js";
import { runBuilder } from "./builder.js";
import { goalExtractSettled, runGoalExtract } from "./goal-extract.js";
import { goalModelSetting, makeGoalCompleter } from "./goal-extract-complete.js";
import { runObserver } from "./observer.js";
import { runReuseRebuild } from "./reuse-rebuild.js";
import { sessionStartMsFromBranch } from "./seams.js";
import { runSelector } from "./selector.js";

/** The bound conversation — see the module comment. */
export interface ConversationBinding {
  readonly key: string;
  readonly sessionId: string;
  readonly agentId: string | null;
  /** Live settings (the installed handle's read; the port's schema defaults
   *  before init — the same composite the handle normalizes through, so the
   *  pre-init window resolves identically, haiku background model included). */
  settings(): SessionOwlConfig;
  /** The live master switch: enabled AND not conflict-paused. */
  isEnabled(): boolean;
  /** The conflict pause (live). */
  isPaused(): boolean;
  /** Pins the conversation's core through the multiplexer's serialized swap. */
  pinCore(): Promise<CoreHandle>;
  /** The pinned conversation's graph (the last pin's reference; the empty
   *  graph before the first pin — the widget renders zeros, never throws). */
  graph(): GraphShape;
  /** The pinned conversation's graph store singleton view. */
  graphStore(): GraphStore;
  /** The conversation's observer frontier (post-pin). */
  observerFrontier(): string | null;
  /** The conversation's entry view (the capture grouper over the row cache). */
  branch(): SessionEntry[];
  /** The entry view's leaf id (null when empty). */
  leafId(): string | null;
  /** The stage widget (the tracker bridge instance for this conversation). */
  readonly widget: WidgetBridge;
  /** The evaluator's deps, runs bound to the real stage-run modules. */
  triggerDeps(): TriggerHostDeps;
  /** The compaction gate's deps (the takeover's named inputs, all bound). */
  compactionDeps(): CompactionHookDeps;
  /** The /owl-* command bodies' deps (browse/maintenance arms; the
   *  confirm + rewind-check capsules arrive from the wiring). */
  commandDeps(extras: {
    confirm: ConfirmFn;
    checkThenServe: (key: string) => Promise<void>;
    openViewer?: (title: string, text: string) => void;
  }): OwlCommandDeps;
  /** Fire the goal extraction for this conversation (never throws). */
  launchGoalExtract(verbatim: string): Promise<void>;
  /** The mid-session initial-prompt capture (pi's every-turn-end gate);
   *  answers the captured text, or null when this conversation's initial
   *  prompt is already captured (idempotent). */
  captureInitialPromptForTurn(): Promise<string | null>;
  /** Drop the instance's memo (the conversation's dispose hook). */
  dispose(): void;
}

// ---- module state ----------------------------------------------------------

const bindings = new Map<string, ConversationBinding>();
/** The process's session cwd (the dumps' per-project dir stem; captured at
 *  the session bootstrap from the hook envelope). */
let sessionCwd = "";

/** Record the session cwd (the bootstrap hands the envelope's cwd over). */
export function setSessionCwd(cwd: string): void {
  sessionCwd = cwd;
}

/** Test isolation. */
export function _resetBindings(): void {
  bindings.clear();
  sessionCwd = "";
}

/** Test/inspection seam: whether a conversation binding exists (the compact
 *  decline, for one, must leave a disabled subagent loop unbound). */
export function hasBinding(key: string): boolean {
  return bindings.has(key);
}

/** One binding per conversation (memoized; releaseBinding/dispose drops it). */
export function getBinding(key: string, sessionId: string, agentId: string | null): ConversationBinding {
  const existing = bindings.get(key);
  if (existing !== undefined) return existing;

  const storage = getSessionStorage(key, sessionId, agentId);
  const services = () => bridge.currentServices();

  // The conversation's prepared store context — the runtime fold of its
  // segment files (the boot backfill's own prepare is the same
  // deterministic fold; both derive identical state).
  let prepared: Promise<PreparedContext> | null = null;
  const preparedCtx = (): Promise<PreparedContext> => {
    // Hydrate the durable mirror batches first (once per binding): an agent
    // loop's storage is RELEASED at each of its turn ends and the re-created
    // MirrorWriter starts EMPTY — without adopting the flushed batches back,
    // the branch (and the compaction gate's catch-up over it) would read a
    // stump of just the post-release rows while the conversation's rows sit
    // unread on disk. The main conversation's storage is never released
    // mid-session (its live index already holds every row — adoption dedups
    // to a no-op), and pi is structurally immune (each subagent runs its own
    // process, whose boot backfill adopts from disk at start).
    prepared ??= (async () => {
      const sweep = await sweepMirror(storage.fs, storage.dir);
      storage.mirror.adoptRows(sweep.rows);
      return prepareStoreContext(storage.fs, storage.dir, storage.ledger, storage.mirror);
    })();
    return prepared;
  };

  const settings = (): SessionOwlConfig => {
    const handle = getInstalledSettingsHandle();
    const base = handle === null ? PORT_DEFAULTS_CONFIG : handle.getSettings();
    // The subagent-mode override: an agent-scoped conversation with
    // "on-compaction" defers its Observer to the compaction catch-up — the
    // effective settings carry observerMode "on-compaction" for THIS
    // conversation only (the vendored matrix then skips the turn-boundary
    // observer arm; the Builder/Selector cadences stay as configured). The
    // main conversation and every other mode read through untouched.
    if (agentId !== null && base.subagentMode === "on-compaction") {
      return { ...base, observerMode: "on-compaction" };
    }
    return base;
  };
  const isPaused = (): boolean =>
    isConflictPaused(() => ({ enabled: state.isOwlEnabled(), ignoreConflicts: state.isOwlIgnoreConflicts() }));
  const isEnabled = (): boolean => state.isOwlEnabled() && !isPaused();

  const mirrorRows = (): ClaudeRow[] => {
    const out: ClaudeRow[] = [];
    for (const uuid of storage.mirror.arrivalOrder()) {
      const row = storage.mirror.rowByUuid(uuid)?.row;
      if (row !== undefined) out.push(row as ClaudeRow);
    }
    return out;
  };

  let pinnedGraph: GraphShape = new SessionOwlGraph({
    nodes: new Map(),
    observations: new Map(),
    nextObsId: 1,
    nextNodeId: 1,
  });
  /** The last pin's store view (captured at pin time — the same no-intervening-
   *  awaits discipline the vendored decisions follow). */
  let pinnedStoreView: GraphStore | null = null;
  /** The resolved store context of the last pin — the sync seams (the
   *  rescan reset) need it without re-awaiting the prepared fold. */
  let resolvedCtx: PreparedContext["ctx"] | null = null;
  /** The last pin's core handle — the module-surface route (the multiplexer's
   *  rule: the stateful core is reached through the handle, never a static
   *  value import). */
  let pinnedHandle: CoreHandle | null = null;

  const pinCore = async (): Promise<CoreHandle> => {
    const ctx = (await preparedCtx()).ctx;
    resolvedCtx = ctx;
    const handle = await getCore(key, {
      ctxFactory: () => ctx,
      resolverFactory: () =>
        makeEntryResolver({ rows: () => mirrorRows(), version: () => storage.mirror.rowVersion() }),
    });
    pinnedHandle = handle;
    const storeView = handle.store.getGraphStore();
    pinnedStoreView = storeView;
    pinnedGraph = storeView.graph;
    return handle;
  };

  // The one-shot model capsule (goal extraction) — literal at the arm site,
  // data here. The skip/answer diagnostics ride the FILE log too (the uiLog
  // debug line alone made "no model resolvable" invisible in production).
  const completer = makeGoalCompleter({
    complete: (req, opts) => services().modelComplete(req, opts) as never,
    getModel: () => goalModelSetting(settings().observerModel, settings().defaultModel, state.getSessionModel()),
    log: (message) => {
      services().log(message);
    },
  });

  function errText(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
  }

  const dumps = (): StageDumpLocation => ({
    fs: {
      readText: (p) => services().fsRead(p),
      writeText: (p, t) => services().fsWrite(p, t),
      listDir: async (p) => {
        try {
          // the platform list returns entry objects ({name, kind}), not
          // strings — map to names (a bare string passes through)
          const entries = (await services().fsList(p)) as Array<string | { name?: unknown }>;
          if (!Array.isArray(entries)) return [];
          return entries.map((e) => (typeof e === "string" ? e : typeof e?.name === "string" ? e.name : ""));
        } catch (err) {
          log.info(`dumps fs listDir failed, treated as empty (${p}): ${errText(err)}`);
          return [];
        }
      },
      statMtime: async (p) => {
        try {
          const st = (await services().fsStat(p)) as { mtimeMs?: number } | null;
          return st?.mtimeMs ?? null;
        } catch (err) {
          log.info(`dumps fs stat failed, treated as missing (${p}): ${errText(err)}`);
          return null;
        }
      },
    },
    baseDir: `${state.getCachedConfigDir() ?? ""}/session-owl`,
    cwd: sessionCwd,
    // the debugging attribution (the dumps dir is per-project): which
    // session — and subagent loop, when the agent id is known — wrote this
    // file rides the <dump> header.
    session: sessionId,
    agent: agentId,
  });

  const notify = makeNotifyAdapter((text) => services().uiLog(text));

  const widget: WidgetBridge = createWidgetBridge({
    getSettings: settings,
    getGraph: () => pinnedGraph,
    resolveContextWindow: (modelId) => {
      if (modelId === null) return null;
      return windowFor(sessionId);
    },
    theme: PLAIN_THEME,
    width: () => 100,
    getSurfaces: async () => (await services().sessionSurfaces()) as string[],
    uiInvalidate: () => services().uiInvalidate(),
    uiStatus: (text) => services().uiStatus(text),
    isConflictPaused: isPaused,
    bootstrapBlockedCommand: () => (state.isOwlEnabled() ? state.getBootstrapBlockedCommand() : null),
    scope: agentId === null ? "main" : "agent",
    log: (message) => {
      // both sinks: the production file log and the engine debug log — a
      // live session's widget dispatch failures were otherwise invisible
      // (uiLog to:"debug" writes nowhere without --debug). Each sink guards:
      // this runs inside issue()'s catch too, where a second throw would
      // surface as an unhandled rejection on an unarmed bridge.
      try {
        services().widgetLog(message);
      } catch (err) {
        /* the bridge un-armed (kit contexts) — the debug sink still gets it */
        log.info(`widget log sink unavailable: ${errText(err)} — ${message}`);
      }
      try {
        services().uiLog(message, { to: "debug" });
      } catch (err) {
        /* same guard for the engine sink */
        log.info(`widget debug sink unavailable: ${errText(err)} — ${message}`);
      }
    },
  });

  const triggerRuns: TriggerRuns = {
    runObserver: async ({ signal, unobserved, maybeBuild }) => {
      await runObserver({
        core: await pinCore(),
        store: (await preparedCtx()).ctx,
        settings: settings(),
        unobserved: unobserved ?? [],
        signal,
        maybeBuild,
        widget,
        notify,
        isEnabled,
        flushLedger: async () => {
          await storage.ledger.flush();
        },
        dumps: dumps(),
      });
    },
    runBuilder: async ({ signal }) => {
      await runBuilder({
        core: await pinCore(),
        store: (await preparedCtx()).ctx,
        settings: settings(),
        signal,
        widget,
        scope: null,
        flushLedger: async () => {
          await storage.ledger.flush();
        },
        dumps: dumps(),
      });
    },
    runSelector: async ({ signal }) => {
      const todo = await makeTodoBridge({
        avtcTodoGetItems: () => services().avtcTodoGetItems(),
      });
      await runSelector({
        core: await pinCore(),
        store: (await preparedCtx()).ctx,
        settings: settings(),
        signal,
        widget,
        scope: null,
        todo: todo === null ? null : todo.context,
        todoBridge: todo === null ? null : todo.bridge,
        readBranch: () => binding.branch() as never,
        flushLedger: async () => {
          await storage.ledger.flush();
        },
        dumps: dumps(),
      });
    },
  };

  const binding: ConversationBinding = {
    key,
    sessionId,
    agentId,
    settings,
    isEnabled,
    isPaused,
    pinCore,
    /** The mid-session initial-prompt capture (pi's every-turn-end gate):
     *  a live session's first prompt arrives AFTER the session-start
     *  backfill, so the turn boundary is where oInitialPrompt lands and
     *  the one-shot goal extraction fires — before the Observer's trigger
     *  so the first user message is exclusively oInitialPrompt. */
    captureInitialPromptForTurn: async (): Promise<string | null> => {
      if (!isEnabled()) return null;
      const core = await pinCore();
      const ctx = (await preparedCtx()).ctx;
      const entries = groupRows(mirrorRows());
      const captured = captureInitialPrompt(core, ctx, entries, (verbatim) => {
        binding.launchGoalExtract(verbatim).catch((cause: unknown) => {
          services().log(`goal extract failed: ${cause instanceof Error ? cause.message : String(cause)}`);
        });
      });
      if (captured !== null) await storage.ledger.flush();
      return captured;
    },
    graph: () => pinnedGraph,
    graphStore: (): GraphStore => {
      if (pinnedStoreView === null) throw new Error(`binding ${key}: graphStore() before the first pin`);
      return pinnedStoreView;
    },
    observerFrontier: () => pinnedStoreView?.observerFrontier ?? null,
    // The branch = the durable mirror (arrival order — the backfill's rows
    // included, so a restarted process sees the full history) overlaid with
    // the capture cache's not-yet-flushed rows. The cache ALONE would hand a
    // post-restart compaction an empty branch: the kept-tail cut could not
    // map, tail thinking could not be collected.
    branch: () => {
      // rewind-aware: rows the reconciliation marked DEAD never re-enter the
      // served branch — the observer's re-observe scope (a rescan
      // after a rewind) and the compaction context both stay on the live
      // branch; the mirror itself keeps every row (chronological order)
      const dead = checkpointService().deadRowsFor(key);
      const seen = new Set<string>();
      const rows: ClaudeRow[] = [];
      for (const row of mirrorRows()) {
        seen.add(row.uuid);
        if (!dead.has(row.uuid)) rows.push(row);
      }
      const cap = getCapture(key);
      if (cap !== undefined) {
        for (const row of cap.rowCache.values()) {
          if (!seen.has(row.uuid) && !dead.has(row.uuid)) rows.push(row);
        }
      }
      return groupRows(rows);
    },
    leafId: () => {
      const entries = entriesForCache(key);
      return entries.length === 0 ? null : (entries[entries.length - 1] as SessionEntry).id;
    },
    widget,
    triggerDeps: (): TriggerHostDeps => ({
      key,
      settings: settings(),
      getLeafId: () => binding.leafId(),
      getBranch: () => binding.branch(),
      thinkingLevel: settings().defaultThinkingLevel,
      isEnabled,
      launchGuard: () => !state.isBootstrapBlocked(),
      cheapGateClean: () => !checkpointService().tripwires().evaluate(key).suspected,
      getObserverFrontier: () => binding.observerFrontier(),
      pinCore: async () => {
        await pinCore();
      },
      runs: triggerRuns,
    }),
    compactionDeps: (): CompactionHookDeps => {
      const liveSettings = settings();
      const keepRecentTokensField = (liveSettings as { keepRecentTokens?: unknown }).keepRecentTokens;
      const aggregatedThinkingField = (liveSettings as { keptTailAggregatedThinking?: unknown })
        .keptTailAggregatedThinking;
      const injectedSummaryRowField = (liveSettings as { injectedSummaryRow?: unknown }).injectedSummaryRow;
      const compactionRuns: CompactionRuns = {
        runObserver: async ({ unobserved, signal, maybeBuild }) => {
          await runObserver({
            core: await pinCore(),
            store: (await preparedCtx()).ctx,
            settings: liveSettings,
            unobserved,
            signal,
            widget,
            notify,
            isEnabled,
            maybeBuild,
            flushLedger: async () => {
              await storage.ledger.flush();
            },
            dumps: dumps(),
          });
        },
        runBuilder: async ({ signal, scope }) => {
          await runBuilder({
            core: await pinCore(),
            store: (await preparedCtx()).ctx,
            settings: liveSettings,
            signal,
            widget,
            scope,
            flushLedger: async () => {
              await storage.ledger.flush();
            },
            dumps: dumps(),
          });
        },
        runSelector: async ({ signal, scope }) => {
          const todo = await makeTodoBridge({
            avtcTodoGetItems: () => services().avtcTodoGetItems(),
          });
          await runSelector({
            core: await pinCore(),
            store: (await preparedCtx()).ctx,
            settings: liveSettings,
            signal,
            widget,
            scope,
            todo: todo === null ? null : todo.context,
            todoBridge: todo === null ? null : todo.bridge,
            readBranch: () => binding.branch() as never,
            flushLedger: async () => {
              await storage.ledger.flush();
            },
            dumps: dumps(),
          });
        },
      };
      return {
        key,
        settings: liveSettings,
        getSettings: settings,
        isPaused,
        // the ported kept-tail budget: a settings field, the port default until
        // the live read carries it
        keepRecentTokens:
          typeof keepRecentTokensField === "number" ? keepRecentTokensField : PORT_KEEP_RECENT_TOKENS_DEFAULT,
        keptTailAggregatedThinking: aggregatedThinkingField !== false, // pi parity: content kept
        injectedSummaryRow: injectedSummaryRowField === true, // display echo, default off
        getBranch: () => binding.branch(),
        getLeafId: () => binding.leafId(),
        getObserverFrontier: () => binding.observerFrontier(),
        pinCore: async () => {
          await pinCore();
        },
        getGraphStore: () => binding.graphStore(),
        runs: compactionRuns,
        persistSnapshot: async (details: unknown, compactionId: string) => {
          // the snapshot's liveness anchor: the newest mirrored row (the
          // rows the render reflects); the branch leaf covers a fresh
          // conversation before any mirror row exists
          const marker = storage.mirror.tipUuid() ?? binding.leafId() ?? "";
          await persistSnapshotText(
            storage.fs,
            storage.dir,
            storage.ledger,
            compactionId,
            JSON.stringify(details),
            marker,
          );
        },
        notify,
        log: (message: string) => {
          // dual-write: the engine's debug channel (the compaction
          // diagnostics surface) AND owl's own file log — the collector's
          // verification lines must be greppable from our log for support
          services().uiLog(`compaction: ${message}`, { to: "debug" });
          log.info(`compaction: ${message}`);
        },
        newCompactionId: newSnapshotId,
      };
    },
    commandDeps: (extras: {
      confirm: ConfirmFn;
      checkThenServe: (key: string) => Promise<void>;
      openViewer?: (title: string, text: string) => void;
    }): OwlCommandDeps => ({
      key,
      notify,
      confirm: extras.confirm,
      openViewer: extras.openViewer,
      // pi's command predicate: ENABLED ONLY (browse serves while
      // conflict-paused, rescan/status/reobserve gate on enabled — the
      // paused state is handled inside the bodies: status is paused-first,
      // browse serves the graph). The pause-aware closure above stays with
      // the trigger/compaction/reuse consumers.
      isEnabled: () => state.isOwlEnabled(),
      isBootstrapBlocked: () => state.isBootstrapBlocked(),
      getSettings: settings,
      checkThenServe: extras.checkThenServe,
      pinCore: async () => {
        await pinCore();
      },
      getGraphStore: () => binding.graphStore(),
      getLeafId: () => binding.leafId(),
      getBranch: () => binding.branch(),
      resetGraphForRescan: () => {
        if (resolvedCtx === null || pinnedHandle === null) {
          throw new Error(`binding ${key}: resetGraphForRescan() before the first pin`);
        }
        pinnedHandle.store.resetGraphForRescan(resolvedCtx);
      },
      relaunchMaintenance: () => evaluateAndLaunch(binding.triggerDeps()),
      acquireForCompaction: () => acquireForCompaction(key),
      acquireOrSkipObserve: () => acquireOrSkip(key, "observe"),
      goalExtractSettled: () => goalExtractSettled(),
      runReuseRebuild: async (signal) => {
        const build = makeMaybeBuilder({
          ctx: makeTriggerCtx({
            key,
            getLeafId: () => binding.leafId(),
            getBranch: () => binding.branch(),
            thinkingLevel: null,
          }) as unknown as Parameters<typeof makeMaybeBuilder>[0]["ctx"],
          settings: settings(),
          signal,
          scope: { firstKeptEntryId: null },
          runBuilder: async () => {
            await triggerRuns.runBuilder({ signal });
          },
        });
        await runReuseRebuild({
          core: await pinCore(),
          store: (await preparedCtx()).ctx,
          settings: settings(),
          signal,
          widget,
          maybeBuild: build,
          isEnabled,
          flushLedger: async () => {
            await storage.ledger.flush();
          },
          headUserEntryId: () => {
            const firstUser = groupRows(mirrorRows()).find(
              (e) => e.type === "message" && (e as { message?: { role?: string } }).message?.role === "user",
            );
            return firstUser?.id ?? null;
          },
          recaptureInitialPrompt: async () => {
            if (!isEnabled()) return null;
            const core = await pinCore();
            const ctx = (await preparedCtx()).ctx;
            const captured = captureInitialPrompt(core, ctx, groupRows(mirrorRows()), () => {});
            if (captured !== null) await storage.ledger.flush();
            return captured;
          },
          fireGoalExtract: (verbatim: string) => {
            binding.launchGoalExtract(verbatim).catch((cause: unknown) => {
              services().log(`goal extract failed: ${cause instanceof Error ? cause.message : String(cause)}`);
            });
          },
        });
      },
      runObserver: async ({ unobserved, signal, maybeBuild, flushLedger }) => {
        await runObserver({
          core: await pinCore(),
          store: (await preparedCtx()).ctx,
          settings: settings(),
          unobserved,
          signal,
          widget,
          notify,
          isEnabled,
          maybeBuild,
          flushLedger,
          dumps: dumps(),
        });
      },
      runBuilder: async ({ signal }) => {
        await triggerRuns.runBuilder({ signal });
      },
      serveStatusReport: async () => {
        await pinCore();
        const view = binding.graphStore();
        const report = await serveStatusReport({
          enabled: state.isOwlEnabled(),
          settings: { ...settings(), ignoreConflicts: state.isOwlIgnoreConflicts() },
          graph: binding.graph(),
          selectedTreeNodes: view.selectedTree?.nodes ?? null,
          session: {
            // pi's readSessionBounds: the branch's FIRST entry is the
            // conversation's birth — survives --resume (a process-start
            // clock reset would otherwise show "Session 00:00:03" right
            // after one)
            sessionStartMs: sessionStartMsFromBranch(
              binding.branch(),
              state.registry.get(key)?.createdAt ?? Date.now(),
            ),
            compactionCount: countCompactions(binding.branch()),
          },
          usageLedger: view.usageLedger,
          lastCompactionLedger: view.lastCompactionLedger,
        });
        // the over-cap bootstrap block: the pi-verbatim body stays untouched;
        // the port appends the ladder hint with the exact manual command
        const blocked = state.isOwlEnabled() ? state.getBootstrapBlockedCommand() : null;
        return blocked === null
          ? report
          : `${report}

Paused — history bootstrap pending. The transcript exceeds the whole-read
cap and the history has not been backfilled. To resolve:
1. open the session on a CLI surface (the bootstrap runs automatically);
2. or run the helper by hand:
     ${blocked}
3. or turn session-owl off (enabled in /owl-settings).`;
      },
    }),
    launchGoalExtract: async (verbatim: string) => {
      // SYNC acquire before the first await: the capture's same-queue boundary
      // evaluation sees the holder and SKIPs (the goal-first sequencing rule).
      // Null = a holder already exists → run under its authority (never wait —
      // a rescan flow holding that holder awaits the extraction's settle).
      const lock = acquireForExtract(key);
      await runGoalExtract({
        core: await pinCore(),
        store: (await preparedCtx()).ctx,
        settings: settings(),
        widget,
        verbatimText: verbatim,
        completer,
        dumps: dumps(),
        lock,
        flushLedger: async () => {
          await storage.ledger.flush();
        },
      });
    },
    dispose: () => {
      bindings.delete(key);
    },
  };

  bindings.set(key, binding);
  return binding;
}

/** Drop one conversation's binding (its dispose path). */
export function releaseBinding(key: string): boolean {
  return bindings.delete(key);
}

/** Drop every binding (the session-end teardown — nothing outlives the
 *  session, matching releaseAllCaptures/releaseAllSessionStorage). */
export function releaseAllBindings(): void {
  bindings.clear();
}

// ---- helpers ---------------------------------------------------------------

/** The theme seam the widget renders with: the band's own compose layer
 *  owns the visual; the stored line stays theme-neutral text. */
const PLAIN_THEME = {
  fg: (_color: string, text: string) => text,
};
