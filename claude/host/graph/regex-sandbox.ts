// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// The host-side regex sandbox: the worker-free port of the core's
// regex-runner (the platform's plugin closure refuses `node:worker_threads`,
// so the worker kill-timer cannot exist here). Contract-identical: the same
// exports, the same outcome shapes, the same message texts.
//
// Mechanism: the tests run INLINE in bounded chunks with a deadline checked
// between chunks — a deadline hit returns the PARTIAL results found so far
// (exactly the worker timeout's semantics). Two backstops bound what the
// chunking cannot: the callers' static `isSafeRegex` fast-reject runs before
// this seam (pi's own layering), and the engine's per-hook time budget is
// the hard kill for anything that still slips through — the degradation is
// the refusal class, never a silent freeze of the host beyond that budget.
/** Outcome of a batched regex test: the boolean per input string (complete),
 *  a PARTIAL result set when the deadline fired, or an error string the
 *  caller surfaces verbatim (shape-identical to the worker runner). */
export type RegexTestOutcome =
  | { results: boolean[] }
  | { results: boolean[]; testedCount: number; timedOutMs: number }
  | { error: string };

/** How many strings run between deadline checks — a granularity knob kept
 *  from the worker design; the check ALSO runs per string (see below). */
const CHUNK_SIZE = 256;

/** The same floor the worker runner applies: even a 0/legacy timeout arms at
 *  least this long, so a slow-but-fine batch is not spuriously cut short. */
const MIN_TIMEOUT_MS = 1000;

const UNAVAILABLE_MESSAGE =
  "Regex search is unavailable in this runtime (worker threads could not start). Try a simpler pattern or browse with ls.";

const WORKER_SHUTDOWN_MESSAGE = "Regex search was stopped (the session shut down). Re-run the query after reload.";

/** Test `regex` against each string in `strings`, returning a boolean[] in
 *  the same order. Inline chunked execution with a deadline: a batch that
 *  exceeds the timeout (floored) returns the PARTIAL matches found so far —
 *  callers report those partials plus a "search was stopped" note. */
export async function runRegexTests(
  regex: RegExp,
  strings: readonly string[],
  timeoutMs: number,
): Promise<RegexTestOutcome> {
  if (strings.length === 0) return { results: [] };
  const effectiveTimeout = Math.max(Number(timeoutMs) || MIN_TIMEOUT_MS, MIN_TIMEOUT_MS);
  const deadline = Date.now() + effectiveTimeout;
  const results: boolean[] = new Array(strings.length).fill(false);
  let tested = 0;
  try {
    for (let i = 0; i < strings.length; i += CHUNK_SIZE) {
      const end = Math.min(i + CHUNK_SIZE, strings.length);
      for (let j = i; j < end; j += 1) {
        // checked BEFORE each string (except the first): a runaway pattern on
        // one string cannot be interrupted inline — the engine's per-hook
        // budget is the hard kill for THAT — but the moment control returns,
        // the fired deadline converts the outcome to the timeout shape.
        if (j > 0 && Date.now() >= deadline) {
          return { results, testedCount: tested, timedOutMs: effectiveTimeout };
        }
        results[j] = regex.test(strings[j] as string);
        tested += 1;
      }
    }
    const timedOutDuringRun = Date.now() >= deadline;
    if (timedOutDuringRun) {
      // The last string(s) straggled past the deadline (a runaway pattern
      // cannot be interrupted mid-test — the engine's per-hook budget is the
      // hard kill for that); the worker would have been terminated at the
      // deadline, so the outcome converts to the SAME timeout shape carrying
      // whatever results exist (the caller renders the timeout note).
      return { results, testedCount: tested, timedOutMs: effectiveTimeout };
    }
    return { results };
  } catch (err) {
    return { error: compileErrorMessage(err instanceof Error ? err.message : String(err)) };
  }
}

/** Teardown no-op (the worker runner's shutdown hook): inline execution has
 *  nothing in flight to resolve or terminate. Kept so the callers' shutdown
 *  path works unchanged. */
export function terminateRegexWorker(): void {
  void WORKER_SHUTDOWN_MESSAGE;
  void UNAVAILABLE_MESSAGE;
}

function compileErrorMessage(detail: string): string {
  return `Regex failed to run: ${detail}. Retry with a fixed pattern.`;
}
