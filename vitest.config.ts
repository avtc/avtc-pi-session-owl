// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// The drift gate's semantic half: the SAME pi suites run twice — once against
// src/ (pi parity baseline, project "pi-src") and once against the vendored
// byte-copies in claude/core/ (project "core-vendored", its ../src/** import
// specifiers re-pointed by the regex alias below).
//
// IMPORTANT: inline test.projects entries do NOT inherit root-level test
// options (each gets its own Vite server with configFile:false) — every
// option that matters (setupFiles, isolate, testTimeout, include) is stated
// IN EACH project. The shared setup file is what makes isolate:false safe:
// it redirects the real avtc-pi-logger to a no-op sink (tests must never
// write the production log file) and resets module singletons per file.
//
// core-vendored EXCLUDES (test files whose ../src imports reach modules that
// are NOT vendored — the sync's HOST_SET / host-by-closure files): lifecycle,
// widget (tracker/render/wiring), commands, compaction/hook, observer/run,
// builder/run, selector/run + selector/input-view (host-by-closure),
// goal-extract/run, status/command, conflicts/pause, todo/wiring, index
// (re-export root), integration (drives the host entry), activation
// (dynamically imports the host entry), and conflicts/detect (research-1
// listed its suite host-free, but the plan hosts conflicts/detect.ts itself
// — the file is not in claude/core/, so the suite cannot run against it).
const CORE_ALIAS = {
  find: /^(\.\.\/)+src\//,
  replacement: fileURLToPath(new URL("./claude/core/src/", import.meta.url)),
};

const SHARED = {
  isolate: false,
  // Absorb CPU-starvation spikes on loaded dev machines (the suite shares the
  // box with live sessions): per-test work is ms-scale, so 30s still catches
  // real hangs while a starved 5s default produced false timeout flakes
  // (mirrors avtc-pi-portrait's timeout). The SAME rationale covers the
  // beforeAll hooks (default hookTimeout 10s): the heavy suites re-import the
  // whole host graph through resetModules + doMock (the isolate:false mock
  // convention), and that import is transform+CPU bound — under the full
  // 12-gate parallel load it crossed 10s while staying ~1.5s standalone.
  testTimeout: 30_000,
  hookTimeout: 30_000,
  setupFiles: ["./tests/setup.ts"],
};

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    // Pin the test process to UTC so LOCAL-time renders (timestamps render in
    // the host timezone) are deterministic: stored UTC instants render their
    // UTC clock values. Production is unaffected (no pin) — real users get
    // their own timezone. Node 26 respects TZ on this platform.
    env: { TZ: "UTC" },
    projects: [
      {
        test: {
          name: "pi-src",
          include: ["tests/**/*.test.ts"],
          ...SHARED,
        },
      },
      {
        test: {
          name: "claude-host",
          include: ["claude/tests/**/*.spec.ts"],
          ...SHARED,
          // The claude-host boundary reset rides as a SECOND setup file
          // (the shared pi setup stays first — it redirects the logger):
          // with isolate:false the specs share one module registry, so an
          // afterAll here clears the host singletons between files even
          // when a spec forgets its own teardown.
          setupFiles: ["./tests/setup.ts", "./claude/tests/helpers/setup-claude.ts"],
        },
      },
      {
        test: {
          name: "core-vendored",
          ...SHARED,
          // The regex-timeout pins drive genuinely catastrophic patterns:
          // the core's worker kills them mid-string at ~1s, but the closure
          // bans worker_threads — the vendored regex seam swaps to the host
          // sandbox (claude-sync rewrite table), which cannot interrupt a
          // backtracking test IN flight. Its per-string deadline + after-run
          // conversion surface the SAME timeout outcome once the runaway
          // string yields (~20s standalone, 30-60s under the 14-gate load),
          // so this project carries a wider test cap instead of skipping the
          // pins (the sandbox contract itself is also pinned in
          // claude/tests/graph/regex-sandbox.spec.ts).
          testTimeout: 120_000,
          // Every suite whose ../src import closure (imports, vi.mock and
          // vi.doMock targets included) lands entirely in claude/core/. New
          // suites are added here as their closures qualify; the exclusion
          // comment above names what stays out and why.
          include: [
            "tests/graph/mutations.test.ts",
            "tests/graph/invariants.test.ts",
            "tests/graph/safe-regex.test.ts",
            "tests/graph/replay.test.ts",
            "tests/graph/regex-runner.test.ts",
            "tests/graph/clone.test.ts",
            "tests/graph/result-render.test.ts",
            "tests/graph/result-budget.test.ts",
            "tests/graph/read-tools.test.ts",
            "tests/format/chunk.test.ts",
            "tests/format/render.test.ts",
            "tests/format/render-agent-messages.test.ts",
            "tests/format/tokens.test.ts",
            "tests/format/sanitize.test.ts",
            "tests/format/details.test.ts",
            "tests/compaction/touched-files.test.ts",
            "tests/compaction/usage-map.test.ts",
            "tests/compaction/summary.test.ts",
            "tests/debug-dump.test.ts",
            "tests/store/codecs.test.ts",
            "tests/store/graph-store.test.ts",
            "tests/runtime/run-lock.test.ts",
            "tests/runtime/streaming-tokens.test.ts",
            "tests/runtime/session-affinity.test.ts",
            "tests/runtime/ledger-hook.test.ts",
            "tests/runtime/convergence.test.ts",
            "tests/runtime/agent-loop.test.ts",
            "tests/status/usage-ledger.test.ts",
            "tests/types.test.ts",
            "tests/todo/bridge.test.ts",
            "tests/prompts/builder.test.ts",
            "tests/prompts/root-shape.test.ts",
            "tests/prompts/observer.test.ts",
            "tests/prompts/selector.test.ts",
            "tests/builder/tools.test.ts",
            "tests/config/schema.test.ts",
            "tests/log.test.ts",
            "tests/schema.test.ts",
            "tests/config/docs-parity.test.ts",
            "tests/triggers.test.ts",
            "tests/recall/mk-recall.test.ts",
          ],
        },
        resolve: {
          alias: [
            CORE_ALIAS,
            // The sync table rewrites the vendored core's bare pi-ai/pi-tui
            // VALUE imports to the local shims (the hooks closure refuses
            // bare specifiers). This project runs pi's OWN suites over the
            // vendored bytes, and those suites exercise the render paths the
            // platform never calls — alias the shim specifiers BACK to the
            // real packages so the tested behavior stays pi-tui/pi-ai's own
            // (the same real-package-under-Node principle the remaining
            // bare type imports follow; the shims themselves are pinned in
            // claude/plugin-test/shims.test.ts for the packaged env).
            {
              find: /^(?:\.\.\/)+shims\/pi-ai\/index\.js$/,
              replacement: fileURLToPath(
                new URL("./node_modules/@earendil-works/pi-ai/dist/utils/typebox-helpers.js", import.meta.url),
              ),
            },
            {
              find: /^(?:\.\.\/)+shims\/pi-tui\/index\.js$/,
              replacement: fileURLToPath(
                new URL("./node_modules/@earendil-works/pi-tui/dist/index.js", import.meta.url),
              ),
            },
          ],
        },
      },
    ],
  },
});
