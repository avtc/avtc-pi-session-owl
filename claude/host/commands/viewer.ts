// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// The command-output viewer pane. The notify transport (ui.log) is a dim
// transcript line the engine draws up to a per-surface character budget —
// long listings (the root view, a node's children, the status report)
// arrive truncated or delimiter-joined. The viewer pane carries the SAME
// text whole: one Text element per line inside the pane's scrollable body,
// no engine drawing cap. The pane is read-only (browse surfaces only) and
// shares the settings pane's lifecycle (opened under a plugin id, Escape
// closes, the ui.render hook below the prompt draws it).

/** The switch: `true` routes eligible command output into the viewer pane;
 *  `false` keeps every message on the notify transport (the ui.log mapping)
 *  — flip it back if the engine's ui.log drawing caps ever lift. */
export const OUTPUT_PANE_VIEWER = true;

/** The pane's plugin id (one pane at a time; a later listing retitles). */
export const VIEWER_PANE_ID = "session-owl-output";

/** Output eligible for the pane: ANY non-empty routed listing. A one-root
 *  root view is still a whole browse surface — the notify transcript line
 *  would draw it as one dim, budget-capped row. Empty text (nothing routed)
 *  keeps the notify transport. */
export function wantsViewer(text: string): boolean {
  return text.trim().length > 0;
}

/** The pane's content (title + exact text), set at open time and read by
 *  the render hook. Module-scoped — the pane outlives the command call. */
let content: { title: string; text: string } | null = null;

/** Set the pane's content (called by the open capsule before ui.open). */
export function setViewerContent(title: string, text: string): void {
  content = { title, text };
}

/** The stored content (the render hook's source); null with nothing set. */
export function getViewerContent(): { title: string; text: string } | null {
  return content;
}

/** Clear the stored content (a closed pane never shows stale text). */
export function clearViewerContent(): void {
  content = null;
}

/** The pane's element tree over the resolved element table: one Text per
 *  line (an empty line draws as a single space — a zero-width text element
 *  is skipped by the surface), the whole listing inside one Box. */
export function buildViewerTree(els: {
  Box: (props: Record<string, unknown>) => unknown;
  Text: (props: Record<string, unknown>) => unknown;
}): unknown {
  const stored = content;
  if (stored === null) {
    return els.Text({ key: "owl-viewer-empty", children: "Nothing to show." });
  }
  const lines = stored.text.split("\n");
  return els.Box({
    key: "owl-viewer",
    flexDirection: "column",
    children: lines.map((line, i) => els.Text({ key: `owl-viewer-l${i}`, children: line === "" ? " " : line })),
  });
}

/** Route one command output: the viewer pane when enabled, eligible, and
 *  wired; the notify transport otherwise (short notices, the unwired kit
 *  contexts, or the switch flipped off). */
export function routeOutput(
  deps: {
    notify: (text: string, level: "info" | "warning" | "error") => void;
    openViewer?: (title: string, text: string) => void;
  },
  title: string,
  text: string,
  enabled: boolean = OUTPUT_PANE_VIEWER,
): void {
  if (enabled && deps.openViewer !== undefined && wantsViewer(text)) {
    deps.openViewer(title, text);
    return;
  }
  deps.notify(text, "info");
}
