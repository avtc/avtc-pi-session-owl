// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// The live progress tracker + the WidgetController surface the
// lifecycle + stages touch. A singleton tracker holds the run state (stage,
// pass, batch, baseline, usage, streaming tokens, context) updated by the runs +
// agent events; the render (render.ts) formats a snapshot of it into the widget
// line. The controller wraps the tracker with a ctx/ui ref and publishes via
// ctx.ui.setWidget (event-driven, NO timer).

import type { AgentEvent } from "@earendil-works/pi-agent-core";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { getMemkeeperSettings } from "../config/schema.js";
import { measureRootViewTokens, nonObsoleteRoots } from "../graph/read-tools.js";
import type { StageUsage } from "../runtime/agent-loop.js";
import { getGraphStore } from "../store/graph-store.js";
import { estimateContentTokens } from "../types.js";
import { formatWidgetLine } from "./render.js";

/** The maintenance stages the widget surfaces (one at a time; run-level). */
export type WidgetStage = "observe" | "build" | "select";

/** Observe multi-chunk progress (shown only when total > 1). */
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

/** The widget key + placement. */
export const WIDGET_KEY = "memkeeper_progress";
export const WIDGET_PLACEMENT = "aboveEditor" as const;

/** `setWidget` is NOT on the no-bare-literals allowlist → a bare undefined 2nd
 *  arg fails lint:bare-literals; pass this named constant to hide the line. */
export const HIDE_WIDGET: undefined = undefined;

const ZERO_USAGE: StageUsage = { input: 0, output: 0, cacheRead: 0, cost: 0, turns: 0 };

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
}

/** The stage-control methods shared by the tracker + the controller surface
 *  (startStage/setPass/setBatch/setSelectedCounts/endStage/onEvent). */
export interface StageController {
  /** Begin a stage, optionally seeding its pass/batch; snapshots the baseline. */
  startStage(stage: WidgetStage, init?: { pass?: number; batch?: BatchProgress }): void;
  setPass(pass: number): void;
  setBatch(done: number, total: number): void;
  setSelectedCounts(rootCount: number, rootViewTokens: number): void;
  endStage(): void;
  /** Consume one agent event (message_end → usage; message_update → streaming tokens). */
  onEvent(event: AgentEvent): void;
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
  selectedCount: number | null;
  selectedViewTokens: number | null;
  selectedBaseline: { count: number; viewTokens: number } | null;
}

/**
 * Pure state object for one widget run. Updated by the runs
 * (startStage/setPass/setBatch/setSelectedCounts/endStage) and the agent event
 * stream (onEvent). The render reads a snapshot via `buildSnapshot`.
 */
export interface ProgressTracker extends StageController, TrackerState {}

// --- streaming-token helpers (two-tier, decision #37) ---------------------

/** Read the streamed cumulative output-token count off a message_update when the
 *  provider reports usage mid-stream. Returns null when not present. */
function streamedOutputUsage(ev: AgentEvent): number | null {
  if (ev.type !== "message_update") return null;
  const usage = (ev as { message?: { usage?: { output?: number } } }).message?.usage;
  const output = usage?.output;
  return typeof output === "number" ? output : null;
}

/** Extract the delta string from a streamed assistant-message event (fallback tier). */
function deltaTextOf(ev: AgentEvent): string | null {
  if (ev.type !== "message_update") return null;
  const inner = (ev as { assistantMessageEvent?: { type?: string; delta?: string } }).assistantMessageEvent;
  if (inner?.type === "text_delta" || inner?.type === "thinking_delta" || inner?.type === "toolcall_delta") {
    return inner.delta ?? null;
  }
  return null;
}

/** Read cumulative usage off a message_end (only assistant messages carry usage). */
function messageEndUsage(message: unknown): StageUsage | null {
  const u = (message as { usage?: { input?: number; output?: number; cacheRead?: number; cost?: { total?: number } } })
    ?.usage;
  if (u === undefined) return null;
  return {
    input: u.input ?? 0,
    output: u.output ?? 0,
    cacheRead: u.cacheRead ?? 0,
    cost: u.cost?.total ?? 0,
    turns: 0,
  };
}

/** Create a fresh idle tracker (stage null, zeroed usage). */
export function createTracker(): ProgressTracker {
  const state: TrackerState & { fallbackTokens: number; primaryTokens: number } = {
    stage: null,
    pass: 1,
    batch: null,
    baseline: null,
    usage: { ...ZERO_USAGE },
    streamingOutputTokens: 0,
    selectedCount: null,
    selectedViewTokens: null,
    selectedBaseline: null,
    fallbackTokens: 0,
    primaryTokens: 0,
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
    get selectedCount() {
      return state.selectedCount;
    },
    get selectedViewTokens() {
      return state.selectedViewTokens;
    },
    get selectedBaseline() {
      return state.selectedBaseline;
    },
    startStage(stage, init) {
      state.stage = stage;
      state.pass = init?.pass ?? 1;
      state.batch = init?.batch ?? null;
      state.baseline = currentRootBaseline();
      state.usage = { ...ZERO_USAGE };
      state.streamingOutputTokens = 0;
      state.fallbackTokens = 0;
      state.primaryTokens = 0;
      // selected counts + baseline are per-Select-run; a fresh stage start
      // re-anchors the selected baseline on the next first push.
      state.selectedCount = null;
      state.selectedViewTokens = null;
      state.selectedBaseline = null;
    },
    setPass(pass) {
      state.pass = pass;
    },
    setBatch(done, total) {
      state.batch = { done, total };
    },
    setSelectedCounts(rootCount, rootViewTokens) {
      // capture the working-copy baseline on the first push of a Select stage.
      if (state.selectedBaseline === null) {
        state.selectedBaseline = { count: rootCount, viewTokens: rootViewTokens };
      }
      state.selectedCount = rootCount;
      state.selectedViewTokens = rootViewTokens;
    },
    endStage() {
      state.stage = null;
    },
    onEvent(event) {
      if (event.type === "message_end") {
        const u = messageEndUsage((event as { message?: unknown }).message);
        if (u !== null) {
          state.usage.input += u.input;
          state.usage.output += u.output;
          state.usage.cacheRead += u.cacheRead;
          state.usage.cost += u.cost;
        }
      } else if (event.type === "turn_end") {
        state.usage.turns += 1;
      } else if (event.type === "message_update") {
        // primary tier (provider streams usage): guard > tokensSoFar so a smaller
        // per-message value (usage.output resets each message) never moves it back.
        const streamed = streamedOutputUsage(event);
        if (streamed !== null && streamed > state.primaryTokens) {
          state.primaryTokens = streamed;
        }
        // fallback tier (chars/4 over deltas): accumulates so the counter always moves.
        const delta = deltaTextOf(event);
        if (delta !== null) {
          state.fallbackTokens += estimateContentTokens(delta);
        }
        state.streamingOutputTokens = state.primaryTokens > 0 ? state.primaryTokens : state.fallbackTokens;
      }
    },
  };
}

// --- snapshot (tracker + live store/ctx → pure data for the render) --------

/** The viewer the widget's roots section reflects: the Builder's budget view
 *  (the builderRootViewThreshold gate uses the same render). */
const WIDGET_ROOTS_VIEWER = "builder" as const;

/** Snapshot the current root counts + view tokens (the baseline at stage start). */
function currentRootBaseline(): Baseline {
  const { graph } = getGraphStore();
  return {
    obsCount: graph.observations.size,
    rootsCount: nonObsoleteRoots(graph).length,
    rootsViewTokens: measureRootViewTokens(graph, WIDGET_ROOTS_VIEWER),
  };
}

/** Build the render snapshot from the tracker + live store/ctx. */
export function buildSnapshot(tracker: ProgressTracker, ctx: ExtensionContext): WidgetSnapshot {
  const settings = getMemkeeperSettings();
  const { graph } = getGraphStore();
  const rootsCount = nonObsoleteRoots(graph).length;
  const rootsViewTokens = measureRootViewTokens(graph, WIDGET_ROOTS_VIEWER);
  const baseline = tracker.baseline ?? { obsCount: 0, rootsCount: 0, rootsViewTokens: 0 };
  const obsCount = graph.observations.size;
  const ctxUsage = ctx.getContextUsage();
  // both context fields are null when getContextUsage() is undefined (the window
  // is unknown too); render shows `?` alone rather than `?/0` (never 0/NaN).
  const contextTokens = ctxUsage === undefined ? null : ctxUsage.tokens;
  const contextWindow = ctxUsage === undefined ? null : ctxUsage.contextWindow;

  // selected section: shown only in selected-root renderMode AND during Select.
  // deltas measured from the working-copy baseline (first push of the stage),
  // NOT the source-graph baseline (the working copy is rebuilt each Select run).
  const inSelect = tracker.stage === "select" && settings.renderMode === "selected-root";
  const selectedBaseline = tracker.selectedBaseline;
  const selected =
    inSelect && tracker.selectedCount !== null && tracker.selectedViewTokens !== null
      ? {
          count: tracker.selectedCount,
          countDelta: selectedBaseline === null ? 0 : tracker.selectedCount - selectedBaseline.count,
          viewTokens: tracker.selectedViewTokens,
          tokenDelta: selectedBaseline === null ? 0 : tracker.selectedViewTokens - selectedBaseline.viewTokens,
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
      count: rootsCount,
      countDelta: rootsCount - baseline.rootsCount,
      viewTokens: rootsViewTokens,
      tokenDelta: rootsViewTokens - baseline.rootsViewTokens,
      threshold: settings.builderRootViewThreshold,
    },
    selected,
    contextTokens,
    contextWindow,
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
}

const NO_OP = (): void => {};

/** A shared no-op widget controller (the hook default + tests). */
export const NO_OP_WIDGET: WidgetController = {
  setCtx: NO_OP,
  clearCtx: NO_OP,
  render: NO_OP,
  startStage: NO_OP,
  setPass: NO_OP,
  setBatch: NO_OP,
  setSelectedCounts: NO_OP,
  endStage: NO_OP,
  onEvent: NO_OP,
};

/** Build the real widget controller: a tracker + a ctx/ui ref + render-to-publish. */
export function initWidget(): WidgetController {
  const tracker = createTracker();
  let ctxRef: ExtensionContext | null = null;
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
    setSelectedCounts(rootCount, rootViewTokens) {
      tracker.setSelectedCounts(rootCount, rootViewTokens);
    },
    endStage() {
      tracker.endStage();
    },
    onEvent(event) {
      tracker.onEvent(event);
      renderWidget(tracker, ctxRef);
    },
    render() {
      renderWidget(tracker, ctxRef);
    },
  };
}

/** Hide the widget line via ctx.ui.setWidget (TUI-only; no-op otherwise). */
function hideWidget(ctx: ExtensionContext | null): void {
  if (ctx === null || ctx.mode !== "tui" || !ctx.hasUI) return;
  ctx.ui.setWidget(WIDGET_KEY, HIDE_WIDGET, { placement: WIDGET_PLACEMENT });
}

/** Publish the widget line (or hide it) via ctx.ui.setWidget. */
function renderWidget(tracker: ProgressTracker, ctx: ExtensionContext | null): void {
  if (ctx === null) return;
  // TUI-only (guard like OM): no-op in rpc/json/print.
  if (ctx.mode !== "tui" || !ctx.hasUI) return;
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

const TEXT_PAD_X = 0;
const TEXT_PAD_Y = 0;
