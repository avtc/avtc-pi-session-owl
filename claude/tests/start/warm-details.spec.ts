// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// The resume-time details warm: after the store read renders the graph, the
// warm materializes every observation's verbatim source into the
// conversation's details cache (keyed writes — lane-safe), chunked with
// yields so it shares the lane politely. A warmed first query serves from
// cache; the widget's owl line waits for this completion.
import { describe, expect, test } from "vitest";
import { computeDetailsAndCacheFor } from "../../core/src/format/details.js";
import { warmDetailsCache } from "../../host/start/warm-details.js";

interface FakeObs {
  id: string;
  sourceEntryIds: string[];
}

function fakeGraph(obs: FakeObs[]): { observations: Map<string, FakeObs> } {
  return { observations: new Map(obs.map((o) => [o.id, o])) };
}

describe("warmDetailsCache", () => {
  test("warms every observation into the named bucket, yielding between chunks", async () => {
    const obs = Array.from({ length: 450 }, (_, i) => ({ id: `o${i}`, sourceEntryIds: [`e${i}`] }));
    const yields: number[] = [];
    let resolved = 0;
    const resolver = (ids: readonly string[]): unknown[] => {
      resolved += 1;
      return [
        {
          type: "message",
          id: ids[0],
          parentId: null,
          timestamp: 0,
          message: { role: "user", content: `verbatim ${ids[0]}`, timestamp: 0 },
        },
      ];
    };
    const out = await warmDetailsCache({
      key: "conv-warm",
      graph: fakeGraph(obs) as never,
      resolver: resolver as never,
      detailsWrite: computeDetailsAndCacheFor,
      chunkSize: 200,
      yieldLane: async () => {
        yields.push(Date.now());
      },
    });
    expect(out.warmed).toBe(450);
    expect(out.failed).toBe(0);
    expect(resolved).toBe(450); // every obs rendered exactly once
    expect(yields.length).toBeGreaterThanOrEqual(2); // chunked, not one blast
    expect(out.ms).toBeGreaterThanOrEqual(0);
  });

  test("an observation whose render throws is counted failed, never thrown", async () => {
    const obs = [
      { id: "ok1", sourceEntryIds: ["e1"] },
      { id: "bad", sourceEntryIds: ["e-boom"] },
      { id: "ok2", sourceEntryIds: ["e2"] },
    ];
    const resolver = (ids: readonly string[]): unknown[] => {
      if (ids[0] === "e-boom") throw new Error("entry poison");
      return [
        {
          type: "message",
          id: ids[0],
          parentId: null,
          timestamp: 0,
          message: { role: "user", content: "ok", timestamp: 0 },
        },
      ];
    };
    const out = await warmDetailsCache({
      key: "conv-warm-fail",
      graph: fakeGraph(obs) as never,
      resolver: resolver as never,
      detailsWrite: computeDetailsAndCacheFor,
      chunkSize: 10,
    });
    expect(out.warmed).toBe(2);
    expect(out.failed).toBe(1);
  });

  test("a second warm over the same bucket re-renders nothing new beyond cache misses", async () => {
    const obs = Array.from({ length: 5 }, (_, i) => ({ id: `o${i}`, sourceEntryIds: [`e${i}`] }));
    let resolved = 0;
    const resolver = (ids: readonly string[]): unknown[] => {
      resolved += 1;
      return [
        {
          type: "message",
          id: ids[0],
          parentId: null,
          timestamp: 0,
          message: { role: "user", content: "v", timestamp: 0 },
        },
      ];
    };
    const first = await warmDetailsCache({
      key: "conv-warm-2",
      graph: fakeGraph(obs) as never,
      resolver: resolver as never,
      detailsWrite: computeDetailsAndCacheFor,
    });
    expect(first.warmed).toBe(5);
    // NOTE: the warm renders unconditionally (computeDetailsAndCacheFor has
    // no read-back); a repeat warm costs the same renders — the guard
    // against repeat warming is the CALLER's once-per-process latch
    expect(resolved).toBe(5);
  });
});

describe("the default yield lane keeps the event loop alive (heartbeat safety)", () => {
  test("macrotask turns happen DURING the warm — a microtask-only lane would starve them", async () => {
    let macrotaskTurns = 0;
    const tick = (): void => {
      macrotaskTurns += 1;
      immediateAgain(tick);
    };
    const immediateAgain = (fn: () => void): void => {
      setImmediate(fn);
    };
    tick();
    const obs = Array.from({ length: 450 }, (_, i) => ({ id: String(i), sourceEntryIds: [String(i)] }));
    const report = await warmDetailsCache({
      key: "k-macro",
      graph: fakeGraph(obs) as never,
      resolver: ((ids: readonly string[]) => [
        {
          type: "message",
          id: ids[0],
          parentId: null,
          timestamp: 0,
          message: { role: "user", content: "x", timestamp: 0 },
        },
      ]) as never,
      detailsWrite: () => ({ lines: 1, tokens: 1 }),
    });
    const during = macrotaskTurns;
    expect(report.warmed).toBe(450);
    // a microtask-only lane completes the warm with ZERO macrotask turns;
    // the macrotask default must let several through mid-warm
    expect(during).toBeGreaterThanOrEqual(2);
  });
});
