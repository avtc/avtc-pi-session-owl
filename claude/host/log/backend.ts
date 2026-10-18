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

import { getDefaultBackend, setDefaultBackend } from "../../node_modules/avtc-claude-logger/dist/index.js";

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

/** The minimal fs surface the slot ring needs (the wiring passes the bridge's). */
export interface LogFsSurface {
  read(path: string): Promise<string>;
  write(path: string, text: string): Promise<void>;
  list(dir: string): Promise<ReadonlyArray<{ name: string; kind: string; size: number; mtimeMs: number }>>;
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
  },
  baseDir: SENTINEL_BASE_DIR,
});

/** Wire the destination: configDir + the fs surface (idempotent per session). */
export function initLogConsumer(init: { configDir: string; fs: LogFsSurface }): void {
  realRoot = `${init.configDir.replace(/\/+$/, "")}/logs`;
  realFs = init.fs;
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
}
