// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// Shared text sanitization. ANSI/VT escape sequences appear in thinking blocks
// (and can be pasted into any user message); they are stripped from EVERY text
// session-owl captures — Observer chunks AND the oInitialPrompt capture — so the
// sanitization surface is uniform across all stored observations.

/** ANSI/VT escape sequences stripped from all captured text: CSI (SGR colors,
 *  24-bit color with ':' params, cursor moves, '?' private modes) via \x1b[ or the
 *  8-bit control introducer \x9b; OSC (terminal titles, OSC-8 hyperlinks) via
 *  BEL or the String Terminator (ESC \ or \x9c). */
// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escape sequences are the explicit target here
const ANSI_ESCAPE_PATTERN = /\x1b\][^\x07\x1b\x9c]*(?:\x07|\x1b\\|\x9c)|\x1b\[[0-9;:?]*[A-Za-z]|\x9b[0-9;:?]*[A-Za-z]/g;

/** Strip ANSI/VT escape sequences from text (applied to all captured text). */
export function stripAnsi(text: string): string {
  return text.replace(ANSI_ESCAPE_PATTERN, "");
}
