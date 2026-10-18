// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// The bootstrap read plan: how a transcript gets read per surface. Within
// the read cap every surface reads whole (the direct path); over it the CLI
// streams through the Node helper ($.process), and a non-CLI surface is
// BLOCKED with the ladder hint (self-heals at the next CLI open, or the
// user runs the script — documented from /owl-status) while the readable
// backlog is still observed (rung 4: degrade and log).
export interface BootstrapPlan {
  read: "direct" | "helper" | "blocked";
  /** The /owl-status hint while blocked (null when not blocked). */
  statusHint: "await-cli-open" | "user-run-script" | null;
  /** Rung 4 semantics: observe the readable backlog, keep the rest pending. */
  degraded: boolean;
}

import { READ_CAP } from "./transcript-reader.js";

export function planBootstrap(input: { byteSize: number | "unknown"; canRunProcess: boolean }): BootstrapPlan {
  if (input.byteSize === "unknown" || input.byteSize <= READ_CAP) {
    return { read: "direct", statusHint: null, degraded: false };
  }
  if (input.canRunProcess) {
    // CLI: the helper streams the file without loading it
    return { read: "helper", statusHint: null, degraded: false };
  }
  // Non-CLI over the cap: the ladder — auto at the next CLI open (rung 1),
  // the user-run script documented from /owl-status (rung 2), MCP deferred
  // (rung 3, not built), and meanwhile observe the readable (rung 4)
  return { read: "blocked", statusHint: "await-cli-open", degraded: true };
}
