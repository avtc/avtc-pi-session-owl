// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

/**
 * Root memkeeper logger.
 *
 * Thin wrapper over the shared `avtc-pi-logger` library. The implementation
 * (file backend, rotation, retention, level formatting) lives in the library;
 * this module only owns the memkeeper singleton.
 *
 * Logs land at `~/.pi/logs/avtc-pi-memkeeper/<YYYY-MM-DD>.log` (date-partitioned,
 * with size roll-over + age-based retention — all handled by the library).
 * Best-effort: a logging failure never throws to the host.
 */

import { createLogger } from "avtc-pi-logger";

/** No custom logger options — use library defaults. */
const NO_LOGGER_OPTIONS: Parameters<typeof createLogger>[1] = null;

/** Root memkeeper logger — writes to ~/.pi/logs/avtc-pi-memkeeper/<date>.log (best-effort). */
export const log = createLogger("avtc-pi-memkeeper", NO_LOGGER_OPTIONS);
