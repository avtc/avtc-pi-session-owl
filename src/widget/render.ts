// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// The widget line render. Pure over a WidgetSnapshot + Theme:
// builds the colored one-line string the factory wraps in a pi-tui Text.
//
// Format: 🦉 {obs} → {roots} [#N] [→ {selected} #N] · {ctx/window} · {tok} tok [· {+N obs}]
// - obs section:   {count}{(+Δ)} obs   (+ inline N/M batch while a multi-chunk observe batch is in flight — observe or an interleaved build)
// - roots section: {count}{(+Δ)} roots {viewTokens}{(+Δ)}/{threshold}   (#N pass on build)
// - selected sect: {count}{(+Δ)} selected {viewTokens}{(+Δ)}/{threshold}  (#N pass on select; selected-root only)
// - trailing:      {ctxUsed}/{contextWindow} · {tok} tok · {+N obs}   (active only; joined to
//                   the structural sections by ·, internally by ·; the +N obs segment appears
//                   only while the current chunk has accepted-but-unpersisted records)
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
const MID = " · ";
const PASS_PREFIX = " #";
/** inFlightObs zero value (no accepted-but-unpersisted records). */
const NO_IN_FLIGHT = 0;

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

/** The obs section: {count}{Δ} obs [N/M batch — while one is in flight]. */
function obsSection(snap: WidgetSnapshot, theme: ThemeSeam): string {
  const active = snap.stage === "observe";
  const countColor: Color = active ? "accent" : "text";
  const count = paint(theme, countColor, String(snap.obs.count));
  const delta = signedCount(snap.obs.delta);
  const deltaColored = delta === "" ? "" : paint(theme, countColor, delta);
  const label = paint(theme, "dim", " obs");
  // stage-independent: the batch belongs to the observe RUN, so it also shows
  // during an interleaved build (the mid-catch-up Builder inside the observe loop).
  const batch =
    snap.batch !== null && snap.batch.total > 1 ? paint(theme, "dim", ` ${snap.batch.done}/${snap.batch.total}`) : "";
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

/** The trailing runtime segments: {ctx/window} · {tok} tok [· {+N obs}] (active
 *  only). Joined to the structural sections by `MID` (·) and internally by `·` —
 *  the runtime metrics read as one grouped cluster, distinct from the `→`
 *  structural breaks (obs → roots → selected).
 *  When contextWindow is null (getContextUsage() undefined) the whole context
 *  segment collapses to `?` (never `?/0`).
 *  The `+N obs` segment (observations accepted by record_observations in the
 *  CURRENT chunk, not yet persisted) appears only when non-zero — the live
 *  working-vs-stuck signal: it moving means the model is recording, even while
 *  the obs total waits for the chunk to complete. */
function trailingSection(snap: WidgetSnapshot, theme: ThemeSeam): string {
  const ctxPart = snap.contextTokens === null ? "?" : formatTokens(snap.contextTokens);
  const windowPart = snap.contextWindow === null ? "" : `/${formatTokens(snap.contextWindow)}`;
  const ctx = paint(theme, "muted", `${ctxPart}${windowPart}`);
  const tok = paint(theme, "muted", `${formatTokens(snap.streamingOutputTokens)} tok`);
  const parts = [ctx, tok];
  if (snap.inFlightObs > NO_IN_FLIGHT) {
    parts.push(paint(theme, "muted", `+${snap.inFlightObs} obs`));
  }
  return parts.join(paint(theme, "dim", MID));
}

/**
 * Format the widget line. Pure: takes a snapshot + theme, returns
 * the colored one-line string. Structural sections (obs → roots → selected)
 * join with a dim ` → `; the trailing runtime cluster (context + streaming)
 * appends with a dim ` · ` and is internally ` · `-joined.
 */
export function formatWidgetLine(snap: WidgetSnapshot, theme: ThemeSeam): string {
  const owl = paint(theme, "text", `${OWL} `);
  const structuralParts: string[] = [obsSection(snap, theme), rootsSection(snap, theme)];
  const selected = selectedSection(snap, theme);
  if (selected !== null) structuralParts.push(selected);
  const structural = structuralParts.join(paint(theme, "dim", SEP));
  const trailing = trailingSection(snap, theme);
  return `${owl}${structural}${paint(theme, "dim", MID)}${trailing}`;
}
