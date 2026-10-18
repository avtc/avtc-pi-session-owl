// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// The goal-extraction launch hook: fired exactly once per session, at the
// fresh oInitialPrompt capture. The launcher is a silent no-op until the
// wiring installs the real one (nGoal.summary stays empty and the Builder
// is the backstop — exactly pi's degraded behavior when extraction
// fails).
type GoalExtractLauncher = (verbatim: string, sessionId: string) => void;

let launcher: GoalExtractLauncher = () => {};

/** Install the real launcher (the wiring). */
export function registerGoalExtractLauncher(fn: GoalExtractLauncher): void {
  launcher = fn;
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Fire-and-forget: never throws into the capture path. */
export function launchGoalExtract(verbatim: string, sessionId: string): void {
  try {
    launcher(verbatim, sessionId);
  } catch (err) {
    log.warn(`goal extract launch failed — summary stays empty: ${errText(err)}`);
    // fire-and-forget: a failing extraction leaves the summary empty
  }
}

/** Test seam. */
export function _resetGoalExtractLauncher(): void {
  launcher = () => {};
}

import { log } from "../../core/src/log.js";
