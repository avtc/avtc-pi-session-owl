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

/** Test isolation: reset to the empty store. */
export function _resetWidgetLine(): void {
  currentLine = null;
  currentSegments = null;
}
