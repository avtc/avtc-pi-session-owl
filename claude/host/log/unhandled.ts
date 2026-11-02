// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import { log } from "../../core/src/log.js";
import { errDetail } from "./err-detail.js";

/** The last-resort net: any rejection the module's
 *  own code paths let slip — a floating promise nobody awaited — reaches the
 *  process-level unhandledRejection hook and is written to the file log WITH
 *  its stack, so the next live fault leaves evidence instead of the engine's
 *  transient "mod .catch" warning. The uncaughtException arm covers the
 *  synchronous twin (a throw inside an engine-invoked callback kills the
 *  hooks worker with no trace); logging it and continuing keeps the owl
 *  alive with the kill-site on record. Installed once per module load; a
 *  sandbox without `process.on` simply keeps it off (the per-site guarded()
 *  calls still cover the known floating paths). */
export function installUnhandledRejectionLogging(): void {
  try {
    const proc = (
      globalThis as {
        process?: {
          on?: (name: string, fn: (reason: unknown) => void) => unknown;
          removeListener?: (name: string, fn: (reason: unknown) => void) => unknown;
        };
      }
    ).process;
    if (proc === undefined || typeof proc.on !== "function") return;
    const onRejection = (reason: unknown): void => {
      try {
        log.warn(`unhandled rejection (process net): ${errDetail(reason)}`);
      } catch {
        // the pre-init stub drops the record — the next one will carry it
      }
    };
    const onUncaught = (err: unknown): void => {
      try {
        log.warn(`uncaught exception (process net — the worker survived): ${errDetail(err)}`);
      } catch {
        // same stub rule as the rejection arm
      }
    };
    proc.on("unhandledRejection", onRejection);
    // a module reload in the same worker must not stack handlers: the
    // previous install's handler rides globalThis (module state resets on
    // reload, the global does not)
    const g = globalThis as { __owlPrevUncaught?: (err: unknown) => void };
    if (g.__owlPrevUncaught !== undefined && typeof proc.removeListener === "function") {
      proc.removeListener("uncaughtException", g.__owlPrevUncaught);
    }
    g.__owlPrevUncaught = onUncaught;
    proc.on("uncaughtException", onUncaught);
  } catch {
    // no process object in this sandbox — the per-site guards remain
  }
}
