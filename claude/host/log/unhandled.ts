// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import { log } from "../../core/src/log.js";
import { errDetail } from "./err-detail.js";

/** The last-resort net: any rejection the module's
 *  own code paths let slip — a floating promise nobody awaited — reaches the
 *  process-level unhandledRejection hook and is written to the file log WITH
 *  its stack, so the next live fault leaves evidence instead of the engine's
 *  transient "mod .catch" warning. Installed once per module load; a sandbox
 *  without `process.on` simply keeps it off (the per-site guarded() calls
 *  still cover the known floating paths). */
export function installUnhandledRejectionLogging(): void {
  try {
    const proc = (globalThis as { process?: { on?: (name: string, fn: (reason: unknown) => void) => unknown } })
      .process;
    if (proc === undefined || typeof proc.on !== "function") return;
    proc.on("unhandledRejection", (reason: unknown) => {
      try {
        log.warn(`unhandled rejection (process net): ${errDetail(reason)}`);
      } catch {
        // the pre-init stub drops the record — the next one will carry it
      }
    });
  } catch {
    // no process object in this sandbox — the per-site guards remain
  }
}
