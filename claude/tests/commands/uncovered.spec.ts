// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import type { SessionEntry } from "@earendil-works/pi-coding-agent";
// The mirror-fallback zero-observation scan: observations whose interval
// endpoints fell off the served branch still cover what they observed.
import { describe, expect, test } from "vitest";
import type { ObservationEntry } from "../../core/src/store/codecs.js";
import { OBSERVATION_TYPE } from "../../core/src/store/codecs.js";
import { computeUncoveredRanges } from "../../core/src/triggers.js";
import { computeUncoveredRangesWithMirrorFallback } from "../../host/commands/uncovered.js";

function user(id: string, text: string): SessionEntry {
  return {
    id,
    timestamp: `${id}-ts`,
    type: "message",
    message: { role: "user", content: [{ type: "text", text }] },
  } as unknown as SessionEntry;
}

function assistant(id: string, text: string): SessionEntry {
  return {
    id,
    timestamp: `${id}-ts`,
    type: "message",
    message: { role: "assistant", content: [{ type: "text", text }] },
  } as unknown as SessionEntry;
}

function observation(id: string, covers: { from: string | null; to: string }, sourceEntryIds: string[]): SessionEntry {
  const payload: ObservationEntry = {
    coversFromId: covers.from,
    coversUpToId: covers.to,
    records: [{ sourceEntryIds, text: "observed" }],
  } as never;
  return {
    id,
    timestamp: `${id}-ts`,
    type: "custom",
    customType: OBSERVATION_TYPE,
    data: payload,
  } as unknown as SessionEntry;
}

// a mirror over the FULL row set: on-branch ids plus off-branch twins
function mirrorIndex(offBranch: string[]): (uuid: string) => number | null {
  const all = ["m-root", "u1", "a1", "u2", "a2", ...offBranch];
  return (uuid) => {
    const i = all.indexOf(uuid);
    return i === -1 ? null : i;
  };
}

describe("computeUncoveredRangesWithMirrorFallback", () => {
  test("an interval whose endpoints fell off the served branch still covers the span it observed", () => {
    // served branch: the four messages, frontier = the last reply
    // an observation covers mirror-span forkL..forkR (BOTH off-branch) which
    // spans the second pair — plain resolution loses the whole interval
    const branch: SessionEntry[] = [
      user("u1", "hello"),
      assistant("a1", "hi"),
      user("u2", "more"),
      assistant("a2", "yes"),
      observation("o1", { from: "forkL", to: "forkR" }, []),
    ];
    // the mirror order: forkL sits between the first pair and u2, forkR after the last reply
    const ordered = ["m-root", "u1", "a1", "forkL", "u2", "a2", "forkR"];
    const pos = (u: string) => {
      const i = ordered.indexOf(u);
      return i === -1 ? null : i;
    };
    const ranges = computeUncoveredRangesWithMirrorFallback(branch, "a2", pos);
    // the second pair is covered through the mirror; the first reply sits
    // before forkL and stays a genuine hole
    expect(ranges.length).toBe(1);
    expect(ranges[0]?.entries.map((e) => e.id)).toEqual(["a1"]);
    // the plain pi scan leaves the whole span unobserved (the regression shape)
    const plain = computeUncoveredRanges(branch, "a2");
    expect(plain.length).toBe(1);
    expect(plain[0]?.entries.map((e) => e.id)).toEqual(["a1", "u2", "a2"]);
  });

  test("on-branch endpoints keep the plain semantics", () => {
    const branch: SessionEntry[] = [
      user("u1", "hello"),
      assistant("a1", "hi"),
      user("u2", "more"),
      assistant("a2", "yes"),
      observation("o1", { from: "u1", to: "a1" }, ["u1", "a1"]),
    ];
    const ranges = computeUncoveredRangesWithMirrorFallback(branch, "a2", mirrorIndex([]));
    expect(ranges.length).toBe(1);
    expect(ranges[0]?.entries.map((e) => e.id)).toEqual(["u2", "a2"]);
  });

  test("an off-branch citation covers nothing on the branch (pi semantics)", () => {
    const branch: SessionEntry[] = [
      user("u1", "hello"),
      assistant("a1", "hi"),
      user("u2", "more"),
      assistant("a2", "yes"),
      observation("o1", { from: null, to: "forkTip" }, ["forkU2"]),
    ];
    const ordered = ["m-root", "u1", "a1", "forkU2", "u2", "a2", "forkTip"];
    const pos = (u: string) => {
      const i = ordered.indexOf(u);
      return i === -1 ? null : i;
    };
    const ranges = computeUncoveredRangesWithMirrorFallback(branch, "a2", pos);
    expect(ranges.length).toBe(1);
    expect(ranges[0]?.entries.map((e) => e.id)).toEqual(["a1", "u2", "a2"]);
  });

  test("the closed territory and anchor rules are unchanged", () => {
    const branch: SessionEntry[] = [
      user("u1", "hello"),
      assistant("a1", "hi"),
      user("u2", "more"),
      observation("o1", { from: "u1", to: "a1" }, ["u1", "a1"]),
    ];
    // the frontier off the branch: nothing repairable
    expect(computeUncoveredRangesWithMirrorFallback(branch, "gone", mirrorIndex([]))).toEqual([]);
    // the anchor skips the first user message even when uncovered
    const ranges = computeUncoveredRangesWithMirrorFallback(branch, "a1", mirrorIndex([]));
    expect(ranges).toEqual([]);
  });
});
