// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    isolate: false,
    // Absorb CPU-starvation spikes on loaded dev machines (the suite shares the
    // box with live sessions): per-test work is ms-scale, so 30s still catches
    // real hangs while a starved 5s default produced false timeout flakes
    // (mirrors avtc-pi-portrait's timeout).
    testTimeout: 30_000,
    // Centralized module-singleton resets between tests (settings handle/override,
    // GraphStore) — the isolate:false leak fix, mirroring the sibling-repo
    // setupFiles pattern (avtc-pi-portrait / avtc-pi-featyard).
    setupFiles: ["./tests/setup.ts"],
    // Pin the test process to UTC so LOCAL-time renders (timestamps render in
    // the host timezone) are deterministic: stored UTC instants render their
    // UTC clock values. Production is unaffected (no pin) — real users get
    // their own timezone. Node 26 respects TZ on this platform.
    env: { TZ: "UTC" },
  },
});
