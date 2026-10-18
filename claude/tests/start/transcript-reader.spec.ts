// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import { readFileSync } from "node:fs";
import { join } from "node:path";
// The transcript-reader suite: JSONL parse (conversation rows vs metadata,
// tip marker extraction), the ≤4 MiB guard, live-path filtering by the
// parentUuid chain, sidechain partitioning, and the transcript→door
// derivation that lets the chunk grouper consume transcript rows unchanged.
import { describe, expect, test } from "vitest";
import {
  livePath,
  parseTranscriptRows,
  readTranscript,
  rowFromTranscript,
  subagentLoopFiles,
} from "../../host/start/transcript-reader.js";
import { createMemoryFs } from "../../host/storage/fs-adapter.js";

const FIX = join(__dirname, "..", "fixtures", "transcripts");

/** Materialize a fixture descriptor into transcript JSONL text. */
function jsonl(name: string): string {
  const d = JSON.parse(readFileSync(join(FIX, `${name}.json`), "utf8")) as {
    rows: Record<string, unknown>[];
  };
  return `${d.rows
    .map((r) => {
      if (r.kind === "metadata" || r.kind === "metadata-tip") return String(r.raw);
      const { kind, ...row } = r;
      void kind;
      return JSON.stringify(row);
    })
    .join("\n")}\n`;
}

describe("transcript-reader — parse", () => {
  test("conversation rows parse; metadata rows skip but the tip marker is extracted", () => {
    const parsed = parseTranscriptRows(jsonl("main-simple"));
    expect(parsed.rows.map((r) => r.uuid)).toEqual(["m-1", "m-2", "m-3", "m-4", "m-5", "m-6", "m-7"]);
    expect(parsed.tip?.leafUuid).toBe("m-7");
    expect(parsed.tip?.sessionId).toBe("sess-main");
    expect(parsed.skippedLines).toBe(0);
  });

  test("corrupt lines are counted and skipped, never fatal", () => {
    const parsed = parseTranscriptRows('{"uuid":"a","type":"user"}\nnot-json\n{"uuid":"b","type":"user"}\n');
    expect(parsed.rows.map((r) => r.uuid)).toEqual(["a", "b"]);
    expect(parsed.skippedLines).toBe(1);
  });

  test("rows without a uuid are not conversation rows (skipped)", () => {
    const parsed = parseTranscriptRows('{"type":"user","message":{"content":"x"}}\n');
    expect(parsed.rows).toEqual([]);
  });
});

describe("transcript-reader — the 4 MiB guard", () => {
  test("a file within the cap reads whole; over-cap reports tooLarge", async () => {
    const mem = createMemoryFs();
    await mem.adapter.writeText("/t/small.jsonl", jsonl("main-simple"));
    const small = await readTranscript(mem.adapter, "/t/small.jsonl", { maxBytes: 1024 * 1024 });
    expect(small.tooLarge).toBe(false);

    const big = `${"x".repeat(100)}\n`;
    await mem.adapter.writeText("/t/big.jsonl", big);
    const over = await readTranscript(mem.adapter, "/t/big.jsonl", { maxBytes: 50 });
    expect(over.tooLarge).toBe(true);
  });

  test("a missing transcript reads as empty rows (fresh-session truth)", async () => {
    const mem = createMemoryFs();
    const out = await readTranscript(mem.adapter, "/t/absent.jsonl");
    expect(out.tooLarge).toBe(false);
    if (out.tooLarge === false) {
      expect(out.rows).toEqual([]);
      expect(out.tip).toBeNull();
    }
  });
});

describe("transcript-reader — live path", () => {
  test("the parentUuid walk from the tip excludes dead-tail siblings", () => {
    const parsed = parseTranscriptRows(jsonl("branched"));
    const live = livePath(parsed.rows, parsed.tip?.leafUuid ?? null);
    expect(live.map((r) => r.uuid)).toEqual(["m-1", "m-2", "m-3", "m-4", "m-5", "m-6b"]);
  });

  test("a null leaf keeps file order (no marker — treat all as live)", () => {
    const parsed = parseTranscriptRows(jsonl("branched"));
    const live = livePath(parsed.rows, null);
    expect(live).toHaveLength(7);
  });

  test("an unknown leaf uuid degrades to file order", () => {
    const parsed = parseTranscriptRows(jsonl("main-simple"));
    const live = livePath(parsed.rows, "no-such-uuid");
    expect(live).toHaveLength(7);
  });
});

describe("transcript-reader — transcript rows → grouper rows", () => {
  test("door derivation per row kind: prompt/response/tool-result, isMeta skipped-class", () => {
    const parsed = parseTranscriptRows(jsonl("main-simple"));
    const doors = parsed.rows.map((r) => rowFromTranscript(r).door);
    expect(doors).toEqual(["prompt", "response", "response", "tool-result", "response", "prompt", "response"]);
    // the assistant origin carries the row's model
    const firstAssistant = rowFromTranscript(parsed.rows[1] ?? parsed.rows[0]);
    expect(firstAssistant.origin).toMatchObject({ kind: "model", model: "glm-5.1" });
    // usage + stop_reason ride through for the assistant conformance mapping
    const final = rowFromTranscript(parsed.rows[4] ?? parsed.rows[0]);
    expect(final.message.usage).toMatchObject({ input_tokens: 100, output_tokens: 20 });
    expect(final.message.stop_reason).toBe("end_turn");
  });

  test("system-reminder isMeta rows map to the attachment door (skipped class, live parity)", () => {
    const parsed = parseTranscriptRows(jsonl("subagent-loop"));
    const metaRow = parsed.rows.find((r) => r.isMeta === true);
    expect(metaRow).toBeDefined();
    const row = rowFromTranscript(metaRow ?? parsed.rows[0]);
    expect(row.door).toBe("attachment");
    expect(row.origin.kind).toBe("engine");
  });

  test("a NON-reminder isMeta user row is a plugin append: the note door with a plugin origin (the custom_message split)", () => {
    const parsed = parseTranscriptRows(
      `${JSON.stringify({
        uuid: "p-1",
        parentUuid: null,
        type: "user",
        isMeta: true,
        message: { role: "user", content: [{ type: "text", text: "injected by another plugin" }] },
      })}
`,
    );
    const row = rowFromTranscript(parsed.rows[0]);
    expect(row.door).toBe("note");
    expect(row.origin.kind).toBe("plugin"); // the grouper renders custom_message
  });

  test("a compact_boundary row maps to the compaction door", () => {
    const parsed = parseTranscriptRows(
      `${JSON.stringify({
        uuid: "c-1",
        parentUuid: null,
        type: "user",
        compact_boundary: true,
        message: { role: "user", content: "summary text" },
      })}\n`,
    );
    expect(rowFromTranscript(parsed.rows[0]).door).toBe("compaction");
  });

  test("a system compact_boundary row marks the NEXT user row as the compaction carrier (this build's shape)", () => {
    const parsed = parseTranscriptRows(
      `${JSON.stringify({
        uuid: "b-1",
        parentUuid: null,
        type: "system",
        subtype: "compact_boundary",
        content: "Conversation compacted",
      })}
${JSON.stringify({
  uuid: "c-1",
  parentUuid: null,
  type: "user",
  message: { role: "user", content: "# Memory — summary" },
})}
`,
    );
    expect(parsed.rows).toHaveLength(1); // the system row itself is not a conversation row
    expect(parsed.rows[0]?.compactBoundary).toBe(true); // the summary row carries the boundary
    expect(rowFromTranscript(parsed.rows[0]).door).toBe("compaction");
  });

  test("a tail system compact_boundary row with no following row marks nothing", () => {
    const parsed = parseTranscriptRows(
      `${JSON.stringify({ uuid: "u-1", parentUuid: null, type: "user", message: { role: "user", content: "hi" } })}
${JSON.stringify({
  uuid: "b-9",
  parentUuid: null,
  type: "system",
  subtype: "compact_boundary",
  content: "Conversation compacted",
})}
`,
    );
    expect(parsed.rows).toHaveLength(1);
    expect(parsed.rows[0]?.compactBoundary).toBeFalsy(); // falsy — never a boundary without a carrier
  });

  test("derived rows render through the chunk grouper (user/assistant/toolResult entries)", async () => {
    const { groupRows } = await import("../../host/capture/grouper.js");
    const parsed = parseTranscriptRows(jsonl("main-simple"));
    const live = livePath(parsed.rows, parsed.tip?.leafUuid ?? null);
    const entries = groupRows(live.map(rowFromTranscript)) as Array<{
      id: string;
      type: string;
      message?: { role: string; content: unknown };
    }>;
    // m-2+m-3 merge into ONE assistant entry (shared message.id)
    const roles = entries.map((e) => (e.type === "message" ? e.message?.role : e.type));
    expect(roles).toEqual(["user", "assistant", "toolResult", "assistant", "user", "assistant"]);
    expect(entries[1]?.id).toBe("m-2");
  });
});

describe("transcript-reader — sidechain loops", () => {
  test("subagent files are recognized by name and their rows carry agentId", () => {
    expect(subagentLoopFiles(["agent-a0036ff.jsonl", "m1-abc12345.jsonl", "notes.txt", "agent-XYZ.jsonl"])).toEqual([
      "agent-a0036ff.jsonl",
    ]);
    const parsed = parseTranscriptRows(jsonl("subagent-loop"));
    expect(parsed.rows.every((r) => r.isSidechain === true && r.agentId === "a0036ff")).toBe(true);
  });
});

describe("transcript-reader — cap rejection vs missing file", () => {
  test("a read that REJECTS over-cap reports tooLarge (stat-backed), not missing", async () => {
    const files = new Map<string, string>([["/t/huge.jsonl", "x".repeat(100)]]);
    const statSizes = new Map<string, number>([["/t/huge.jsonl", 5 * 1024 * 1024]]);
    const fs = {
      readText: async (path: string) => {
        if (files.has(path)) throw new Error("reject: over 4 MiB read cap");
        throw new Error("ENOENT");
      },
      writeText: async () => {},
      listDir: async () => [],
      stat: async (path: string) => {
        const size = statSizes.get(path);
        return size === undefined ? null : { size };
      },
    };
    const out = await readTranscript(fs, "/t/huge.jsonl");
    expect(out.tooLarge).toBe(true);
    if (out.tooLarge === true) {
      expect(out.byteSize).toBe(5 * 1024 * 1024);
    }
    const missing = await readTranscript(fs, "/t/gone.jsonl");
    expect(missing.tooLarge).toBe(false);
    if (missing.tooLarge === false) {
      expect(missing.rows).toEqual([]);
    }
  });
});

describe("transcript-reader — cycle guard", () => {
  test("a parentUuid cycle degrades to a bounded chain (no hang)", () => {
    const rows = [
      { uuid: "c-1", parentUuid: "c-2", type: "user", message: { content: "a" } },
      { uuid: "c-2", parentUuid: "c-1", type: "user", message: { content: "b" } },
    ].map((r) => r as never);
    const live = livePath(rows, "c-1");
    expect(live.length).toBeLessThanOrEqual(2); // bounded — the guard cut the cycle
    expect(live.some((r) => r.uuid === "c-1")).toBe(true);
  }, 2000);
});
