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

/** Root memkeeper logger. `debug` honors the live `debugLog` setting. */
export const log = {
  info: (msg: string) => baseLogger.info(msg),
  warn: (msg: string) => baseLogger.warn(msg),
  error: (msg: string, err?: unknown) => baseLogger.error(msg, err),
  debug: (msg: string) => {
    if (getMemkeeperSettings().debugLog) baseLogger.debug(msg);
  },
};
