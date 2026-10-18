// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// The mirror suite: per-flush batch files, anchor rewrite, roll-margin split,
// the sweep (uuid->file map + anchors), absent-from-mirror checks, tolerant
// reads of crash-truncated batches.
import { beforeEach, describe, expect, test } from "vitest";
import { byteLength, createMemoryFs, ROLL_MARGIN } from "../../host/storage/fs-adapter.js";
import {
  findUuidFile,
  type MirroredRow,
  MirrorWriter,
  mirrorAnchorName,
  mirrorBatchName,
  producer8,
  sweepMirror,
} from "../../host/storage/mirror.js";
import { makeFlakyWrite, makeParkedWrite } from "./helpers.js";

const mem = createMemoryFs();
const fs = mem.adapter;
const DIR = "/sess";

function row(uuid: string, parentUuid: string | null, size = 0): MirroredRow {
  return { uuid, parentUuid, row: { text: size > 0 ? "y".repeat(size) : `row-${uuid}` } };
}

beforeEach(() => {
  mem.files.clear();
});

describe("mirror — writer", () => {
  test("flush writes one NEW m<seq>-<producer8>.jsonl per turn-flush, seq per process", async () => {
    const w = new MirrorWriter(fs, DIR, "proc-abc");
    w.bufferRow(row("u1", null));
    w.bufferRow(row("u2", "u1"));
    const f1 = await w.flush();
    const p8 = producer8("proc-abc");
    expect(f1).toEqual([mirrorBatchName(1, p8, 0)]);
    w.bufferRow(row("u3", "u2"));
    const f2 = await w.flush();
    expect(f2).toEqual([mirrorBatchName(2, p8, 0)]);
    const listing = await fs.listDir(DIR);
    expect(listing.filter((n) => /^m\d+-/.test(n))).toHaveLength(2);
  });

  test("the anchor is rewritten per flush: {lastUuid, seq} tracks the newest batch", async () => {
    const w = new MirrorWriter(fs, DIR, "proc-abc");
    const p8 = producer8("proc-abc");
    w.bufferRow(row("u1", null));
    await w.flush();
    expect(JSON.parse(mem.peek(`${DIR}/${mirrorAnchorName(p8)}`) ?? "{}")).toEqual({ lastUuid: "u1", seq: 1 });
    w.bufferRow(row("u2", "u1"));
    w.bufferRow(row("u3", "u2"));
    await w.flush();
    expect(JSON.parse(mem.peek(`${DIR}/${mirrorAnchorName(p8)}`) ?? "{}")).toEqual({ lastUuid: "u3", seq: 2 });
  });

  test("empty flush writes no batch but keeps the anchor", async () => {
    const w = new MirrorWriter(fs, DIR, "proc-x");
    w.bufferRow(row("u1", null));
    await w.flush();
    expect(await w.flush()).toEqual([]);
    const listing = await fs.listDir(DIR);
    expect(listing.filter((n) => /^m\d+-/.test(n))).toHaveLength(1);
    expect(w.anchorState()).toEqual({ lastUuid: "u1", seq: 1 });
  });

  test("huge turns split at the roll margin into continuation files (same seq)", async () => {
    const w = new MirrorWriter(fs, DIR, "proc-abc");
    const p8 = producer8("proc-abc");
    for (let i = 0; i < 4; i += 1) {
      w.bufferRow(row(`u${i}`, i === 0 ? null : `u${i - 1}`, 1024 * 1024));
    }
    const files = await w.flush();
    expect(files.length).toBeGreaterThan(1);
    expect(files[0]).toBe(mirrorBatchName(1, p8, 0));
    expect(files[1]).toBe(mirrorBatchName(1, p8, 1));
    for (const f of files) {
      expect((await fs.stat(`${DIR}/${f}`))?.size ?? 0).toBeLessThanOrEqual(3 * 1024 * 1024);
    }
  });
});

describe("mirror — producer tag + corrupted edges", () => {
  test("producer8 emits 16 hex chars and discriminates near-ids", () => {
    const a = producer8("proc-1");
    const b = producer8("proc-2");
    expect(a).toMatch(/^[0-9a-f]{16}$/);
    expect(a).not.toBe(b);
  });

  test("a parentUuid cycle degrades to the linear fallback (no hang)", async () => {
    const w = new MirrorWriter(fs, DIR, "proc-A");
    w.bufferRow({ uuid: "x", parentUuid: "y", row: {} });
    w.bufferRow({ uuid: "y", parentUuid: "x", row: {} });
    expect(w.chainTo("x")).toBeNull();
    expect(w.arrivalOrder()).toEqual(["x", "y"]);
  });
});

describe("mirror — oversized rows (the design's rare boundary case)", () => {
  test("a row past the budget alone goes to numbered part files; the sweep rejoins it", async () => {
    const w = new MirrorWriter(fs, DIR, "proc-big");
    const bigRow = { uuid: "big1", parentUuid: null, row: { blob: "y".repeat(3_500_000) } };
    w.bufferRow(bigRow);
    w.bufferRow({ uuid: "small1", parentUuid: "big1", row: { ok: true } });
    const files = await w.flush();
    expect(w.oversizedRows).toBe(1);
    expect(files).toHaveLength(1); // the batch carries the reassembly line + the small row
    // the batch line itself stayed small
    const batchText = mem.peek(`${DIR}/${files[0]}`) ?? "";
    expect(byteLength(batchText)).toBeLessThan(ROLL_MARGIN);
    // part files exist
    const listing = await fs.listDir(DIR);
    const partFiles = listing.filter((n) => n.includes(".r0.p"));
    expect(partFiles.length).toBeGreaterThanOrEqual(2);
    // the sweep rejoins: the big row comes back whole
    const sweep = await sweepMirror(fs, DIR);
    expect(sweep.rows.map((r) => r.uuid)).toEqual(["big1", "small1"]);
    expect(sweep.rows[0]?.row).toEqual(bigRow.row);
  });
});

describe("mirror — partial-flush retry contract", () => {
  test("a mid-flush write failure keeps the unwritten rows retryable, no duplication", async () => {
    const flaky = makeFlakyWrite(fs, 1);
    const w = new MirrorWriter(flaky, DIR, "proc-A");
    w.bufferRow(row("u1", null));
    w.bufferRow(row("u2", "u1"));
    await expect(w.flush()).rejects.toThrow("disk full");
    expect(w.pendingRows().map((r) => r.uuid)).toEqual(["u1", "u2"]);
    await w.flush();
    const sweep = await sweepMirror(fs, DIR);
    expect(sweep.rows.map((r) => r.uuid)).toEqual(["u1", "u2"]); // exactly once
  });

  test("appends arriving DURING a flush await are kept (never overwritten)", async () => {
    const parkedFs = makeParkedWrite(fs);
    const slow = parkedFs.fs;
    const w = new MirrorWriter(slow, DIR, "proc-A");
    w.bufferRow(row("u1", null));
    const flushing = w.flush();
    await new Promise((r) => setTimeout(r, 2));
    w.bufferRow(row("u2", "u1")); // arrives mid-flush
    parkedFs.release();
    await flushing;
    // u2 survived the flush (still buffered for the next one)
    expect(w.pendingRows().map((r) => r.uuid)).toEqual(["u2"]);
    await w.flush();
    const sweep = await sweepMirror(fs, DIR);
    expect(sweep.rows.map((r) => r.uuid)).toEqual(["u1", "u2"]);
  });
});

describe("mirror — sweep (first-recall fill)", () => {
  test("arrivalSlice returns the inclusive uuid range in ONE walk (missing/reversed endpoints null)", () => {
    const w = new MirrorWriter(fs, DIR, "sliceProducer");
    for (const u of ["a", "b", "c", "d"]) {
      w.bufferRow({ uuid: u, parentUuid: null, row: {} });
    }
    expect(w.arrivalSlice("b", "d")).toEqual(["b", "c", "d"]); // inclusive
    expect(w.arrivalSlice("a", "a")).toEqual(["a"]); // degenerate range
    expect(w.arrivalSlice("d", "b")).toBeNull(); // reversed
    expect(w.arrivalSlice("a", "zz")).toBeNull(); // unknown endpoint
    expect(w.arrivalSlice("zz", "a")).toBeNull();
  });

  test("rowVersion is monotonic across bufferRow, re-delivery and adoptRows", () => {
    const w = new MirrorWriter(fs, DIR, "verProducer");
    const v0 = w.rowVersion();
    w.bufferRow({ uuid: "a", parentUuid: null, row: { t: 1 } });
    const v1 = w.rowVersion();
    w.bufferRow({ uuid: "a", parentUuid: null, row: { t: 2 } }); // in-place refresh
    const v2 = w.rowVersion();
    w.adoptRows([{ uuid: "b", parentUuid: null, row: { t: 3 } }]);
    const v3 = w.rowVersion();
    expect(v1).toBeGreaterThan(v0);
    expect(v2).toBeGreaterThan(v1); // the same-length refresh MOVED the version
    expect(v3).toBeGreaterThan(v2);
  });

  test("sweep reads all batches in order, builds uuid->file and anchors", async () => {
    const wA = new MirrorWriter(fs, DIR, "proc-A");
    const wB = new MirrorWriter(fs, DIR, "proc-B");
    wA.bufferRow(row("a1", null));
    wA.bufferRow(row("a2", "a1"));
    await wA.flush();
    wB.bufferRow(row("b1", "a2"));
    await wB.flush();
    const sweep = await sweepMirror(fs, DIR);
    expect(sweep.rows.map((r) => r.uuid)).toEqual(["a1", "a2", "b1"]);
    expect(sweep.uuidFile.get("b1")).toBe(mirrorBatchName(1, producer8("proc-B"), 0));
    expect(sweep.anchors.get(producer8("proc-A"))).toEqual({ lastUuid: "a2", seq: 1 });
    expect(sweep.anchors.get(producer8("proc-B"))).toEqual({ lastUuid: "b1", seq: 1 });
  });

  test("absent-from-mirror check: known uuid resolves its file, unknown is null", async () => {
    const w = new MirrorWriter(fs, DIR, "proc-A");
    w.bufferRow(row("u1", null));
    await w.flush();
    const sweep = await sweepMirror(fs, DIR);
    expect(findUuidFile(sweep, "u1")).toBe(mirrorBatchName(1, producer8("proc-A"), 0));
    expect(findUuidFile(sweep, "never-seen")).toBeNull();
  });

  test("a crash-truncated trailing line is dropped; earlier rows survive", async () => {
    const w = new MirrorWriter(fs, DIR, "proc-A");
    w.bufferRow(row("u1", null));
    await w.flush();
    const name = `${DIR}/${mirrorBatchName(1, producer8("proc-A"), 0)}`;
    const text = (await fs.readText(name)) ?? "";
    await fs.writeText(name, `${text}{"uuid":"u2","parentUuid":"u1"`);
    const sweep = await sweepMirror(fs, DIR);
    expect(sweep.rows.map((r) => r.uuid)).toEqual(["u1"]);
  });

  test("a corrupt anchor is ignored (hint data only); batch rows unaffected", async () => {
    const w = new MirrorWriter(fs, DIR, "proc-A");
    w.bufferRow(row("u1", null));
    await w.flush();
    await fs.writeText(`${DIR}/${mirrorAnchorName(producer8("proc-A"))}`, "{corrupt");
    const sweep = await sweepMirror(fs, DIR);
    expect(sweep.anchors.size).toBe(0);
    expect(sweep.rows).toHaveLength(1);
  });
});

describe("patchEdges — the exact-edge true-up over arrival inferences", () => {
  test("a file chain through uncaptured chrome resolves onto the nearest captured ancestor", () => {
    const w = new MirrorWriter(fs, DIR, "proc-pe");
    // live capture shape: envelope rows carry NO parentUuid — the arrival
    // inference chains them linearly
    w.bufferRow(row("u1", null));
    w.bufferRow(row("a1", null));
    w.bufferRow(row("u2", null));
    // the transcript pass hands the FILE's exact edges: u2 actually chains
    // through a system row (s1) that the mirror never carries
    w.patchEdges([
      { uuid: "u1", parent: null },
      { uuid: "a1", parent: "u1" },
      { uuid: "s1", parent: "a1" },
      { uuid: "u2", parent: "s1" },
    ]);
    expect(w.chainTo("u2")).toEqual(["u1", "a1", "u2"]); // resolved through s1
  });

  test("a rewound branch re-links: the stale tail leaves the chain", () => {
    const w = new MirrorWriter(fs, DIR, "proc-pe2");
    w.bufferRow(row("u1", null));
    w.bufferRow(row("dead1", null));
    w.bufferRow(row("new1", null)); // inference chained it onto dead1's tail
    w.patchEdges([
      { uuid: "u1", parent: null },
      { uuid: "dead1", parent: "u1" },
      { uuid: "new1", parent: "u1" }, // the rewind: new1 chains to u1
    ]);
    expect(w.chainTo("new1")).toEqual(["u1", "new1"]);
  });

  test("rows the edges do not mention keep their current parents", () => {
    const w = new MirrorWriter(fs, DIR, "proc-pe3");
    w.bufferRow(row("u1", null));
    w.bufferRow(row("a1", "u1"));
    w.patchEdges([{ uuid: "u1", parent: null }]);
    expect(w.chainTo("a1")).toEqual(["u1", "a1"]);
  });

  test("a REGION BOUNDARY (a null-parent row mid-history — the engine restarts the parent chain after each compaction) continues to the earlier arrivals", () => {
    // Post-compaction rows parent at null (or at a summary row never
    // delivered): the walk must not treat a mid-history null root as the
    // branch's true start — the pre-boundary arrivals are the branch's
    // prefix (same inferred-edge rule as the unknown-parent gap).
    const w = new MirrorWriter(fs, DIR, "proc-region");
    w.bufferRow(row("r1", null));
    w.bufferRow(row("r2", "r1"));
    w.bufferRow(row("r3", "r2"));
    // the compaction boundary: r4 starts a fresh chain
    w.bufferRow(row("r4", null));
    w.bufferRow(row("r5", "r4"));
    expect(w.chainTo("r5")).toEqual(["r1", "r2", "r3", "r4", "r5"]);
  });

  test("a mid-chain GAP (an unknown parent — the engine's compaction summary row) never amputates the prefix: the walk continues from the nearest earlier arrival", () => {
    // The live collapse shape: the engine parents the post-compaction rows
    // on a summary row it never delivers through session.append — the
    // mirror cannot know it. A parent walk that STOPS at the gap would
    // serve only the post-gap tail (every older record + snapshot falling
    // off the branch, the reload starting from an empty base). The
    // inferred-edge rule applies instead: the nearest EARLIER arrival
    // continues the chain.
    const w = new MirrorWriter(fs, DIR, "proc-gap1");
    w.bufferRow(row("u1", null));
    w.bufferRow(row("u2", "u1"));
    w.bufferRow(row("u3", "u2"));
    // the gap: u4's parent is the engine's summary row (never mirrored)
    w.bufferRow(row("u4", "summary-row-not-in-mirror"));
    w.bufferRow(row("u5", "u4"));
    expect(w.chainTo("u5")).toEqual(["u1", "u2", "u3", "u4", "u5"]);
    // a gap at the very start walks back to the first arrival
    const w2 = new MirrorWriter(fs, DIR, "proc-gap2");
    w2.bufferRow(row("v1", "unknown-root"));
    w2.bufferRow(row("v2", "v1"));
    expect(w2.chainTo("v2")).toEqual(["v1", "v2"]);
  });
});

describe("servedBranch — the leaf path plus attached parallel rows", () => {
  const trRow = (uuid: string, parent: string): MirroredRow => ({
    uuid,
    parentUuid: parent,
    row: { message: { content: [{ type: "tool_result", tool_use_id: uuid, content: "ok" }] } },
  });
  test("a parallel tool result parented at its own tool_use stays served", () => {
    // the engine's parallel-tool shape: two chained tool_use rows; each
    // result parents at its own tool_use; the conversation continues through
    // one of them
    const w = new MirrorWriter(fs, DIR, "proc-sb");
    w.bufferRow(row("u1", null));
    w.bufferRow(row("a1", "u1"));
    w.bufferRow(row("a2", "a1"));
    w.bufferRow(trRow("tr1", "a1")); // parallel sibling — OFF the leaf path
    w.bufferRow(trRow("tr2", "a2"));
    w.bufferRow(row("a3", "tr2"));
    expect(w.chainTo("a3")).toEqual(["u1", "a1", "a2", "tr2", "a3"]); // strict path
    expect(w.servedBranch("a3")).toEqual(["u1", "a1", "a2", "tr1", "tr2", "a3"]);
  });

  test("attachment is ONE level — a dead fork's subtree under an attached row stays off", () => {
    const w = new MirrorWriter(fs, DIR, "proc-sb2");
    // the engine's write order: the on-chain continuation row is written
    // BEFORE the turn's results arrive
    w.bufferRow(row("u1", null));
    w.bufferRow(row("a2", "u1"));
    w.bufferRow(trRow("tr1", "u1")); // attached parallel row
    w.bufferRow(trRow("deep1", "tr1")); // a subtree under it — not served
    expect(w.servedBranch("a2")).toEqual(["u1", "a2", "tr1"]);
  });

  test("a SAME-parent parallel batch: both results of one tool_use row stay served", () => {
    // two tool_use blocks in ONE assistant row; BOTH results parent at that
    // row; the conversation continues through the LAST result — the first
    // result arrives BEFORE the on-chain sibling and must not be mistaken
    // for an orphaned reply
    const w = new MirrorWriter(fs, DIR, "proc-sb4");
    w.bufferRow(row("u1", null));
    w.bufferRow(row("a1", "u1")); // the assistant row (two tool_use blocks)
    w.bufferRow(trRow("r1", "a1")); // result of block pt1 — arrives first
    w.bufferRow(trRow("r2", "a1")); // result of block pt2 — ON the leaf path
    w.bufferRow(row("u2", "r2"));
    expect(w.chainTo("u2")).toEqual(["u1", "a1", "r2", "u2"]);
    expect(w.servedBranch("u2")).toEqual(["u1", "a1", "r1", "r2", "u2"]);
  });

  test("the orphaned-reply shape stays skipped: a result the engine passed by is dead", () => {
    // the engine skipped the reply and attached the NEXT TURN to the
    // parent — the earlier off-path result is dead, not parallel (the
    // on-chain continuation is a turn row, not a sibling result)
    const w = new MirrorWriter(fs, DIR, "proc-sb5");
    w.bufferRow(row("u1", null));
    w.bufferRow(trRow("rDead", "u1")); // passed by — dead
    w.bufferRow(row("u2", "u1")); // the chain continued through the parent
    expect(w.servedBranch("u2")).toEqual(["u1", "u2"]);
  });

  test("unknown leaf falls back to null (the caller degrades to arrival order)", () => {
    const w = new MirrorWriter(fs, DIR, "proc-sb3");
    w.bufferRow(row("u1", null));
    expect(w.servedBranch("nope")).toBeNull();
  });
});
