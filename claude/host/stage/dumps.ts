// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// The stage dumps' call sites: what a run's dump holds.
// The full dump module (the ring under `dumps/<sanitized-cwd>/`, retention
// limits) lands in the dump-ring persistence layer; these functions fill the
// per-run buffer the
// engine owns — `<input>` = the spawn prompt verbatim, `<output>` = the
// run's captured rows + the handback pair + a marker when a stop was
// fabricated (the dump shows the run as it actually executed).
// Import-free by construction (it sits inside the hooks closure).
import { noteStageFatalModelError, type StageRunState } from "./runs.js";

/** One captured row of the run's `<output>` (response rows, tool calls,
 *  tool results — routed here by the capture layer's stage-agent branch). */
export function recordDumpOutputRow(run: StageRunState, row: unknown): void {
  run.dump.outputRows.push(row);
  const detail = fatalModelRowDetail(row);
  if (detail !== null) noteStageFatalModelError(run.stage, detail);
}

/** An engine `api_error` system row in the run's stream: the model side
 *  failed and the engine's retries are exhausted — whatever the run produces
 *  afterwards is not a verdict. Null for every other row shape. */
function fatalModelRowDetail(row: unknown): string | null {
  if (row === null || typeof row !== "object") return null;
  const message = (row as { message?: unknown }).message;
  if (message === null || typeof message !== "object") return null;
  const m = message as { type?: unknown; name?: unknown; status?: unknown };
  if (m.type !== "system" || m.name !== "api_error") return null;
  const status = typeof m.status === "number" ? ` status ${m.status}` : "";
  return `api_error${status}`;
}

/** The run's handback pair (the SubagentHandback tool call + its result). */
export function recordDumpHandback(run: StageRunState, pair: { tool: string; result: unknown }): void {
  run.dump.handback = pair;
}

/** A run-module forensic section (pi's `<chunk>/<allowed>` and `<pass>`
 *  wrappers) — appended at spawn time, kept in order. An OPENER (`<chunk …`
 *  or `<pass …`) stashes its matching closer: the run's teardown flushes it
 *  (completeStageRun), so the wrappers stay balanced even when the pass
 *  throws or the runner completes before the caller's own finally runs. */
export function recordDumpSection(run: StageRunState, text: string): void {
  run.dump.sections.push(text);
  if (text.startsWith("<chunk")) run.dump.pendingCloser = "</chunk>\n";
  else if (text.startsWith("<pass")) run.dump.pendingCloser = "</pass>\n";
}

/** A fabricated stop happened (abort/timeout/cap) — the marker that
 *  keeps the dump honest about how the run ended. The first sticks. */
export function markFabricatedStop(run: StageRunState, kind: string): void {
  if (run.dump.fabricatedStop === null) run.dump.fabricatedStop = kind;
}
