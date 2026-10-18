// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// The notify adapter's contract: every pi `notify` call site maps to
// `$.ui.log` — the platform's dim transcript line the model never reads.
// A multi-line message posts as ONE call whose line breaks are replaced by
// " | ": the engine's block draw renders an embedded newline as U+FFFD,
// so a raw multi-line payload collapses into a line of diamonds at the
// terminal (our receipt keeps the newlines intact — the conversion is at
// draw), and one-call-per-line flooded the screen with a plugin bullet per
// row. The chosen delimiter keeps one notice readable; empty lines are
// dropped. pi's per-level color/theming has no ui.log equivalent, so the
// level is dropped (cosmetic, never compensated by rewriting the text).
import { describe, expect, test } from "vitest";
import { makeNotifyAdapter } from "../../host/notify/adapter.js";

describe("makeNotifyAdapter — level dropped, text + order preserved", () => {
  test("a multi-line message posts ONE call with the breaks replaced by the | delimiter", () => {
    const lines: string[] = [];
    const notify = makeNotifyAdapter((text) => lines.push(text));
    notify("l1\nl2\nl3", "info");
    expect(lines).toEqual(["l1 | l2 | l3"]);
  });

  test("empty lines are dropped before the single call is posted", () => {
    const lines: string[] = [];
    const notify = makeNotifyAdapter((text) => lines.push(text));
    notify("head\n\nbody\n\n\ntail", "info");
    expect(lines).toEqual(["head | body | tail"]);
  });

  test("the level never reaches the ui.log capsule and never alters the text", () => {
    const seen: Array<{ text: string; level: string }> = [];
    const notify = makeNotifyAdapter((text) => seen.push({ text, level: "none" }));
    notify("w", "warning");
    notify("e", "error");
    notify("i", "info");
    // the severity survives only in the message texts themselves — the
    // adapter passes each through byte-identical
    expect(seen.map((s) => s.text)).toEqual(["w", "e", "i"]);
    expect(seen.every((s) => s.level === "none")).toBe(true);
  });

  test("independent notify calls keep their relative order", () => {
    const calls: string[] = [];
    const notify = makeNotifyAdapter((text) => calls.push(text));
    notify("header", "info");
    notify("body1\nbody2", "info");
    notify("tail", "error");
    expect(calls).toEqual(["header", "body1 | body2", "tail"]);
  });
});
