// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// The live progress tracker + the WidgetController surface the
// lifecycle + stages touch. A singleton tracker holds the run state (stage,
// pass, batch, baseline, usage, streaming tokens, context) updated by the runs +
// agent events; the render layer formats a snapshot of it into the widget
// line. The controller wraps the tracker with a ctx/ui ref and publishes via
// ctx.ui.setWidget (event-driven, NO timer).

import type { AgentEvent } from "@earendil-works/pi-agent-core";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { getSessionOwlSettings } from "../config/schema.js";
import { isConflictPaused } from "../conflicts/pause.js";
import { BUILDER } from "../format/render.js";
import { nonObsoleteRoots, renderRootViewFromRoots } from "../graph/read-tools.js";
import { RECORD_OBS_TOOL } from "../observer/run.js";
import type { StageUsage } from "../runtime/agent-loop.js";
import { deltaTextOf, deltaTokens, messageEndUsage, streamedOutputUsage } from "../runtime/streaming-tokens.js";
import { getGraphStore } from "../store/graph-store.js";
import { estimateContentTokens, type SessionOwlGraph } from "../types.js";
import { formatConflictLine, formatWidgetLine } from "./render.js";

/** The maintenance stages the widget surfaces (one at a time; run-level). */
export type WidgetStage = "observe" | "build" | "select";

/** Observe multi-chunk progress (shown only when total > 1). Survives an
 *  interleaved stage start (the mid-catch-up Builder runs inside an observe
 *  run); cleared on endStage so a finished/aborted batch never leaks into a
 *  later independent stage. */
export interface BatchProgress {
  done: number;
  total: number;
}

/** Graph counts snapshot captured at stage start — drives the `current − baseline` deltas. */
export interface Baseline {
  obsCount: number;
  rootsCount: number;
  rootsViewTokens: number;
}

/** Live counts over the Selector's working copy (non-obsolete roots + rendered
 *  view tokens) — what the `selected` widget section shows. */
export interface SelectedCounts {
  count: number;
  viewTokens: number;
}

/** A pull-based source of live selected counts over the Selector's transient
 *  working copy. The run registers one at select startStage; the widget pulls
 *  per render (its cache invalidated on every tool_execution_end), so each
 *  applied mutate shows immediately — mirroring the Builder's live roots. */
export type SelectedCountsProvider = () => SelectedCounts;

/** The widget key + placement. */
export const WIDGET_KEY = "session_owl_progress";
export const WIDGET_PLACEMENT = "aboveEditor" as const;

/** `setWidget` is NOT on the no-bare-literals allowlist → a bare undefined 2nd
 *  arg fails lint:bare-literals; pass this named constant to hide the line. */
export const HIDE_WIDGET: undefined = undefined;

/** inFlightObs zero value (no accepted-but-unpersisted records). */
const NO_IN_FLIGHT_OBS = 0;

const ZERO_USAGE: StageUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0, elapsedMs: 0 };

// --- the snapshot the render formats (pure data; render.ts is pure over it) --

/** A render-time snapshot of the tracker + live graph/config counts. */
export interface WidgetSnapshot {
  stage: WidgetStage;
  pass: number;
  batch: BatchProgress | null;
  usage: StageUsage;
  streamingOutputTokens: number;
  obs: { count: number; delta: number };
  roots: { count: number; countDelta: number; viewTokens: number; tokenDelta: number; threshold: number };
  selected: { count: number; countDelta: number; viewTokens: number; tokenDelta: number; threshold: number } | null;
  contextTokens: number | null;
  contextWindow: number | null;
  /** Observations ACCEPTED by record_observations in the CURRENT chunk but not
   *  yet persisted (the chunk's loop is still running) — the live `+N obs`
   *  working-vs-stuck signal. Resets at each chunk boundary. */
  inFlightObs: number;
}

/** The stage-control methods shared by the tracker + the controller surface
 *  (startStage/setPass/setBatch/endStage/onEvent). */
export interface StageController {
  /** Begin a stage, optionally seeding its pass/batch; snapshots the baseline.
   *  An omitted batch preserves an in-flight observe batch (an interleaved
   *  stage — the mid-catch-up Builder — runs inside the observe run that owns
   *  the batch). `selectedCounts` (Select) registers the live working-copy
   *  counts provider the `selected` section renders from. */
  startStage(
    stage: WidgetStage,
    init?: { pass?: number; batch?: BatchProgress; selectedCounts?: SelectedCountsProvider },
  ): void;
  setPass(pass: number): void;
  setBatch(done: number, total: number): void;
  /** End the stage (idle → the line hides); clears any in-flight batch. */
  endStage(): void;
  /** Consume one agent event (message_end → usage; message_update → streaming tokens). */
  onEvent(event: AgentEvent): void;
  /** Drop the cached root counts so the next render recomputes them from the
   *  live graph (call after a persist that adds nodes outside an agentLoop tool
   *  call — e.g. the Observer's per-chunk persist, which happens after the
   *  tool_execution_end that last invalidated the cache). */
  invalidateRoots(): void;
}

/** The tracker's read-side state fields (the public ProgressTracker getters +
 *  the internal state object share this shape). */
interface TrackerState {
  stage: WidgetStage | null;
  pass: number;
  batch: BatchProgress | null;
  baseline: Baseline | null;
  usage: StageUsage;
  streamingOutputTokens: number;
  /** The background agent's latest context-window consumption (its last
   *  `message_end` usage.totalTokens) — the per-agent context-usage figure the
   *  widget surfaces (NOT the main session's usage). Null until the first
   *  message_end of the stage. */
  agentContextTokens: number | null;
  /** The background agent's model id (`message.model` from its last message_end)
   *  — used to resolve the context-window denominator via the model registry. */
  agentModelId: string | null;
  /** Working-copy counts baseline captured at select stage start (the pristine
   *  copy, before any mutate) — the `selected` deltas are measured from it, NOT
   *  from the source-graph baseline (the working copy is rebuilt each run and
   *  carries an injected nIrrelevant root). */
  selectedBaseline: SelectedCounts | null;
  /** Observations accepted by record_observations in the CURRENT chunk, not yet
   *  persisted (persistence happens once per completed chunk) — the `+N obs`
   *  signal. Reset at chunk (setBatch) and run (startStage) boundaries. */
  inFlightObs: number;
}

/**
 * Pure state object for one widget run. Updated by the runs
 * (startStage/setPass/setBatch/endStage) and the agent event stream (onEvent).
 * The render reads a snapshot via `buildSnapshot`.
 */
export interface ProgressTracker extends StageController, TrackerState {
  /** Cached non-obsolete root count + view tokens for the widget render. The
   *  widget renders per streaming event, but the graph only changes on a
   *  tool_execution_end, so this reuses the cache across message_update deltas
   *  (invalidated on startStage and tool_execution_end). */
  rootViewCounts(graph: SessionOwlGraph): { count: number; viewTokens: number };

  /** Live selected counts over the Selector's working copy: pulled from the
   *  stage-registered provider and cached across renders (recomputed after a
   *  tool_execution_end — a mutate may have changed the copy). Null when no
   *  provider is registered (non-Select stages). */
  selectedCounts(): SelectedCounts | null;
}

// --- streaming-token helpers (two-tier) -------------------------------------
// Extraction primitives live in src/runtime/streaming-tokens.ts (shared with
// the agent-loop run accumulator). The tracker owns its own ACCUMULATE
// strategy here: a running primary max (mid-stream message_update usage.output)
// + a chars/4 fallback, so the live widget counter always moves.

/** Create a fresh idle tracker (stage null, zeroed usage). */
export function createTracker(): ProgressTracker {
  const state: TrackerState & {
    fallbackTokens: number;
    primaryTokens: number;
    cachedRoots: { count: number; viewTokens: number } | null;
    /** The Select run's live working-copy counts provider (registered at select
     *  startStage; null on other stages). Internal — surfaced via
     *  `selectedCounts()`. */
    selectedProvider: SelectedCountsProvider | null;
    /** Cached `selectedProvider()` result — invalidated on every
     *  tool_execution_end (a mutate may have changed the working copy) and
     *  re-pulled lazily at render time. */
    cachedSelected: SelectedCounts | null;
  } = {
    stage: null,
    pass: 1,
    batch: null,
    baseline: null,
    usage: { ...ZERO_USAGE },
    streamingOutputTokens: 0,
    selectedBaseline: null,
    agentContextTokens: null,
    agentModelId: null,
    inFlightObs: 0,
    fallbackTokens: 0,
    primaryTokens: 0,
    cachedRoots: null,
    selectedProvider: null,
    cachedSelected: null,
  };

  return {
    get stage() {
      return state.stage;
    },
    get pass() {
      return state.pass;
    },
    get batch() {
      return state.batch;
    },
    get baseline() {
      return state.baseline;
    },
    get usage() {
      return state.usage;
    },
    get streamingOutputTokens() {
      return state.streamingOutputTokens;
    },
    get selectedBaseline() {
      return state.selectedBaseline;
    },
    get agentContextTokens() {
      return state.agentContextTokens;
    },
    get agentModelId() {
      return state.agentModelId;
    },
    get inFlightObs() {
      return state.inFlightObs;
    },
    startStage(stage, init) {
      state.stage = stage;
      state.pass = init?.pass ?? 1;
      // an omitted batch keeps an in-flight observe batch visible: the
      // mid-catch-up Builder interleaves inside the observe run that owns it.
      state.batch = init?.batch ?? state.batch;
      state.baseline = currentRootBaseline();
      state.usage = { ...ZERO_USAGE };
      state.streamingOutputTokens = 0;
      state.fallbackTokens = 0;
      state.primaryTokens = 0;
      // selected counts are per-Select-run: register the run's provider (null
      // on other stages) and capture the baseline from the PRISTINE copy at
      // stage start — before any mutate — so the deltas anchor to the copy as
      // the run received it. The baseline doubles as the initial cache (the
      // copy cannot have mutated before the first render).
      state.selectedProvider = init?.selectedCounts ?? null;
      state.selectedBaseline = state.selectedProvider?.() ?? null;
      state.cachedSelected = state.selectedBaseline;
      state.agentContextTokens = null;
      state.agentModelId = null;
      state.inFlightObs = 0;
      state.cachedRoots = null;
    },
    setPass(pass) {
      state.pass = pass;
    },
    setBatch(done, total) {
      state.batch = { done, total };
      // a chunk boundary: the completed chunk persists (or wrote its empty
      // verdict) — the in-flight counter belongs to the NEXT chunk
      state.inFlightObs = 0;
    },
    endStage() {
      state.stage = null;
      // the owning run ended → its batch must not leak into a later
      // independent stage (e.g. the post-Observer Builder at compaction).
      state.batch = null;
    },
    rootViewCounts(graph) {
      if (state.cachedRoots === null) state.cachedRoots = rootViewCounts(graph);
      return state.cachedRoots;
    },
    selectedCounts() {
      if (state.selectedProvider === null) return null;
      if (state.cachedSelected === null) state.cachedSelected = state.selectedProvider();
      return state.cachedSelected;
    },
    invalidateRoots() {
      state.cachedRoots = null;
    },
    onEvent(event) {
      if (event.type === "message_start") {
        // Each assistant message is a new prompt response (an Observer chunk, a
        // Builder/Selector turn). Reset the streaming counter so it reflects the
        // CURRENT generation (ticks up from 0), not a stage-wide cumulative that
        // grows so large per-generation additions become invisible.
        state.primaryTokens = 0;
        state.fallbackTokens = 0;
        state.streamingOutputTokens = 0;
      } else if (event.type === "message_end") {
        const u = messageEndUsage(event.message);
        if (u !== null) {
          state.usage.input += u.input;
          state.usage.output += u.output;
          state.usage.cacheRead += u.cacheRead;
          state.usage.cacheWrite += u.cacheWrite;
          state.usage.cost += u.cost;
          // the agent's context-window consumption for this message (the per-agent
          // context-usage figure the widget surfaces — NOT the main session's).
          state.agentContextTokens = u.totalTokens;
        }
        // the model id (provider/id) to resolve the context-window denominator.
        const model = (event.message as { model?: string }).model;
        if (typeof model === "string" && model.length > 0) state.agentModelId = model;
      } else if (event.type === "turn_end") {
        state.usage.turns += 1;
      } else if (event.type === "message_update") {
        // primary tier (provider streams usage): guard > tokensSoFar so a smaller
        // per-message value (usage.output resets each message) never moves it back.
        const streamed = streamedOutputUsage(event);
        if (streamed !== null && streamed > state.primaryTokens) {
          state.primaryTokens = streamed;
        }
        // fallback tier (chars/4 over text + thinking + tool-call deltas):
        // accumulates so the counter always moves, including during extended
        // thinking when the provider typically does NOT stream usage.output.
        const delta = deltaTextOf(event);
        if (delta !== null) {
          state.fallbackTokens += deltaTokens(delta);
        }
        // max — NOT primary-wins: a provider that reports usage.output once early
        // then goes silent during thinking would otherwise freeze the counter at
        // that stale value while the fallback (thinking deltas) rises unseen. max
        // shows whichever is further along, so the counter progresses throughout
        // streaming and converges to accurate output when the provider reports it.
        state.streamingOutputTokens = Math.max(state.primaryTokens, state.fallbackTokens);
      } else if (event.type === "tool_execution_end") {
        // record_observations accepted records for the CURRENT chunk (persisted
        // only when the whole chunk completes — this is the live +N obs signal)
        if (event.toolName === RECORD_OBS_TOOL && !event.isError) {
          const accepted = (event.result?.details as { accepted?: number } | undefined)?.accepted;
          if (typeof accepted === "number" && accepted > NO_IN_FLIGHT_OBS) {
            state.inFlightObs += accepted;
          }
        }
        // a mutate happened → the cached root view is stale; rebuild on next snapshot.
        state.cachedRoots = null;
        // the Selector's working copy mutates inside its tool calls too → the
        // cached selected counts are stale; re-pull from the provider.
        state.cachedSelected = null;
      }
    },
  };
}

// --- snapshot (tracker + live store/ctx → pure data for the render) --------

/** The viewer the widget's roots section reflects: the Builder's budget view
 *  (the builderRootViewThreshold gate uses the same render). */
const WIDGET_ROOTS_VIEWER = BUILDER;

/** Non-obsolete root count + view tokens from a SINGLE `nonObsoleteRoots` pass
 *  (the widget renders per streaming event, so the count + the rendered view must
 *  share one roots computation, not two). */
function rootViewCounts(graph: SessionOwlGraph): { count: number; viewTokens: number } {
  const roots = nonObsoleteRoots(graph);
  const viewTokens = estimateContentTokens(renderRootViewFromRoots(roots, WIDGET_ROOTS_VIEWER, graph.observations));
  return { count: roots.length, viewTokens };
}

/** Snapshot the current root counts + view tokens (the baseline at stage start). */
function currentRootBaseline(): Baseline {
  const { graph } = getGraphStore();
  const roots = rootViewCounts(graph);
  return { obsCount: graph.observations.size, rootsCount: roots.count, rootsViewTokens: roots.viewTokens };
}

/** Resolve the context-window denominator for the background agent's model id
 *  (a `provider/id` string) via the model registry. Returns null when the model
 *  id is absent or the registry has no contextWindow for it. */
function resolveContextWindow(ctx: ExtensionContext, modelId: string | null): number | null {
  if (modelId === null) return null;
  const slash = modelId.indexOf("/");
  if (slash <= 0) return null;
  const provider = modelId.slice(0, slash);
  const id = modelId.slice(slash + 1);
  const model = ctx.modelRegistry.find(provider, id);
  return model?.contextWindow ?? null;
}

/** Build the render snapshot from the tracker + live store/ctx. */
export function buildSnapshot(tracker: ProgressTracker, ctx: ExtensionContext): WidgetSnapshot {
  const settings = getSessionOwlSettings();
  const { graph } = getGraphStore();
  // The widget renders per streaming event, but the graph only changes on a
  // tool_execution_end, so reuse the cached root counts across message_update
  // deltas (invalidated on startStage + tool_execution_end inside the tracker).
  const roots = tracker.rootViewCounts(graph);
  const baseline = tracker.baseline ?? { obsCount: 0, rootsCount: 0, rootsViewTokens: 0 };
  const obsCount = graph.observations.size;
  // Context usage = the BACKGROUND agent's consumption (its last message_end
  // usage.totalTokens), NOT the main session's getContextUsage() — so the widget
  // reflects the current stage's progress, not the ever-growing main session.
  // The window denominator resolves from the model registry via the agent's
  // model id; both are null until the first message_end of the stage.
  const contextTokens = tracker.agentContextTokens;
  const contextWindow = resolveContextWindow(ctx, tracker.agentModelId);

  // selected section: shown only in selected-root renderMode AND during Select.
  // counts are PULLED from the run's working-copy provider (cached across
  // renders, refreshed after each tool_execution_end — per-mutate live updates);
  // deltas measured from the working-copy baseline captured at stage start,
  // NOT the source-graph baseline (the working copy is rebuilt each Select run).
  const inSelect = tracker.stage === "select" && settings.renderMode === "selected-root";
  const selectedCounts = inSelect ? tracker.selectedCounts() : null;
  const selectedBaseline = tracker.selectedBaseline;
  const selected =
    selectedCounts !== null
      ? {
          count: selectedCounts.count,
          countDelta: selectedBaseline === null ? 0 : selectedCounts.count - selectedBaseline.count,
          viewTokens: selectedCounts.viewTokens,
          tokenDelta: selectedBaseline === null ? 0 : selectedCounts.viewTokens - selectedBaseline.viewTokens,
          threshold: settings.selectorRootViewThreshold,
        }
      : null;

  return {
    stage: (tracker.stage ?? "observe") as WidgetStage,
    pass: tracker.pass,
    batch: tracker.batch,
    usage: tracker.usage,
    streamingOutputTokens: tracker.streamingOutputTokens,
    obs: { count: obsCount, delta: obsCount - baseline.obsCount },
    roots: {
      count: roots.count,
      countDelta: roots.count - baseline.rootsCount,
      viewTokens: roots.viewTokens,
      tokenDelta: roots.viewTokens - baseline.rootsViewTokens,
      threshold: settings.builderRootViewThreshold,
    },
    selected,
    contextTokens,
    contextWindow,
    inFlightObs: tracker.inFlightObs,
  };
}

/**
 * The widget controller surface the lifecycle + stages touch (setCtx on start,
 * clearCtx on shutdown, startStage/endStage/setPass/setBatch/onEvent during runs,
 * render to publish). The real tracker + setWidget publishing live here.
 */
export interface WidgetController extends StageController {
  setCtx(ctx: ExtensionContext): void;
  clearCtx(): void;
  render(): void;
  /** Conflict-pause mode: publish the static paused line instead of stage
   *  progress (names = conflicting package names; null-able via []). */
  setConflict(names: string[]): void;
}

const NO_OP = (): void => {};

/** A shared no-op widget controller (the hook default + tests). */
export const NO_OP_WIDGET: WidgetController = {
  setCtx: NO_OP,
  clearCtx: NO_OP,
  render: NO_OP,
  setConflict: NO_OP,
  startStage: NO_OP,
  setPass: NO_OP,
  setBatch: NO_OP,
  endStage: NO_OP,
  onEvent: NO_OP,
  invalidateRoots: NO_OP,
};

/** Build the real widget controller: a tracker + a ctx/ui ref + render-to-publish. */
export function initWidget(): WidgetController {
  const tracker = createTracker();
  let ctxRef: ExtensionContext | null = null;
  let conflictNames: string[] | null = null;
  // Throttle renders: a fast stream emits many message_update events, but the
  // widget only needs a fresh line every so often — and rendering every chunk
  // (microtask) can saturate pi's event loop on a runaway generation, freezing
  // the UI (Ctrl+C unresponsive). Cap to one render per RENDER_INTERVAL_MS via
  // a leading-and-trailing throttle: the first event renders immediately, a
  // burst coalesces into one trailing render at the interval boundary.
  const RENDER_INTERVAL_MS = 200;
  let lastRenderMs = 0;
  let trailingTimer: ReturnType<typeof setTimeout> | null = null;
  const scheduleRender = (): void => {
    const now = Date.now();
    const elapsed = now - lastRenderMs;
    if (trailingTimer === null && elapsed >= RENDER_INTERVAL_MS) {
      lastRenderMs = now;
      renderWidget(tracker, ctxRef, conflictNames);
      return;
    }
    if (trailingTimer !== null) return; // a trailing render is already pending
    trailingTimer = setTimeout(() => {
      trailingTimer = null;
      lastRenderMs = Date.now();
      renderWidget(tracker, ctxRef, conflictNames);
    }, RENDER_INTERVAL_MS - elapsed);
  };
  return {
    setCtx(ctx) {
      ctxRef = ctx;
    },
    clearCtx() {
      // hide the widget before dropping the ref (session-switch/fork teardown —
      // otherwise a stale line persists because render() no-ops without a ctx).
      hideWidget(ctxRef);
      ctxRef = null;
    },
    startStage(stage, init) {
      tracker.startStage(stage, init);
    },
    setPass(pass) {
      tracker.setPass(pass);
    },
    setBatch(done, total) {
      tracker.setBatch(done, total);
    },
    invalidateRoots() {
      tracker.invalidateRoots();
      scheduleRender();
    },
    endStage() {
      tracker.endStage();
      // Re-publish so the line hides when the stage dropped to null — a run
      // ends with no further events, so without this the last stage's line
      // (e.g. the Selector's final `N selected`) would persist forever. The
      // onEvent path coalesces its own renders; endStage is one-shot.
      renderWidget(tracker, ctxRef, conflictNames);
    },
    onEvent(event) {
      tracker.onEvent(event);
      scheduleRender();
    },
    render() {
      renderWidget(tracker, ctxRef, conflictNames);
    },
    setConflict(names) {
      conflictNames = names;
      renderWidget(tracker, ctxRef, conflictNames);
    },
  };
}

/** Hide the widget line via ctx.ui.setWidget (TUI-only; no-op otherwise). */
function hideWidget(ctx: ExtensionContext | null): void {
  if (ctx === null || ctx.mode !== "tui" || !ctx.hasUI) return;
  ctx.ui.setWidget(WIDGET_KEY, HIDE_WIDGET, { placement: WIDGET_PLACEMENT });
}

const TEXT_PAD_X = 0;
const TEXT_PAD_Y = 0;

/** Publish the widget line (or hide it) via ctx.ui.setWidget. */
function renderWidget(tracker: ProgressTracker, ctx: ExtensionContext | null, conflictNames: string[] | null): void {
  if (ctx === null) return;
  // TUI-only: no-op in rpc/json/print.
  if (ctx.mode !== "tui" || !ctx.hasUI) return;
  // Conflict-pause line first — width-aware, ignores stage state. LIVENESs: the
  // gate (isConflictPaused) reads settings live, so a mid-session ignoreConflicts
  // flip drops the line on the next render instead of lingering over a
  // resumed session-owl (the hits themselves only exist while conflict-paused).
  if (conflictNames !== null && isConflictPaused()) {
    const names = conflictNames;
    ctx.ui.setWidget(
      WIDGET_KEY,
      (_tui, theme) =>
        ({ render: (width: number): string[] => [formatConflictLine(names, width, theme)] }) as unknown as Text,
      { placement: WIDGET_PLACEMENT },
    );
    return;
  }
  // idle → hide the line (a prior render may have shown it during a run).
  if (tracker.stage === null) {
    hideWidget(ctx);
    return;
  }
  const snapshot = buildSnapshot(tracker, ctx);
  ctx.ui.setWidget(WIDGET_KEY, (_tui, theme) => new Text(formatWidgetLine(snapshot, theme), TEXT_PAD_X, TEXT_PAD_Y), {
    placement: WIDGET_PLACEMENT,
  });
}
