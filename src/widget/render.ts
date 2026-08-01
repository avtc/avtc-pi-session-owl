// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// The widget line render. Pure over a WidgetSnapshot + Theme:
// builds the colored one-line string the factory wraps in a pi-tui Text.
//
// Format: 🦉 {obs} → {roots} [#N] [→ {selected} #N] → {ctx/window} → {tok} tok
// - obs section:   {count}{(+Δ)} obs   (+ inline N/M batch on observe when total>1)
// - roots section: {count}{(+Δ)} roots {viewTokens}{(+Δ)}/{threshold}   (#N pass on build)
// - selected sect: {count}{(+Δ)} selected {viewTokens}{(+Δ)}/{threshold}  (#N pass on select; selected-root only)
// - trailing:      {ctxUsed}/{contextWindow} → {tok} tok   (active only)
// Colors: counts=text (accent on the active stage's section); budgets/labels/→
// separators/spaces=dim; deltas follow their parent count; trailing ctx/tok=muted.

import { formatTokens } from "../format/tokens.js";
import type { WidgetSnapshot } from "./tracker.js";

/** Minimal Theme seam: the factory receives a real pi Theme; tests pass a fake. */
interface ThemeSeam {
  fg(color: string, text: string): string;
}

/** A reusable color set for one count (count color + dim for the rest). */
type Color = "text" | "accent" | "dim" | "muted";

const OWL = "🦉";
const SEP = " → ";
const PASS_PREFIX = " #";

/** Format a signed integer delta as (+N) / (-N), or "" when zero. */
function signedCount(delta: number): string {
  if (delta === 0) return "";
  return delta > 0 ? `(+${delta})` : `(${delta})`;
}

/** Format a signed token delta as +Nk / -Nk (formatTokens), or "" when zero. */
function signedTokens(delta: number): string {
  if (delta === 0) return "";
  const body = formatTokens(Math.abs(delta));
  return delta > 0 ? `(+${body})` : `(-${body})`;
}

/** Color a fragment via the theme seam. */
function paint(theme: ThemeSeam, color: Color, text: string): string {
  return theme.fg(color, text);
}

/** The obs section: {count}{Δ} obs [N/M batch]. */
function obsSection(snap: WidgetSnapshot, theme: ThemeSeam): string {
  const active = snap.stage === "observe";
  const countColor: Color = active ? "accent" : "text";
  const count = paint(theme, countColor, String(snap.obs.count));
  const delta = signedCount(snap.obs.delta);
  const deltaColored = delta === "" ? "" : paint(theme, countColor, delta);
  const label = paint(theme, "dim", " obs");
  const batch =
    snap.stage === "observe" && snap.batch !== null && snap.batch.total > 1
      ? paint(theme, "dim", ` ${snap.batch.done}/${snap.batch.total}`)
      : "";
  return `${count}${deltaColored}${label}${batch}`;
}

/** The roots section: {count}{Δ} roots {viewTokens}{Δ}/{threshold} [#N]. */
function rootsSection(snap: WidgetSnapshot, theme: ThemeSeam): string {
  const active = snap.stage === "build";
  const countColor: Color = active ? "accent" : "text";
  const count = paint(theme, countColor, String(snap.roots.count));
  const countDelta = signedCount(snap.roots.countDelta);
  const countDeltaColored = countDelta === "" ? "" : paint(theme, countColor, countDelta);
  const label = paint(theme, "dim", " roots ");
  const viewTokens = paint(theme, "dim", formatTokens(snap.roots.viewTokens));
  const tokenDelta = signedTokens(snap.roots.tokenDelta);
  const tokenDeltaColored = tokenDelta === "" ? "" : paint(theme, "dim", tokenDelta);
  const threshold = paint(theme, "dim", `/${formatTokens(snap.roots.threshold)}`);
  const pass = active ? paint(theme, "dim", `${PASS_PREFIX}${snap.pass}`) : "";
  return `${count}${countDeltaColored}${label}${viewTokens}${tokenDeltaColored}${threshold}${pass}`;
}

/** The selected section (select + selected-root only): {count}{Δ} selected {tok}{Δ}/{thr} #N. */
function selectedSection(snap: WidgetSnapshot, theme: ThemeSeam): string | null {
  if (snap.selected === null) return null;
  const count = paint(theme, "accent", String(snap.selected.count));
  const countDelta = signedCount(snap.selected.countDelta);
  const countDeltaColored = countDelta === "" ? "" : paint(theme, "accent", countDelta);
  const label = paint(theme, "dim", " selected ");
  const viewTokens = paint(theme, "dim", formatTokens(snap.selected.viewTokens));
  const tokenDelta = signedTokens(snap.selected.tokenDelta);
  const tokenDeltaColored = tokenDelta === "" ? "" : paint(theme, "dim", tokenDelta);
  const threshold = paint(theme, "dim", `/${formatTokens(snap.selected.threshold)}`);
  const pass = paint(theme, "dim", `${PASS_PREFIX}${snap.pass}`);
  return `${count}${countDeltaColored}${label}${viewTokens}${tokenDeltaColored}${threshold}${pass}`;
}

/** The trailing runtime segments: {ctx/window} → {tok} tok (active only).
 *  When contextWindow is null (getContextUsage() undefined) the whole context
 *  segment collapses to `?` (never `?/0`). */
function trailingSection(snap: WidgetSnapshot, theme: ThemeSeam): string {
  const ctxPart = snap.contextTokens === null ? "?" : formatTokens(snap.contextTokens);
  const windowPart = snap.contextWindow === null ? "" : `/${formatTokens(snap.contextWindow)}`;
  const ctx = paint(theme, "muted", `${ctxPart}${windowPart}`);
  const tok = paint(theme, "muted", `${formatTokens(snap.streamingOutputTokens)} tok`);
  return `${ctx}${paint(theme, "dim", SEP)}${tok}`;
}

/**
 * Format the widget line. Pure: takes a snapshot + theme, returns
 * the colored one-line string. Sections joined by a dim ` → ` separator.
 */
export function formatWidgetLine(snap: WidgetSnapshot, theme: ThemeSeam): string {
  const sep = paint(theme, "dim", SEP);
  const owl = paint(theme, "text", OWL);
  const parts: string[] = [owl, obsSection(snap, theme), rootsSection(snap, theme)];
  const selected = selectedSection(snap, theme);
  if (selected !== null) parts.push(selected);
  parts.push(trailingSection(snap, theme));
  return `${paint(theme, "text", " ")}${parts.join(sep)}`;
}
