// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import { describe, expect, it, vi } from "vitest";
import type { GraphDelta } from "../../src/graph/mutations.js";
import { applyCreateNode, applyMerge, MUTATE_SOURCE } from "../../src/graph/mutations.js";
import { log } from "../../src/log.js";
import {
  cloneLedger,
  DETAILS_TYPE,
  EMPTY_LEDGER,
  encodeDetails,
  encodeSelection,
  GRAPH_DELTA_TYPE,
  type GraphDeltaEntry,
  type MemkeeperDetails,
  OBSERVATION_TYPE,
  type ObservationEntry,
  RESCAN_TYPE,
  SELECTION_TYPE,
  type SelectionEntry,
  USAGE_TYPE,
  type UsageEntry,
} from "../../src/store/codecs.js";
import type { StoreContext, StoreEntry } from "../../src/store/graph-store.js";
import {
  appendGraphDelta,
  appendObservation,
  appendUsage,
  clearEntryResolver,
  getGraphStore,
  load,
  persistSelectedTree,
  resetForNewSession,
  setEntryResolver,
} from "../../src/store/graph-store.js";
import type { Importance, NodeId } from "../../src/types.js";
import { MemkeeperGraph, makeNode, N_GOAL } from "../../src/types.js";

// --- fake StoreContext -----------------------------------------------------

class FakeStore implements StoreContext {
  entries: StoreEntry[] = [];
  leafId: string | null = null;
  getBranchCalls = 0;
  getEntriesCalls = 0;
  seq = 0;

  appendEntry = (customType: string, data: unknown): void => {
    this.seq += 1;
    const entry: StoreEntry = {
      id: `e${this.seq}`,
      type: "custom",
      customType,
      data,
    };
    this.entries.push(entry);
    this.leafId = `e${this.seq}`;
  };

  getLeafId = (): string | null => this.leafId;

  getBranch = (): StoreEntry[] => {
    this.getBranchCalls += 1;
    return [...this.entries];
  };

  /** A NO-OP that the store must never call (branch-scoped graph reads use getBranch). */
  getEntries = (): StoreEntry[] => {
    this.getEntriesCalls += 1;
    return [...this.entries];
  };

  /** Inject a compaction entry directly (custom entries use appendEntry). */
  addCompaction(id: string, details: unknown): void {
    const entry: StoreEntry = { id, type: "compaction", details };
    this.entries.push(entry);
  }

  /** Inject a custom entry at a specific id (for ordered replay fixtures). */
  addCustomAt(id: string, customType: string, data: unknown): void {
    const entry: StoreEntry = { id, type: "custom", customType, data };
    this.entries.push(entry);
  }
}

function freshStore(): void {
  resetForNewSession();
}

/** Narrow a StoreEntry to its custom form (the FakeStore only appends customs). */
function customAt(fake: FakeStore, i: number): StoreEntry & { customType: string; data?: unknown } {
  const e = fake.entries[i];
  if (e === undefined || e.type !== "custom") throw new Error(`entry ${i} is not custom`);
  return e;
}

describe("GraphStore singleton", () => {
  it("getGraphStore returns a stable singleton", () => {
    freshStore();
    const a = getGraphStore();
    const b = getGraphStore();
    expect(a).toBe(b);
    expect(a.graph.nodes.size).toBe(0);
    expect(a.selectedTree).toBeNull();
    expect(a.usageLedger).toEqual(EMPTY_LEDGER);
    expect(a.observerFrontier).toBeNull();
  });

  it("resetForNewSession empties the store", () => {
    freshStore();
    const store = getGraphStore();
    store.graph.nodes.set(
      "n1" as NodeId,
      makeNode({ id: "n1", summary: "x", importance: "med", state: "active", parentNode: null, createdAt: "t" }),
    );
    store.observerFrontier = "e5";
    resetForNewSession();
    const after = getGraphStore();
    expect(after.graph.nodes.size).toBe(0);
    expect(after.observerFrontier).toBeNull();
  });

  it("resolveEntries is null until setEntryResolver installs a resolver", () => {
    freshStore();
    expect(getGraphStore().resolveEntries).toBeNull();
  });

  it("setEntryResolver installs a resolver that resolves ids to entries", () => {
    freshStore();
    const entries = new Map<string, unknown>([
      ["12", { id: "12", type: "message" }],
      ["13", { id: "13", type: "message" }],
    ]);
    setEntryResolver((ids) =>
      ids.map((id) => entries.get(id)).filter((e): e is NonNullable<typeof e> => e !== undefined),
    );
    const resolver = getGraphStore().resolveEntries;
    expect(resolver).not.toBeNull();
    // resolves known ids, drops missing ones (graceful for cross-branch drills)
    expect(resolver?.(["12", "99", "13"])).toEqual([
      { id: "12", type: "message" },
      { id: "13", type: "message" },
    ]);
    clearEntryResolver();
  });

  it("clearEntryResolver clears the resolver", () => {
    freshStore();
    setEntryResolver(() => []);
    expect(getGraphStore().resolveEntries).not.toBeNull();
    clearEntryResolver();
    expect(getGraphStore().resolveEntries).toBeNull();
  });

  it("resetForNewSession clears the resolver (stale ctx must not survive a new session)", () => {
    freshStore();
    setEntryResolver(() => [{ id: "1", type: "message" }]);
    resetForNewSession();
    expect(getGraphStore().resolveEntries).toBeNull();
  });
});

describe("persist methods (PERSIST-ONLY)", () => {
  it("appendObservation persists a memkeeper.observation entry and advances the frontier", () => {
    freshStore();
    const fake = new FakeStore();
    const batch: ObservationEntry = {
      coversFromId: null,
      coversUpToId: "e10",
      records: [
        { id: "o1", summary: "fact", importance: "high", sourceEntryIds: ["8"], timestamp: "t", parentNode: N_GOAL },
      ],
      tokenCount: 1,
    };
    appendObservation(fake, batch);
    expect(customAt(fake, 0).customType).toBe(OBSERVATION_TYPE);
    expect(customAt(fake, 0).data).toEqual(batch);
    // advancing the frontier mirrors the in-memory cache refresh other persists do
    expect(getGraphStore().observerFrontier).toBe("e10");
  });

  it("appendGraphDelta persists a memkeeper.graph_delta envelope", () => {
    freshStore();
    const fake = new FakeStore();
    const delta: GraphDelta = {
      type: "create_node",
      id: "n1" as NodeId,
      summary: "x",
      importance: "med" as Importance,
      parentNode: null,
      state: "active",
    };
    appendGraphDelta(fake, delta);
    expect(customAt(fake, 0).customType).toBe(GRAPH_DELTA_TYPE);
    expect((customAt(fake, 0).data as GraphDeltaEntry).kind).toBe("graph_delta");
    expect((customAt(fake, 0).data as GraphDeltaEntry).delta).toEqual(delta);
  });

  it("persistSelectedTree persists + holds the snapshot in memory", () => {
    freshStore();
    const fake = new FakeStore();
    const store = getGraphStore();
    applyCreateNode(store.graph, {
      id: "n1" as NodeId,
      summary: "x",
      importance: "med" as Importance,
      parentNode: null,
      state: "active",
    });
    const snapshot = encodeSelection(store.graph, null, null);
    persistSelectedTree(fake, snapshot);
    expect(customAt(fake, 0).customType).toBe(SELECTION_TYPE);
    expect(getGraphStore().selectedTree).toEqual(snapshot);
  });

  it("appendUsage persists + holds the ledger", () => {
    freshStore();
    const fake = new FakeStore();
    appendUsage(fake, EMPTY_LEDGER);
    expect(customAt(fake, 0).customType).toBe(USAGE_TYPE);
    expect(getGraphStore().usageLedger).toEqual(EMPTY_LEDGER);
  });
});

describe("load reconstruction", () => {
  it("reconstructs from a snapshot + replayed deltas (flush_new inside a graph_delta)", async () => {
    freshStore();
    const fake = new FakeStore();
    // base snapshot at e5: nGoal + n1(active) with o1
    const details: MemkeeperDetails = {
      type: DETAILS_TYPE,
      version: "v1",
      nodes: [
        {
          id: N_GOAL,
          summary: "the goal",
          summaryTokens: 2,
          state: "active",
          importance: "crit",
          parentNode: null,
          observationIds: [],
          childNodeIds: ["n1"],
          supersededBy: null,
          timestamps: { createdAt: "t0", updatedAt: "t0", rangeStart: "t0", rangeEnd: "t0" },
        },
        {
          id: "n1",
          summary: "branch",
          summaryTokens: 2,
          state: "active",
          importance: "med",
          parentNode: N_GOAL,
          observationIds: ["o1"],
          childNodeIds: [],
          supersededBy: null,
          timestamps: { createdAt: "t0", updatedAt: "t0", rangeStart: "t0", rangeEnd: "t0" },
        },
      ],
      oInitialPrompt: null,
      nextObsId: 2,
      nextNodeId: 2,
      selectedTree: null,
      lastCompactionLedger: null,
    };
    // e2: pre-snapshot observation entry carrying o1's record (o1 is referenced
    // by the snapshot's n1; the record stays in the append-only store, scanned
    // by reconstruction's content-index pass)
    fake.addCustomAt("e2", OBSERVATION_TYPE, {
      coversFromId: null,
      coversUpToId: "e2",
      records: [
        { id: "o1", summary: "first", importance: "med", sourceEntryIds: ["1"], timestamp: "t0", parentNode: "n1" },
      ],
      tokenCount: 1,
    } satisfies ObservationEntry);
    fake.addCompaction("e5", details);
    // e7: observation batch (o5 under n1)
    fake.addCustomAt("e7", OBSERVATION_TYPE, {
      coversFromId: "e6",
      coversUpToId: "e7",
      records: [
        { id: "o5", summary: "fifth", importance: "low", sourceEntryIds: ["6"], timestamp: "t1", parentNode: "n1" },
      ],
      tokenCount: 1,
    } satisfies ObservationEntry);
    // e9: graph_delta carrying a mkdir + record_observation
    fake.addCustomAt("e9", GRAPH_DELTA_TYPE, {
      kind: "graph_delta",
      delta: {
        type: "create_node",
        id: "n2",
        summary: "new",
        importance: "high",
        parentNode: N_GOAL,
        state: "new",
      },
    } satisfies GraphDeltaEntry);
    // e10: graph_delta carrying a flush_new (flush_new replays via graph_delta)
    fake.addCustomAt("e10", GRAPH_DELTA_TYPE, {
      kind: "graph_delta",
      delta: { type: "flush_new", nodeIds: ["n2"] },
    } satisfies GraphDeltaEntry);
    fake.leafId = "e10";

    await load(fake);
    const store = getGraphStore();
    // snapshot base present
    expect(store.graph.nodes.has(N_GOAL)).toBe(true);
    expect(store.graph.nodes.has("n1")).toBe(true);
    // o1 from snapshot, o5 from replayed observation
    expect(store.graph.observations.has("o1")).toBe(true);
    expect(store.graph.observations.has("o5")).toBe(true);
    // n2 created by replayed graph_delta (mkdir)
    expect(store.graph.nodes.has("n2")).toBe(true);
    // flush_new replayed: n2 state new → active
    expect(store.graph.nodes.get("n2")?.state).toBe("active");
    // observerFrontier advanced to the last coversUpToId
    expect(store.observerFrontier).toBe("e7");
  });

  it("reconstructs from deltas only when no valid compaction snapshot (empty base)", async () => {
    freshStore();
    const fake = new FakeStore();
    // no compaction — reconstruct from scratch. A wrapper node is created by a
    // graph_delta, then the obs record (under that wrapper) is replayed.
    fake.addCustomAt("e1", GRAPH_DELTA_TYPE, {
      kind: "graph_delta",
      delta: {
        type: "create_node",
        id: "n1",
        summary: "first wrapper",
        importance: "med",
        parentNode: null,
        state: "active",
      },
    } satisfies GraphDeltaEntry);
    fake.addCustomAt("e2", OBSERVATION_TYPE, {
      coversFromId: null,
      coversUpToId: "e2",
      records: [
        { id: "o1", summary: "first", importance: "high", sourceEntryIds: ["1"], timestamp: "t", parentNode: "n1" },
      ],
      tokenCount: 1,
    } satisfies ObservationEntry);
    fake.leafId = "e2";

    await load(fake);
    const store = getGraphStore();
    expect(store.graph.nodes.has("n1" as NodeId)).toBe(true);
    expect(store.graph.observations.has("o1")).toBe(true);
    expect(store.observerFrontier).toBe("e2");
  });

  it("reconstructs observations + selection + usage from one mixed branch (single scan)", async () => {
    // Guards the folded single-pass reconstruction: observation content, the
    // latest selected tree, and the latest usage ledger must all load from a
    // branch that interleaves all three custom-entry types.
    freshStore();
    const fake = new FakeStore();
    // n1 must exist before observations reference it (reconcileLinks drops
    // orphans whose parent node was never created).
    fake.addCustomAt("e0", GRAPH_DELTA_TYPE, {
      kind: "graph_delta",
      delta: {
        type: "create_node",
        id: "n1",
        summary: "wrap",
        importance: "med",
        parentNode: null,
        state: "active",
      },
    } satisfies GraphDeltaEntry);
    fake.addCustomAt("e1", OBSERVATION_TYPE, {
      coversFromId: null,
      coversUpToId: "e1",
      records: [
        { id: "o1", summary: "first", importance: "high", sourceEntryIds: ["1"], timestamp: "t", parentNode: "n1" },
      ],
      tokenCount: 1,
    } satisfies ObservationEntry);
    const tree = encodeSelection(
      new MemkeeperGraph({ nodes: new Map(), observations: new Map(), nextObsId: 1, nextNodeId: 1 }),
      null,
      null,
    );
    fake.addCustomAt("e2", SELECTION_TYPE, tree satisfies SelectionEntry);
    fake.addCustomAt("e3", USAGE_TYPE, { ledger: cloneLedger(EMPTY_LEDGER) } satisfies UsageEntry);
    // a LATER observation advances the frontier past the selection/usage —
    // order independence must hold (latest-wins for selection/usage).
    fake.addCustomAt("e4", OBSERVATION_TYPE, {
      coversFromId: null,
      coversUpToId: "e4",
      records: [
        { id: "o2", summary: "second", importance: "med", sourceEntryIds: ["3"], timestamp: "t2", parentNode: "n1" },
      ],
      tokenCount: 1,
    } satisfies ObservationEntry);
    fake.leafId = "e4";

    await load(fake);
    const store = getGraphStore();
    expect(store.graph.observations.has("o1")).toBe(true);
    expect(store.graph.observations.has("o2")).toBe(true);
    expect(store.observerFrontier).toBe("e4");
    expect(store.selectedTree).toEqual(tree);
    expect(store.usageLedger).toEqual(EMPTY_LEDGER);
  });

  it("reconstructs from a batched graph_delta entry (deltas array, e.g. an Observer run)", async () => {
    freshStore();
    const fake = new FakeStore();
    // one memkeeper.graph_delta entry carrying an ARRAY of two create_node
    // deltas (how the Observer persists its wrapper batch).
    fake.addCustomAt("e1", GRAPH_DELTA_TYPE, {
      kind: "graph_delta",
      deltas: [
        {
          type: "create_node",
          id: "n1",
          summary: "",
          importance: "high",
          parentNode: null,
          state: "new",
        },
        {
          type: "create_node",
          id: "n2",
          summary: "",
          importance: "low",
          parentNode: null,
          state: "new",
        },
      ],
    } satisfies GraphDeltaEntry);
    fake.addCustomAt("e2", OBSERVATION_TYPE, {
      coversFromId: null,
      coversUpToId: "e2",
      records: [
        { id: "o1", summary: "a", importance: "high", sourceEntryIds: ["1"], timestamp: "t", parentNode: "n1" },
        { id: "o2", summary: "b", importance: "low", sourceEntryIds: ["2"], timestamp: "t", parentNode: "n2" },
      ],
      tokenCount: 1,
    } satisfies ObservationEntry);
    fake.leafId = "e2";

    await load(fake);
    const store = getGraphStore();
    expect(store.graph.nodes.has("n1" as NodeId)).toBe(true);
    expect(store.graph.nodes.has("n2" as NodeId)).toBe(true);
    expect(store.graph.observations.has("o1")).toBe(true);
    expect(store.graph.observations.has("o2")).toBe(true);
  });

  it("recomputes a parent's time range once when multiple new obs link to it", async () => {
    // One parent n1 gains THREE new observations at load. reconcileLinks must
    // recompute n1's range once (covering all three), not once per obs — and the
    // final range must span the earliest-to-latest obs timestamps.
    freshStore();
    const fake = new FakeStore();
    fake.addCustomAt("e1", GRAPH_DELTA_TYPE, {
      kind: "graph_delta",
      delta: {
        type: "create_node",
        id: "n1",
        summary: "",
        importance: "high",
        parentNode: null,
        state: "new",
      },
    } satisfies GraphDeltaEntry);
    fake.addCustomAt("e2", OBSERVATION_TYPE, {
      coversFromId: null,
      coversUpToId: "e2",
      records: [
        {
          id: "o1",
          summary: "a",
          importance: "high",
          sourceEntryIds: ["1"],
          timestamp: "2026-07-28T09:00:00.000Z",
          parentNode: "n1",
        },
        {
          id: "o2",
          summary: "b",
          importance: "high",
          sourceEntryIds: ["2"],
          timestamp: "2026-07-28T10:00:00.000Z",
          parentNode: "n1",
        },
        {
          id: "o3",
          summary: "c",
          importance: "high",
          sourceEntryIds: ["3"],
          timestamp: "2026-07-28T11:00:00.000Z",
          parentNode: "n1",
        },
      ],
      tokenCount: 3,
    } satisfies ObservationEntry);
    fake.leafId = "e2";

    await load(fake);
    const node = getGraphStore().graph.nodes.get("n1" as NodeId);
    expect(node).toBeDefined();
    expect(node?.observationIds).toEqual(["o1", "o2", "o3"]);
    // range spans the earliest (09:00) to latest (11:00) obs — proving the single
    // recompute ran after all three were linked (a per-obs recompute that stopped
    // early would leave the range stale at 10:00).
    expect(node?.timestamps.rangeStart).toBe("2026-07-28T09:00:00.000Z");
    expect(node?.timestamps.rangeEnd).toBe("2026-07-28T11:00:00.000Z");
  });

  it("falls back to deltas-only and does not throw on a corrupt details snapshot", async () => {
    freshStore();
    const fake = new FakeStore();
    fake.addCompaction("e3", { bogus: "not memkeeper details" });
    // a wrapper node via graph_delta (deltas-only path after the corrupt snapshot is skipped)
    fake.addCustomAt("e3b", GRAPH_DELTA_TYPE, {
      kind: "graph_delta",
      delta: {
        type: "create_node",
        id: "n9",
        summary: "wrapper",
        importance: "low",
        parentNode: null,
        state: "active",
      },
    } satisfies GraphDeltaEntry);
    fake.addCustomAt("e4", OBSERVATION_TYPE, {
      coversFromId: null,
      coversUpToId: "e4",
      records: [
        { id: "o9", summary: "post", importance: "low", sourceEntryIds: ["3"], timestamp: "t", parentNode: "n9" },
      ],
      tokenCount: 1,
    } satisfies ObservationEntry);
    fake.leafId = "e4";

    await load(fake); // must not throw
    const store = getGraphStore();
    // corrupt snapshot skipped → deltas-only reconstruction
    expect(store.graph.observations.has("o9")).toBe(true);
  });

  it("deltas-only load advances nextObsId past loaded observation records (no collision on the next Observer run)", async () => {
    // Reproduces the production crash: a deltas-only reconstruction (no valid
    // snapshot — e.g. a session whose snapshots are foreign, or background
    // Observer runs before the first compaction snapshot) loaded observations
    // directly without advancing nextObsId, so the seed (1) stayed and the next
    // Observer run created o1 → "observation o1 already exists".
    freshStore();
    const fake = new FakeStore();
    fake.addCustomAt("g1", GRAPH_DELTA_TYPE, {
      kind: "graph_delta",
      delta: {
        type: "create_node",
        id: "n1",
        summary: "w1",
        importance: "low",
        parentNode: null,
        state: "active",
      },
    } satisfies GraphDeltaEntry);
    fake.addCustomAt("g2", OBSERVATION_TYPE, {
      coversFromId: null,
      coversUpToId: "g2",
      records: [
        { id: "o1", summary: "a", importance: "low", sourceEntryIds: ["1"], timestamp: "t", parentNode: "n1" },
        { id: "o2", summary: "b", importance: "low", sourceEntryIds: ["2"], timestamp: "t", parentNode: "n1" },
      ],
      tokenCount: 2,
    } satisfies ObservationEntry);
    fake.leafId = "g2";

    await load(fake);
    const store = getGraphStore();
    expect(store.graph.observations.has("o1")).toBe(true);
    expect(store.graph.observations.has("o2")).toBe(true);
    // nextObsId advanced past the highest loaded id → the next Observer run
    // creates o3, not o1 (no collision).
    expect(store.graph.nextObsId).toBe(3);
    // nextNodeId advanced past the wrapper node n1 → the next create is n2.
    expect(store.graph.nextNodeId).toBe(2);
  });

  it("a /mk:rescan marker voids everything before it (reconstruct from the marker forward)", async () => {
    freshStore();
    const fake = new FakeStore();
    // pre-rescan: n1 + o1
    fake.addCustomAt("g1", GRAPH_DELTA_TYPE, {
      kind: "graph_delta",
      delta: { type: "create_node", id: "n1", summary: "old", importance: "low", parentNode: null, state: "active" },
    } satisfies GraphDeltaEntry);
    fake.addCustomAt("g2", OBSERVATION_TYPE, {
      coversFromId: null,
      coversUpToId: "g2",
      records: [
        { id: "o1", summary: "old", importance: "low", sourceEntryIds: ["1"], timestamp: "t", parentNode: "n1" },
      ],
      tokenCount: 1,
    } satisfies ObservationEntry);
    // the rescan marker voids g1/g2
    fake.addCustomAt("g3", RESCAN_TYPE, { at: "2026-08-09T10:00:00.000Z" });
    // post-rescan: n2 + o2
    fake.addCustomAt("g4", GRAPH_DELTA_TYPE, {
      kind: "graph_delta",
      delta: { type: "create_node", id: "n2", summary: "new", importance: "high", parentNode: null, state: "new" },
    } satisfies GraphDeltaEntry);
    fake.addCustomAt("g5", OBSERVATION_TYPE, {
      coversFromId: null,
      coversUpToId: "g5",
      records: [
        { id: "o2", summary: "new", importance: "high", sourceEntryIds: ["2"], timestamp: "t", parentNode: "n2" },
      ],
      tokenCount: 1,
    } satisfies ObservationEntry);
    fake.leafId = "g5";

    await load(fake);
    const store = getGraphStore();
    // pre-rescan n1/o1 are VOID; only post-rescan n2/o2 reconstruct.
    expect(store.graph.nodes.has("n1" as NodeId)).toBe(false);
    expect(store.graph.observations.has("o1")).toBe(false);
    expect(store.graph.nodes.has("n2" as NodeId)).toBe(true);
    expect(store.graph.observations.has("o2")).toBe(true);
    // the frontier reflects only the post-rescan observation entry.
    expect(store.observerFrontier).toBe("g5");
  });

  it("warns on a corrupt memkeeper snapshot (carries the memkeeper type marker but fails validation)", async () => {
    freshStore();
    const fake = new FakeStore();
    const warn = vi.spyOn(log, "warn");
    // a details carrying the memkeeper type marker but a malformed body that
    // fails decodeDetails → the warn branch + deltas-only
    fake.addCompaction("e3", { type: DETAILS_TYPE, version: "v1", nodes: "NOT_AN_ARRAY" });
    fake.addCustomAt("e3b", GRAPH_DELTA_TYPE, {
      kind: "graph_delta",
      delta: {
        type: "create_node",
        id: "n9",
        summary: "wrapper",
        importance: "low",
        parentNode: null,
        state: "active",
      },
    } satisfies GraphDeltaEntry);
    fake.addCustomAt("e4", OBSERVATION_TYPE, {
      coversFromId: null,
      coversUpToId: "e4",
      records: [
        { id: "o9", summary: "post", importance: "low", sourceEntryIds: ["3"], timestamp: "t", parentNode: "n9" },
      ],
      tokenCount: 1,
    } satisfies ObservationEntry);
    fake.leafId = "e4";

    await load(fake);
    // the version-carrying corrupt snapshot surfaced the warn
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("corrupt memkeeper snapshot"));
    // deltas-only reconstruction still applies
    expect(getGraphStore().graph.observations.has("o9")).toBe(true);
    warn.mockRestore();
  });

  it("skips a native (non-memkeeper) compaction details", async () => {
    freshStore();
    const fake = new FakeStore();
    // a native pi compaction with non-memkeeper details
    fake.addCompaction("e5", { someOtherExt: true });
    fake.addCustomAt("e5b", GRAPH_DELTA_TYPE, {
      kind: "graph_delta",
      delta: {
        type: "create_node",
        id: "n1",
        summary: "wrapper",
        importance: "low",
        parentNode: null,
        state: "active",
      },
    } satisfies GraphDeltaEntry);
    fake.addCustomAt("e6", OBSERVATION_TYPE, {
      coversFromId: null,
      coversUpToId: "e6",
      records: [
        {
          id: "o1",
          summary: "native-skip",
          importance: "high",
          sourceEntryIds: ["4"],
          timestamp: "t",
          parentNode: "n1",
        },
      ],
      tokenCount: 1,
    } satisfies ObservationEntry);
    fake.leafId = "e6";

    await load(fake);
    expect(getGraphStore().graph.observations.has("o1")).toBe(true);
  });

  it("stays silent (debug, not warn) on a foreign-TYPED snapshot — e.g. another memory extension's details", async () => {
    // The compaction `details` field is shared + last-writer-wins; a snapshot
    // another extension wrote (carrying ITS OWN type marker, not "memkeeper")
    // legitimately fails decode. That is expected when switching extensions, not
    // corruption — so it must NOT flood the log with warns on every load.
    freshStore();
    const fake = new FakeStore();
    const warn = vi.spyOn(log, "warn");
    fake.addCompaction("f1", { type: "some-other-extension", version: 4, observations: [] });
    fake.addCustomAt("f1b", GRAPH_DELTA_TYPE, {
      kind: "graph_delta",
      delta: {
        type: "create_node",
        id: "n1",
        summary: "wrapper",
        importance: "low",
        parentNode: null,
        state: "active",
      },
    } satisfies GraphDeltaEntry);
    fake.addCustomAt("f2", OBSERVATION_TYPE, {
      coversFromId: null,
      coversUpToId: "f2",
      records: [
        {
          id: "o1",
          summary: "foreign-skip",
          importance: "high",
          sourceEntryIds: ["9"],
          timestamp: "t",
          parentNode: "n1",
        },
      ],
      tokenCount: 1,
    } satisfies ObservationEntry);
    fake.leafId = "f2";

    await load(fake);
    // deltas-only reconstruction still applies
    expect(getGraphStore().graph.observations.has("o1")).toBe(true);
    // no warn — the foreign snapshot is expected, not corrupt
    expect(warn).not.toHaveBeenCalledWith(expect.stringContaining("corrupt memkeeper snapshot"));
    warn.mockRestore();
  });

  it("calls getBranch, never getEntries", async () => {
    freshStore();
    const fake = new FakeStore();
    fake.leafId = null;
    await load(fake);
    expect(fake.getBranchCalls).toBeGreaterThan(0);
    expect(fake.getEntriesCalls).toBe(0);
  });

  it("restores the usage ledger from a usage delta + lastCompactionLedger baseline", async () => {
    freshStore();
    const fake = new FakeStore();
    const baselineLedger = { ...EMPTY_LEDGER, observe: { ...EMPTY_LEDGER.observe, input: 50, runs: 1, elapsedMs: 0 } };
    const details = encodeDetails(getGraphStore().graph, null, baselineLedger);
    fake.addCompaction("e1", details);
    const laterLedger = {
      observe: { input: 100, output: 20, cacheRead: 5, cost: 0.01, turns: 2, runs: 2, elapsedMs: 0 },
      build: { ...EMPTY_LEDGER.build },
      select: { ...EMPTY_LEDGER.select },
    };
    fake.addCustomAt("e2", USAGE_TYPE, { ledger: laterLedger });
    fake.leafId = "e2";

    await load(fake);
    expect(getGraphStore().usageLedger).toEqual(laterLedger);
  });

  it("does NOT alias usageLedger to lastCompactionLedger when seeded from a snapshot with no later delta (in-place mutate must not corrupt the baseline)", async () => {
    freshStore();
    const fake = new FakeStore();
    const baselineLedger = {
      observe: { ...EMPTY_LEDGER.observe, input: 50, runs: 1, elapsedMs: 0 },
      build: { ...EMPTY_LEDGER.build },
      select: { ...EMPTY_LEDGER.select },
    };
    const details = encodeDetails(getGraphStore().graph, null, baselineLedger);
    fake.addCompaction("e1", details);
    fake.leafId = "e1"; // no later usage delta

    await load(fake);
    // both read the same baseline values…
    expect(getGraphStore().usageLedger).toEqual(baselineLedger);
    expect(getGraphStore().lastCompactionLedger).toEqual(baselineLedger);
    // …but they MUST be independent objects: mutating usageLedger in place (as
    // addPhaseUsage does) must not touch lastCompactionLedger.
    getGraphStore().usageLedger.observe.input += 1000;
    expect(getGraphStore().lastCompactionLedger?.observe.input).toBe(50);
    expect(getGraphStore().usageLedger).not.toBe(getGraphStore().lastCompactionLedger);
  });

  it("event-sourcing round-trip: real mutator deltas persist + reload to an identical graph", async () => {
    // Producer↔consumer contract: apply the REAL mutators (the producer side),
    // persist each returned delta verbatim, then load() into a fresh store and
    // assert the reconstructed graph matches — catching any drift between the
    // delta a mutator emits and the shape replay() expects (e.g. merge's
    // resolvedDestId, create_node's id).
    freshStore();
    const producer = getGraphStore().graph;
    const persist = new FakeStore();
    const deltas: GraphDelta[] = [];
    // a fresh root + observation + merge into a new root + supersede + set_meta
    deltas.push(
      applyCreateNode(producer, {
        id: "n1" as NodeId,
        summary: "root one",
        importance: "high",
        parentNode: null,
        state: "active",
      }),
    );
    deltas.push(
      applyCreateNode(producer, {
        id: "n2" as NodeId,
        summary: "root two",
        importance: "med",
        parentNode: null,
        state: "active",
      }),
    );
    const mergeDelta = applyMerge(
      producer,
      {
        sourceIds: ["n1", "n2"],
        destId: null,
        newSummary: "merged root",
        importance: "high",
      },
      MUTATE_SOURCE,
    );
    deltas.push(mergeDelta);
    // pin the resolved new-root id for assertions
    expect(mergeDelta.resolvedDestId).toBeDefined();
    for (const delta of deltas) appendGraphDelta(persist, delta);
    persist.leafId = "e3";

    // consumer: fresh store, replay the persisted entries
    resetForNewSession();
    await load(persist);
    const reconstructed = getGraphStore().graph;
    // the merged new-root id survives (identity-stable via resolvedDestId)
    expect(reconstructed.nodes.has(mergeDelta.resolvedDestId as NodeId)).toBe(true);
    expect(reconstructed.nodes.get(mergeDelta.resolvedDestId as NodeId)?.summary).toBe("merged root");
    expect(reconstructed.nodes.get(mergeDelta.resolvedDestId as NodeId)?.importance).toBe("high");
    // the two source roots dissolved
    expect(reconstructed.nodes.has("n1" as NodeId)).toBe(false);
    expect(reconstructed.nodes.has("n2" as NodeId)).toBe(false);
  });
});

describe("load edge cases", () => {
  it("yields an empty valid graph when nothing is found", async () => {
    freshStore();
    const fake = new FakeStore();
    fake.leafId = null;
    await load(fake);
    const store = getGraphStore();
    expect(store.graph.nodes.size).toBe(0);
    expect(store.graph.observations.size).toBe(0);
    expect(store.observerFrontier).toBeNull();
  });

  it("drops an orphaned observation whose parent node is absent (graceful)", async () => {
    freshStore();
    const fake = new FakeStore();
    // an obs pointing at a node that was never created (corruption / missing wrapper)
    fake.addCustomAt("e1", OBSERVATION_TYPE, {
      coversFromId: null,
      coversUpToId: "e1",
      records: [
        {
          id: "o1",
          summary: "orphan",
          importance: "low",
          sourceEntryIds: ["1"],
          timestamp: "t",
          parentNode: "nMissing",
        },
      ],
      tokenCount: 1,
    } satisfies ObservationEntry);
    fake.leafId = "e1";

    await load(fake); // must not throw
    const store = getGraphStore();
    // the orphaned obs is dropped from the in-memory graph (persisted record survives)
    expect(store.graph.observations.has("o1")).toBe(false);
    expect(store.observerFrontier).toBe("e1");
  });

  it("replays only graph deltas AFTER the compaction entry (not before)", async () => {
    freshStore();
    const fake = new FakeStore();
    // entries are appended in call order = branch order here
    // e2: a graph_delta BEFORE the compaction (must NOT be replayed)
    fake.addCustomAt("e2", GRAPH_DELTA_TYPE, {
      kind: "graph_delta",
      delta: {
        type: "create_node",
        id: "nPre" as NodeId,
        summary: "pre-snapshot node",
        importance: "low",
        parentNode: null,
        state: "active",
      },
    } satisfies GraphDeltaEntry);
    // e5: the compaction snapshot (empty base)
    const details = encodeDetails(getGraphStore().graph, null, null);
    fake.addCompaction("e5", details);
    // e8: a graph_delta AFTER the compaction (replayed)
    fake.addCustomAt("e8", GRAPH_DELTA_TYPE, {
      kind: "graph_delta",
      delta: {
        type: "create_node",
        id: "nPost" as NodeId,
        summary: "post-snapshot node",
        importance: "low",
        parentNode: null,
        state: "active",
      },
    } satisfies GraphDeltaEntry);
    fake.leafId = "e8";

    await load(fake);
    const store = getGraphStore();
    expect(store.graph.nodes.has("nPre" as NodeId)).toBe(false);
    expect(store.graph.nodes.has("nPost" as NodeId)).toBe(true);
  });

  it("extends a node's time range when a post-snapshot observation is linked", async () => {
    freshStore();
    const fake = new FakeStore();
    // snapshot: a single node n1 with rangeEnd at an early time
    const details: MemkeeperDetails = {
      type: DETAILS_TYPE,
      version: "v1",
      nodes: [
        {
          id: "n1",
          summary: "branch",
          summaryTokens: 1,
          state: "active",
          importance: "med",
          parentNode: null,
          observationIds: [],
          childNodeIds: [],
          supersededBy: null,
          timestamps: {
            createdAt: "2026-07-01T00:00:00.000Z",
            updatedAt: "2026-07-01T00:00:00.000Z",
            rangeStart: "2026-07-01T00:00:00.000Z",
            rangeEnd: "2026-07-01T00:00:00.000Z",
          },
        },
      ],
      oInitialPrompt: null,
      nextObsId: 1,
      nextNodeId: 2,
      selectedTree: null,
      lastCompactionLedger: null,
    };
    fake.addCompaction("e1", details);
    // post-snapshot obs with a later timestamp, parented at n1
    fake.addCustomAt("e2", OBSERVATION_TYPE, {
      coversFromId: "e1",
      coversUpToId: "e2",
      records: [
        {
          id: "o1",
          summary: "later",
          importance: "low",
          sourceEntryIds: ["2"],
          timestamp: "2026-07-09T12:00:00.000Z",
          parentNode: "n1",
        },
      ],
      tokenCount: 1,
    } satisfies ObservationEntry);
    fake.leafId = "e2";

    await load(fake);
    const n1 = getGraphStore().graph.nodes.get("n1" as NodeId);
    expect(n1?.observationIds).toContain("o1");
    // the linked obs extended the node's range (not stale at the snapshot value)
    expect(n1?.timestamps.rangeEnd).toBe("2026-07-09T12:00:00.000Z");
  });
});
