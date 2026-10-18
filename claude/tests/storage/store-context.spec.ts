// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// The Claude StoreContext suite: the pi contract over the ledger + mirror,
// branch reconstruction (parentUuid chain + linear fallback), record
// interleaving after marker rows (the liveness rule), snapshot -> compaction
// entries, the buffered-records live view, and the crown integration — the
// real graph-store load() running on this adapter.
import { beforeEach, describe, expect, test } from "vitest";
import { _setBaseLoggerForTest } from "../../core/src/log.js";
import {
  encodeObservation,
  GRAPH_DELTA_TYPE,
  OBSERVATION_TYPE,
  type ObservationEntry,
  RESCAN_TYPE,
} from "../../core/src/store/codecs.js";
import type { StoreEntry } from "../../core/src/store/graph-store.js";
import { makeObservation, type NodeId, type ObsId } from "../../core/src/types.js";
import { createMemoryFs } from "../../host/storage/fs-adapter.js";
import { LedgerWriter } from "../../host/storage/ledger.js";
import { type MirroredRow, MirrorWriter } from "../../host/storage/mirror.js";
import { newSnapshotId, persistSnapshotText } from "../../host/storage/snapshot.js";
import {
  branchForLeaf,
  type PreparedContext,
  prepareStoreContext,
  ROW_TYPE,
  SESSION_MARKER_FILENAME,
} from "../../host/storage/store-context.js";

const mem = createMemoryFs();
const fs = mem.adapter;
const DIR = "/sess";

function row(uuid: string, parentUuid: string | null): MirroredRow {
  return { uuid, parentUuid, row: { role: "user", content: `row ${uuid}` } };
}

function obsEntry(from: string, to: string, obsIds: string[]): ObservationEntry {
  return {
    coversFromId: from,
    coversUpToId: to,
    tokenCount: 1,
    records: obsIds.map((id) =>
      encodeObservation(
        makeObservation({
          id: id as ObsId,
          summary: `summary ${id}`,
          importance: "med",
          sourceEntryIds: [id],
          timestamp: "2026-10-06T00:00:00.000Z",
          parentNode: "n1" as unknown as NodeId,
        }),
      ),
    ),
  };
}

async function setup(): Promise<{ ledger: LedgerWriter; mirror: MirrorWriter; prepared: PreparedContext }> {
  const ledger = new LedgerWriter(fs, DIR, "proc-1", () => 1000);
  const mirror = new MirrorWriter(fs, DIR, "proc-1");
  const prepared = await prepareStoreContext(fs, DIR, ledger, mirror);
  return { ledger, mirror, prepared };
}

beforeEach(() => {
  mem.files.clear();
});

describe("store-context — the pi contract", () => {
  test("an append stays BUFFERED until a unit flush — no write-through (unit-commit cadence)", async () => {
    const { ledger, prepared } = await setup();
    prepared.ctx.appendEntry(GRAPH_DELTA_TYPE, { op: "create_node" });
    // settle the fire-and-forget window: nothing may reach a file on its own
    await new Promise((resolve) => setTimeout(resolve, 5));
    const landed = () => [...mem.files.values()].filter((text) => text.includes('"graph_delta"'));
    expect(landed()).toHaveLength(0); // buffered (was 1 under write-through)
    await ledger.flush();
    expect(landed()).toHaveLength(1); // the unit flush delivers it
  });

  test("one flush writes ONE file carrying every buffered record (coalesced unit set)", async () => {
    const { ledger, prepared } = await setup();
    prepared.ctx.appendEntry(GRAPH_DELTA_TYPE, { op: "create_node" });
    prepared.ctx.appendEntry(OBSERVATION_TYPE, obsEntry("u1", "u2", ["o1"]));
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect([...mem.files.values()].filter((t) => t.includes('"graph_delta"'))).toHaveLength(0);
    await ledger.flush();
    const files = [...mem.files.entries()].filter(([path]) => path.includes("/ledger-"));
    expect(files).toHaveLength(1);
    expect(files[0][1]).toContain('"graph_delta"');
    expect(files[0][1]).toContain('"observation"');
  });

  test("the on-disk prefix is coherent: each flush lands a whole record set, the tail only at its unit flush", async () => {
    const { ledger, prepared } = await setup();
    prepared.ctx.appendEntry(GRAPH_DELTA_TYPE, { op: "mv", id: "a" });
    await ledger.flush();
    prepared.ctx.appendEntry(GRAPH_DELTA_TYPE, { op: "mv", id: "b" });
    await new Promise((resolve) => setTimeout(resolve, 5));
    const text = () => [...mem.files.values()].filter((t) => t.includes('"graph_delta"')).join("\n");
    expect(text()).toContain('"id":"a"');
    expect(text()).not.toContain('"id":"b"'); // the buffered tail never half-lands
    await ledger.flush();
    expect(text()).toContain('"id":"b"');
  });

  test("appendEntry maps the pi custom types to ledger kinds at the right markers", async () => {
    const { mirror, prepared } = await setup();
    mirror.bufferRow(row("u1", null));
    mirror.bufferRow(row("u2", "u1"));
    prepared.ctx.appendEntry(OBSERVATION_TYPE, obsEntry("u1", "u2", ["o1"]));
    prepared.ctx.appendEntry(GRAPH_DELTA_TYPE, { op: "create_node" });
    // verify via the branch: both records appear after their marker rows
    const branch = prepared.ctx.getBranch("u2");
    const kinds = branch.map((e: StoreEntry) => (e.type === "custom" ? e.customType : e.type));
    // the observation's marker is its range END (coversUpToId = u2): it sits
    // after u2's row; the delta rides the live tip (also u2), fold order after
    expect(kinds).toEqual([ROW_TYPE, ROW_TYPE, OBSERVATION_TYPE, GRAPH_DELTA_TYPE]);
    expect(branch[0]?.id).toBe("u1");
    expect(branch[1]?.id).toBe("u2");
    expect(branch[2]).toMatchObject({ customType: OBSERVATION_TYPE });
    expect(branch[3]).toMatchObject({ customType: GRAPH_DELTA_TYPE });
  });

  test("getLeafId tracks the live tip; null before any row", async () => {
    const { mirror, prepared } = await setup();
    expect(prepared.ctx.getLeafId()).toBeNull();
    mirror.bufferRow(row("u1", null));
    expect(prepared.ctx.getLeafId()).toBe("u1");
    mirror.bufferRow(row("u2", "u1"));
    expect(prepared.ctx.getLeafId()).toBe("u2");
  });

  test("getBranch walks the parentUuid chain to the asked leaf (dead tail drops out)", async () => {
    const { mirror, prepared } = await setup();
    mirror.bufferRow(row("u1", null));
    mirror.bufferRow(row("u2", "u1"));
    mirror.bufferRow(row("u3", "u2"));
    const branch = prepared.ctx.getBranch("u2");
    expect(branch.map((e) => e.id)).toEqual(["u1", "u2"]);
    // a record marker on the dead tail is skipped (the liveness rule)
    const ledger2 = new LedgerWriter(fs, DIR, "other");
    ledger2.append("graph_delta", { op: 1 }, "u3");
    await ledger2.flush();
    const p2 = await prepareStoreContext(fs, DIR, new LedgerWriter(fs, DIR, "x"), mirror);
    const branch2 = p2.ctx.getBranch("u2");
    expect(branch2.map((e: StoreEntry) => (e.type === "custom" ? e.customType : e.type))).toEqual([ROW_TYPE, ROW_TYPE]);
    // ...and the full branch keeps it
    const branch3 = p2.ctx.getBranch("u3");
    expect(branch3.map((e: StoreEntry) => (e.type === "custom" ? e.customType : e.type))).toEqual([
      ROW_TYPE,
      ROW_TYPE,
      ROW_TYPE,
      GRAPH_DELTA_TYPE,
    ]);
  });

  test("an unknown leaf falls back to the linear arrival order", async () => {
    const { mirror, prepared } = await setup();
    mirror.bufferRow(row("u1", null));
    mirror.bufferRow(row("u2", "u1"));
    const branch = prepared.ctx.getBranch("not-a-known-uuid");
    expect(branch.map((e) => e.id)).toEqual(["u1", "u2"]);
    expect(branchForLeaf(mirror, null)).toEqual(["u1", "u2"]);
  });
});

describe("store-context — ordering vs liveness (the two position fields)", () => {
  test("a post-rescan re-observe (backward coversUpToId) survives the rescan voiding", async () => {
    const ledger = new LedgerWriter(fs, DIR, "p", () => 1000);
    const mirror = new MirrorWriter(fs, DIR, "p");
    const prepared = await prepareStoreContext(fs, DIR, ledger, mirror);
    mirror.bufferRow(row("u1", null));
    mirror.bufferRow(row("u2", "u1"));
    // an observation covering u1..u2, written at tip u2
    prepared.ctx.appendEntry(OBSERVATION_TYPE, obsEntry("u1", "u2", ["o1"]));
    // a plain rescan at tip u2 (voids structure at/before u2)
    prepared.ctx.appendEntry(RESCAN_TYPE, { mode: "plain" });
    await ledger.flush();
    await mirror.flush();
    // post-rescan re-observe: covers BACKWARD (u1..u1) but written at tip u2
    const p2 = await prepareStoreContext(fs, DIR, ledger, mirror);
    p2.ctx.appendEntry(OBSERVATION_TYPE, obsEntry("u1", "u1", ["o2"]));
    const graphStore = await import("../../core/src/store/graph-store.js");
    await p2.refresh();
    await graphStore.load(p2.ctx);
    const store = graphStore.getGraphStore();
    // BOTH observations must survive: the rescan voids the PRE-rescan
    // observation o1 (structure ledger rules per pi), but the POST-rescan
    // re-observe o2 must NOT be voided by index position
    const ids = [...store.graph.observations.values()].map((o) => o.id).sort();
    expect(ids).toContain("o2");
    expect(store.observerFrontier).toBe("u1");
  });
});

describe("store-context — snapshots", () => {
  test("a flushed snapshot rides as ONE compaction entry after its marker row", async () => {
    const ledger = new LedgerWriter(fs, DIR, "p", () => 5);
    const mirror = new MirrorWriter(fs, DIR, "p");
    mirror.bufferRow(row("u1", null));
    mirror.bufferRow(row("u2", "u1"));
    const snapId = newSnapshotId();
    await persistSnapshotText(
      fs,
      DIR,
      ledger,
      snapId,
      JSON.stringify({ type: "session-owl", version: "v1", nodes: [] }),
      "u2",
    );
    await ledger.flush();
    const prepared = await prepareStoreContext(fs, DIR, new LedgerWriter(fs, DIR, "live"), mirror);
    const branch = prepared.ctx.getBranch("u2");
    const compaction = branch.find((e) => e.type === "compaction");
    expect(compaction).toBeDefined();
    expect((compaction as { details?: unknown }).details).toEqual({ type: "session-owl", version: "v1", nodes: [] });
    expect(branch[branch.length - 1]).toBe(compaction); // after its marker row u2
  });
});

describe("store-context — session marker", () => {
  test("the .session.json marker double-write is benign (whole-file replace, same shape)", async () => {
    // the production write is an inline whole-file replace ($.fs has no
    // append) — the marker path joins the filename constant
    const write = (marker: { sessionId: string; transcriptPath: string | null }) =>
      fs.writeText(
        `${DIR}/${SESSION_MARKER_FILENAME}`,
        `${JSON.stringify(marker)}
`,
      );
    await write({ sessionId: "s1", transcriptPath: "/t.jsonl" });
    const first = mem.peek(`${DIR}/${SESSION_MARKER_FILENAME}`);
    await write({ sessionId: "s1", transcriptPath: "/t2.jsonl" });
    const second = JSON.parse(mem.peek(`${DIR}/${SESSION_MARKER_FILENAME}`) ?? "{}");
    expect(first).toContain('"sessionId":"s1"');
    expect(second).toEqual({ sessionId: "s1", transcriptPath: "/t2.jsonl" });
  });
});

describe("store-context — blind-window quarantine scope (start + detection only)", () => {
  test("in-process writes past a CHECK stay durable-visible to plain swap re-folds (the mutation-visibility defect)", async () => {
    const ledger = new LedgerWriter(fs, DIR, "bw", () => 1000);
    const mirror = new MirrorWriter(fs, DIR, "bw");
    mirror.bufferRow(row("u1", null));
    await mirror.flush();
    // construction FIRST (fresh session — no CHECK yet, nothing to quarantine)
    const p = await prepareStoreContext(fs, DIR, ledger, mirror);
    // then the turn closes its CHECK and stage writes land past it (all
    // flushed immediately — write-through)
    ledger.append("CHECK", null, "u1");
    ledger.append("graph_delta", { test: "past-check" }, "u1");
    await ledger.flush();
    const holdsPastCheck = () =>
      p.recordsRef.flushed.some((r) => (r.payload as { test?: string } | null | undefined)?.test === "past-check");
    // an ordinary in-process swap re-fold: the record is durable and its
    // marker row is live — a re-load must NEVER amputate it (mid-turn
    // stage writes are invisible to every later run if this drops)
    await p.refresh();
    expect(holdsPastCheck()).toBe(true);
  });

  test("the start fold KEEPS records past the last CHECK", async () => {
    const ledger = new LedgerWriter(fs, DIR, "bw2", () => 1000);
    const mirror = new MirrorWriter(fs, DIR, "bw2");
    mirror.bufferRow(row("u1", null));
    await mirror.flush();
    ledger.append("CHECK", null, "u1");
    ledger.append("graph_delta", { test: "crash-window" }, "u1");
    await ledger.flush(); // both rows belong to a process that is now gone
    const p = await prepareStoreContext(fs, DIR, ledger, mirror);
    const holds = () =>
      p.recordsRef.flushed.some((r) => (r.payload as { test?: string } | null | undefined)?.test === "crash-window");
    // process start has no transcript, so no liveness predicate exists — the
    // start fold must NOT evaluate the blind window (a plain resume owns live
    // work past the last CHECK: mid-gate stage writes, snapshots). Dropping it
    // here would amputate persisted work on every resume and force catch-up
    // from 0.
    expect(p.recordsRef.quarantinedDropped).toBe(0);
    expect(holds()).toBe(true);
    await p.refresh();
    expect(holds()).toBe(true); // and a plain re-fold keeps it
  });

  test("a detection refold applies the window and its verdict sticks after plain re-folds", async () => {
    const ledger = new LedgerWriter(fs, DIR, "bw3", () => 1000);
    const mirror = new MirrorWriter(fs, DIR, "bw3");
    mirror.bufferRow(row("u1", null));
    await mirror.flush();
    const p = await prepareStoreContext(fs, DIR, ledger, mirror);
    ledger.append("CHECK", null, "u1");
    ledger.append("graph_delta", { test: "detection-window" }, "u1");
    await ledger.flush();
    const holds = () =>
      p.recordsRef.flushed.some(
        (r) => (r.payload as { test?: string } | null | undefined)?.test === "detection-window",
      );
    // detection path: the live-set override re-evaluates the blind window
    await p.refresh(() => true);
    expect(p.recordsRef.quarantinedDropped).toBe(1);
    expect(holds()).toBe(false);
    // the verdict persists across the next ordinary swap re-fold
    await p.refresh();
    expect(holds()).toBe(false);
  });
});

describe("store-context — THE INTEGRATION (graph-store load on this adapter)", () => {
  test("persist via the ctx, reload through the REAL core load(): graph + frontier restored", async () => {
    // --- process 1: rows u1..u3, an observation covering u1..u2
    const ledger1 = new LedgerWriter(fs, DIR, "proc-1", () => 1000);
    const mirror1 = new MirrorWriter(fs, DIR, "proc-1");
    const p1 = await prepareStoreContext(fs, DIR, ledger1, mirror1);
    mirror1.bufferRow(row("u1", null));
    mirror1.bufferRow(row("u2", "u1"));
    mirror1.bufferRow(row("u3", "u2"));
    p1.ctx.appendEntry(OBSERVATION_TYPE, obsEntry("u1", "u2", ["o1", "o2"]));
    await ledger1.flush();
    await mirror1.flush();

    // --- process 2 (restart): sweep the mirror, prepare fresh, LOAD
    const sweep = await (await import("../../host/storage/store-context.js")).sweepSession(fs, DIR);
    const mirror2 = new MirrorWriter(fs, DIR, "proc-2");
    mirror2.adoptRows(sweep.rows);
    const p2 = await prepareStoreContext(fs, DIR, new LedgerWriter(fs, DIR, "proc-2"), mirror2);
    const graphStore = await import("../../core/src/store/graph-store.js");
    const result = await graphStore.load(p2.ctx);
    const store = graphStore.getGraphStore();
    const obsIds = [...store.graph.observations.values()].map((o) => o.id).sort();
    expect(obsIds).toEqual(["o1", "o2"]);
    // the frontier names the observation's coversUpToId — a row ON the branch
    expect(store.observerFrontier).toBe("u2");
    expect(result).toBeDefined();
  });

  test("a snapshot whose delta replay is inconsistent falls back to the next-older snapshot (the load never cements a damaged base)", async () => {
    // THE COLLAPSE SHAPE: a compaction persisted
    // a snapshot over an already-collapsed fold; the deltas that follow
    // reference nodes only the OLDER snapshot carries. The newest snapshot
    // wins by rule — its replay hits inapplicable deltas — so the load must
    // RETRY on the next-older snapshot and replay ALL deltas after it (the
    // ops are never pruned; the full stream rebuilds the true state).
    const ledger1 = new LedgerWriter(fs, DIR, "proc-fb", () => 1000);
    const mirror1 = new MirrorWriter(fs, DIR, "proc-fb");
    const p1 = await prepareStoreContext(fs, DIR, ledger1, mirror1);
    mirror1.bufferRow(row("u1", null));
    mirror1.bufferRow(row("u2", "u1"));
    p1.ctx.appendEntry(OBSERVATION_TYPE, obsEntry("u1", "u2", ["o1"]));
    await ledger1.flush();
    await mirror1.flush();
    // snapshot A (the healthy base): one node n1 holding o1
    const obsA = makeObservation({
      id: "o1",
      parentNode: "n1",
      summary: "obs one",
      importance: "med",
      sourceEntryIds: ["u1"],
      timestamp: "2026-10-11T10:00:00.000Z",
    });
    const detailsA = {
      type: "session-owl",
      version: "v1",
      nodes: [
        {
          id: "n1",
          summary: "node one",
          summaryTokens: 3,
          state: "active",
          importance: "med",
          parentNode: null,
          observationIds: ["o1"],
          childNodeIds: [],
          supersededBy: null,
          timestamps: {
            createdAt: "2026-10-11T10:00:00.000Z",
            updatedAt: "2026-10-11T10:00:00.000Z",
            rangeStart: "2026-10-11T10:00:00.000Z",
            rangeEnd: "2026-10-11T10:00:00.000Z",
          },
        },
      ],
      oInitialPrompt: null,
      nextObsId: 2,
      nextNodeId: 2,
      selectedTree: null,
      lastCompactionLedger: null,
      compactionStages: {},
      observations: [obsA],
    };
    await persistSnapshotText(fs, DIR, ledger1, "snapA", JSON.stringify(detailsA), "u2");
    // snapshot B (the damaged base): NO nodes — a collapsed fold
    const detailsB = { ...detailsA, nodes: [], observations: [] };
    await persistSnapshotText(fs, DIR, ledger1, "snapB", JSON.stringify(detailsB), "u2");
    // a delta AFTER B that references n1 (merge n1 into itself — applicable
    // only over a base that HAS n1)
    p1.ctx.appendEntry(GRAPH_DELTA_TYPE, {
      kind: "graph_delta",
      delta: { type: "set_meta", nodeId: "n1", importance: "high", archived: null, obsolete: null, summary: null },
    });
    await ledger1.flush();
    // restart: sweep + load
    const sweep = await (await import("../../host/storage/store-context.js")).sweepSession(fs, DIR);
    const mirror2 = new MirrorWriter(fs, DIR, "proc-fb2");
    mirror2.adoptRows(sweep.rows);
    const p2 = await prepareStoreContext(fs, DIR, new LedgerWriter(fs, DIR, "proc-fb2"), mirror2);
    const graphStore = await import("../../core/src/store/graph-store.js");
    const result = await graphStore.load(p2.ctx);
    const store = graphStore.getGraphStore();
    // the fallback base (A) + the replay: n1 SURVIVES with the applied delta
    expect([...store.graph.nodes.keys()]).toContain("n1");
    expect(store.graph.nodes.get("n1")?.importance).toBe("high");
    expect(result.skippedDeltas).toBe(0);
  });

  test("a restart KEEPS a snapshot persisted past the last CHECK", async () => {
    // THE RESUME SHAPE: a normal turn closed its
    // CHECK; the compaction catch-up then persisted a NEW snapshot + deltas
    // past it (mid-gate writes carry no CHECK of their own); /exit; resume.
    // A start-fold blind window would amputate EVERYTHING past the CHECK —
    // the newest snapshot included — leaving the load to delta-replay a
    // divergent base (catch-up from 0, sticky duplicate-create deltas). The
    // start fold must keep the records.
    const ledger1 = new LedgerWriter(fs, DIR, "proc-resume", () => 1000);
    const mirror1 = new MirrorWriter(fs, DIR, "proc-resume");
    const p1 = await prepareStoreContext(fs, DIR, ledger1, mirror1);
    mirror1.bufferRow(row("u1", null));
    mirror1.bufferRow(row("u2", "u1"));
    p1.ctx.appendEntry(OBSERVATION_TYPE, obsEntry("u1", "u2", ["o1"]));
    // the normal turn boundary: CHECK at u2
    ledger1.append("CHECK", null, "u2");
    await ledger1.flush();
    await mirror1.flush();
    // --- the mid-gate work (no further CHECK ever lands): a snapshot carrying n1+o1
    const obsA = makeObservation({
      id: "o1",
      parentNode: "n1",
      summary: "obs one",
      importance: "med",
      sourceEntryIds: ["u1"],
      timestamp: "2026-10-16T10:00:00.000Z",
    });
    const details = {
      type: "session-owl",
      version: "v1",
      nodes: [
        {
          id: "n1",
          summary: "node one",
          summaryTokens: 3,
          state: "active",
          importance: "med",
          parentNode: null,
          observationIds: ["o1"],
          childNodeIds: [],
          supersededBy: null,
          timestamps: {
            createdAt: "2026-10-16T10:00:00.000Z",
            updatedAt: "2026-10-16T10:00:00.000Z",
            rangeStart: "2026-10-16T10:00:00.000Z",
            rangeEnd: "2026-10-16T10:00:00.000Z",
          },
        },
      ],
      oInitialPrompt: null,
      nextObsId: 2,
      nextNodeId: 2,
      selectedTree: null,
      lastCompactionLedger: null,
      compactionStages: {},
      observations: [obsA],
    };
    await persistSnapshotText(fs, DIR, ledger1, "snapResume", JSON.stringify(details), "u2");
    p1.ctx.appendEntry(GRAPH_DELTA_TYPE, {
      kind: "graph_delta",
      delta: { type: "set_meta", nodeId: "n1", importance: "high", archived: null, obsolete: null, summary: null },
    });
    await ledger1.flush();
    // --- restart (resume): sweep + fresh context + load
    const sweep = await (await import("../../host/storage/store-context.js")).sweepSession(fs, DIR);
    const mirror2 = new MirrorWriter(fs, DIR, "proc-resume2");
    mirror2.adoptRows(sweep.rows);
    const p2 = await prepareStoreContext(fs, DIR, new LedgerWriter(fs, DIR, "proc-resume2"), mirror2);
    expect(p2.recordsRef.quarantinedDropped).toBe(0); // nothing amputated at start
    const graphStore = await import("../../core/src/store/graph-store.js");
    const result = await graphStore.load(p2.ctx);
    const store = graphStore.getGraphStore();
    // the newest snapshot materializes (n1 from the snapshot, not a replay)
    expect([...store.graph.nodes.keys()]).toContain("n1");
    expect(store.graph.nodes.get("n1")?.importance).toBe("high");
    expect([...store.graph.observations.keys()]).toEqual(["o1"]);
    expect(result.skippedDeltas).toBe(0);
  });

  test("a second observation appends live and survives its own reload", async () => {
    const ledger1 = new LedgerWriter(fs, DIR, "proc-1", () => 1000);
    const mirror1 = new MirrorWriter(fs, DIR, "proc-1");
    const p1 = await prepareStoreContext(fs, DIR, ledger1, mirror1);
    mirror1.bufferRow(row("u1", null));
    mirror1.bufferRow(row("u2", "u1"));
    p1.ctx.appendEntry(OBSERVATION_TYPE, obsEntry("u1", "u2", ["o1"]));
    await ledger1.flush();
    await mirror1.flush();

    // more rows + a second observation, in the SAME process (live buffer view)
    mirror1.bufferRow(row("u3", "u2"));
    p1.ctx.appendEntry(OBSERVATION_TYPE, obsEntry("u2", "u3", ["o2"]));
    await p1.refresh(); // the ctxFactory pattern: re-fold before the next load
    const graphStore = await import("../../core/src/store/graph-store.js");
    await graphStore.load(p1.ctx);
    const store = graphStore.getGraphStore();
    expect([...store.graph.observations.values()].map((o) => o.id).sort()).toEqual(["o1", "o2"]);
    expect(store.observerFrontier).toBe("u3");
  });
});

describe("observation batch refs (the ids-drill shortcut)", () => {
  test("an observation over flushed rows carries their mirror batch refs; unflushed rows contribute none", async () => {
    const mem2 = createMemoryFs();
    const dir = "/sess-refs";
    const mirror = new MirrorWriter(mem2.adapter, dir, "refProducer");
    const ledger = new LedgerWriter(mem2.adapter, dir, "refProducer");
    const r1 = { uuid: "u1", parentUuid: null, row: { t: 1 } };
    const r2 = { uuid: "u2", parentUuid: "u1", row: { t: 2 } };
    const r3 = { uuid: "u3", parentUuid: "u2", row: { t: 3 } };
    mirror.bufferRow(r1);
    mirror.bufferRow(r2);
    await mirror.flush(); // u1+u2 in batch seq 1
    mirror.bufferRow(r3); // u3 still buffered
    const prepared = await prepareStoreContext(mem2.adapter, dir, ledger, mirror);
    prepared.ctx.appendEntry("session-owl.observation", {
      coversFromId: "u1",
      coversUpToId: "u3",
      records: [],
      tokenCount: 0,
    });
    const recs = ledger.liveRecords(); // must serve appends already drained to disk
    const obs = recs.find((r) => r.kind === "observation");
    expect(obs).toBeDefined();
    const refs = (obs as unknown as { batchRefs?: Array<{ producer: string; seq: number }> }).batchRefs;
    expect(refs).toEqual([{ producer: "refProducer", seq: 1 }]); // u3 carries no ref (unflushed)
    // the referenced batch is REAL and covers the range's rows
    const names = await mem2.adapter.listDir(dir);
    expect(names).toContain(`m1-${(await import("../../host/storage/mirror.js")).producer8("refProducer")}.jsonl`);
    await prepared.ctx.appendEntry("session-owl.observation", {
      coversFromId: "u1",
      coversUpToId: "u1",
      records: [],
      tokenCount: 0,
    });
    const second = ledger
      .liveRecords()
      .filter((r) => r.kind === "observation")
      .pop();
    expect((second as unknown as { batchRefs?: unknown }).batchRefs).toEqual([{ producer: "refProducer", seq: 1 }]);
  });
});

// ---- the RESTORE-FORK served-branch contract -----------------------------------
// A restore fork never removes transcript rows (the engine keeps the whole
// file), so every row — abandoned and kept — is PRESENT in the mirror.
// Liveness therefore comes solely from the SERVED BRANCH: sibling-branch rows
// drop out of getBranch, records marked on them stop serving with one
// `branch-drop` trace per context, while the records themselves stay in the
// ledger files (never rewritten — deletion is not the mechanism; the fold is).
describe("store-context — the restore-fork served-branch contract", () => {
  /** alpha → (fork) γ and alpha → β in one mirror, with one observation per
   *  branch and a seeded nGoal created while the tip sits on the served chain. */
  async function forkFixture(dir: string): Promise<{
    ledger: LedgerWriter;
    mirror: MirrorWriter;
    prepared: PreparedContext;
  }> {
    const ledger = new LedgerWriter(fs, dir, "fork-1", () => 1000);
    const mirror = new MirrorWriter(fs, dir, "fork-1");
    const p = await prepareStoreContext(fs, dir, ledger, mirror);
    mirror.bufferRow(row("a1", null));
    mirror.bufferRow(row("a2", "a1"));
    // root created while the chain tip sits ON the served branch
    p.ctx.appendEntry(GRAPH_DELTA_TYPE, {
      kind: "graph_delta",
      delta: { type: "create_node", id: "nGoal", summary: "", importance: "crit", parentNode: null, state: "active" },
    });
    // the abandoned beta turn
    mirror.bufferRow(row("b1", "a2"));
    mirror.bufferRow(row("b2", "b1"));
    p.ctx.appendEntry(OBSERVATION_TYPE, obsEntry("b1", "b2", ["oB"]));
    // the forked re-send: a SIBLING of the abandoned turn, parented at the pivot
    mirror.bufferRow(row("g1", "a2"));
    p.ctx.appendEntry(OBSERVATION_TYPE, obsEntry("a1", "a2", ["oA"]));
    await ledger.flush();
    await mirror.flush();
    return { ledger, mirror, prepared: p };
  }

  test("getBranch serves alpha+fork only: beta rows excluded, the beta-marked record dropped with ONE branch-drop trace", async () => {
    const { prepared } = await forkFixture(`${DIR}-fork`);
    const warns: string[] = [];
    const prev = _setBaseLoggerForTest({
      info: () => {},
      warn: (m: string) => warns.push(m),
      error: () => {},
      debug: () => {},
    });
    try {
      const served = prepared.ctx.getBranch(prepared.ctx.getLeafId());
      const asKind = (e: StoreEntry): string =>
        e.type === "custom" ? ((e as { customType?: string }).customType ?? "custom") : e.type;
      const rowUuids = served.filter((e) => asKind(e) === ROW_TYPE).map((e) => e.id);
      expect(rowUuids).toEqual(["a1", "a2", "g1"]); // the abandoned branch stays off
      const customs = served.filter((e) => asKind(e) !== ROW_TYPE).map(asKind);
      expect(customs.filter((t) => t === GRAPH_DELTA_TYPE)).toHaveLength(1); // nGoal serves
      expect(customs.filter((t) => t === OBSERVATION_TYPE)).toHaveLength(1); // only oA — oB dropped
      // the silent-drop trace fired for the abandoned record, once
      const trace = warns.join("\n");
      expect(trace).toContain("branch-drop");
      expect(trace).toContain("b2");
      // a second render re-masks nothing (the once-per-context dedup)
      const warnsAfterFirst = warns.length;
      prepared.ctx.getBranch(prepared.ctx.getLeafId());
      expect(warns.length).toBe(warnsAfterFirst);
    } finally {
      _setBaseLoggerForTest(prev);
    }
  });

  test("the forked graph LOADS: nGoal stays a live root, only the alpha observation belongs (the /owl-ls serving leg)", async () => {
    const dir = `${DIR}-fork-load`;
    await forkFixture(dir);
    // process 2 (restart shape): sweep the mirror, prepare fresh, REAL load
    const sweepMod = await import("../../host/storage/store-context.js");
    const sweep = await sweepMod.sweepSession(fs, dir);
    const mirror2 = new MirrorWriter(fs, dir, "proc-fork2");
    mirror2.adoptRows(sweep.rows);
    const p2 = await prepareStoreContext(fs, dir, new LedgerWriter(fs, dir, "proc-fork2"), mirror2);
    const graphStore = await import("../../core/src/store/graph-store.js");
    await graphStore.load(p2.ctx);
    const store = graphStore.getGraphStore();
    // the observation load sees belongs to the LIVE branch only
    const obsIds = [...store.graph.observations.values()].map((o) => o.id).sort();
    expect(obsIds).toEqual(["oA"]);
    // nGoal anchors the roots listing (the input to /owl-ls' roots arm)
    const { nonObsoleteRoots } = await import("../../core/src/graph/read-tools.js");
    const roots = nonObsoleteRoots(store.graph);
    expect(roots.map((n) => n.id)).toContain("nGoal");
  });
});
