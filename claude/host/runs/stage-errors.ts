// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// The stage-run error classes — HOST PORT of the three in the vendored
// runtime/agent-loop.ts (whose own module value-imports pi-agent-core, an
// edge the engine loader refuses; the classes' messages and names are pi's
// verbatim so callers instanceof-check and users read the same text).

/** A per-LLM-call timeout — a stage-stopping error. Propagates to the caller
 *  (which cancels compaction + notifies the user) so a slow/oversized call
 *  surfaces instead of silently producing a partial/wrong summary. */
export class StageTimeoutError extends Error {
  constructor(stage: string, limitMs: number | null) {
    const limit = limitMs === null ? "the time limit" : `${Math.round(limitMs / 1000)}s time limit`;
    super(`${stage} stopped: an LLM call exceeded the ${limit}`);
    this.name = "StageTimeoutError";
  }
}

/** A stage run failure (wraps a cause; the ledger already folded partial usage
 *  in the shim's finally — this carries only the cause). */
export class StageRunError extends Error {
  constructor(cause: unknown) {
    const msg = cause instanceof Error ? cause.message : String(cause);
    super(`stage run failed: ${msg}`, { cause });
    this.name = "StageRunError";
  }
}

/** A terminal model/runtime failure — the engine's error/refusal completion
 *  (server unavailable, wrong model hosted, provider error; the shim throws
 *  its own message for these — this class marks the mapped boundary). */
export class StageModelError extends Error {
  readonly modelErrorMessage: string | null;
  constructor(modelErrorMessage: string | null) {
    const detail = modelErrorMessage?.trim();
    super(
      detail
        ? `agent model call failed (stopReason "error"): ${detail}`
        : 'agent model call failed (stopReason "error")',
    );
    this.name = "StageModelError";
    this.modelErrorMessage = detail || null;
  }
}
