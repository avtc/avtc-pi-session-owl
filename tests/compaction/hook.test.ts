// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// Stub-guard: verifies the T7 compactionHook returns undefined (Pi native
// compaction). T14 replaces the stub with the real ensure-ready gate + render and
// replaces this test with the real suite.

import type { ExtensionAPI, ExtensionContext, SessionBeforeCompactEvent } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { compactionHook } from "../../src/compaction/hook.js";

describe("compactionHook stub (T7; T14 replaces)", () => {
  it("resolves to undefined (Pi native compaction)", async () => {
    const result = await compactionHook(
      { type: "session_before_compact" } as unknown as SessionBeforeCompactEvent,
      {} as unknown as ExtensionContext,
      {} as unknown as ExtensionAPI,
    );
    expect(result).toBeUndefined();
  });
});
