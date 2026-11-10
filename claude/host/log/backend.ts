// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

/**
 * The log backend — the module the vendored core's log.ts is REWRITTEN to
 * import (the sync-time rewrite table maps avtc-pi-logger here).
 *
 * The vendored core constructs its logger AT MODULE LOAD (log.ts top level)
 * over the avtc-claude-logger DEFAULT backend — and the hooks sandbox has
 * no `process`, no env and no `$` at import time, so neither the config dir
 * nor an fs surface exists yet. Being log.ts's OWN import, this module
 * evaluates fully first WHATEVER order the loader visits the graph in: its
 * body installs a TRANSLATING default backend before re-exporting the
 * library surface log.ts links against.
 *
 * The backend hands the library a sentinel base dir; every adapter call
 * rewrites the sentinel prefix onto `<configDir>/logs/…` using
 * the root + fs surface that `initLogConsumer` receives at the awaited
 * session start. Before that, adapter calls reject and the library's
 * best-effort contract drops the record (early-boot logs are lost by
 * design; the console fallback carries registration failures).
 */

import {
  getDefaultBackend,
  type ScheduleFn,
  setDefaultBackend,
} from "../../node_modules/avtc-claude-logger/dist/index.js";

// The library surface the vendored log.ts links against — re-exported AFTER
// this module's body installed the translating default backend below.
export { createLogger } from "../../node_modules/avtc-claude-logger/dist/index.js";

/** The base dir the library sees; translated per call once the real root lands. */
const SENTINEL_BASE_DIR = "/session-owl-logs-sentinel";

/** The real root: `<configDir>/logs` — the shared per-logger root, pi's
 * `~/.pi/logs` shape (`<root>/<name>/<file>.log`) carried to Claude. */
let realRoot: string | null = null;

/** The whole-file fs surface (set at initLogConsumer). */
let realFs: LogFsSurface | null = null;

/** The host's window timer (set at initLogConsumer). Loggers created at
 *  module load read it through the stable closure below — the seam lands
 *  long after their writer exists. */
let hostSchedule: ScheduleFn | null = null;

/** The minimal fs surface the slot ring needs (the wiring passes the bridge's). */
export interface LogFsSurface {
  read(path: string): Promise<string>;
  write(path: string, text: string): Promise<void>;
  list(dir: string): Promise<ReadonlyArray<{ name: string; kind: string; size: number; mtimeMs: number }>>;
  /** The identity of an existing file, or null when it is absent (the
   *  library's read-skip guard). Absent — or rejecting on anything beyond
   *  ENOENT — turns the guard off: every flush reads, the pre-guard cost. */
  stat?(path: string): Promise<{ mtimeMs: number; size: number } | null>;
}

/** Translate one library-issued path onto the real root (identity pre-init). */
function translate(path: string): string {
  if (realRoot === null) return path;
  return path === SENTINEL_BASE_DIR
    ? realRoot
    : path.startsWith(`${SENTINEL_BASE_DIR}/`)
      ? `${realRoot}${path.slice(SENTINEL_BASE_DIR.length)}`
      : path;
}

/** The translating adapter: rejects everything until initLogConsumer lands. */
function rejecting(): never {
  throw new Error("session-owl log backend not initialized yet (record dropped)");
}

setDefaultBackend({
  adapter: {
    read(path) {
      if (realFs === null) return Promise.reject(rejecting());
      return realFs.read(translate(path));
    },
    write(path, text) {
      if (realFs === null) return Promise.reject(rejecting());
      return realFs.write(translate(path), text);
    },
    list(dir) {
      if (realFs === null) return Promise.reject(rejecting());
      return realFs.list(translate(dir));
    },
    stat(path) {
      if (realFs === null) return Promise.reject(rejecting());
      if (realFs.stat === undefined) {
        // the surface carries no identity authority — reject so the library
        // disables its read-skip guard (freshness never rests on a lie)
        return Promise.reject(new Error("session-owl log surface: no stat — ring retention disabled"));
      }
      return realFs.stat(translate(path));
    },
  },
  baseDir: SENTINEL_BASE_DIR,
  // the stable closure: writers created at module load (long before the
  // host's clock seam lands) resolve the window timer at ARM time — and
  // while the seam is not installed yet it THROWS, which the writer's
  // catch treats as "no authority": every line flushes immediately
  // (pre-init semantics), not into an armed void that never fires
  schedule: (ms, fn) => {
    if (hostSchedule === null) throw new Error("session-owl log window timer not installed yet");
    return hostSchedule(ms, fn);
  },
});

/** Wire the destination: configDir + the fs surface (idempotent per session). */
export function initLogConsumer(init: { configDir: string; fs: LogFsSurface; schedule: ScheduleFn | null }): void {
  realRoot = `${init.configDir.replace(/\/+$/, "")}/logs`;
  realFs = init.fs;
  hostSchedule = init.schedule;
}

/** Whether the destination has landed (the console fallback keys off this). */
export function logConsumerReady(): boolean {
  return realFs !== null;
}

/** Test seam: the installed backend (assertions over the sentinel + adapter). */
export function testBackend(): {
  baseDir: string;
  adapter: NonNullable<ReturnType<typeof getDefaultBackend>>["adapter"];
} {
  const backend = getDefaultBackend();
  if (backend === null) throw new Error("log consumer: backend unexpectedly absent");
  return backend;
}

/** Test seam: full reset (pre-init state). */
export function _resetLogConsumerForTest(): void {
  realRoot = null;
  realFs = null;
  hostSchedule = null;
}
