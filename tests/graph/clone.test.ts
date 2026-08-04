// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import { describe, expect, it } from "vitest";
import { cloneNode, cloneObservation } from "../../src/graph/clone.js";
import { makeNode, makeObservation, N_GOAL } from "../../src/types.js";

describe("cloneNode", () => {
  it("produces an independent deep copy (mutating the clone does not affect the source)", () => {
    const source = makeNode({
      id: N_GOAL,
      summary: "the goal",
      importance: "critical",
      parentNode: null,
      state: "active",
      createdAt: "2026-07-28T09:00:00.000Z",
    });
    source.childNodeIds = ["n3"];
    source.observationIds = ["o1"];

    const clone = cloneNode(source);
    clone.summary = "changed";
    clone.childNodeIds.push("n99");
    clone.observationIds.push("o99");
    if (clone.supersededBy !== null) throw new Error("test setup");
    clone.timestamps.createdAt = "2026-07-29T09:00:00.000Z";

    expect(source.summary).toBe("the goal");
    expect(source.childNodeIds).toEqual(["n3"]);
    expect(source.observationIds).toEqual(["o1"]);
    expect(source.timestamps.createdAt).toBe("2026-07-28T09:00:00.000Z");
  });

  it("does not share nested array/timestamp references with the source", () => {
    const source = makeNode({
      id: "n3",
      summary: "child",
      importance: "high",
      parentNode: N_GOAL,
      state: "active",
      createdAt: "2026-07-28T09:00:00.000Z",
    });
    source.childNodeIds = ["n9"];
    source.observationIds = ["o2"];
    const clone = cloneNode(source);
    expect(clone.childNodeIds).not.toBe(source.childNodeIds);
    expect(clone.observationIds).not.toBe(source.observationIds);
    expect(clone.timestamps).not.toBe(source.timestamps);
  });
});

describe("cloneObservation", () => {
  it("produces an independent deep copy (mutating the clone does not affect the source)", () => {
    const source = makeObservation({
      id: "o1",
      content: "fact",
      importance: "medium",
      sourceEntryIds: ["e2"],
      parentNode: "n3",
      timestamp: "2026-07-28T10:00:00.000Z",
    });
    const clone = cloneObservation(source);
    clone.sourceEntryIds.push("e99");

    expect(source.sourceEntryIds).toEqual(["e2"]);
  });

  it("does not share the sourceEntryIds array reference with the source", () => {
    const source = makeObservation({
      id: "o1",
      content: "fact",
      importance: "medium",
      sourceEntryIds: ["e2"],
      parentNode: "n3",
      timestamp: "2026-07-28T10:00:00.000Z",
    });
    const clone = cloneObservation(source);
    expect(clone.sourceEntryIds).not.toBe(source.sourceEntryIds);
  });
});
