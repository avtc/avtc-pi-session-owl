// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// The compaction run anchor: the last content row before the command zone
// (the fork base). Command-invocation rows (the slash echo, the caveat, the
// command-name and stdout wrappers) are the rows the engine side-branches
// when a command is canceled and re-issued — a record anchored at one dies
// with it. The anchor picks the nearest row that is none of those.
import { describe, expect, test } from "vitest";
import type { MirroredRow } from "../../host/storage/mirror.js";
import { compactionRunAnchorFrom, isCommandZoneRow } from "../../host/storage/store-context.js";

function engineRow(
  uuid: string,
  text: string,
  extra: { isMeta?: boolean; door?: string; role?: string } = {},
): MirroredRow {
  return {
    uuid,
    parentUuid: null,
    row: {
      message: {
        type: extra.role === "assistant" ? "message" : "message",
        role: extra.role ?? "user",
        ...(extra.isMeta === true ? { isMeta: true } : {}),
        content: [{ type: "text", text }],
      },
      door: extra.door ?? "note",
      origin: { kind: "engine" },
      uuid,
      timestamp: "2026-11-05T12:00:00.000Z",
    },
  };
}

describe("isCommandZoneRow", () => {
  test("the slash-command echo rows are command zone (the /compact invocation itself)", () => {
    expect(isCommandZoneRow(engineRow("a", "/compact"))).toBe(true);
    expect(isCommandZoneRow(engineRow("b", "/compact /owl-settings"))).toBe(true);
  });

  test("the caveat, command-name and stdout wrapper rows are command zone", () => {
    expect(
      isCommandZoneRow(
        engineRow("a", "<local-command-caveat>The command below was run directly in Claude Code…", {
          isMeta: true,
        }),
      ),
    ).toBe(true);
    expect(isCommandZoneRow(engineRow("b", "<command-name>/compact</command-name>\n<command-message>compact…"))).toBe(
      true,
    );
    expect(isCommandZoneRow(engineRow("c", "<local-command-stdout>(no content)</local-command-stdout>"))).toBe(true);
  });

  test("rows carrying the command door are command zone regardless of text", () => {
    expect(isCommandZoneRow(engineRow("a", "some text", { door: "command" }))).toBe(true);
  });

  test("real conversation rows are NOT command zone", () => {
    expect(isCommandZoneRow(engineRow("a", "hello, please continue"))).toBe(false);
    expect(isCommandZoneRow(engineRow("b", "No response requested.", { role: "assistant" }))).toBe(false);
    expect(
      isCommandZoneRow(
        engineRow("c", "what about /compact inside a longer sentence the user typed?", { role: "user" }),
      ),
    ).toBe(false);
  });

  test("a row with no recognizable message shape is command zone (walk back, never forward)", () => {
    const bare: MirroredRow = { uuid: "a", parentUuid: null, row: { type: "system" } };
    expect(isCommandZoneRow(bare)).toBe(true);
  });
});

describe("compactionRunAnchorFrom", () => {
  const content = engineRow("content-1", "the last real message");
  const caveat = engineRow("caveat-1", "<local-command-caveat>The command below…", { isMeta: true });
  const cmdName = engineRow("cmd-1", "<command-name>/exit</command-name>");
  const stdout = engineRow("stdout-1", "<local-command-stdout>(no content)</local-command-stdout>");
  const compactEcho = engineRow("compact-1", "/compact");

  test("walks back past the whole command zone to the last content row", () => {
    const rows = new Map([content, caveat, cmdName, stdout, compactEcho].map((r) => [r.uuid, r]));
    const anchor = compactionRunAnchorFrom(["content-1", "caveat-1", "cmd-1", "stdout-1", "compact-1"], (u) =>
      rows.get(u),
    );
    expect(anchor).toBe("content-1");
  });

  test("a queued re-issue: two command zones back to back still land on the content row", () => {
    const rows = new Map([content, caveat, compactEcho].map((r) => [r.uuid, r]));
    const anchor = compactionRunAnchorFrom(["content-1", "caveat-1", "compact-1"], (u) => rows.get(u));
    expect(anchor).toBe("content-1");
  });

  test("a mirror with only command-zone rows (degenerate fresh session) anchors at null", () => {
    const rows = new Map([compactEcho].map((r) => [r.uuid, r]));
    expect(compactionRunAnchorFrom(["compact-1"], (u) => rows.get(u))).toBeNull();
    expect(compactionRunAnchorFrom([], () => undefined)).toBeNull();
  });

  test("a mirror ending on plain content anchors at that row (no command zone at all)", () => {
    const rows = new Map([content].map((r) => [r.uuid, r]));
    expect(compactionRunAnchorFrom(["content-1"], (u) => rows.get(u))).toBe("content-1");
  });
});
