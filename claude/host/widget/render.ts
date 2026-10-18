// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// The widget line render — the host port of pi's src/widget/render.ts.
// Pure over a WidgetSnapshot + theme seam: builds the one-line string the
// band Text carries (and the status fallback re-issues). pi's exact format:
// 🦉 {obs} → {roots} [#N] [→ {selected} #N] · {ctx/window} · {tok} tok [· {+N obs}]
// The snapshot type lives HERE (not in the bridge) so this module stays
// closure-loadable — the band hook reads only the rendered line string.
// pi-tui's truncateToWidth/visibleWidth map to the host's own width pair
// (the bare package edge the closure refuses); formatTokens is the vendored
// core's (pure, closure-safe).
import { formatTokens } from "../../core/src/format/tokens.js";
import { truncateToWidth, visibleWidth } from "./width.js";

/** The maintenance stages the widget surfaces (one at a time; run-level). */
export type WidgetStage = "observe" | "build" | "select";

/** Observe multi-chunk progress (shown only when total > 1). */
export interface BatchProgress {
  done: number;
  total: number;
}

/** Per-stage usage accumulation (the vendored StageUsage shape). */
export interface WidgetUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  turns: number;
  elapsedMs: number;
}

/** A render-time snapshot of the tracker + live graph/config counts. */
export interface WidgetSnapshot {
  stage: WidgetStage;
  pass: number;
  batch: BatchProgress | null;
  usage: WidgetUsage;
  streamingOutputTokens: number;
  obs: { count: number; delta: number };
  roots: { count: number; countDelta: number; viewTokens: number; tokenDelta: number; threshold: number };
  selected: { count: number; countDelta: number; viewTokens: number; tokenDelta: number; threshold: number } | null;
  contextTokens: number | null;
  contextWindow: number | null;
  /** Observations ACCEPTED by record_observations in the CURRENT chunk but
   *  not yet persisted — the live `+N obs` working-vs-stuck signal. */
  inFlightObs: number;
}

/** Minimal Theme seam: the band receives the engine's; tests pass a fake. */
export interface ThemeSeam {
  fg(color: string, text: string): string;
}

/** A reusable color set for one count (count color + dim for the rest).
 *  Carried on every segment; the band maps it to engine Text styles. */
type Color = "text" | "accent" | "dim" | "muted";

/** One painted fragment of the widget line: what the band draws as its own
 *  styled Text span so the active stage's section carries the accent color
 *  (pi's Theme paints the same fragment through pi-tui). */
export interface WidgetSegment {
  text: string;
  color: Color;
}

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
function obsSection(snap: WidgetSnapshot): WidgetSegment[] {
  const active = snap.stage === "observe";
  const countColor: Color = active ? "accent" : "text";
  const out: WidgetSegment[] = [{ text: String(snap.obs.count), color: countColor }];
  const delta = signedCount(snap.obs.delta);
  if (delta !== "") out.push({ text: delta, color: countColor });
  out.push({ text: " obs", color: "dim" });
  // stage-independent: the batch belongs to the observe RUN, so it also shows
  // during an interleaved build (the mid-catch-up Builder inside the observe loop).
  if (snap.batch !== null && snap.batch.total > 1) {
    out.push({ text: ` ${snap.batch.done}/${snap.batch.total}`, color: "dim" });
  }
  return out;
}

/** The roots section: {count}{Δ} roots {viewTokens}{Δ}/{threshold} [#N]. */
function rootsSection(snap: WidgetSnapshot): WidgetSegment[] {
  const active = snap.stage === "build";
  const countColor: Color = active ? "accent" : "text";
  const out: WidgetSegment[] = [{ text: String(snap.roots.count), color: countColor }];
  const countDelta = signedCount(snap.roots.countDelta);
  if (countDelta !== "") out.push({ text: countDelta, color: countColor });
  out.push({ text: " roots ", color: "dim" });
  out.push({ text: formatTokens(snap.roots.viewTokens), color: "dim" });
  const tokenDelta = signedTokens(snap.roots.tokenDelta);
  if (tokenDelta !== "") out.push({ text: tokenDelta, color: "dim" });
  out.push({ text: `/${formatTokens(snap.roots.threshold)}`, color: "dim" });
  if (active) out.push({ text: `${PASS_PREFIX}${snap.pass}`, color: "dim" });
  return out;
}

/** The selected section (select + selected-root only). */
function selectedSection(snap: WidgetSnapshot): WidgetSegment[] | null {
  if (snap.selected === null) return null;
  const out: WidgetSegment[] = [{ text: String(snap.selected.count), color: "accent" }];
  const countDelta = signedCount(snap.selected.countDelta);
  if (countDelta !== "") out.push({ text: countDelta, color: "accent" });
  out.push({ text: " selected ", color: "dim" });
  out.push({ text: formatTokens(snap.selected.viewTokens), color: "dim" });
  const tokenDelta = signedTokens(snap.selected.tokenDelta);
  if (tokenDelta !== "") out.push({ text: tokenDelta, color: "dim" });
  out.push({ text: `/${formatTokens(snap.selected.threshold)}`, color: "dim" });
  out.push({ text: `${PASS_PREFIX}${snap.pass}`, color: "dim" });
  return out;
}

/** The trailing runtime segments: {ctx/window} · {tok} tok [· {+N obs}].
 *  When contextWindow is null the whole context segment collapses to `?`. */
function trailingSection(snap: WidgetSnapshot): WidgetSegment[] {
  const ctxPart = snap.contextTokens === null ? "?" : formatTokens(snap.contextTokens);
  const windowPart = snap.contextWindow === null ? "" : `/${formatTokens(snap.contextWindow)}`;
  const out: WidgetSegment[] = [
    { text: `${ctxPart}${windowPart}`, color: "muted" },
    { text: MID, color: "dim" },
    { text: `${formatTokens(snap.streamingOutputTokens)} tok`, color: "muted" },
  ];
  if (snap.inFlightObs > NO_IN_FLIGHT) {
    out.push({ text: MID, color: "dim" });
    out.push({ text: `+${snap.inFlightObs} obs`, color: "muted" });
  }
  return out;
}

/**
 * The widget line as painted segments — pi's color structure, fragment for
 * fragment: the 🦉 prefix text-colored; the ACTIVE stage's count (+delta)
 * accent; labels/separators/thresholds dim; the trailing runtime cluster
 * muted. Segments are non-empty and in paint order.
 */
export function formatWidgetSegments(snap: WidgetSnapshot): WidgetSegment[] {
  const out: WidgetSegment[] = [{ text: `${OWL} `, color: "text" }, ...obsSection(snap)];
  out.push({ text: SEP, color: "dim" }, ...rootsSection(snap));
  const selected = selectedSection(snap);
  if (selected !== null) {
    out.push({ text: SEP, color: "dim" }, ...selected);
  }
  out.push({ text: MID, color: "dim" }, ...trailingSection(snap));
  return out;
}

/**
 * Format the widget line. Pure: takes a snapshot + theme, returns
 * the colored one-line string. Structural sections (obs → roots → selected)
 * join with a dim ` → `; the trailing runtime cluster appends with a dim
 * ` · ` and is internally ` · `-joined.
 */
export function formatWidgetLine(snap: WidgetSnapshot, theme: ThemeSeam): string {
  let out = "";
  for (const segment of formatWidgetSegments(snap)) out += paint(theme, segment.color, segment.text);
  return out;
}

/**
 * The conflict-pause line (static — no stages run while paused):
 * `🦉 ⚠ paused — {names} also handle(s) compaction (/owl-status)`.
 * Width-aware degradation ladder — the resolution hint `(/owl-status)` is the
 * last thing to go: full list → `{first}, +N more` → drop the verb → cut the
 * names with an ellipsis. Coloring happens after truncation so the visible
 * width math stays ANSI-free (prefix accent, rest muted).
 */
export function formatConflictLine(names: string[], width: number, theme: ThemeSeam): string {
  const prefix = `${OWL} ⚠ paused — `;
  const suffix = " (/owl-status)";
  const verb = names.length > 1 ? " also handle compaction" : " also handles compaction";
  const compose = (body: string): string => `${prefix}${body}${suffix}`;
  const fits = (line: string): boolean => visibleWidth(line) <= width;

  let body = `${names.join(", ")}${verb}`;
  if (!fits(compose(body)) && names.length > 1) {
    body = `${names[0]}, +${names.length - 1} more${verb}`;
  }
  if (!fits(compose(body))) {
    body = names.length > 1 ? `${names[0]}, +${names.length - 1} more` : `${names[0]}`;
  }
  let plain = compose(body);
  if (!fits(plain)) {
    // middle-truncate the names segment so prefix + resolution hint survive
    const cut = width - visibleWidth(prefix) - visibleWidth(suffix) - 1; // -1: ellipsis
    plain = cut > 0 ? `${prefix}${truncateToWidth(body, cut, "…")}${suffix}` : truncateToWidth(plain, width, "…");
  }
  return paint(theme, "accent", plain.slice(0, prefix.length)) + paint(theme, "muted", plain.slice(prefix.length));
}
