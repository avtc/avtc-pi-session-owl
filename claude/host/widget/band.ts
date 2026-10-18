// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// The AbovePrompt band composition — the pure half of the widget's band
// surface. The register's ui.render hook owns the `$`-touching parts (the
// element table from `$.ui.resolve(e)`, the `next(e)` await); this module
// decides WHAT to draw and shapes the composition, so it stays testable and
// closure-loadable (it imports only the line store — data-only).
//
// The rules (the widget task's design):
//   survey holds the band  ⇒ yield: draw `next(e)` untouched (return null —
//                             the hook passes through);
//   no line (idle/hidden)  ⇒ passthrough (null);
//   otherwise              ⇒ Box{ children: [next(e), line] } — the
//                             owl line APPENDED under whatever else the band
//                             carries, so every other mod's band content
//                             stays alive; a painted line draws as a row of
//                             per-span Texts (color styling), a plain line as
//                             one Text. The 🦉 prefix carries owl's
//                             identity (the engine adds its own `[-]`).
import { widgetLine, widgetSegments } from "./line-store.js";
import type { WidgetSegment } from "./render.js";

/** The element constructors the composition needs (the surface table's
 *  Box/Text — a structural slice of `$.ui.resolve(e)`'s frozen table).
 *  Text carries the per-span style props the engine paints with. */
export interface BandElements {
  Box: (props: { children?: unknown[]; flexDirection?: string }) => unknown;
  Text: (props: { children?: unknown[]; color?: string; dimColor?: boolean }) => unknown;
}

/** The engine-facing style each segment color paints as: pi's accent rides
 *  the brand key, dim rides the engine's dim flag, muted the subtle theme
 *  key (the port's platform color mapping — pi's Theme picks the equivalent). */
const SEGMENT_STYLE: Record<WidgetSegment["color"], { color?: string; dimColor?: boolean }> = {
  text: { color: "text" },
  accent: { color: "claude" },
  dim: { dimColor: true },
  muted: { color: "subtle" },
};

/** What the band hook should draw for this render ask. */
export type BandDecision = { kind: "passthrough" } | { kind: "compose"; inner: unknown; line: string };

/** Decide the band's drawing for one render ask. `hasSurvey` yields (the
 *  engine's survey owns the band); a null/empty line passes through; a live
 *  line composes under `inner` (the `next(e)` result). A non-null
 *  `pauseLine` (the conflict-pause text, live-computed by the hook) WINS
 *  over the store's line — a stale stage line must not outlive the pause,
 *  and the pause stays honest across mid-session flips; the survey still
 *  holds the band either way. */
export function decideBand(hasSurvey: boolean, inner: unknown, pauseLine: string | null = null): BandDecision {
  if (hasSurvey) return { kind: "passthrough" };
  const line = pauseLine ?? widgetLine();
  if (line === null || line === "") return { kind: "passthrough" };
  return { kind: "compose", inner, line };
}

/** Shape the composition: the inner drawing with owl's line appended.
 *  A PUBLISHED segment set (the line's own spans) draws as a row of styled
 *  Text fragments — colors reach the band (the active stage's accent); a
 *  text-only line (the conflict-pause override, plain publishes) draws as
 *  one plain Text, which is exactly the uncolored behavior. */
export function composeBand(
  elements: BandElements,
  decision: { kind: "compose"; inner: unknown; line: string },
): unknown {
  const segments = decision.line === widgetLine() ? widgetSegments() : null;
  const lineElement =
    segments === null || segments.length === 0
      ? elements.Text({ children: [decision.line] })
      : elements.Box({
          flexDirection: "row",
          children: segments.map((segment) =>
            elements.Text({ children: [segment.text], ...SEGMENT_STYLE[segment.color] }),
          ),
        });
  return elements.Box({
    children: [decision.inner, lineElement],
  });
}
