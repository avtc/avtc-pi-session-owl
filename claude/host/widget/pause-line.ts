// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// The closure-safe pause line ("Pause wiring"): the band's
// conflict-pause text with the same degradation ladder as the widget
// formatter (full list → first + "+N more" → drop the verb → ellipsize the
// names), data-only so the hooks closure loads it (imports nothing).
//
// Plain text — the band paints through its Text element; the theme-painted
// Node-side formatter (widget/render.ts formatConflictLine) serves the
// status surfaces that render outside the closure.

/** The pause line's degradation ladder. `width` is the drawing width. */
export function formatPauseLine(names: string[], width: number): string {
  const prefix = "🦉 ⚠ paused — ";
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
    const cut = width - visibleWidth(prefix) - visibleWidth(suffix) - 1; // -1: ellipsis
    plain = cut > 0 ? `${prefix}${truncateMiddle(body, cut)}${suffix}` : truncateMiddle(plain, width);
  }
  return plain;
}

/** Visible width of a string (wide chars count 2; ANSI never appears here). */
function visibleWidth(text: string): number {
  let w = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0;
    w +=
      cp >= 0x1100 &&
      (cp <= 0x115f ||
        (cp >= 0x2e80 && cp <= 0xa4cf) ||
        (cp >= 0xac00 && cp <= 0xd7a3) ||
        (cp >= 0xf900 && cp <= 0xfaff) ||
        (cp >= 0xfe30 && cp <= 0xfe6f) ||
        (cp >= 0xff00 && cp <= 0xff60) ||
        (cp >= 0xffe0 && cp <= 0xffe6) ||
        (cp >= 0x20000 && cp <= 0x3fffd))
        ? 2
        : 1;
  }
  return w;
}

/** Middle truncation keeping head+tail with an ellipsis. */
function truncateMiddle(text: string, max: number): string {
  if (visibleWidth(text) <= max) return text;
  const keep = max - 1; // the ellipsis
  const chars = [...text];
  let head = "";
  let headW = 0;
  for (const ch of chars) {
    const w = visibleWidth(ch);
    if (headW + w > Math.floor(keep * 0.7)) break;
    head += ch;
    headW += w;
  }
  let tail = "";
  let tailW = 0;
  for (let i = chars.length - 1; i >= 0; i--) {
    const w = visibleWidth(chars[i]);
    if (tailW + w > keep - headW) break;
    tail = chars[i] + tail;
    tailW += w;
  }
  return `${head}…${tail}`;
}
