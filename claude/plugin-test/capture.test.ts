// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// Engine-kit twin of the capture suite: the pure grouper + the capture body
// loaded from the plugin's own tree under the hooks-environment import rules
// (relative own-file paths only — no bare specifiers at runtime). The
// full table-driven corpus lives in the Node suite; this twin pins the
// door-table contract and the owl-spawn skip under the real kit loader.
import { describe, expect, test } from "claude-code/testing";
import { captureAppend, ensureCapture } from "../host/capture/append-handler.js";
import type { ClaudeRow } from "../host/capture/grouper.js";
import { groupRows } from "../host/capture/grouper.js";
import { createMemoryFs } from "../host/storage/fs-adapter.js";
import { MirrorWriter } from "../host/storage/mirror.js";

function row(uuid: string, over: Partial<ClaudeRow> = {}): ClaudeRow {
  return {
    uuid,
    parentUuid: null,
    door: "prompt",
    origin: { kind: "composer" },
    message: { type: "user", content: [{ type: "text", text: `row ${uuid}` }] },
    ...over,
  };
}

describe("capture pipeline — engine-run twin", () => {
  test("the door table holds: prompt user, plugin split, unknown door skipped", () => {
    const entries = groupRows([
      row("u1"),
      {
        ...row("p1"),
        door: "note",
        origin: { kind: "plugin", plugin: "other-mod" },
        message: { type: "user", content: [{ type: "text", text: "plugin append" }] },
      },
      { ...row("k1"), door: "hook-context" },
      { ...row("z1"), door: "future-door" },
    ]) as Array<{ type: string; message?: { role: string; content: unknown } }>;
    expect(entries).toHaveLength(2);
    expect(entries[0]?.type).toBe("message");
    expect(entries[0]?.message?.role).toBe("user");
    expect(entries[1]?.type).toBe("custom_message");
  });

  test("owl-spawn loops are skipped; real rows land in cache + mirror buffer", () => {
    const fs = createMemoryFs().adapter;
    const mirrorFor = (key: string): MirrorWriter => new MirrorWriter(fs, `/sess/${key}`, `kit-${key}`);
    const isOwl = (agentId: string | undefined) => agentId === "owl-x";
    expect(captureAppend("s1", row("u1"), mirrorFor, isOwl)).toBe(true);
    expect(captureAppend("s1", { ...row("o1"), agentId: "owl-x" }, mirrorFor, isOwl)).toBe(false);
    const cap = ensureCapture("s1", mirrorFor);
    expect(cap.rowCache.size).toBe(1);
    expect(cap.pending).toEqual(["u1"]);
    expect(cap.mirror.pendingRows()).toHaveLength(1);
  });
});
