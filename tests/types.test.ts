// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import { describe, expect, it } from "vitest";
import type { Importance, NodeId, NodeState, ObsId } from "../src/types.js";
import {
  CHARS_PER_TOKEN_ESTIMATE,
  estimateContentTokens,
  IMPORTANCE_RANK,
  SessionOwlGraph,
  makeNode,
  makeObservation,
  N_GOAL,
  N_IRRELEVANT,
  nowStoredTimestamp,
  O_INITIAL_PROMPT,
  ROOT_PARENT,
} from "../src/types.js";

describe("Importance", () => {
  it("ranks crit > high > med > low", () => {
    expect(IMPORTANCE_RANK.crit).toBeGreaterThan(IMPORTANCE_RANK.high);
    expect(IMPORTANCE_RANK.high).toBeGreaterThan(IMPORTANCE_RANK.med);
    expect(IMPORTANCE_RANK.med).toBeGreaterThan(IMPORTANCE_RANK.low);
  });
});

describe("special ids", () => {
  it("exposes the three fixed string-literal specials as named constants", () => {
    expect(N_GOAL).toBe("nGoal");
    expect(O_INITIAL_PROMPT).toBe("oInitialPrompt");
    expect(N_IRRELEVANT).toBe("nIrrelevant");
  });

  it("treats null as the root parent sentinel", () => {
    expect(ROOT_PARENT).toBeNull();
  });
});

describe("token estimation", () => {
  it("divides content length by the chars-per-token constant (ceil)", () => {
    expect(CHARS_PER_TOKEN_ESTIMATE).toBe(4);
    expect(estimateContentTokens("")).toBe(0);
    expect(estimateContentTokens("abcdefgh")).toBe(2);
    expect(estimateContentTokens("abcdefghi")).toBe(3);
  });
});

describe("nowStoredTimestamp", () => {
  it("returns a UTC ISO 8601 string ending in Z", () => {
    const ts = nowStoredTimestamp();
    expect(ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  it("parses to a Date within a few seconds of now (a real instant)", () => {
    const before = Date.now();
    const ts = nowStoredTimestamp();
    const after = Date.now();
    const parsed = new Date(ts).getTime();
    expect(parsed).toBeGreaterThanOrEqual(before);
    expect(parsed).toBeLessThanOrEqual(after);
  });

  it("is lexicographically orderable = chronological (two calls preserve order)", () => {
    const a = nowStoredTimestamp();
    // a tiny gap guarantees a distinct instant (millisecond resolution)
    const loopEnd = Date.now() + 1;
    while (Date.now() < loopEnd) {
      /* spin to cross a ms boundary */
    }
    const b = nowStoredTimestamp();
    expect(a < b).toBe(true);
  });
});

describe("makeObservation", () => {
  it("freezes summaryTokens from content at construction", () => {
    const obs = makeObservation({
      id: "o1" as ObsId,
      summary: "abcdefgh",
      importance: "med" as Importance,
      sourceEntryIds: ["12"],
      timestamp: "2026-07-29T14:30:00.000Z",
      parentNode: N_GOAL as NodeId,
    });
    expect(obs.summaryTokens).toBe(2);
    expect(obs.importance).toBe("med");
    expect(obs.parentNode).toBe(N_GOAL);
  });
});

describe("makeNode", () => {
  it("computes summaryTokens from summary and seeds timestamps", () => {
    const node = makeNode({
      id: "n1" as NodeId,
      summary: "abcdefgh",
      importance: "high" as Importance,
      state: "active",
      parentNode: null,
      createdAt: "2026-07-29T09:00:00.000Z",
    });
    expect(node.summaryTokens).toBe(2);
    expect(node.observationIds).toEqual([]);
    expect(node.childNodeIds).toEqual([]);
    expect(node.supersededBy).toBeNull();
    expect(node.timestamps.createdAt).toBe("2026-07-29T09:00:00.000Z");
    expect(node.timestamps.rangeStart).toBe("2026-07-29T09:00:00.000Z");
    expect(node.timestamps.rangeEnd).toBe("2026-07-29T09:00:00.000Z");
  });

  it("defaults rangeEnd to rangeStart when only rangeStart is given", () => {
    const node = makeNode({
      id: "n2" as NodeId,
      summary: "x",
      importance: "low" as Importance,
      state: "active",
      parentNode: null,
      createdAt: "2026-07-29T09:00:00.000Z",
      rangeStart: "2026-07-29T08:00:00.000Z",
    });
    expect(node.timestamps.rangeStart).toBe("2026-07-29T08:00:00.000Z");
    expect(node.timestamps.rangeEnd).toBe("2026-07-29T08:00:00.000Z");
  });
});

describe("SessionOwlGraph", () => {
  it("exposes maps and counters as a plain data container", () => {
    const graph = createBareGraph();
    expect(graph.nextObsId).toBe(1);
    expect(graph.nextNodeId).toBe(1);
    expect(graph.nodes.size).toBe(0);
  });

  it("hasInitialPrompt is a computed getter derived from the observations map", () => {
    const graph = createBareGraph();
    expect(graph.hasInitialPrompt).toBe(false);
    graph.observations.set(
      O_INITIAL_PROMPT,
      makeObservation({
        id: O_INITIAL_PROMPT as ObsId,
        summary: "the goal",
        importance: "crit" as Importance,
        sourceEntryIds: ["1"],
        timestamp: "2026-07-29T09:00:00.000Z",
        parentNode: N_GOAL as NodeId,
      }),
    );
    expect(graph.hasInitialPrompt).toBe(true);
  });

  it("NodeState is the four persisted states", () => {
    const states: NodeState[] = ["new", "active", "archived", "obsolete"];
    expect(states).toHaveLength(4);
  });

  it("makeNode seeds nGoal in the active state", () => {
    const goal = makeNode({
      id: N_GOAL,
      summary: "the goal",
      importance: "crit" as Importance,
      state: "active",
      parentNode: null,
      createdAt: "2026-07-29T09:00:00.000Z",
    });
    expect(goal.state).toBe("active");
    expect(goal.importance).toBe("crit");
  });
});

// helper local to this test file
function createBareGraph(): SessionOwlGraph {
  return new SessionOwlGraph({
    nodes: new Map(),
    observations: new Map(),
    nextObsId: 1,
    nextNodeId: 1,
  });
}
