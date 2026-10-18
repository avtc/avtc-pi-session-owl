// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
// The grouper suite: table-driven over the fixture corpus (every door row ->
// expected entry kind/shape), the parallel-batch re-pairing proven through
// the VENDORED renderGroups, and the plugin/compaction dispatch rules.
import { describe, expect, test } from "vitest";
import { isRenderableEntry, renderGroups } from "../../core/src/format/chunk.js";
import { type ClaudeRow, groupRows } from "../../host/capture/grouper.js";

const FIX = join(__dirname, "..", "fixtures", "rows");
function fixture(name: string): ClaudeRow[] {
  return (JSON.parse(readFileSync(join(FIX, `${name}.json`), "utf8")) as { rows: ClaudeRow[] }).rows;
}
type AnyEntry = SessionEntry & {
  message?: { role?: string; content?: unknown; toolCallId?: string; toolName?: string; isError?: boolean };
  customType?: string;
  details?: unknown;
};

/** A minimal row base for hand-built rows (fixtures carry their own). */
function fixtureRowBase(uuid: string, parentUuid: string | null): ClaudeRow {
  return {
    uuid,
    parentUuid,
    door: "prompt",
    origin: { kind: "composer" },
    message: { type: "user", content: [] },
  };
}

describe("grouper — the door table", () => {
  test("doors-basics: every door maps to its entry kind per the table", () => {
    const entries = groupRows(fixture("doors-basics")) as AnyEntry[];
    const shape = entries.map((e) => {
      if (e.type === "message" && e.message?.role === "assistant") return "assistant";
      if (e.type === "message" && e.message?.role === "toolResult") return "toolResult";
      if (e.type === "message") return "user";
      return e.type;
    });
    // prompt -> user; 2 response rows of one API response -> ONE assistant;
    // response-door USER row -> user (the table row covers both prompt and
    // response doors); tool-result -> toolResult; delivery -> user;
    // command -> user (text); attachment/hook-context/notice -> skipped
    expect(shape).toEqual(["user", "assistant", "user", "toolResult", "user", "user"]);
  });

  test("user entries carry the row's text content and ids", () => {
    const entries = groupRows(fixture("doors-basics")) as AnyEntry[];
    const prompt = entries[0];
    expect(prompt?.id).toBe("u-prompt-1");
    expect(prompt?.message?.role).toBe("user");
    expect(prompt?.message?.content).toBe("Read the config and summarize");
    const responseUser = entries[2];
    expect(responseUser?.message?.content).toBe("tool flow continuation");
    const delivery = entries[4];
    expect(delivery?.message?.content).toBe("Peer message: the build finished");
    const command = entries[5];
    expect(command?.message?.content).toBe("report: 3 files changed");
  });

  test("the assistant group merges one API response: thinking + toolCall items in row order", () => {
    const entries = groupRows(fixture("doors-basics")) as AnyEntry[];
    const assistant = entries[1];
    expect(assistant?.id).toBe("u-assistant-1"); // first row's uuid anchors the group
    const content = assistant?.message?.content as Array<{ type: string; thinking?: string; name?: string }>;
    expect(content).toHaveLength(2);
    expect(content[0]).toMatchObject({ type: "thinking", thinking: "Plan: read config first" });
    expect(content[1]).toMatchObject({ type: "toolCall", name: "Read" });
  });

  test("toolResult entries key on tool_use_id, flatten string content, resolve the tool name", () => {
    const entries = groupRows(fixture("doors-basics")) as AnyEntry[];
    const tr = entries[3];
    expect(tr?.message?.role).toBe("toolResult");
    expect(tr?.message?.toolCallId).toBe("call-1");
    expect(tr?.message?.toolName).toBe("Read");
    expect(tr?.message?.content).toEqual([{ type: "text", text: '{\n  "theme": "dark"\n}' }]);
    expect(tr?.message?.isError).toBe(false);
  });
});

describe("grouper — plugin + compaction dispatch", () => {
  test("plugin user appends become custom_message; system skipped; engine notes skipped; isMeta does NOT gate", () => {
    const entries = groupRows(fixture("plugin-and-compaction")) as AnyEntry[];
    const customs = entries.filter((e) => e.type === "custom_message");
    expect(customs).toHaveLength(1);
    expect(customs[0]?.message ?? customs[0]).toMatchObject({
      customType: "claude.plugin.todo-bridge",
      content: "Todos updated: 2 of 5 done",
    });
    // the isMeta:true user append WAS captured (not gated); the system one was not
    expect(JSON.stringify(entries)).not.toContain("notice the model never reads");
    expect(JSON.stringify(entries)).not.toContain("SubagentHandback");
  });

  test("a native compaction row becomes a CompactionEntry — skipped as an observer source", () => {
    const entries = groupRows(fixture("plugin-and-compaction")) as AnyEntry[];
    const compaction = entries.find((e) => e.type === "compaction");
    expect(compaction).toBeDefined();
    expect((compaction?.details as { summary?: string })?.summary).toContain("Native summary");
    expect(isRenderableEntry(compaction as SessionEntry)).toBe(false);
  });

  test("tool-message dispatch: tool_result blocks -> toolResult (isError kept); text -> user", () => {
    const entries = groupRows(fixture("plugin-and-compaction")) as AnyEntry[];
    const tr = entries.find((e) => e.message?.role === "toolResult" && e.message.toolCallId === "call-9");
    expect(tr?.message?.isError).toBe(true);
    expect(tr?.message?.content).toEqual([{ type: "text", text: "failed to write" }]);
    const textUser = entries.find(
      (e) => e.message?.role === "user" && (e.message.content as string).includes("tool-emitted"),
    );
    expect(textUser).toBeDefined();
  });
});

describe("grouper — parallel batch through the VENDORED renderGroups", () => {
  test("three calls pair with their results as adjacent groups (pi adjacency)", () => {
    const rows = fixture("parallel-batch");
    const entries = groupRows(rows);
    // assistant(resp-p) merged: thinking + 3 toolCalls; three toolResults; assistant(resp-p2) text
    const assistant = entries.find((e) => (e as AnyEntry).message?.role === "assistant" && e.id === "p-1") as AnyEntry;
    const content = assistant.message?.content as Array<{ type: string; id?: string }>;
    expect(content.map((c) => c.type)).toEqual(["thinking", "toolCall", "toolCall", "toolCall"]);
    expect(content.filter((c) => c.type === "toolCall").map((c) => c.id)).toEqual(["call-a", "call-b", "call-c"]);

    // THE parity proof: the vendored renderGroups (entry-bounded groups — one
    // assistant entry = one group) restores call->result ADJACENCY inside the
    // group: thinking, call-a, result-a, call-b, result-b, call-c, result-c
    const groups = renderGroups(entries, {
      includeThinking: true,
      toolBlockCapTokens: null,
      tokenThreshold: 1000,
      includeEntryId: true,
    });
    const flat = groups.flatMap((g: any) => g.blocks.map((b: any) => b.text));
    const tags = flat.map((t: string) => {
      if (t.startsWith("<USER")) return "user";
      if (t.startsWith("<THINKING")) return "think";
      if (t.startsWith("<TOOLCALL")) {
        const m = /"(api|db|cache)"/.exec(t);
        return `call-${m === null ? "?" : m[1]}`;
      }
      if (t.startsWith("<TOOLRESULT")) return "res";
      if (t.startsWith("<ASSISTANT")) return "assist";
      return "other";
    });
    expect(tags).toEqual([
      "user", // p-0's group
      "think",
      "call-api", // the assistant group, interleaved call->result adjacency
      "res",
      "call-db",
      "res",
      "call-cache",
      "res",
      "assist", // p-8's group
    ]);
    // each result sits immediately after ITS call (service names: the call
    // block carries the args JSON, the result block the result text)
    const joined = flat.join("\n");
    expect(joined.indexOf('service":"api')).toBeLessThan(joined.indexOf("api: ok"));
    expect(joined.indexOf('service":"db')).toBeLessThan(joined.indexOf("db: degraded"));
    expect(joined.indexOf('service":"cache')).toBeLessThan(joined.indexOf("cache: ok"));
  });
});

describe("grouper — purity + degradation", () => {
  test("assistant rows without message.id never merge across responses", () => {
    const rows: ClaudeRow[] = [
      {
        uuid: "a1",
        parentUuid: null,
        door: "response",
        origin: { kind: "model", model: "m" },
        message: { type: "assistant", content: [{ type: "text", text: "one" }] },
      },
      {
        uuid: "a2",
        parentUuid: "a1",
        door: "response",
        origin: { kind: "model", model: "m" },
        message: { type: "assistant", content: [{ type: "text", text: "two" }] },
      },
    ];
    const entries = groupRows(rows) as AnyEntry[];
    expect(entries).toHaveLength(2);
    const textAt = (i: number): string | undefined => {
      const c = entries[i]?.message?.content;
      if (!Array.isArray(c)) return undefined;
      const block = c[0] as { text?: string } | undefined;
      return block?.text;
    };
    expect(textAt(0)).toBe("one");
    expect(textAt(1)).toBe("two");
  });

  test("array-of-blocks tool_result content flattens by joining text items", () => {
    const rows: ClaudeRow[] = [
      {
        uuid: "r1",
        parentUuid: null,
        door: "tool-result",
        origin: { kind: "tool", tool: "T" },
        message: {
          type: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "call-x",
              content: [
                { type: "text", text: "line one" },
                { type: "text", text: "line two" },
              ],
            },
          ],
        },
      },
    ];
    const entries = groupRows(rows) as AnyEntry[];
    const content = entries[0]?.message?.content as { text: string }[] | undefined;
    expect(content?.[0]?.text).toBe("line one\nline two");
  });
});

describe("grouper — robustness and shapes", () => {
  test("a tool-message row with plain-string content becomes a user entry (no throw)", () => {
    const rows: ClaudeRow[] = [
      {
        ...fixtureRowBase("tm-1", null),
        door: "tool-message",
        origin: { kind: "tool", tool: "Bash" },
        message: { type: "user", content: "plain string content" } as unknown as ClaudeRow["message"],
      },
    ];
    const entries = groupRows(rows) as AnyEntry[];
    expect(entries).toHaveLength(1);
    expect(entries[0]?.message?.role).toBe("user");
    expect(entries[0]?.message?.content).toBe("plain string content");
  });

  test("rows with missing message or missing origin are skipped without throwing", () => {
    expect(
      groupRows([
        { uuid: "x1", parentUuid: null, door: "prompt", origin: { kind: "composer" } } as unknown as ClaudeRow,
      ]),
    ).toEqual([]);
    expect(
      groupRows([
        {
          uuid: "x2",
          parentUuid: null,
          door: "prompt",
          message: { type: "user", content: [] },
        } as unknown as ClaudeRow,
      ]),
    ).toEqual([]);
  });

  test("missing content degrades to empty text, not a crash", () => {
    const rows: ClaudeRow[] = [
      {
        ...fixtureRowBase("mc-1", null),
        message: { type: "user" } as ClaudeRow["message"],
      },
    ];
    const entries = groupRows(rows) as AnyEntry[];
    expect(entries).toHaveLength(1);
    expect(entries[0]?.message?.content).toBe("");
  });

  test("a tool_result whose call is not in the batch keeps an empty toolName", () => {
    const rows: ClaudeRow[] = [
      {
        ...fixtureRowBase("orphan-1", null),
        door: "tool-result",
        origin: { kind: "tool", tool: "Read" },
        message: {
          type: "user",
          content: [{ type: "tool_result", tool_use_id: "call-elsewhere", content: "data" }],
        },
      },
    ];
    const entries = groupRows(rows) as AnyEntry[];
    expect(entries).toHaveLength(1);
    expect(entries[0]?.message?.role).toBe("toolResult");
    expect(entries[0]?.message?.toolName).toBe("");
  });

  test("compaction entries carry the full pi CompactionEntry shape", () => {
    const rows: ClaudeRow[] = [
      {
        ...fixtureRowBase("cmp-1", null),
        door: "compaction",
        origin: { kind: "system" },
        message: { type: "user", content: [{ type: "text", text: "the summary text" }] },
      },
    ];
    const entries = groupRows(rows) as unknown as Array<{
      type: string;
      summary: string;
      firstKeptEntryId: string;
      tokensBefore: number;
      details: { summary: string };
    }>;
    expect(entries).toHaveLength(1);
    expect(entries[0]?.type).toBe("compaction");
    expect(entries[0]?.summary).toBe("the summary text");
    expect(entries[0]?.firstKeptEntryId).toBe("");
    expect(entries[0]?.tokensBefore).toBe(0);
    expect(entries[0]?.details.summary).toBe("the summary text");
  });

  test("assistant usage follows the pi-ai Usage shape", () => {
    const rows: ClaudeRow[] = [
      {
        ...fixtureRowBase("as-1", null),
        door: "response",
        origin: { kind: "model", model: "glm-5.1" },
        message: {
          type: "assistant",
          id: "resp-1",
          content: [{ type: "text", text: "hi" }],
        },
      },
    ];
    const entries = groupRows(rows) as unknown as Array<{ message: { usage: unknown } }>;
    expect(entries[0]?.message.usage).toMatchObject({
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
    });
  });

  test("unknown doors are skipped (fail-closed: no rule, no entry)", () => {
    const rows: ClaudeRow[] = [
      {
        ...fixtureRowBase("unk-1", null),
        door: "future-door",
        message: { type: "user", content: [{ type: "text", text: "whatever" }] },
      },
    ];
    expect(groupRows(rows)).toEqual([]);
  });
});

describe("grouper — assistant message conformance and id invariants", () => {
  test("assistant usage maps from the row's real usage tokens (pi-ai shape)", () => {
    const rows: ClaudeRow[] = [
      {
        ...fixtureRowBase("au-1", null),
        door: "response",
        origin: { kind: "model", model: "glm-5.1" },
        message: {
          type: "assistant",
          id: "resp-au",
          usage: { input_tokens: 11, output_tokens: 7, cache_read_input_tokens: 3, cache_creation_input_tokens: 5 },
          content: [{ type: "text", text: "hi" }],
        },
      },
    ];
    const entries = groupRows(rows) as unknown as Array<{ message: { usage: unknown; stopReason: string } }>;
    expect(entries[0]?.message.usage).toMatchObject({
      input: 11,
      output: 7,
      cacheRead: 3,
      cacheWrite: 5,
      totalTokens: 26,
    });
    expect(entries[0]?.message.stopReason).toBe("stop");
  });

  test("a response carrying tool_use rows maps stopReason toolUse (stop_reason override wins)", () => {
    const base = {
      door: "response",
      origin: { kind: "model", model: "glm-5.1" },
    };
    const withCall = groupRows([
      {
        ...fixtureRowBase("tc-1", null),
        ...base,
        message: {
          type: "assistant",
          id: "resp-tc",
          content: [{ type: "tool_use", id: "call-1", name: "Read", input: {} }],
        },
      },
    ]) as unknown as Array<{ message: { stopReason: string } }>;
    expect(withCall[0]?.message.stopReason).toBe("toolUse");

    const explicit = groupRows([
      {
        ...fixtureRowBase("tc-2", null),
        ...base,
        message: {
          type: "assistant",
          id: "resp-tc2",
          stop_reason: "end_turn",
          content: [{ type: "tool_use", id: "call-2", name: "Read", input: {} }],
        },
      },
    ]) as unknown as Array<{ message: { stopReason: string } }>;
    expect(explicit[0]?.message.stopReason).toBe("stop"); // end_turn maps to stop — the explicit override beats the toolUse default
  });

  test("one row with multiple tool_result blocks yields ONE entry with joined content", () => {
    const rows: ClaudeRow[] = [
      {
        ...fixtureRowBase("mb-1", null),
        door: "tool-result",
        origin: { kind: "tool", tool: "Task" },
        message: {
          type: "user",
          content: [
            { type: "tool_result", tool_use_id: "call-a", content: "part one" },
            { type: "tool_result", tool_use_id: "call-b", content: "part two" },
          ],
        },
      },
    ];
    const entries = groupRows(rows) as AnyEntry[];
    expect(entries).toHaveLength(1);
    expect(entries[0]?.message?.toolCallId).toBe("call-a");
    const content = entries[0]?.message?.content as Array<{ type: string; text: string }>;
    expect(content.map((c) => c.text)).toEqual(["part one", "part two"]);
  });

  test("a tool_result row arriving BEFORE its tool_use row still resolves the tool name", () => {
    const rows: ClaudeRow[] = [
      {
        ...fixtureRowBase("rb-1", null),
        door: "tool-result",
        origin: { kind: "tool", tool: "Read" },
        message: {
          type: "user",
          content: [{ type: "tool_result", tool_use_id: "call-x", content: "data" }],
        },
      },
      {
        ...fixtureRowBase("rb-2", "rb-1"),
        door: "response",
        origin: { kind: "model", model: "glm-5.1" },
        message: {
          type: "assistant",
          id: "resp-rb",
          content: [{ type: "tool_use", id: "call-x", name: "Grep", input: {} }],
        },
      },
    ];
    const entries = groupRows(rows) as AnyEntry[];
    const tr = entries.find((e) => e.message?.role === "toolResult");
    expect(tr?.message?.toolName).toBe("Grep");
  });

  test("id-namespace invariant: entry ids are FIRST-row anchors, never mid-group uuids", () => {
    const rows: ClaudeRow[] = [
      {
        ...fixtureRowBase("g1", null),
        door: "response",
        origin: { kind: "model", model: "glm-5.1" },
        message: { type: "assistant", id: "resp-g", apiBlockIndex: 0, content: [{ type: "text", text: "a" }] },
      },
      {
        ...fixtureRowBase("g2", "g1"),
        door: "response",
        origin: { kind: "model", model: "glm-5.1" },
        message: {
          type: "assistant",
          id: "resp-g",
          apiBlockIndex: 1,
          content: [{ type: "text", text: "b" }],
        },
      },
    ];
    const entries = groupRows(rows) as AnyEntry[];
    expect(entries).toHaveLength(1);
    expect(entries[0]?.id).toBe("g1"); // the first row's uuid
    const ids = entries.map((e) => e.id);
    expect(ids.includes("g2")).toBe(false); // mid-group uuids are NOT entry ids
  });
});

describe("grouper — live-event degraded shape (the typed minimum)", () => {
  test("a d.ts-minimal row (no parentUuid/timestamp/message.id) degrades gracefully", () => {
    const rows: ClaudeRow[] = [
      {
        uuid: "live-1",
        door: "prompt",
        origin: { kind: "composer" },
        message: { type: "user", content: [{ type: "text", text: "typed minimum" }] },
      } as unknown as ClaudeRow,
      {
        uuid: "live-2",
        door: "response",
        origin: { kind: "model", model: "glm-5.1" },
        message: { type: "assistant", content: [{ type: "text", text: "no merge id" }] },
      } as unknown as ClaudeRow,
    ];
    const entries = groupRows(rows) as AnyEntry[];
    expect(entries).toHaveLength(2);
    expect(entries[0]?.message?.content).toBe("typed minimum");
    expect(entries[1]?.message?.role).toBe("assistant");
    expect(entries[1]?.id).toBe("live-2"); // one-entry-per-row fallback
  });

  test("a command row without text degrades to a skip (nothing fabricated)", () => {
    const rows: ClaudeRow[] = [
      {
        uuid: "cmd-notext",
        parentUuid: null,
        door: "command",
        origin: { kind: "plugin", plugin: "other" },
        message: { type: "user", content: [] },
      },
    ];
    expect(groupRows(rows)).toEqual([]);
  });
});
