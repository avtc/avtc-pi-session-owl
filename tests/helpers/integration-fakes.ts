// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

/** Shared fakes for the end-to-end integration test. Kept here so the test body
 *  stays readable; the agent-loop module mock in the test delegates to a script
 *  set per scenario via `vi.mocked(runStage).mockImplementation`. */

import type { StageRunResult } from "../../src/runtime/agent-loop.js";

/** A no-op result (no messages, zero usage). The default script. */
export const EMPTY_RESULT: StageRunResult = {
  messages: [],
  usage: { input: 0, output: 0, cacheRead: 0, cost: 0, turns: 1 },
  streamingOutputTokens: 0,
  aborted: false,
};
