// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import { describe, expect, it } from "vitest";
import { stripAnsi } from "../../src/format/sanitize.js";

describe("stripAnsi", () => {
  it("returns plain text unchanged", () => {
    expect(stripAnsi("hello world")).toBe("hello world");
  });

  it("returns an empty string unchanged", () => {
    expect(stripAnsi("")).toBe("");
  });

  it("strips CSI SGR color sequences (16-color)", () => {
    // the common "\x1b[31m" red-on / "\x1b[0m" reset pair
    expect(stripAnsi("\x1b[31merror\x1b[0m")).toBe("error");
  });

  it("strips 24-bit color sequences with ':' params (e.g. \x1b[38:2::r:g:b)", () => {
    expect(stripAnsi("\x1b[38:2:255:0:0mred\x1b[0m")).toBe("red");
  });

  it("strips cursor-move and line-clear sequences", () => {
    // \x1b[2K clear-line + \x1b[1;1H cursor-home
    expect(stripAnsi("\x1b[2K\x1b[1;1Hdone")).toBe("done");
  });

  it("strips private-mode sequences (the '?' prefix)", () => {
    // \x1b[?25l hide-cursor
    expect(stripAnsi("\x1b[?25lworking\x1b[?25h")).toBe("working");
  });

  it("strips OSC sequences terminated by BEL (terminal titles)", () => {
    // \x1b]0;title\x07
    expect(stripAnsi("\x1b]0;my title\x07body")).toBe("body");
  });

  it("strips OSC sequences terminated by the String Terminator (ESC \\)", () => {
    // \x1b]8;;https://example.com\x1b\\link\x1b]8;;\x1b\\
    expect(stripAnsi("\x1b]8;;https://example.com\x1b\\link\x1b]8;;\x1b\\")).toBe("link");
  });

  it("strips the 8-bit control introducer (\\x9b) form", () => {
    // \x9b31m is the 8-bit form of \x1b[31m
    expect(stripAnsi("\x9b31merror\x9b0m")).toBe("error");
  });

  it("strips an embedded ANSI-colored 'Thinking:' prefix from a thinking block", () => {
    // the live pattern observed in session JSONL: ANSI codes wrap the prefix
    const raw = "\x1b[36mThinking:\x1b[0m let me analyze this";
    expect(stripAnsi(raw)).toBe("Thinking: let me analyze this");
  });

  it("leaves surrounding content intact when stripping mid-string escapes", () => {
    expect(stripAnsi("before\x1b[1mbold\x1b[22mafter")).toBe("beforeboldafter");
  });
});
