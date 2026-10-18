// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// The capture suite: append handler (row cache, pending, spawn-skip,
// uncapped), the turn flush (mirror + CHECK ordering, split guard), and the
// details bridge (tier union, graceful misses).
import { beforeEach, describe, expect, test } from "vitest";
import {
  _resetCapture,
  captureAppend,
  ensureCapture,
  entriesForCache,
  releaseAllCaptures,
  releaseCapture,
} from "../../host/capture/append-handler.js";
import { makeEntryResolver } from "../../host/capture/details-bridge.js";
import { flushTurn } from "../../host/capture/flush.js";
import type { ClaudeRow } from "../../host/capture/grouper.js";
import { createMemoryFs } from "../../host/storage/fs-adapter.js";
import { foldLedger, LedgerWriter } from "../../host/storage/ledger.js";
import { MirrorWriter, mirrorBatchName, producer8, sweepMirror } from "../../host/storage/mirror.js";

const mem = createMemoryFs();
const fs = mem.adapter;
const DIR = "/sess";

function row(uuid: string, parentUuid: string | null, over: Partial<ClaudeRow> = {}): ClaudeRow {
  return {
    uuid,
    parentUuid,
    door: "prompt",
    origin: { kind: "composer" },
    message: { type: "user", content: [{ type: "text", text: `row ${uuid}` }] },
    timestamp: "2026-10-06T10:00:00.000Z",
    ...over,
  };
}

function mirrorFor(key: string): MirrorWriter {
  return new MirrorWriter(fs, `${DIR}/${key}`, `proc-${key}`);
}

beforeEach(() => {
  mem.files.clear();
  _resetCapture();
});

describe("append-handler — capture", () => {
  test("engine META rows (system: turn_duration/informational/…) are NOT captured — they never enter the api view", () => {
    // Mirroring them would make the rewind check see a dead row every turn
    // (the engine writes a turn_duration row after each answer; it is
    // chained in the file but absent from messages({as:"api"})) — a false
    // rewind that aborts the observer and quarantines its records.
    const meta = row("meta-1", null, {
      message: { type: "system", name: "turn_duration", content: [] } as never,
    });
    expect(captureAppend("s1", meta, mirrorFor)).toBe(false);
    const cap = ensureCapture("s1", mirrorFor);
    expect(cap.rowCache.has("meta-1")).toBe(false);
    expect(cap.pending).toEqual([]);
  });

  test("rows land in the row cache, the pending list, and the mirror buffer", () => {
    const owlLoops = new Set<string>(["owl-agent-1"]);
    const isOwl = (agentId: string | undefined) => agentId !== undefined && owlLoops.has(agentId);
    expect(captureAppend("s1", row("u1", null), mirrorFor, isOwl)).toBe(true);
    const cap = ensureCapture("s1", mirrorFor);
    expect(cap.rowCache.get("u1")?.message.type).toBe("user");
    expect(cap.pending).toEqual(["u1"]);
    expect(cap.mirror.pendingRows().map((r) => r.uuid)).toEqual(["u1"]);
  });

  test("owl-spawn loops are skipped entirely (stage-dump is their record)", () => {
    const isOwl = (agentId: string | undefined) => agentId === "owl-agent-1";
    const skipped = { ...row("o1", null), agentId: "owl-agent-1" };
    expect(captureAppend("s1|owl-agent-1", skipped, mirrorFor, isOwl)).toBe(false);
    expect(ensureCapture("s1|owl-agent-1", mirrorFor).rowCache.size).toBe(0);
  });

  test("an agentId row files under its OWN loop's key", () => {
    const isOwl = () => false;
    const sub = { ...row("sub-1", null), agentId: "agent-7" };
    captureAppend("s1|agent-7", sub, mirrorFor, isOwl);
    expect(ensureCapture("s1|agent-7", mirrorFor).pending).toEqual(["sub-1"]);
    expect(ensureCapture("s1", mirrorFor).rowCache.size).toBe(0);
  });

  test("a re-delivered uuid does not double-append to pending", () => {
    const isOwl = () => false;
    captureAppend("s1", row("u1", null), mirrorFor, isOwl);
    captureAppend("s1", row("u1", null), mirrorFor, isOwl);
    expect(ensureCapture("s1", mirrorFor).pending).toEqual(["u1"]);
  });

  test("capture is UNCAPPED: a 300 KB tool result is stored whole", async () => {
    const isOwl = () => false;
    const big = "y".repeat(300 * 1024);
    const bigRow = row("u-big", null, {
      door: "tool-result",
      origin: { kind: "tool", tool: "Read" },
      message: {
        type: "user",
        content: [{ type: "tool_result", tool_use_id: "call-big", content: big }],
      },
    });
    captureAppend("s1", bigRow, mirrorFor, isOwl);
    const cap = ensureCapture("s1", mirrorFor);
    const stored = cap.rowCache.get("u-big");
    expect(((stored?.message.content[0]?.content as string) ?? "").length).toBe(300 * 1024);
    // and it survives the mirror round-trip whole
    await cap.mirror.flush();
    const sweep = await sweepMirror(fs, `${DIR}/s1`);
    {
      const mirrored = sweep.rows.find((r) => r.uuid === "u-big");
      const mirroredRow = mirrored?.row as ClaudeRow | undefined;
      const first = mirroredRow?.message.content[0];
      const content = typeof first?.content === "string" ? first.content : "";
      expect(content.length).toBe(300 * 1024);
    }
  });

  test("entriesForCache renders the cache through the grouper", () => {
    const isOwl = () => false;
    captureAppend("s1", row("u1", null), mirrorFor, isOwl);
    const entries = entriesForCache("s1");
    expect(entries).toHaveLength(1);
    expect((entries[0] as { message?: { content?: unknown } }).message?.content).toBe("row u1");
  });
});

describe("flush — turn.complete", () => {
  test("mirror flushes first, then the CHECK record lands after the rows", async () => {
    const isOwl = () => false;
    captureAppend("s1", row("u1", null), mirrorFor, isOwl);
    captureAppend("s1", row("u2", "u1"), mirrorFor, isOwl);
    const cap = ensureCapture("s1", mirrorFor);
    const ledger = new LedgerWriter(fs, `${DIR}/s1`, "proc-s1");
    const result = await flushTurn(cap.mirror, ledger, "u2");
    // mirror wrote the batch
    expect(result.files).toEqual([mirrorBatchName(1, producer8("proc-s1"), 0)]);
    // the CHECK record is buffered AFTER the flush (fold order will show it last)
    ledger.append("graph_delta", { late: true }, "u2");
    await ledger.flush();
    const fold = await foldLedger(fs, `${DIR}/s1`);
    const kinds = fold.records.map((r) => r.kind);
    expect(kinds).toEqual(["CHECK", "graph_delta"]);
    expect(fold.records[0]?.marker).toBe("u2");
    expect(result.checkId).toBe("proc-s1:1");
  });

  test("an empty turn flushes no batch but still records the CHECK mark", async () => {
    const mirror = new MirrorWriter(fs, `${DIR}/s2`, "proc-s2");
    const ledger = new LedgerWriter(fs, `${DIR}/s2`, "proc-s2");
    const result = await flushTurn(mirror, ledger, null);
    expect(result.files).toEqual([]);
    await ledger.flush();
    const fold = await foldLedger(fs, `${DIR}/s2`);
    expect(fold.records.map((r) => r.kind)).toEqual(["CHECK"]);
    expect(fold.records[0]?.marker).toBe("seed");
  });

  test("the mid-turn split guard: huge buffered rows split at the roll margin", async () => {
    const mirror = new MirrorWriter(fs, `${DIR}/s3`, "proc-s3");
    for (let i = 0; i < 4; i += 1) {
      mirror.bufferRow({
        uuid: `u${i}`,
        parentUuid: i === 0 ? null : `u${i - 1}`,
        row: row(`u${i}`, null, {}),
      });
      mirror.bufferRow({
        uuid: `big${i}`,
        parentUuid: `u${i}`,
        row: {
          ...row(`big${i}`, null, {}),
          message: { type: "user", content: [{ type: "text", text: "y".repeat(1024 * 1024) }] },
        },
      });
    }
    const files = await mirror.flush();
    expect(files.length).toBeGreaterThan(1);
    for (const f of files) {
      expect((await fs.stat(`${DIR}/s3/${f}`))?.size ?? 0).toBeLessThanOrEqual(3 * 1024 * 1024);
    }
  });
});

describe("details-bridge — the resolver tiers", () => {
  test("resolves ids through the grouper over the index union (cache + adopted mirror)", () => {
    const isOwl = () => false;
    captureAppend("s1", row("u1", null), mirrorFor, isOwl);
    captureAppend("s1", row("u2", "u1"), mirrorFor, isOwl);
    const cap = ensureCapture("s1", mirrorFor);
    // an adopted (restart-swept) row joins the union through the index
    const index = {
      rows: () => [...cap.rowCache.values(), row("u-old", null)],
    };
    const resolver = makeEntryResolver(index);
    const resolved = resolver(["u1", "u-old", "missing"]) as Array<{ id: string }>;
    expect(resolved.map((e) => e.id)).toEqual(["u1", "u-old"]); // graceful miss
  });

  test("a same-length in-place REFRESH invalidates the entry cache when the index exposes a version", () => {
    let rows = [row("u1", null)];
    let ver = 1;
    const index = {
      rows: () => rows,
      version: () => ver,
    };
    const resolver = makeEntryResolver(index);
    const [before] = resolver(["u1"]) as Array<{ message: { content: string } }>;
    expect(before.message.content).toBe("row u1");
    // the platform re-delivers u1 with changed content — same length
    rows = [row("u1", null, { message: { type: "user", content: [{ type: "text", text: "row u1 EDITED" }] } })];
    ver += 1;
    const [after] = resolver(["u1"]) as Array<{ message: { content: string } }>;
    expect(after.message.content).toBe("row u1 EDITED"); // NOT the stale cache
  });

  test("the resolver serves the details renderer's shape (message entries)", () => {
    const index = { rows: () => [row("u1", null)] };
    const resolver = makeEntryResolver(index);
    const [entry] = resolver(["u1"]) as Array<{ type: string; message: { role: string; content: string } }>;
    expect(entry.type).toBe("message");
    expect(entry.message.role).toBe("user");
    expect(entry.message.content).toBe("row u1");
  });
});

describe("append-handler — dedupe and release", () => {
  test("a re-delivered uuid does not re-buffer to the mirror (one line, one row)", () => {
    const isOwl = () => false;
    captureAppend("s1", row("u1", null), mirrorFor, isOwl);
    captureAppend("s1", row("u1", null), mirrorFor, isOwl);
    const cap = ensureCapture("s1", mirrorFor);
    expect(cap.pending).toEqual(["u1"]);
    expect(cap.mirror.pendingRows()).toHaveLength(1);
  });

  test("releaseCapture drops one conversation's capture state", () => {
    const isOwl = () => false;
    captureAppend("s1", row("u1", null), mirrorFor, isOwl);
    captureAppend("s2", row("v1", null), mirrorFor, isOwl);
    expect(releaseCapture("s1")).toBe(true);
    expect(ensureCapture("s1", mirrorFor).rowCache.size).toBe(0);
    expect(ensureCapture("s2", mirrorFor).rowCache.size).toBe(1);
    expect(releaseCapture("missing")).toBe(false);
  });

  test("releaseAllCaptures clears every conversation (session.end teardown)", () => {
    const isOwl = () => false;
    captureAppend("s1", row("u1", null), mirrorFor, isOwl);
    captureAppend("s2", row("v1", null), mirrorFor, isOwl);
    releaseAllCaptures();
    expect(entriesForCache("s1")).toEqual([]);
    expect(entriesForCache("s2")).toEqual([]);
  });
});

describe("details-bridge — invalidation", () => {
  test("makeEntryResolver self-invalidates when the index grows (generation check)", () => {
    const live: ClaudeRow[] = [row("u1", null)];
    const resolver = makeEntryResolver({ rows: () => live });
    expect(resolver(["u2"])).toEqual([]); // not yet in the index
    live.push(row("u2", "u1"));
    const resolved = resolver(["u2"]) as Array<{ id: string }>;
    expect(resolved.map((e) => e.id)).toEqual(["u2"]);
  });
});

describe("append-handler — the envelope's missing fields", () => {
  test("a row without a timestamp is stamped with its arrival time (never the epoch)", async () => {
    const raw = row("ts1", null, { timestamp: undefined });
    const stamped = { ...raw, timestamp: undefined } as unknown as ClaudeRow;
    delete (stamped as Partial<ClaudeRow>).timestamp;
    expect(captureAppend("s-ts", stamped, mirrorFor)).toBe(true);
    const entries = entriesForCache("s-ts");
    expect(entries).toHaveLength(1);
    const ts = (entries[0] as { timestamp?: string }).timestamp;
    expect(typeof ts).toBe("string");
    expect(ts?.length).toBeGreaterThan(0);
    // a real ISO arrival stamp, not "" (which renders as Jan 01 epoch)
    expect(ts).toMatch(/^20\d\d-/);
  });

  test("an explicit timestamp is preserved verbatim (never overwritten)", () => {
    expect(captureAppend("s-ts2", row("ts2", null, { timestamp: "2020-01-02T03:04:05.000Z" }), mirrorFor)).toBe(true);
    const entries = entriesForCache("s-ts2");
    expect((entries[0] as { timestamp?: string }).timestamp).toBe("2020-01-02T03:04:05.000Z");
  });
});
