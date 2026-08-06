// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

/**
 * Root memkeeper logger.
 *
 * Thin wrapper over the shared `avtc-pi-logger` library. The implementation
 * (file backend, rotation, retention, level formatting) lives in the library;
 * this module only owns the memkeeper singleton + the live `debugLog` gate.
 *
 * Logs land at `~/.pi/logs/avtc-pi-memkeeper/<YYYY-MM-DD>.log` (date-partitioned,
 * with size roll-over + age-based retention — all handled by the library).
 * Best-effort: a logging failure never throws to the host.
 *
 * `debug` honors the live `debugLog` setting (read each call, so toggling it in
 * /mk:settings takes effect immediately, no restart). `info`/`warn`/`error`
 * always write. The library logger itself is created with debug enabled; this
 * module gates `.debug` so the setting can flip without recreating the logger.
 */

import { createLogger } from "avtc-pi-logger";
import { getMemkeeperSettings } from "./config/schema.js";

/** Library logger created with debug-level enabled; memkeeper gates `.debug`. */
const LOGGER_OPTIONS: Parameters<typeof createLogger>[1] = { debug: true };

const baseLogger = createLogger("avtc-pi-memkeeper", LOGGER_OPTIONS);

/** The methods memkeeper's logger wrapper actually uses. */
type LogSink = Pick<typeof baseLogger, "info" | "warn" | "error" | "debug">;

// `current` lets a test seam redirect calls (observe `.debug` without writing to
// the real log file); defaults to the real baseLogger.
let current: LogSink = baseLogger;

/** Test-only: swap the underlying logger sink (pass `null` to restore the real
 *  one). Returns the previous sink so a test can restore it. */
export function _setBaseLoggerForTest(replacement: LogSink | null): LogSink {
  const prev = current;
  current = replacement ?? baseLogger;
  return prev;
}

/** Root memkeeper logger. `debug` honors the live `debugLog` setting. */
export const log = {
  info: (msg: string) => current.info(msg),
  warn: (msg: string) => current.warn(msg),
  error: (msg: string, err?: unknown) => current.error(msg, err),
  debug: (msg: string) => {
    if (getMemkeeperSettings().debugLog) current.debug(msg);
  },
};
