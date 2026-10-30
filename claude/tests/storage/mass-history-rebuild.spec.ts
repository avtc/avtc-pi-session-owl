// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// The mass-history rebuild regression: a many-boundary session (duplicate
// re-materialized generations, the compaction-tail shape) boots with EVERY
// record kept (the fold never drops), a within-generation rewind verdict
// kills only that generation's dead tail (the boundary cap + the live-CHECK
// quarantine window), and the reloaded graph serves the whole surviving
// history under a SANE root view — the orphan explosion (thousands of
// roots from mid-graph record drops) is structurally gone.
import { beforeEach, describe, expect, test } from "vitest";
import { encodeObservation } from "../../core/src/store/codecs.js";
import { makeObservation, type NodeId, type ObsId } from "../../core/src/types.js";
import { resolveLiveSet } from "../../host/rewind/checkpoint-service.js";
import { applyLiveRewind } from "../../host/rewind/live-rewind.js";
import { createMemoryFs } from "../../host/storage/fs-adapter.js";
import { LedgerWriter } from "../../host/storage/ledger.js";
import { type MirroredRow, MirrorWriter } from "../../host/storage/mirror.js";
import type { SessionStorage } from "../../host/storage/session-storage.js";
import { prepareStoreContext, sweepSession } from "../../host/storage/store-context.js";

const mem = createMemoryFs();
const fs = mem.adapter;

function row(uuid: string, parentUuid: string | null): MirroredRow {
  return { uuid, parentUuid, row: { role: "user", content: `row ${uuid}` } };
}

function obsPayload(obsIds: string[]): unknown {
  return {
    coversFromId: obsIds[0] ?? "",
    coversUpToId: obsIds[0] ?? "",
    tokenCount: 1,
    records: obsIds.map((id) =>
      encodeObservation(
        makeObservation({
          id: id as ObsId,
          summary: `summary ${id}`,
          importance: "med",
          sourceEntryIds: [id],
          timestamp: "2026-10-06T00:00:00.000Z",
          parentNode: "nSession" as unknown as NodeId,
        }),
      ),
    ),
  };
}

/** The many-boundary shape: originals + G generations, each generation's
 *  fresh rows rooted at its boundary ceremony edge (parent null) in the
 *  lineage ledger; ONE session root node; one observation per generation
 *  (marked on that generation's tail row); a live CHECK on the newest
 *  generation's mid row BEFORE the amputated tail's record. */
async function buildMassSession(dir: string, generations: number): Promise<SessionStorage> {
  let ts = 1000;
  const clock = () => (ts += 1);
  const ledger = new LedgerWriter(fs, dir, "boot-1", clock);
  const mirror = new MirrorWriter(fs, dir, "boot-1");
  const edges: Array<{ uuid: string; parent: string | null }> = [];
  mirror.bufferRow(row("o1", null));
  mirror.bufferRow(row("o2", "o1"));
  mirror.bufferRow(row("o3", "o2"));
  edges.push({ uuid: "o1", parent: null }, { uuid: "o2", parent: "o1" }, { uuid: "o3", parent: "o2" });
  ledger.append(
    "graph_delta",
    {
      kind: "graph_delta",
      delta: {
        type: "create_node",
        id: "nSession",
        summary: "session root",
        importance: "high",
        parentNode: null,
        state: "active",
      },
    },
    "seed",
  );
  for (let g = 1; g <= generations; g += 1) {
    const a = `g${g}a`;
    const mid = `g${g}b`;
    const tail = `g${g}c`;
    mirror.bufferRow(row(a, null)); // arrival follows the previous generation (the boundary re-roots the chain)
    mirror.bufferRow(row(mid, a));
    mirror.bufferRow(row(tail, mid));
    edges.push(
      { uuid: `b${g}`, parent: null },
      { uuid: a, parent: `b${g}` },
      { uuid: mid, parent: a },
      { uuid: tail, parent: mid },
    );
    if (g === generations) {
      // the live checkpoint precedes the amputated turn (the observer's
      // every-N cadence): marked on the mid row, LIVE at the verdict
      ledger.append("CHECK", null, mid);
    }
    ledger.append("observation", obsPayload([`obs-g${g}`]), tail);
  }
  ledger.append("lineage", { edges }, `g${generations}c`);
  await ledger.flush();
  await mirror.flush();
  return { fs, dir, ledger, mirror } as SessionStorage;
}

describe("the many-boundary mass-history rebuild", () => {
  beforeEach(() => {
    mem.files.clear();
  });

  test("boot keeps every record; a within-generation verdict kills only that tail; the root view stays one root", async () => {
    const dir = "/mass";
    const gens = 5;
    const storage = await buildMassSession(dir, gens);

    // --- BOOT: sweep the file, prepare, load the graph (the resume shape)
    const sweep = await sweepSession(fs, dir);
    expect(sweep.rows.length).toBeGreaterThan(0);
    const mirror2 = new MirrorWriter(fs, dir, "boot-3");
    mirror2.adoptRows(sweep.rows);
    const prepared = await prepareStoreContext(fs, dir, new LedgerWriter(fs, dir, "boot-3"), mirror2);
    const graphStore = await import("../../core/src/store/graph-store.js");
    await graphStore.load(prepared.ctx);
    let store = graphStore.getGraphStore();
    // the boot fold keeps EVERY observation from EVERY generation
    const bootObs = [...store.graph.observations.values()].map((o) => o.id).sort();
    expect(bootObs).toEqual(["obs-g1", "obs-g2", "obs-g3", "obs-g4", "obs-g5"]);
    const { nonObsoleteRoots } = await import("../../core/src/graph/read-tools.js");
    expect(nonObsoleteRoots(store.graph).map((n) => n.id)).toEqual(["nSession"]);

    // --- THE VERDICT: a rewind inside the NEWEST generation (settle g5b)
    const settle = "g5b";
    const liveOrder = await resolveLiveSet(storage, settle);
    expect(liveOrder[0]).toBe("b5"); // the live path roots at the newest boundary
    expect(liveOrder).toEqual(["b5", "g5a", "g5b"]);
    const knownOrder = mirror2.arrivalOrder();
    await applyLiveRewind(
      {
        abortAndAwaitInFlight: async () => {},
        liveOrderFor: async () => liveOrder,
        deadPath: async () => knownOrder.filter((u) => !liveOrder.includes(u)),
        knownOrder: () => knownOrder,
        refold: async (liveSet, order, dead) => {
          prepared.setLiveBranch(order, dead);
          await prepared.refresh((uuid) => liveSet.has(uuid));
          return { quarantined: prepared.recordsRef.quarantinedDropped };
        },
        onDivergence: () => {},
        log: () => {},
      },
      { settle },
    );

    // --- RELOAD: a fresh boot over the same store. The fold keeps every
    // record (deletion is never the mechanism), so the process-start
    // check RE-DETECTS the rewind and re-applies the (capped) verdict —
    // exactly the resume flow. Then the root-view sanity holds.
    const mirror3 = new MirrorWriter(fs, dir, "boot-4");
    mirror3.adoptRows(sweep.rows);
    const prepared2 = await prepareStoreContext(fs, dir, new LedgerWriter(fs, dir, "boot-4"), mirror3);
    await graphStore.load(prepared2.ctx);
    store = graphStore.getGraphStore();
    // the fresh boot serves EVERYTHING again (no silent boot drops)
    expect([...store.graph.observations.values()].map((o) => o.id).sort()).toEqual([
      "obs-g1",
      "obs-g2",
      "obs-g3",
      "obs-g4",
      "obs-g5",
    ]);
    const knownOrder2 = mirror3.arrivalOrder();
    const liveOrder2 = await resolveLiveSet(storage, settle);
    await applyLiveRewind(
      {
        abortAndAwaitInFlight: async () => {},
        liveOrderFor: async () => liveOrder2,
        deadPath: async () => knownOrder2.filter((u) => !liveOrder2.includes(u)),
        knownOrder: () => knownOrder2,
        refold: async (liveSet, order, dead) => {
          prepared2.setLiveBranch(order, dead);
          await prepared2.refresh((uuid) => liveSet.has(uuid));
          return { quarantined: prepared2.recordsRef.quarantinedDropped };
        },
        onDivergence: () => {},
        log: () => {},
      },
      { settle },
    );
    await graphStore.load(prepared2.ctx);
    store = graphStore.getGraphStore();
    const afterObs = [...store.graph.observations.values()].map((o) => o.id).sort();
    // the pre-boundary generations ALL survive; only the dead tail's record
    // (after the last live CHECK) is quarantined by the verdict
    expect(afterObs).toEqual(["obs-g1", "obs-g2", "obs-g3", "obs-g4"]);
    // ONE root, not one-per-orphan: the surviving history loads under the
    // session root and the root view never explodes
    expect(nonObsoleteRoots(store.graph).map((n) => n.id)).toEqual(["nSession"]);
  });
});
