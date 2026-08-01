// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// Shared ui.notify wrapper. Pure delegation to ctx.ui.notify so every stage
// (Observer/Builder/Selector/compaction hook) surfaces user notifications the
// same way; owning it once avoids per-module duplication (the run modules + the
// compaction hook all call this).

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

/** Surface a user notification through the host UI. */
export function notify(ctx: ExtensionContext, message: string, level: "warning" | "info"): void {
  ctx.ui.notify(message, level);
}
