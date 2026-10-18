// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// The ledger suite: envelope/batch mechanics, fold-order determinism, CHECK +
// quarantine evaluability, batch-ref resolution, split at the roll margin.
import { beforeEach, describe, expect, test } from "vitest";
import type { FsAdapter } from "../../host/storage/fs-adapter.js";
import { createMemoryFs } from "../../host/storage/fs-adapter.js";
import { randomUUID } from "../../host/storage/id.js";
import {
  foldLedger,
  type LedgerRecord,
  LedgerWriter,
  newestLiveCheck,
  quarantineAfterLastLiveCheck,
} from "../../host/storage/ledger.js";
import { makeFlakyWrite, makeParkedWrite } from "./helpers.js";

const mem = createMemoryFs();
const fs = mem.adapter;
const DIR = "/sess";

beforeEach(() => {
  mem.files.clear();
});

describe("id — crypto-free uuids", () => {
  test("randomUUID is uuid-v4-shaped and non-repeating", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i += 1) {
      const id = randomUUID();
      expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
      seen.add(id);
    }
    expect(seen.size).toBe(200);
  });
});

describe("ledger — flush serialization (one writer at a time)", () => {
  test("a second flush during an active one never overlaps its file writes", async () => {
    const raw = createMemoryFs();
    let active = 0;
    let maxActive = 0;
    const spy: FsAdapter = {
      ...raw.adapter,
      writeText: async (path: string, text: string) => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        try {
          await raw.adapter.writeText(path, text);
        } finally {
          active -= 1;
        }
      },
    };
    const w = new LedgerWriter(spy, DIR, "p-serial", () => 1000);
    w.append("graph_delta", { first: true }, "m1");
    const first = w.flush();
    w.append("graph_delta", { second: true }, "m1");
    const second = w.flush();
    await Promise.all([first, second]);

    expect(maxActive).toBe(1); // never two concurrent writers (own- or cross-file)
    const text = [...raw.files.values()].join("");
    expect(text.split('"first":true').length - 1).toBe(1); // each record exactly once
    expect(text.split('"second":true').length - 1).toBe(1);
    expect(w.pendingCount()).toBe(0); // the trailing run drained the queue
  });
});

describe("ledger — batch writing", () => {
  test("flush writes one NEW batch file per flush; empty flush writes nothing", async () => {
    const w = new LedgerWriter(fs, DIR, "p1");
    w.append("graph_delta", { op: "create_node" }, "u1");
    w.append("graph_delta", { op: "record_observation" }, "u2");
    const files1 = await w.flush();
    expect(files1).toHaveLength(1);
    expect(files1[0]).toMatch(/^ledger-[0-9a-f-]+\.jsonl$/);
    w.append("usage", { ledger: 1 }, "u3");
    const files2 = await w.flush();
    expect(files2).toHaveLength(1);
    expect(files2[0]).not.toBe(files1[0]);
    expect(await w.flush()).toEqual([]);
    const fold = await foldLedger(fs, DIR);
    expect(fold.records.map((r) => r.kind)).toEqual(["graph_delta", "graph_delta", "usage"]);
  });

  test("records carry producerId, monotonic seq, ts, marker, payload", async () => {
    let now = 1000;
    const w = new LedgerWriter(fs, DIR, "producer-A", () => (now += 5));
    w.append("observation", { records: [] }, "u9");
    w.append("CHECK", null, "u10");
    await w.flush();
    const [a, b] = (await foldLedger(fs, DIR)).records;
    expect(a.producerId).toBe("producer-A");
    expect(a.seq).toBe(1);
    expect(a.ts).toBe(1005);
    expect(a.marker).toBe("u9");
    expect(a.payload).toEqual({ records: [] });
    expect(b.seq).toBe(2);
    expect(b.payload).toBeNull();
  });
});

describe("ledger — fold order determinism", () => {
  test("two producers, skewed clocks: (ts, producerId, seq) total order", async () => {
    // producer B's clock runs 500 ms AHEAD of A's; their writes interleave
    let tsA = 10_000;
    let tsB = 10_500;
    const a = new LedgerWriter(fs, DIR, "A", () => (tsA += 10));
    const b = new LedgerWriter(fs, DIR, "B", () => (tsB += 10));
    a.append("graph_delta", { i: 1 }, "u1");
    b.append("graph_delta", { i: 2 }, "u2");
    a.append("graph_delta", { i: 3 }, "u3");
    b.append("graph_delta", { i: 4 }, "u4");
    // a "skewed" B record stamped BEFORE its actual write: ts equal to A's #3
    tsB = tsA - 10;
    b.append("graph_delta", { i: 5 }, "u5");
    await Promise.all([a.flush(), b.flush()]);
    const fold = await foldLedger(fs, DIR);
    const items = fold.records.map((r) => `${r.payload && (r.payload as { i: number }).i}@${r.ts}`);
    // deterministic: sorted by ts then producerId then seq
    const sorted = [...fold.records].sort((x, y) => {
      if (x.ts !== y.ts) return x.ts - y.ts;
      if (x.producerId !== y.producerId) return x.producerId < y.producerId ? -1 : 1;
      return x.seq - y.seq;
    });
    expect(fold.records).toEqual(sorted);
    expect(items.length).toBe(5);
  });

  test("the same tie (ts, producerId) breaks by seq — later seq folds later", async () => {
    const w1 = new LedgerWriter(fs, DIR, "same", () => 42);
    w1.append("usage", { n: 1 }, "u1");
    w1.append("usage", { n: 2 }, "u1");
    w1.append("usage", { n: 3 }, "u1");
    await w1.flush();
    const fold = await foldLedger(fs, DIR);
    expect(fold.records.map((r) => (r.payload as { n: number }).n)).toEqual([1, 2, 3]);
  });
});

describe("ledger — CHECK records + quarantine", () => {
  test("newestLiveCheck picks the fold-newest LIVE check (dead checks ignored)", async () => {
    const recs: LedgerRecord[] = [
      { producerId: "A", seq: 1, ts: 1, marker: "u1", at: "u1", kind: "CHECK", payload: null },
      { producerId: "A", seq: 2, ts: 2, marker: "u2", at: "u2", kind: "graph_delta", payload: {} },
      { producerId: "A", seq: 3, ts: 3, marker: "u3", at: "u3", kind: "CHECK", payload: null },
    ];
    const live = (m: string) => m !== "u3"; // the newest check's marker is dead
    const newest = newestLiveCheck(recs, live);
    expect(newest?.marker).toBe("u1");
  });

  test("quarantine drops records ordered after the newest live CHECK; keeps the rest", () => {
    const recs: LedgerRecord[] = [
      { producerId: "A", seq: 1, ts: 1, marker: "u1", at: "u1", kind: "CHECK", payload: null },
      { producerId: "A", seq: 2, ts: 2, marker: "u2", at: "u2", kind: "graph_delta", payload: { i: 2 } },
      { producerId: "A", seq: 3, ts: 3, marker: "u3", at: "u3", kind: "graph_delta", payload: { i: 3 } },
      { producerId: "A", seq: 4, ts: 4, marker: "u4", at: "u4", kind: "CHECK", payload: null },
      { producerId: "A", seq: 5, ts: 5, marker: "u5", at: "u5", kind: "graph_delta", payload: { i: 5 } },
    ];
    const allLive = () => true;
    const q = quarantineAfterLastLiveCheck(recs, allLive);
    expect(q.kept.map((r) => r.seq)).toEqual([1, 2, 3, 4]);
    expect(q.dropped.map((r) => r.seq)).toEqual([5]);
  });

  test("with NO live check at all (fresh session truth) everything is kept", () => {
    const recs: LedgerRecord[] = [
      { producerId: "A", seq: 1, ts: 1, marker: "u1", at: "u1", kind: "graph_delta", payload: {} },
      { producerId: "A", seq: 2, ts: 2, marker: "u2", at: "u2", kind: "graph_delta", payload: {} },
    ];
    const q = quarantineAfterLastLiveCheck(recs, () => true);
    expect(q.dropped).toEqual([]);
    expect(q.kept).toHaveLength(2);
  });

  test("a simulated crash (records after the last live CHECK, no trailing CHECK) is still evaluable — the boundary is the check", () => {
    const recs: LedgerRecord[] = [
      { producerId: "A", seq: 1, ts: 1, marker: "u1", at: "u1", kind: "CHECK", payload: null },
      { producerId: "A", seq: 2, ts: 2, marker: "u2", at: "u2", kind: "graph_delta", payload: {} },
      { producerId: "A", seq: 3, ts: 3, marker: "u3", at: "u3", kind: "graph_delta", payload: {} },
    ];
    const q = quarantineAfterLastLiveCheck(recs, () => true);
    // crash-before-its-CHECK: the post-check records are exactly the widened
    // quarantine window (one extra re-observed range)
    expect(q.kept.map((r) => r.seq)).toEqual([1]);
    expect(q.dropped.map((r) => r.seq)).toEqual([2, 3]);
  });

  test("CHECK cadence: checks coalesce into the batch of their dispatch (file-level grouping)", async () => {
    const w = new LedgerWriter(fs, DIR, "A");
    w.append("graph_delta", { i: 1 }, "u1");
    w.append("CHECK", null, "u1"); // turn-complete boundary of the same dispatch
    const files = await w.flush();
    expect(files).toHaveLength(1); // coalesced — not a file per record
    const text = mem.peek(`${DIR}/${files[0]}`);
    expect((text?.match(/"kind":"CHECK"/g) ?? []).length).toBe(1);
  });
});

describe("ledger — batch refs", () => {
  test("refsForNextObservation lands on the next observation record only", async () => {
    const w = new LedgerWriter(fs, DIR, "A");
    w.refsForNextObservation([{ producer: "A", seq: 1 }]);
    w.append("graph_delta", { i: 1 }, "u1"); // NOT observation — no ref
    w.append("observation", { records: [] }, "u2"); // gets the ref
    w.append("observation", { records: [] }, "u3"); // none left
    await w.flush();
    const recs = (await foldLedger(fs, DIR)).records;
    expect((recs[0] as LedgerRecord & { batchRefs?: unknown }).batchRefs).toBeUndefined();
    expect((recs[1] as LedgerRecord & { batchRefs?: unknown }).batchRefs).toEqual([{ producer: "A", seq: 1 }]);
    expect((recs[2] as LedgerRecord & { batchRefs?: unknown }).batchRefs).toBeUndefined();
  });
});

describe("ledger — split at the roll margin", () => {
  test("a batch past the margin splits into multiple files, fold is identical", async () => {
    const w = new LedgerWriter(fs, DIR, "A");
    const big = "x".repeat(1024 * 1024); // 1 MiB payloads
    w.append("graph_delta", { big }, "u1");
    w.append("graph_delta", { big }, "u2");
    w.append("graph_delta", { big }, "u3");
    w.append("graph_delta", { big }, "u4");
    const files = await w.flush();
    expect(files.length).toBeGreaterThan(1);
    for (const f of files) {
      const size = (await fs.stat(`${DIR}/${f}`))?.size ?? 0;
      expect(size).toBeLessThanOrEqual(3 * 1024 * 1024);
    }
    const fold = await foldLedger(fs, DIR);
    expect(fold.records).toHaveLength(4);
    expect(fold.records.map((r) => r.marker)).toEqual(["u1", "u2", "u3", "u4"]);
  });
});

describe("ledger — byte-true guards", () => {
  test("CJK-heavy batch splits by BYTES: two ~2.4 MB records cannot share one file", async () => {
    const w = new LedgerWriter(fs, DIR, "A");
    // 0.8M CJK chars per payload: ~0.8M UTF-16 units each (char-counting
    // would fit BOTH in one 3M-unit file) but ~2.4 MB UTF-8 EACH
    const cjk = "\u4e2d".repeat(800_000);
    w.append("graph_delta", { cjk }, "u1");
    w.append("graph_delta", { cjk }, "u2");
    const files = await w.flush();
    expect(files.length).toBeGreaterThan(1);
    for (const f of files) {
      expect((await fs.stat(`${DIR}/${f}`))?.size ?? 0).toBeLessThanOrEqual(3 * 1024 * 1024);
    }
    const fold = await foldLedger(fs, DIR);
    expect(fold.records).toHaveLength(2);
  });

  test("a SINGLE record past the budget is skipped+warned (unsplittable line), never poisons the buffer", async () => {
    const w = new LedgerWriter(fs, DIR, "A");
    const huge = "x".repeat(3_500_000); // one 3.5 MB ASCII line
    w.append("graph_delta", { huge }, "u1");
    w.append("graph_delta", { ok: true }, "u2");
    const files = await w.flush();
    expect(files).toHaveLength(1); // only the small record landed
    expect(w.skippedOversized).toBe(1);
    const fold2 = await foldLedger(fs, DIR);
    expect(fold2.records).toHaveLength(1);
    expect(fold2.records[0]?.payload).toEqual({ ok: true });
    // the buffer drained fully — later flushes are clean
    expect(w.pendingCount()).toBe(0);
    expect(await w.flush()).toEqual([]);
  });
});

describe("ledger — partial-flush retry contract", () => {
  test("a mid-flush write failure keeps the unwritten tail retryable, no duplication after retry", async () => {
    const flaky = makeFlakyWrite(fs, 1);
    const w = new LedgerWriter(flaky, DIR, "A");
    w.append("graph_delta", { i: 1 }, "u1");
    w.append("graph_delta", { i: 2 }, "u2");
    await expect(w.flush()).rejects.toThrow("disk full");
    // the whole tail is retryable (nothing was durable)
    expect(w.pendingCount()).toBe(2);
    const files = await w.flush();
    expect(files.length).toBeGreaterThanOrEqual(1);
    expect(w.pendingCount()).toBe(0);
    const fold = await foldLedger(fs, DIR);
    expect(fold.records).toHaveLength(2); // each record exactly once
  });

  test("[small, huge, small] with a failed write loses NOTHING (the pre-filter regression)", async () => {
    const flaky = makeFlakyWrite(fs, 1);
    const w = new LedgerWriter(flaky, DIR, "A");
    w.append("graph_delta", { i: 1 }, "u1");
    w.append("graph_delta", { huge: "x".repeat(3_500_000) }, "u2"); // skipped as oversized
    w.append("graph_delta", { i: 3 }, "u3");
    await expect(w.flush()).rejects.toThrow("disk full");
    // BOTH fitting records survive in the buffer (the huge one is skipped)
    const buffered = w.bufferedRecords();
    expect(buffered.map((r) => (r.payload as { i: number }).i)).toEqual([1, 3]);
    await w.flush();
    const fold = await foldLedger(fs, DIR);
    expect(fold.records.map((r) => (r.payload as { i: number }).i)).toEqual([1, 3]);
  });

  test("appends arriving DURING a flush await are kept (never overwritten)", async () => {
    const parked = makeParkedWrite(fs);
    const slow = parked.fs;
    const w = new LedgerWriter(slow, DIR, "A");
    w.append("graph_delta", { i: 1 }, "u1");
    const flushing = w.flush();
    await new Promise((r) => setTimeout(r, 2)); // the write is parked
    w.append("graph_delta", { i: 2 }, "u2"); // arrives mid-flush
    parked.release();
    await flushing;
    // the mid-flush append (i:2) was never part of this flush — it stays
    // buffered for the NEXT one (kept, never dropped)
    expect(w.bufferedRecords().map((r) => (r.payload as { i: number }).i)).toEqual([2]);
    await w.flush();
    const fold = await foldLedger(fs, DIR);
    expect(fold.records.map((r) => (r.payload as { i: number }).i)).toEqual([1, 2]);
  });
});

describe("ledger — tolerant fold", () => {
  test("corrupt lines are skipped and counted; unreadable files reported", async () => {
    await fs.writeText(
      `${DIR}/ledger-good.jsonl`,
      '{"producerId":"A","seq":1,"ts":1,"marker":"u1","kind":"usage","payload":{}}\nnot-json\n',
    );
    await fs.writeText(`${DIR}/ledger-truncated.jsonl`, '{"producerId":"A","seq":2,"ts":2,"mar'); // crash-cut line
    const fold = await foldLedger(fs, DIR);
    expect(fold.records).toHaveLength(1);
    expect(fold.skippedLines).toBe(2);
    expect(fold.unreadableFiles).toEqual([]);
  });
});
