// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import { describe, expect, it } from "vitest";
import type { SerializedNode } from "../../src/store/codecs.js";
import {
  decodeDetails,
  decodeNode,
  decodeObservation,
  decodeSelection,
  decodeUsage,
  encodeDetails,
  encodeNode,
  encodeObservation,
  encodeSelection,
  GRAPH_DELTA_TYPE,
  OBSERVATION_TYPE,
  SELECTION_TYPE,
  USAGE_TYPE,
} from "../../src/store/codecs.js";
import type { Importance, NodeId, ObsId } from "../../src/types.js";
import { MemkeeperGraph, makeNode, makeObservation, N_GOAL, O_INITIAL_PROMPT } from "../../src/types.js";

// --- fixtures ---------------------------------------------------------------

function sampleObs() {
  return makeObservation({
    id: "o1" as ObsId,
    content: "abcdefgh", // 2 tokens at chars/4
    importance: "high" as Importance,
    sourceEntryIds: ["12", "13"],
    timestamp: "2026-07-29 14:30",
    parentNode: N_GOAL,
  });
}

function sampleNode() {
  return makeNode({
    id: "n1" as NodeId,
    summary: "bug fix landed",
    importance: "critical" as Importance,
    state: "active",
    parentNode: N_GOAL,
    observationIds: ["o1" as ObsId],
    createdAt: "2026-07-29 09:00",
    rangeStart: "2026-07-29 08:00",
    rangeEnd: "2026-07-29 10:00",
  });
}

function emptyGraph(): MemkeeperGraph {
  return new MemkeeperGraph({
    nodes: new Map(),
    observations: new Map(),
    nextObsId: 1,
    nextNodeId: 1,
  });
}

describe("customType constants", () => {
  it("uses the documented type names", () => {
    expect(OBSERVATION_TYPE).toBe("memkeeper.observation");
    expect(GRAPH_DELTA_TYPE).toBe("memkeeper.graph_delta");
    expect(SELECTION_TYPE).toBe("memkeeper.selection");
    expect(USAGE_TYPE).toBe("memkeeper.usage");
  });
});

describe("observation codec", () => {
  it("round-trips an observation", () => {
    const wire = encodeObservation(sampleObs());
    // contentTokens is NOT on the wire (recomputed on decode)
    expect(wire).not.toHaveProperty("contentTokens");
    expect(wire.id).toBe("o1");
    expect(wire.content).toBe("abcdefgh");
    expect(wire.importance).toBe("high");
    expect(wire.sourceEntryIds).toEqual(["12", "13"]);
    expect(wire.timestamp).toBe("2026-07-29 14:30");
    expect(wire.parentNode).toBe(N_GOAL);

    const decoded = decodeObservation(wire);
    expect(decoded).not.toBeNull();
    expect(decoded?.contentTokens).toBe(2); // recomputed
    expect(decoded?.parentNode).toBe(N_GOAL);
  });

  it("returns null for a malformed observation (tolerant, never throws)", () => {
    expect(decodeObservation(null)).toBeNull();
    expect(decodeObservation({ id: "o1" })).toBeNull(); // missing fields
    expect(decodeObservation({ ...encodeObservation(sampleObs()), importance: "bogus" })).toBeNull();
  });

  it("ignores unknown fields (tolerant reader)", () => {
    const wire = encodeObservation(sampleObs()) as unknown as Record<string, unknown>;
    wire.futureField = "ignored";
    const decoded = decodeObservation(wire);
    expect(decoded).not.toBeNull();
    expect(decoded?.id).toBe("o1");
  });
});

describe("node codec", () => {
  it("round-trips a node including timestamps and summaryTokens", () => {
    const wire = encodeNode(sampleNode());
    expect(wire.id).toBe("n1");
    expect(wire.summary).toBe("bug fix landed");
    expect(wire.summaryTokens).toBe(4); // "bug fix landed" = 14 chars / 4 = 4 (ceil)
    expect(wire.state).toBe("active");
    expect(wire.importance).toBe("critical");
    expect(wire.parentNode).toBe(N_GOAL);
    expect(wire.observationIds).toEqual(["o1"]);
    expect(wire.supersededBy).toBeNull();
    expect(wire.timestamps.createdAt).toBe("2026-07-29 09:00");
    expect(wire.timestamps.rangeStart).toBe("2026-07-29 08:00");
    expect(wire.timestamps.rangeEnd).toBe("2026-07-29 10:00");

    const decoded = decodeNode(wire);
    expect(decoded).not.toBeNull();
    expect(decoded?.id).toBe("n1");
    expect(decoded?.timestamps.rangeStart).toBe("2026-07-29 08:00");
    expect(decoded?.summaryTokens).toBe(wire.summaryTokens);
  });

  it("recomputes summaryTokens on decode when missing from wire", () => {
    const wire = encodeNode(sampleNode());
    // strip summaryTokens — decoder must recompute from summary
    const withoutTokens: Omit<SerializedNode, "summaryTokens"> = {
      id: wire.id,
      summary: wire.summary,
      state: wire.state,
      importance: wire.importance,
      parentNode: wire.parentNode,
      observationIds: wire.observationIds,
      childNodeIds: wire.childNodeIds,
      supersededBy: wire.supersededBy,
      timestamps: wire.timestamps,
    };
    const decoded = decodeNode(withoutTokens);
    expect(decoded).not.toBeNull();
    expect(decoded?.summaryTokens).toBe(4);
  });

  it("returns null for a malformed node (tolerant, never throws)", () => {
    expect(decodeNode(null)).toBeNull();
    expect(decodeNode({ id: "n1" })).toBeNull();
    expect(decodeNode({ ...encodeNode(sampleNode()), state: "weird" })).toBeNull();
  });
});

describe("selection snapshot codec", () => {
  it("round-trips a self-contained snapshot (nodes deep-copied, obs are id refs)", () => {
    const g = emptyGraph();
    const node = sampleNode();
    g.nodes.set(node.id, node);
    const obs = sampleObs();
    g.observations.set(obs.id, obs);
    const prompt = makeObservation({
      id: O_INITIAL_PROMPT,
      content: "build memkeeper",
      importance: "critical" as Importance,
      sourceEntryIds: [],
      timestamp: "2026-07-29 09:00",
      parentNode: N_GOAL,
    });
    g.observations.set(prompt.id, prompt);
    const snapshot = encodeSelection(g, O_INITIAL_PROMPT, "entry-42");
    expect(snapshot.nodes.map((n) => n.id)).toContain("n1");
    // oInitialPrompt is carried verbatim (full SerializedObservation)
    expect(snapshot.oInitialPrompt?.id).toBe(O_INITIAL_PROMPT);
    // obsRefs are id-only refs (NOT full content)
    expect(snapshot.obsRefs).toContain("o1");
    expect(snapshot.obsRefs).not.toContain(O_INITIAL_PROMPT); // oInitialPrompt carried separately
    // coveredFrontier is the observer frontier at tree-build time (staleness check)
    expect(snapshot.coveredFrontier).toBe("entry-42");

    const decoded = decodeSelection(snapshot);
    expect(decoded).not.toBeNull();
    expect(decoded?.oInitialPrompt?.id).toBe(O_INITIAL_PROMPT);
    expect(decoded?.obsRefs).toContain("o1");
    expect(decoded?.coveredFrontier).toBe("entry-42");
  });

  it("decodeSelection treats a missing coveredFrontier as null (additive field, legacy-safe → stale → rebuild)", () => {
    const snapshot = encodeSelection(emptyGraph(), null, "entry-7");
    const { coveredFrontier, ...legacy } = snapshot;
    void coveredFrontier;
    const decoded = decodeSelection(legacy);
    expect(decoded).not.toBeNull();
    expect(decoded?.coveredFrontier).toBeNull();
  });

  it("rejects a snapshot with a malformed inner node (validates, not blind-casts)", () => {
    const good = encodeSelection(emptyGraph(), null, null);
    const badNode = {
      id: "n1",
      summary: "x",
      summaryTokens: 1,
      state: "bogus", // invalid state
      importance: "medium",
      parentNode: null,
      observationIds: [],
      childNodeIds: [],
      supersededBy: null,
      timestamps: { createdAt: "t", updatedAt: "t", rangeStart: "t", rangeEnd: "t" },
    };
    expect(decodeSelection({ ...good, nodes: [badNode] })).toBeNull();
  });
});

describe("usage codec", () => {
  it("round-trips a cumulative usage ledger", () => {
    const ledger = {
      observe: { input: 100, output: 50, cacheRead: 10, cost: 0.02, turns: 3, runs: 1 },
      build: { input: 200, output: 80, cacheRead: 20, cost: 0.05, turns: 5, runs: 1 },
      select: { input: 0, output: 0, cacheRead: 0, cost: 0, turns: 0, runs: 0 },
    };
    const decoded = decodeUsage(ledger);
    expect(decoded).toEqual(ledger);
  });

  it("returns null for a malformed ledger", () => {
    expect(decodeUsage(null)).toBeNull();
    expect(decodeUsage({ observe: {} })).toBeNull();
  });
});

describe("MemkeeperDetails codec", () => {
  it("round-trips the compaction details payload including the version field", () => {
    const g = emptyGraph();
    const node = sampleNode();
    g.nodes.set(node.id, node);
    const details = encodeDetails(g, null, null);
    expect(details.version).toBe("v1");
    expect(details.nodes.map((n) => n.id)).toContain("n1");
    expect(details.oInitialPrompt).toBeNull();
    expect(details.nextObsId).toBe(1);
    expect(details.nextNodeId).toBe(1);
    expect(details.selectedTree).toBeNull();
    expect(details.lastCompactionLedger).toBeNull();

    const decoded = decodeDetails(details);
    expect(decoded).not.toBeNull();
    expect(decoded?.version).toBe("v1");
    expect(decoded?.nextObsId).toBe(1);
  });

  it("returns null for malformed details (native/Pi compaction rejected)", () => {
    expect(decodeDetails(null)).toBeNull();
    expect(decodeDetails({ foo: "bar" })).toBeNull();
    // missing required fields
    expect(decodeDetails({ version: "v1" })).toBeNull();
  });

  it("rejects an otherwise-valid details with an unknown version", () => {
    const details = encodeDetails(emptyGraph(), null, null);
    const future = { ...details, version: "v2" };
    expect(decodeDetails(future)).toBeNull();
  });

  it("ignores unknown details fields (tolerant reader, additive fields)", () => {
    const details = encodeDetails(emptyGraph(), null, null);
    const withExtra = { ...details, futureField: "ignored" } as Record<string, unknown>;
    const decoded = decodeDetails(withExtra);
    expect(decoded).not.toBeNull();
    expect(decoded?.version).toBe("v1");
  });
});
