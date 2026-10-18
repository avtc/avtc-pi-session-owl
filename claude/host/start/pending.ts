// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { UncoveredRange } from "../../core/src/triggers.js";
// The pending-backlog evaluator: the vendored coverage-union computation
// over the reconstructed branch. Lives in its OWN module because the
// vendored triggers module transitively imports the settings library (a
// bare package specifier the hooks closure refuses — the recorded
// platform gap); the register wiring adopts this evaluator once that gap
// resolves, and the Node suite exercises it directly.
import { computeUncoveredRanges } from "../../core/src/triggers.js";

export type PendingEvaluator = (entries: readonly SessionEntry[], frontier: string | null) => UncoveredRange[];

export const corePendingEvaluator: PendingEvaluator = (entries, frontier) =>
  computeUncoveredRanges(entries as unknown as Parameters<typeof computeUncoveredRanges>[0], frontier);
