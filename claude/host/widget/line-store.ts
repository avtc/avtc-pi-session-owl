// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// The closure-safe line store: the ONE piece of widget state the hooks
// closure reads (the AbovePrompt band hook draws this line). Data-only —
// no imports at all (the segment shape is mirrored inline, not imported) —
// so the closure's loader accepts it.

/** The painted span the bridge publishes — structurally render's
 *  WidgetSegment, declared here so this module imports nothing. */
export interface StoredSegment {
  readonly text: string;
  readonly color: "text" | "accent" | "dim" | "muted";
}
// The bridge (Node-side) writes; the band hook reads.

let currentLine: string | null = null;
let currentSegments: readonly StoredSegment[] | null = null;
let idleProvider: (() => readonly StoredSegment[] | null) | null = null;

/** The line the band draws (null = compose nothing — pure passthrough). */
export function widgetLine(): string | null {
  return currentLine;
}

/** The line's painted spans (null when the caller published text only —
 *  the conflict-pause line and plain string publishes draw plain). Aligned
 *  with the line: a segment set belongs to the CURRENT line only. */
export function widgetSegments(): readonly StoredSegment[] | null {
  return currentSegments;
}

/** Set (or clear) the line. Called by the tracker bridge's publish; the
 *  segments are optional (the pause/text paths publish none). */
export function setWidgetLine(line: string | null, segments: readonly StoredSegment[] | null = null): void {
  currentLine = line;
  currentSegments = line === null ? null : segments;
}

/** Register (or clear) the idle-line source: the current tracker bridge,
 *  rendering the usual line with no highlighted stage from live counts.
 *  Read at band-draw time so the numbers stay fresh between runs. */
export function setIdleProvider(fn: (() => readonly StoredSegment[] | null) | null): void {
  idleProvider = fn;
}

/** The idle line's painted spans (null when no bridge registered). */
export function idleSegments(): readonly StoredSegment[] | null {
  try {
    return idleProvider?.() ?? null;
  } catch {
    return null;
  }
}

/** Whether the idle line awaits its first post-fold re-render: the band's
 *  opening frame drew before the store fold landed, and a re-render must be
 *  requested from inside a later render dispatch (an out-of-frame
 *  invalidation does not redraw the band on every surface). */
let idleRefreshPending = false;

/** Mark the idle line as awaiting its refresh (one-shot). */
export function requestIdleRefresh(): void {
  idleRefreshPending = true;
}

/** Consume the pending refresh request, if any. */
export function consumeIdleRefresh(): boolean {
  if (!idleRefreshPending) return false;
  idleRefreshPending = false;
  return true;
}

/** Test isolation: reset to the empty store. */
export function _resetWidgetLine(): void {
  currentLine = null;
  currentSegments = null;
  idleProvider = null;
  idleRefreshPending = false;
}
