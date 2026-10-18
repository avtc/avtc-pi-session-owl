// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// Own width-aware truncation for the widget lines. pi's render layer uses
// pi-tui's visibleWidth/truncateToWidth; those live in a bare package the
// hooks closure's loader refuses, so the host port carries its own pair
// with the same contract for the strings the widget draws: measure runs
// BEFORE theming (ANSI-free — pi's own rule, the conflict line colors only
// after truncation), grapheme-based with wide-char (East Asian + emoji)
// double-width accounting — the 🦉 prefix and the → separators measure the
// same cells pi-tui would.
import type { RenderSurface } from "claude-code";

/** The ESC byte, spelled without a control-character regex literal (lint). */
const ESC = String.fromCharCode(27);

/** Strip ANSI escape sequences (defensive — callers measure pre-theme text). */
export function stripAnsi(text: string): string {
  return text.replace(new RegExp(`${ESC}\\[[0-9;?]*[ -/]*[@-~]`, "g"), "");
}

const WIDE_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x1100, 0x115f], // Hangul Jamo
  [0x2e80, 0x303e], // CJK radicals, Kangxi, CJK symbols
  [0x3041, 0x33ff], // Hiragana .. CJK compatibility
  [0x3400, 0x4dbf], // CJK ext A
  [0x4e00, 0x9fff], // CJK unified
  [0xa000, 0xa4cf], // Yi
  [0xac00, 0xd7a3], // Hangul syllables
  [0xf900, 0xfaff], // CJK compatibility ideographs
  [0xfe30, 0xfe6f], // CJK compatibility forms
  [0xff00, 0xff60], // fullwidth forms
  [0xffe0, 0xffe6],
  [0x1f300, 0x1f64f], // emoji: symbols .. emotions
  [0x1f680, 0x1f6ff], // transport
  [0x1f900, 0x1f9ff], // supplemental symbols
  [0x1fa70, 0x1faff], // extended-A symbols
  [0x20000, 0x2fffd], // CJK ext B..
  [0x30000, 0x3fffd],
];

/** Cells one code point occupies (2 for wide ranges, else 1). */
function codePointWidth(cp: number): number {
  for (const [lo, hi] of WIDE_RANGES) {
    if (cp >= lo && cp <= hi) return 2;
  }
  return 1;
}

/** The combining/marks set: Unicode property classes + the joiners, each
 *  its OWN test (a character class cannot mix them safely — lint rule). */
const COMBINING_PROPS: RegExp[] = [/\p{Mn}/u, /\p{Me}/u, /\p{Mc}/u, /\u200d/u, /\uFE0F/u, /\uFE0E/u];

function isCombining(ch: string): boolean {
  return COMBINING_PROPS.some((re) => re.test(ch));
}

/** Split into user-perceived graphemes (combining marks stay attached). */
function* graphemes(text: string): Generator<string> {
  const cps = [...text];
  for (let i = 0; i < cps.length; i += 1) {
    let cluster = cps[i] as string;
    while (i + 1 < cps.length && isCombining(cps[i + 1] as string)) {
      i += 1;
      cluster += cps[i];
    }
    yield cluster;
  }
}

/** The visible width in terminal cells (ANSI stripped, wide chars ×2). */
export function visibleWidth(text: string): number {
  const clean = stripAnsi(text);
  let width = 0;
  for (const g of graphemes(clean)) {
    const cp = g.codePointAt(0) ?? 0;
    width += codePointWidth(cp);
  }
  return width;
}

/** Truncate to at most `maxWidth` cells, appending the ellipsis when cut. */
export function truncateToWidth(text: string, maxWidth: number, ellipsis = "…"): string {
  if (maxWidth <= 0) return "";
  if (visibleWidth(text) <= maxWidth) return text;
  // the ellipsis itself must fit: clip it when wider than the whole budget
  // (pi-tui's rule — a 2-cell ellipsis in a 1-cell budget clips to ".")
  if (visibleWidth(ellipsis) >= maxWidth) {
    return clipGraphemes(ellipsis, maxWidth);
  }
  const budget = maxWidth - visibleWidth(ellipsis);
  const clipped = clipGraphemes(text, budget);
  return `${clipped}${ellipsis}`;
}

/** Keep the leading graphemes that fit `maxWidth` cells. */
function clipGraphemes(text: string, maxWidth: number): string {
  let width = 0;
  let out = "";
  for (const g of graphemes(stripAnsi(text))) {
    const w = codePointWidth(g.codePointAt(0) ?? 0);
    if (width + w > maxWidth) break;
    width += w;
    out += g;
  }
  return out;
}

/** The surfaces that raise the AbovePrompt band (its render component is
 *  documented terminal+desktop only — the mobile/vscode clients never ask
 *  for it). */
export const BAND_SURFACES: readonly RenderSurface[] = ["terminal", "desktop"];

/** Does this surface list contain a band-raising surface? */
export function hasBandSurface(surfaces: readonly string[]): boolean {
  return surfaces.some((s) => (BAND_SURFACES as readonly string[]).includes(s));
}

/** The fallback surfaces (the status-pin line where no band is raised). */
export const FALLBACK_SURFACES: readonly RenderSurface[] = ["mobile", "vscode"];

/** Does this surface list contain a fallback surface? */
export function hasFallbackSurface(surfaces: readonly string[]): boolean {
  return surfaces.some((s) => (FALLBACK_SURFACES as readonly string[]).includes(s));
}
