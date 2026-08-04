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
 *  posts back either the boolean results or a compile error. It handles one
 *  message per request and stays alive across requests (the Worker is reused). */
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

/** A pending request awaiting the worker's reply (or its timeout). */
interface Pending {
  resolve: (outcome: RegexTestOutcome) => void;
  timer: NodeJS.Timeout | null;
}

/** The lazily-created, reused worker. Null until first use, and reset to null
 *  after a timeout or worker error (the next call respawns). One worker serves
 *  all calls so the per-call spawn cost (OS thread + V8 isolate init) is paid
 *  once, not once per find/mk_recall query. */
let worker: Worker | null = null;
/** Pending requests keyed by id, so the shared worker's replies route to the
 *  right caller (the id also disambiguates if calls ever overlap). */
const pending = new Map<number, Pending>();
/** Monotonic request id correlating the worker's reply to the call. */
let nextRequestId = 0;

/** Ensure the shared worker exists, wiring its message/error listeners once. */
function getWorker(): Worker {
  if (worker !== null) return worker;
  const w = new Worker(WORKER_SOURCE, { eval: true });
  // a persistent listener routes every reply to its pending caller.
  w.on("message", (msg: { id: number; results?: boolean[]; error?: string }) => {
    const p = pending.get(msg.id);
    if (p === undefined) return;
    if (p.timer !== null) clearTimeout(p.timer);
    pending.delete(msg.id);
    if (msg.error !== undefined) p.resolve({ error: compileErrorMessage(msg.error) });
    else p.resolve({ results: msg.results ?? [] });
  });
  // a worker-level error (crash) fails every still-pending request, then the
  // worker is discarded so the next call respawns.
  w.on("error", (err: Error) => {
    failAll({ error: compileErrorMessage(err.message) });
  });
  worker = w;
  return w;
}

/** Resolve all pending requests with `outcome`, terminate + discard the worker. */
function failAll(outcome: RegexTestOutcome): void {
  for (const p of pending.values()) {
    if (p.timer !== null) clearTimeout(p.timer);
    p.resolve(outcome);
  }
  pending.clear();
  if (worker !== null) {
    void worker.terminate();
    worker = null;
  }
}

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
  const w = getWorker();
  return new Promise<RegexTestOutcome>((resolve) => {
    const timer =
      timeoutMs > 0
        ? setTimeout(() => {
            // a timeout kills the stuck worker (the pattern is still running in
            // it) and fails this request; the next call respawns a fresh worker.
            pending.delete(id);
            if (worker !== null) {
              void worker.terminate();
              worker = null;
            }
            resolve({ error: timeoutErrorMessage(timeoutMs) });
          }, timeoutMs)
        : null;
    pending.set(id, { resolve, timer });
    w.postMessage({ id, source: regex.source, flags: regex.flags, strings });
  });
}

function timeoutErrorMessage(timeoutMs: number): string {
  const seconds = timeoutMs / 1000;
  return `Regex timed out after ${seconds}s — the pattern backtracks too heavily or the input is too large. Simplify the regex.`;
}

function compileErrorMessage(detail: string): string {
  return `Regex failed to run: ${detail}. Retry with a fixed pattern.`;
}
