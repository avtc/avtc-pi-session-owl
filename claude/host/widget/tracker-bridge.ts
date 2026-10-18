// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// The tracker bridge — the host port of pi's widget/tracker.ts state
// machine + publish path. One bridge per conversation backs the StageWidget
// surface the host runs drive (startStage/setPass/setBatch/
// endStage/onEvent/invalidateRoots/render), computes the render snapshot
// over injected graph/settings/context seams, renders the line with the
// host render port, and publishes on transitions:
//
//   band surfaces (terminal/desktop) — the line lands in the closure-safe
//     line store and the uiInvalidate capsule asks the engine to re-render
//     (the AbovePrompt band hook draws the stored line);
//   fallback surfaces (mobile/vscode) — the uiStatus capsule re-issues the
//     SAME text (the status line replaces itself per call);
//   neither — logger-only degrade.
// The pause line (setConflict) swaps the stage line while paused; endStage
// hides the line (the status capsule takes undefined; the store clears).
import type { SessionOwlConfig } from "../../core/src/config/schema.js";
import { BUILDER } from "../../core/src/format/render.js";
import { nonObsoleteRoots, renderRootViewFromRoots } from "../../core/src/graph/read-tools.js";
import {
  deltaTextOf,
  deltaTokens,
  messageEndUsage,
  streamedOutputUsage,
} from "../../core/src/runtime/streaming-tokens.js";
import { estimateContentTokens, type SessionOwlGraph } from "../../core/src/types.js";
import type {
  BatchProgress,
  SelectedCountsProvider,
  StageWidget,
  WidgetAgentEvent,
  WidgetStage,
} from "../runs/seams.js";
import { type StoredSegment, setWidgetLine } from "./line-store.js";
import { formatConflictLine, formatWidgetSegments, type ThemeSeam, type WidgetSnapshot } from "./render.js";
import { hasBandSurface, hasFallbackSurface } from "./width.js";

const RECORD_OBS_TOOL = "record_observations";

/** The bootstrap-pause line (pinned text): the history backlog is
 *  blocked and the owl is dormant until the bootstrap completes. */
const BOOTSTRAP_PAUSE_LINE = "🦉 ⚠ paused — see /owl-status for session-owl bootstrap";
const ZERO_USAGE: WidgetSnapshot["usage"] = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  cost: 0,
  turns: 0,
  elapsedMs: 0,
};
const NO_IN_FLIGHT = 0;

/** The bridge's injected surfaces (the wiring binds engine capsules; tests
 *  supply fakes). Everything $-touching stays behind these. */
export interface TrackerBridgeDeps {
  /** The conversation's live settings (read per snapshot). */
  getSettings: () => SessionOwlConfig;
  /** The conversation's live graph (post-pin). */
  getGraph: () => SessionOwlGraph;
  /** Resolves the background agent's context window for its model id
   *  (pi: the model registry; null when unknown). */
  resolveContextWindow: (modelId: string | null) => number | null;
  /** The theme the line renders with (the engine's, at the wiring). */
  theme: ThemeSeam;
  /** The width the conflict line degrades against. */
  width: () => number;
  /** The surfaces this session draws on (the dispatch predicate). */
  getSurfaces: () => Promise<readonly string[]>;
  /** Ask the engine to re-render the band (throttled + coalesced there). */
  uiInvalidate: () => void;
  /** The fallback pinned line (undefined clears it). */
  uiStatus: (text: string | undefined) => void;
  /** The conflict-pause live predicate (pi reads the settings gate live so
   *  a mid-session ignoreConflicts flip drops the pause line at the next
   *  render; the wiring binds the conflicts module). */
  isConflictPaused: () => boolean;
  /** The over-cap bootstrap block's manual command (null = nothing blocked;
   *  the line surfaces the notice while the history backlog stays
   *  unmirrored — beside the /owl-status report). */
  bootstrapBlockedCommand: () => string | null;
  /** The logger seam (the neither-surface degrade + errors). */
  log: (message: string) => void;
  /** Which conversation owns this bridge: the MAIN loop is the band's ONLY
   *  publisher (the widget never mixes main and subagent
   *  stats); a background agent loop's line never reaches the shared line
   *  store, the status pin, or a band redraw. The engine's AbovePrompt draw
   *  carries no focus/agent identity to scope by, so the fallback is
   *  main-only. */
  scope: "main" | "agent";
}

/** pi's baseline (graph counts captured at stage start — drives deltas). */
interface Baseline {
  obsCount: number;
  rootsCount: number;
  rootsViewTokens: number;
}

/** The pause state: null = not paused; names render the conflict line. */
interface PauseState {
  names: string[];
}

/** Non-obsolete root count + view tokens from one pass (pi's rule: the
 *  count and the rendered view share one roots computation). */
function rootViewCounts(graph: SessionOwlGraph): { count: number; viewTokens: number } {
  const roots = nonObsoleteRoots(graph);
  const viewTokens = estimateContentTokens(renderRootViewFromRoots(roots, BUILDER, graph.observations));
  return { count: roots.length, viewTokens };
}

/**
 * Build the bridge: the tracker state machine + the StageWidget controller
 * + the transition publish. `deps` carries every external surface.
 */
export interface WidgetBridge extends StageWidget {
  setConflict: (names: string[]) => void;
  /** Force a publish now (the throttle's leading edge for callers that
   *  changed out-of-band state — the bootstrap-blocked notice). */
  renderNow(): void;
  /** Test seam: the current snapshot (the line does not render usage). */
  _snapshotForTest(): WidgetSnapshot;
}

export function createWidgetBridge(deps: TrackerBridgeDeps): WidgetBridge {
  // --- the tracker state (pi's TrackerState, verbatim fields) -------------
  let stage: WidgetStage | null = null;
  let pass = 1;
  let batch: BatchProgress | null = null;
  let baseline: Baseline | null = null;
  let usage: WidgetSnapshot["usage"] = { ...ZERO_USAGE };
  let streamingOutputTokens = 0;
  let agentContextTokens: number | null = null;
  let agentModelId: string | null = null;
  let selectedBaseline: { count: number; viewTokens: number } | null = null;
  let inFlightObs = 0;
  let fallbackTokens = 0;
  let primaryTokens = 0;
  let cachedRoots: { count: number; viewTokens: number } | null = null;
  let selectedProvider: SelectedCountsProvider | null = null;
  let cachedSelected: { count: number; viewTokens: number } | null = null;
  let pause: PauseState | null = null;

  const currentRootBaseline = (): Baseline => {
    const graph = deps.getGraph();
    const roots = rootViewCounts(graph);
    return { obsCount: graph.observations.size, rootsCount: roots.count, rootsViewTokens: roots.viewTokens };
  };

  const snapshot = (): WidgetSnapshot => {
    const settings = deps.getSettings();
    const graph = deps.getGraph();
    if (cachedRoots === null) cachedRoots = rootViewCounts(graph);
    const roots = cachedRoots;
    const base = baseline ?? { obsCount: 0, rootsCount: 0, rootsViewTokens: 0 };
    const obsCount = graph.observations.size;
    const inSelect = stage === "select" && settings.renderMode === "selected-root";
    const selectedCounts = inSelect && selectedProvider !== null ? (cachedSelected ?? selectedProvider()) : null;
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
      stage: (stage ?? "observe") as WidgetStage,
      pass,
      batch,
      usage,
      streamingOutputTokens,
      obs: { count: obsCount, delta: obsCount - base.obsCount },
      roots: {
        count: roots.count,
        countDelta: roots.count - base.rootsCount,
        viewTokens: roots.viewTokens,
        tokenDelta: roots.viewTokens - base.rootsViewTokens,
        threshold: settings.builderRootViewThreshold,
      },
      selected,
      contextTokens: agentContextTokens,
      contextWindow: deps.resolveContextWindow(agentModelId),
      inFlightObs,
    };
  };

  // --- the publish (transition → band store + status fallback) -----------

  const issue = (line: string | null, segments: readonly StoredSegment[] | null = null): void => {
    if (deps.scope !== "main") {
      // one band channel, main's alone: a background loop reports here only
      // as a log line (the suppression is visible in the file log)
      deps.log(`widget: agent-loop line suppressed — ${line}`);
      return;
    }
    setWidgetLine(line, segments);
    void (async () => {
      try {
        const surfaces = await deps.getSurfaces();
        const band = hasBandSurface(surfaces);
        const fallback = hasFallbackSurface(surfaces);
        // The status pin is NOT surface-scoped (it rides the engine chrome
        // on every surface) — so a band surface present means the pinned
        // line would double-draw ON the band surface. Never both on one
        // surface: the band wins; fallback surfaces only serve sessions
        // with NO band surface (mixed sessions miss the fallback surface —
        // recorded in the gaps register).
        if (band) {
          // an earlier publish may have pinned the status line while only a
          // fallback surface was attached — the band now owns the line, so
          // clear the pin or it double-draws under the band forever
          deps.uiStatus(undefined);
          deps.uiInvalidate();
          deps.log(`widget: band publish — ${line}`);
          return;
        }
        if (fallback) {
          deps.uiStatus(line ?? undefined);
          deps.log(`widget: status fallback publish — ${line}`);
          return;
        }
        if (line !== null) deps.log(`widget: no band or status surface — ${line}`);
      } catch (err) {
        deps.log(`widget: surface dispatch failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    })();
  };

  const renderNow = (): void => {
    // pause first (pi's rule — width-aware, ignores stage state; liveness:
    // the gate reads settings live so a mid-session flip drops the line)
    if (pause !== null && deps.isConflictPaused()) {
      issue(formatConflictLine(pause.names, deps.width(), deps.theme));
      return;
    }
    // the bootstrap pause: the history backlog is blocked — the owl is
    // dormant (no capture, no observation, no stages), so the line is the
    // pause notice alone, stage state notwithstanding; /owl-status carries
    // the exact manual command
    if (deps.bootstrapBlockedCommand() !== null) {
      issue(BOOTSTRAP_PAUSE_LINE);
      return;
    }
    if (stage === null) {
      issue(null); // idle → hide
      return;
    }
    // the painted publish: the segments carry pi's color structure to the
    // band; the text is their join (identical to the themed line — the
    // wiring's theme is plain) so the status fallback logs/pins text only.
    const segments = formatWidgetSegments(snapshot());
    issue(segments.map((segment) => segment.text).join(""), segments);
  };

  // pi's throttle: a fast stream emits many message_update events; one
  // render per RENDER_INTERVAL_MS, leading + trailing.
  const RENDER_INTERVAL_MS = 200;
  let lastRenderMs = 0;
  let trailingTimer: ReturnType<typeof setTimeout> | null = null;
  const scheduleRender = (): void => {
    const now = Date.now();
    const elapsed = now - lastRenderMs;
    if (trailingTimer === null && elapsed >= RENDER_INTERVAL_MS) {
      lastRenderMs = now;
      renderNow();
      return;
    }
    if (trailingTimer !== null) return;
    trailingTimer = setTimeout(() => {
      trailingTimer = null;
      lastRenderMs = Date.now();
      renderNow();
    }, RENDER_INTERVAL_MS - elapsed);
  };

  // --- the StageWidget surface --------------------------------------------

  return {
    startStage(nextStage, init) {
      stage = nextStage;
      pass = init?.pass ?? 1;
      // an omitted batch keeps an in-flight observe batch visible (the
      // mid-catch-up Builder interleaves inside the observe run owning it)
      batch = init?.batch ?? batch;
      baseline = currentRootBaseline();
      usage = { ...ZERO_USAGE };
      streamingOutputTokens = 0;
      fallbackTokens = 0;
      primaryTokens = 0;
      selectedProvider = init?.selectedCounts ?? null;
      selectedBaseline = selectedProvider?.() ?? null;
      cachedSelected = selectedBaseline;
      agentContextTokens = null;
      agentModelId = null;
      inFlightObs = 0;
      cachedRoots = null;
    },
    setPass(next) {
      pass = next;
    },
    setBatch(done, total) {
      batch = { done, total };
      inFlightObs = 0; // chunk boundary: the counter belongs to the next chunk
    },
    endStage() {
      stage = null;
      batch = null;
      // Re-publish so the line hides when the stage dropped to null — a run
      // ends with no further events (pi's one-shot endStage render).
      renderNow();
    },
    invalidateRoots() {
      cachedRoots = null;
      scheduleRender();
    },
    onEvent(event: WidgetAgentEvent) {
      if (event.type === "message_start") {
        primaryTokens = 0;
        fallbackTokens = 0;
        streamingOutputTokens = 0;
      } else if (event.type === "message_end") {
        const u = messageEndUsage((event as { message?: unknown }).message as never);
        if (u !== null) {
          usage.input += u.input;
          usage.output += u.output;
          usage.cacheRead += u.cacheRead;
          usage.cacheWrite += u.cacheWrite;
          usage.cost += u.cost;
          agentContextTokens = u.totalTokens;
        }
        const model = (event as { message?: { model?: unknown } }).message?.model;
        if (typeof model === "string" && model.length > 0) agentModelId = model;
      } else if (event.type === "turn_end") {
        usage.turns += 1;
      } else if (event.type === "message_update") {
        const streamed = streamedOutputUsage(event as never);
        if (streamed !== null && streamed > primaryTokens) primaryTokens = streamed;
        const delta = deltaTextOf(event as never);
        if (delta !== null) fallbackTokens += deltaTokens(delta);
        streamingOutputTokens = Math.max(primaryTokens, fallbackTokens);
      } else if (event.type === "tool_execution_end") {
        const toolName = (event as { toolName?: unknown }).toolName;
        if (toolName === RECORD_OBS_TOOL && (event as { isError?: unknown }).isError !== true) {
          const accepted = (
            (event as { result?: { details?: { accepted?: unknown } } }).result?.details as
              | { accepted?: number }
              | undefined
          )?.accepted;
          if (typeof accepted === "number" && accepted > NO_IN_FLIGHT) inFlightObs += accepted;
        }
        cachedRoots = null;
        cachedSelected = null;
      }
      scheduleRender();
    },
    render() {
      renderNow();
    },
    setConflict(names) {
      pause = names.length > 0 ? { names } : null;
      renderNow();
    },
    /** Test seam: the current snapshot (the line does not render usage). */
    renderNow,
    _snapshotForTest(): WidgetSnapshot {
      return snapshot();
    },
  };
}
