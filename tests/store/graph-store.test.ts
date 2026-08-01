// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import { describe, expect, it } from "vitest";
import type { GraphDelta } from "../../src/graph/mutations.js";
import { applyCreateNode } from "../../src/graph/mutations.js";
import {
  EMPTY_LEDGER,
  encodeDetails,
  encodeSelection,
  GRAPH_DELTA_TYPE,
  type GraphDeltaEntry,
  type MemkeeperDetails,
  OBSERVATION_TYPE,
  type ObservationEntry,
  SELECTION_TYPE,
  USAGE_TYPE,
} from "../../src/store/codecs.js";
import type { StoreContext, StoreEntry } from "../../src/store/graph-store.js";
import {
  appendGraphDelta,
  appendObservation,
  appendUsage,
  getGraphStore,
  load,
  persistSelectedTree,
  resetForNewSession,
} from "../../src/store/graph-store.js";
import type { Importance, NodeId } from "../../src/types.js";
import { makeNode, N_GOAL } from "../../src/types.js";

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

  /** A NO-OP that the store must never call (decision #38). */
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
      makeNode({ id: "n1", summary: "x", importance: "medium", state: "active", parentNode: null, createdAt: "t" }),
    );
    store.observerFrontier = "e5";
    resetForNewSession();
    const after = getGraphStore();
    expect(after.graph.nodes.size).toBe(0);
    expect(after.observerFrontier).toBeNull();
  });
});

describe("persist methods (PERSIST-ONLY)", () => {
  it("appendObservation persists a memkeeper.observation entry and returns ids via getLeafId", () => {
    freshStore();
    const fake = new FakeStore();
    const batch: ObservationEntry = {
      coversFromId: null,
      coversUpToId: "e10",
      records: [
        { id: "o1", content: "fact", importance: "high", sourceEntryIds: ["8"], timestamp: "t", parentNode: N_GOAL },
      ],
      tokenCount: 1,
    };
    const ids = appendObservation(fake, batch);
    expect(ids).toEqual(["e1"]);
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
      importance: "medium" as Importance,
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
      importance: "medium" as Importance,
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
  it("reconstructs from a snapshot + replayed deltas (flush_new inside a graph_delta, Issue 6)", async () => {
    freshStore();
    const fake = new FakeStore();
    // base snapshot at e5: nGoal + n1(active) with o1
    const details: MemkeeperDetails = {
      version: "v1",
      nodes: [
        {
          id: N_GOAL,
          summary: "the goal",
          summaryTokens: 2,
          state: "active",
          importance: "critical",
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
          importance: "medium",
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
        { id: "o1", content: "first", importance: "medium", sourceEntryIds: ["1"], timestamp: "t0", parentNode: "n1" },
      ],
      tokenCount: 1,
    } satisfies ObservationEntry);
    fake.addCompaction("e5", details);
    // e7: observation batch (o5 under n1)
    fake.addCustomAt("e7", OBSERVATION_TYPE, {
      coversFromId: "e6",
      coversUpToId: "e7",
      records: [
        { id: "o5", content: "fifth", importance: "low", sourceEntryIds: ["6"], timestamp: "t1", parentNode: "n1" },
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
    // e10: graph_delta carrying a flush_new (flush_new replays via graph_delta, Issue 6)
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
        importance: "medium",
        parentNode: null,
        state: "active",
      },
    } satisfies GraphDeltaEntry);
    fake.addCustomAt("e2", OBSERVATION_TYPE, {
      coversFromId: null,
      coversUpToId: "e2",
      records: [
        { id: "o1", content: "first", importance: "high", sourceEntryIds: ["1"], timestamp: "t", parentNode: "n1" },
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
        { id: "o9", content: "post", importance: "low", sourceEntryIds: ["3"], timestamp: "t", parentNode: "n9" },
      ],
      tokenCount: 1,
    } satisfies ObservationEntry);
    fake.leafId = "e4";

    await load(fake); // must not throw
    const store = getGraphStore();
    // corrupt snapshot skipped → deltas-only reconstruction
    expect(store.graph.observations.has("o9")).toBe(true);
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
          content: "native-skip",
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

  it("calls getBranch, never getEntries (decision #38)", async () => {
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
    const baselineLedger = { ...EMPTY_LEDGER, observe: { ...EMPTY_LEDGER.observe, input: 50, runs: 1 } };
    const details = encodeDetails(getGraphStore().graph, null, baselineLedger);
    fake.addCompaction("e1", details);
    const laterLedger = {
      observe: { input: 100, output: 20, cacheRead: 5, cost: 0.01, turns: 2, runs: 2 },
      build: { ...EMPTY_LEDGER.build },
      select: { ...EMPTY_LEDGER.select },
    };
    fake.addCustomAt("e2", USAGE_TYPE, { ledger: laterLedger });
    fake.leafId = "e2";

    await load(fake);
    expect(getGraphStore().usageLedger).toEqual(laterLedger);
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
          content: "orphan",
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
      version: "v1",
      nodes: [
        {
          id: "n1",
          summary: "branch",
          summaryTokens: 1,
          state: "active",
          importance: "medium",
          parentNode: null,
          observationIds: [],
          childNodeIds: [],
          supersededBy: null,
          timestamps: {
            createdAt: "2026-07-01 00:00",
            updatedAt: "2026-07-01 00:00",
            rangeStart: "2026-07-01 00:00",
            rangeEnd: "2026-07-01 00:00",
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
          content: "later",
          importance: "low",
          sourceEntryIds: ["2"],
          timestamp: "2026-07-09 12:00",
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
    expect(n1?.timestamps.rangeEnd).toBe("2026-07-09 12:00");
  });
});
