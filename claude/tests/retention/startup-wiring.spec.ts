// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// The startup mirror-retention sweep — the S5 read path: the classic
// SessionStart backfill plans the prune helper from the LIVE settings
// (mirrorRetentionDays), runs it on CLI surfaces via $.process.run, and
// never lets a retention failure block the start sequence.

import { beforeEach, describe, expect, test } from "vitest";
import { _resetSettingsConsumerForTest } from "../../host/settings/consumer.js";
import { createHarness } from "../helpers/harness.js";

describe("the startup retention sweep", () => {
  let h: ReturnType<typeof createHarness>;
  beforeEach(() => {
    _resetSettingsConsumerForTest();
    h = createHarness();
  });

  test("mirrorRetentionDays set → the prune helper runs with --days on the CLI surface", async () => {
    await h.load();
    h.env.set("CLAUDE_CONFIG_DIR", "/cfg");
    h.env.set("CLAUDE_SETTINGS_SESSION_OWL", JSON.stringify({ mirrorRetentionDays: 30 }));
    await h.dispatch("classic.SessionStart", {
      source: "startup",
      session_id: "s-prune-1",
      transcript_path: "/t.jsonl",
      cwd: "/w",
    });
    expect(h.processRuns.length).toBe(1);
    const argv = h.processRuns[0];
    expect(argv[0]).toContain("node"); // the node binary fronts the helper
    expect(argv[1]).toContain("/owl/helpers/prune.mjs"); // $.plugin.root-derived
    expect(argv).toContain("--days");
    expect(argv).toContain("30");
    expect(argv).toContain("--apply");
  });

  test("the keep-forever default (no field) → the sweep stays opted out", async () => {
    await h.load();
    h.env.set("CLAUDE_CONFIG_DIR", "/cfg");
    await h.dispatch("classic.SessionStart", {
      source: "startup",
      session_id: "s-prune-2",
      transcript_path: "/t.jsonl",
      cwd: "/w",
    });
    expect(h.processRuns.length).toBe(0);
  });
});
