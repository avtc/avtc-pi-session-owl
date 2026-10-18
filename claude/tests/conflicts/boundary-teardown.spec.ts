// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// The claude-host file boundary: specs share one module registry
// (isolate: false), so a finished spec must not leave host singletons
// armed behind it — conflict hits leak into every pause-gated branch,
// an installed settings handle keeps the FIRST harness's fs/env
// closures, and armed bridge services keep the LAST dispatch's `$`
// capsules. This guard pins the boundary reset the suite relies on.
import { describe, expect, test } from "vitest";
import { getConflictHits, setConflictHits } from "../../host/conflicts/pause.js";
import { currentServices } from "../../host/engine-bridge.js";
import { getInstalledSettingsHandle } from "../../host/settings/consumer.js";
import { createHarness } from "../helpers/harness.js";
import { resetClaudeHostSingletons } from "../helpers/host-teardown.js";

describe("claude-host file-boundary teardown", () => {
  test("armed conflict hits clear at the boundary", async () => {
    setConflictHits([{ channel: "B", name: "other-mod@x", evidence: "teardown-guard" }]);
    expect(getConflictHits()).not.toBeNull();
    await resetClaudeHostSingletons();
    expect(getConflictHits()).toBeNull();
  });

  test("an installed settings handle and armed bridge services clear at the boundary", async () => {
    const h = createHarness();
    await h.load();
    h.env.set("CLAUDE_CONFIG_DIR", "/cfg");
    await h.dispatch("classic.SessionStart", {
      source: "startup",
      session_id: "s-teardown",
      transcript_path: "/t.jsonl",
      cwd: "/w",
    });
    expect(getInstalledSettingsHandle()).not.toBeNull();
    expect(() => currentServices()).not.toThrow();
    await resetClaudeHostSingletons();
    expect(getInstalledSettingsHandle()).toBeNull();
    expect(() => currentServices()).toThrow(/before any handler armed the bridge/);
  });
});
