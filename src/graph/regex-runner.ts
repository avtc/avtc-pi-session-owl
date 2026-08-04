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
//
// The worker posts each result back as it completes (not one batch at the end),
// so a timeout returns the PARTIAL matches found so far instead of discarding
// everything: the caller reports those partials plus a "search was stopped"
// note.

import { Worker } from "node:worker_threads";

/** Worker body (raw JS — `eval: true`, no module resolution so it needs no
 *  bundler/loader). Receives a regex source+flags + the strings to test, posts
 *  each boolean result back immediately (indexed), then a done marker — so the
 *  main thread accumulates partial results and can return them on timeout. It
 *  handles one message per request and stays alive across requests (the Worker
 *  is reused). */
const WORKER_SOURCE = `
const { parentPort } = require("worker_threads");
parentPort.on("message", (req) => {
  try {
    const re = new RegExp(req.source, req.flags);
    for (let i = 0; i < req.strings.length; i++) {
      parentPort.postMessage({ id: req.id, index: i, result: re.test(req.strings[i]) });
    }
    parentPort.postMessage({ id: req.id, done: true });
  } catch (err) {
    parentPort.postMessage({ id: req.id, error: (err && err.message) ? err.message : String(err) });
  }
});
`;

/** A pending request awaiting the worker's reply (or its timeout). */
interface Pending {
  resolve: (outcome: RegexTestOutcome) => void;
  timer: NodeJS.Timeout | null;
  /** Results accumulated so far (length === total; untested slots stay false). */
  results: boolean[];
  /** How many results have been posted back by the worker so far. */
  testedCount: number;
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
  w.on("message", (msg: { id: number; index?: number; result?: boolean; done?: boolean; error?: string }) => {
    const p = pending.get(msg.id);
    if (p === undefined) return;
    if (msg.error !== undefined) {
      if (p.timer !== null) clearTimeout(p.timer);
      pending.delete(msg.id);
      p.resolve({ error: compileErrorMessage(msg.error) });
      return;
    }
    if (msg.done === true) {
      if (p.timer !== null) clearTimeout(p.timer);
      pending.delete(msg.id);
      p.resolve({ results: p.results });
      return;
    }
    if (msg.index !== undefined && msg.result !== undefined) {
      p.results[msg.index] = msg.result;
      p.testedCount += 1;
    }
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

/** Outcome of a batched regex test: the boolean per input string (complete), a
 *  PARTIAL result set when the timeout fired (the matches found before the kill,
 *  untested slots false), or an error string the caller surfaces verbatim. */
export type RegexTestOutcome =
  | { results: boolean[] }
  | { results: boolean[]; testedCount: number; timedOutMs: number }
  | { error: string };

/** A floor on the configured timeout: even when a legacy/persisted config
 *  carries 0 (the removed "Off" preset), the worker kill timer is armed at
 *  least this long so a catastrophic pattern cannot freeze the reused worker
 *  and brick every later search. */
const MIN_TIMEOUT_MS = 1000;

/** Test `regex` against each string in `strings`, returning a boolean[] in the
 *  same order. Runs in a worker thread; the worker posts each result back as it
 *  completes. If the batch has not finished by the configured timeout (floored
 *  to a minimum), the worker is terminated and the PARTIAL results found so far
 *  are returned alongside a timed-out marker — callers report those partials
 *  plus a "search was stopped" note. If the worker cannot be spawned (a
 *  restricted runtime), the batch is REFUSED with an error — running
 *  unprotected on the main thread (where a backtracking pattern cannot be
 *  interrupted) would risk freezing the host process. */
export async function runRegexTests(regex: RegExp, strings: string[], timeoutMs: number): Promise<RegexTestOutcome> {
  if (strings.length === 0) return { results: [] };
  try {
    return await runInWorker(regex, strings, timeoutMs);
  } catch {
    // worker_threads unavailable or the worker failed to spawn — refuse rather
    // than run an interruptible pattern unprotected on the main thread.
    return { error: UNAVAILABLE_MESSAGE };
  }
}

const UNAVAILABLE_MESSAGE =
  "Regex search is unavailable in this runtime (worker threads could not start). Try a simpler pattern or browse with ls.";

async function runInWorker(regex: RegExp, strings: string[], timeoutMs: number): Promise<RegexTestOutcome> {
  const id = nextRequestId;
  nextRequestId += 1;
  const w = getWorker();
  const effectiveTimeout = Math.max(Number(timeoutMs) || MIN_TIMEOUT_MS, MIN_TIMEOUT_MS);
  const results: boolean[] = new Array(strings.length).fill(false);
  return new Promise<RegexTestOutcome>((resolve) => {
    // entry is mutated by the worker's per-result messages (results + testedCount);
    // the timer reads testedCount at timeout. Build entry first, then arm the timer.
    const entry: Pending = { resolve, timer: null, results, testedCount: 0 };
    const timer = setTimeout(() => {
      pending.delete(id);
      if (worker !== null) {
        void worker.terminate();
        worker = null;
      }
      resolve({ results, testedCount: entry.testedCount, timedOutMs: effectiveTimeout });
    }, effectiveTimeout);
    entry.timer = timer;
    pending.set(id, entry);
    w.postMessage({ id, source: regex.source, flags: regex.flags, strings });
  });
}

function compileErrorMessage(detail: string): string {
  return `Regex failed to run: ${detail}. Retry with a fixed pattern.`;
}
