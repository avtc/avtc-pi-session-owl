// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// The closure-safe pause line: the widget's conflict-pause line formatted
// for the band (the AbovePrompt hook draws it). The full theme-painted
// formatter lives Node-side (widget/render.ts — it imports the vendored
// core's token formatter); this module carries the SAME degradation ladder
// data-only so the hooks closure can load it (band.ts's rule: imports
// nothing at all beyond width math).
import { describe, expect, test } from "vitest";
import { formatPauseLine } from "../../host/widget/pause-line.js";

describe("widget pause line — the closure-safe formatter", () => {
  test("the full line names everyone and points at the status command", () => {
    const line = formatPauseLine(["evil-mod", "later-mod"], 80);
    expect(line).toBe("🦉 ⚠ paused — evil-mod, later-mod also handle compaction (/owl-status)");
  });

  test("singular verb for one name", () => {
    expect(formatPauseLine(["evil-mod"], 80)).toBe("🦉 ⚠ paused — evil-mod also handles compaction (/owl-status)");
  });

  test("narrow width degrades: +N more, then the verb drops, then ellipsis — the hint survives", () => {
    const two = formatPauseLine(["evil-mod", "later-mod"], 67);
    expect(two).toBe("🦉 ⚠ paused — evil-mod, +1 more also handle compaction (/owl-status)");
    const narrower = formatPauseLine(["evil-mod", "later-mod"], 60);
    expect(narrower).toBe("🦉 ⚠ paused — evil-mod, +1 more (/owl-status)");
    const tiny = formatPauseLine(["a-very-long-mod-name-here"], 40);
    expect(tiny).toContain("…");
    expect(tiny).toContain("(/owl-status)");
  });
});
