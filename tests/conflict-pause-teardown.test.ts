// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

/**
 * The isolate:false teardown invariant, checked at the file boundary: the
 * conflict-pause singleton is process-global (the real src/index.ts activation
 * writes it; the status + widget gates read it live), and this suite shares one
 * module registry across files. A file that leaves hits set turns every later
 * file's conflict gate dormant — the /owl:status error path then notifies
 * "info" (the paused report) instead of "error". tests/setup.ts's per-file
 * afterAll clears the CURRENT registry instance; this file asserts that at its
 * own start so a regression of that reset surfaces as this failure rather
 * than as a random one elsewhere (it pairs after whichever file the worker
 * handed it — a failing run means: predecessor leaked AND the boundary missed).
 */

import { expect, it } from "vitest";
import { getConflictHits } from "../src/conflicts/pause.js";

it("the preceding file's teardown left no conflict-pause state behind", () => {
  expect(getConflictHits()).toBeNull();
});
