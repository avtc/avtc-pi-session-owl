// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// Regex execution in a worker thread with a kill timeout.
//
// JavaScript is single-threaded: a backtracking `regex.test()` runs to
// completion on the main thread and cannot be interrupted by a timer. Running
// the tests in a `worker_threads` Worker keeps the host (pi) responsive, and
// `worker.terminate()` kills a runaway pattern at the timeout. This is the
// authoritative backstop for any catastrophic pattern that slips the static
// `isSafeRegex` fast-reject — it closes the residual polynomial/exponential
// shapes without freezing the process.

import { Worker } from "node:worker_threads";

/** Worker body (raw JS — `eval: true`, no module resolution so it needs no
 *  bundler/loader). Receives a regex source+flags + the strings to test,
 *  posts back either the boolean results or a compile error. */
const WORKER_SOURCE = `
const { parentPort } = require("worker_threads");
parentPort.on("message", (req) => {
  try {
    const re = new RegExp(req.source, req.flags);
    const results = req.strings.map((s) => re.test(s));
    parentPort.postMessage({ id: req.id, results });
  } catch (err) {
    parentPort.postMessage({ id: req.id, error: (err && err.message) ? err.message : String(err) });
  }
});
`;

/** Monotonic request id correlating the worker's reply to the call (the worker
 *  handles one request per call then is terminated, so the id is defensive). */
let nextRequestId = 0;

/** Outcome of a batched regex test: either a boolean per input string or an
 *  error string the caller surfaces verbatim (timeout / compile failure). */
export type RegexTestOutcome = { results: boolean[] } | { error: string };

/** Test `regex` against each string in `strings`, returning a boolean[] in the
 *  same order. Runs in a worker thread; if a single test has not finished by
 *  `timeoutMs` the worker is terminated and an error is returned. `timeoutMs`
 *  of 0 disables the timeout (the worker runs to completion). On any failure
 *  to spawn a worker (e.g. a restricted runtime), falls back to synchronous
 *  testing — the static `isSafeRegex` guard in `tryCompileFindRegex` still
 *  rejects known-catastrophic patterns before this point, so the fallback is
 *  safe in practice. */
export async function runRegexTests(regex: RegExp, strings: string[], timeoutMs: number): Promise<RegexTestOutcome> {
  if (strings.length === 0) return { results: [] };
  try {
    return await runInWorker(regex, strings, timeoutMs);
  } catch {
    // worker_threads unavailable or the worker failed to spawn — degrade to a
    // synchronous test. Patterns reaching here already passed the static guard.
    return { results: strings.map((s) => regex.test(s)) };
  }
}

async function runInWorker(regex: RegExp, strings: string[], timeoutMs: number): Promise<RegexTestOutcome> {
  const id = nextRequestId;
  nextRequestId += 1;
  const worker = new Worker(WORKER_SOURCE, { eval: true });
  return new Promise<RegexTestOutcome>((resolve) => {
    let settled = false;
    const finish = (outcome: RegexTestOutcome): void => {
      if (settled) return;
      settled = true;
      if (timer !== null) clearTimeout(timer);
      // release the worker regardless of outcome (terminate is a no-op if dead)
      void worker.terminate();
      resolve(outcome);
    };

    const onMessage = (msg: { id: number; results?: boolean[]; error?: string }): void => {
      if (msg.id !== id) return;
      if (msg.error !== undefined) finish({ error: compileErrorMessage(msg.error) });
      else if (msg.results !== undefined) finish({ results: msg.results });
    };

    worker.once("message", onMessage);
    worker.once("error", (err: Error) => finish({ error: compileErrorMessage(err.message) }));

    let timer: NodeJS.Timeout | null = null;
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        finish({ error: timeoutErrorMessage(timeoutMs) });
      }, timeoutMs);
    }

    worker.postMessage({ id, source: regex.source, flags: regex.flags, strings });
  });
}

function timeoutErrorMessage(timeoutMs: number): string {
  const seconds = timeoutMs / 1000;
  return `Regex timed out after ${seconds}s — the pattern backtracks too heavily or the input is too large. Simplify the regex.`;
}

function compileErrorMessage(detail: string): string {
  return `Regex failed to run: ${detail}. Retry with a fixed pattern.`;
}
