// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// The recall serve's budget-free lane: a heavy search outlives the ~10s
// hook budget, so the serve parks under a stage key and the hook rides the
// await_stage dispatch loop — every engine-served $.tool.call keeps the
// budget clock paused for the whole wait, and the 9s slices answer before
// the engine's per-call ceiling (no lingering, no worker respawn).
import { describe, expect, test } from "vitest";
import { serveViaStageLane } from "../../host/recall/budget-lane.js";

function lane(opts: {
  slices: Array<{ result: string; done: boolean } | { deny: string }>;
  work: () => Promise<string>;
  signal?: AbortSignal;
}) {
  let i = 0;
  const parkCalls: string[] = [];
  const dispatches: number[] = [];
  const p = serveViaStageLane({
    key: "test-key",
    park: (key: string, work: () => Promise<string>) => {
      parkCalls.push(key);
      void work(); // the tool side TAKES and RUNS the parked work
    },
    startWork: opts.work,
    dispatch: () => {
      dispatches.push(i);
      const a = opts.slices[i];
      i += 1;
      if (a === undefined) return Promise.resolve({ result: "done", done: true } as const);
      if ("deny" in a) return Promise.resolve(a);
      return Promise.resolve(a);
    },
    signal: opts.signal,
    sliceAbortResult: "aborted",
  });
  return { promise: p, parkCalls, dispatches };
}

describe("serveViaStageLane", () => {
  test("a fast work settles in ONE dispatch and returns its value", async () => {
    const x = lane({
      slices: [{ result: "done", done: true }],
      work: async () => "the search result",
    });
    await expect(x.promise).resolves.toBe("the search result");
    expect(x.dispatches).toEqual([0]);
  });

  test("a slow work rides multiple slices, then done returns the value", async () => {
    const x = lane({
      slices: [
        { result: "slice", done: false },
        { result: "slice", done: false },
        { result: "done", done: true },
      ],
      work: async () => "late result",
    });
    await expect(x.promise).resolves.toBe("late result");
    expect(x.dispatches).toEqual([0, 1, 2]);
  });

  test("a denied dispatch falls back to running the work inline", async () => {
    const x = lane({
      slices: [{ deny: "await_stage: no prepared work for k" }],
      work: async () => "inline result",
    });
    await expect(x.promise).resolves.toBe("inline result");
    expect(x.dispatches).toEqual([0]);
  });

  test("an aborted slice answers an interrupted marker, never hangs", async () => {
    const controller = new AbortController();
    controller.abort();
    const x = lane({
      slices: [{ result: "aborted", done: false }],
      work: async () => "never",
      signal: controller.signal,
    });
    const out = await x.promise;
    expect(out).toMatchObject({ interrupted: true });
  });
});
