// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>
//
// The live rewind application: what the chain processor's onRewind seam
// runs. The recipe mirrors the reconcile divergence move — abort in-flight
// stage runs first (they anchor to the amputated world), then the live
// order from the settle point feeds the store refold together with the
// dead path (everything owl held after the settle), and the divergence is
// recorded so future checks exclude the dead set. A failure propagates —
// the processor's tick retries and the rewind re-detects (never silently
// dropped).

import { describe, expect, test } from "vitest";
import { applyLiveRewind, capDeadAtOldestLiveKnown } from "../../host/rewind/live-rewind.js";

function deps(overrides?: Partial<Parameters<typeof applyLiveRewind>[0]>) {
  const calls: string[] = [];
  const base = {
    abortAndAwaitInFlight: async () => {
      calls.push("abort");
    },
    liveOrderFor: async (settle: string | null) => {
      calls.push(`liveOrderFor:${String(settle)}`);
      return settle === null ? [] : ["b1", "t1"];
    },
    deadPath: async (settle: string | null) => {
      calls.push(`deadPath:${String(settle)}`);
      return settle === null ? ["t1", "t2"] : ["t2"];
    },
    refold: async (liveSet: ReadonlySet<string>, liveOrder: readonly string[], dead: ReadonlySet<string>) => {
      calls.push(`refold:${liveOrder.join(",")}|dead:${[...dead].join(",")}`);
      void liveSet;
      return { quarantined: dead.size };
    },
    onDivergence: (settle: string | null, dead: string[]) => {
      calls.push(`onDivergence:${String(settle)}:${dead.join(",")}`);
    },
    log: (line: string) => {
      calls.push(`log:${line}`);
    },
  };
  return { deps: { ...base, ...overrides }, calls };
}

describe("applyLiveRewind", () => {
  test("abort → live order → dead path → refold(liveSet, liveOrder, dead) → divergence recorded", async () => {
    const { deps: d, calls } = deps();
    const r = await applyLiveRewind(d, { settle: "t1" });
    expect(r).toEqual({ quarantined: 1 });
    expect(calls).toEqual([
      "abort",
      "liveOrderFor:t1",
      "deadPath:t1",
      "log:live rewind: settle=t1 live=2 dead=1 — refolding",
      "refold:b1,t1|dead:t2",
      "onDivergence:t1:t2",
    ]);
  });

  test("a null settle (rewind to the root) refolds an empty live set with the whole path dead", async () => {
    const { deps: d, calls } = deps();
    const r = await applyLiveRewind(d, { settle: null });
    expect(r).toEqual({ quarantined: 2 });
    expect(calls).toContain("refold:|dead:t1,t2");
    expect(calls).toContain("onDivergence:null:t1,t2");
  });

  test("failures propagate (the tick retries; a rewind is never silently dropped)", async () => {
    const { deps: d } = deps({
      refold: async () => {
        throw new Error("store busy");
      },
    });
    await expect(applyLiveRewind(d, { settle: "t1" })).rejects.toThrow("store busy");
  });

  test("an absent onDivergence seam is optional", async () => {
    const { deps: d, calls } = deps();
    const { onDivergence: _omit, ...rest } = d;
    void _omit;
    await applyLiveRewind(rest as typeof d, { settle: "t1" });
    expect(calls).not.toContain("onDivergence:t1:t2");
  });

  test("the live set is derived from the order (set semantics for refold)", async () => {
    const seen: ReadonlySet<string>[] = [];
    const { deps: d } = deps({
      refold: async (liveSet) => {
        seen.push(liveSet);
        return { quarantined: 0 };
      },
    });
    await applyLiveRewind(d, { settle: "t1" });
    expect(seen[0]).toBeInstanceOf(Set);
    expect([...(seen[0] as Set<string>)].sort()).toEqual(["b1", "t1"]);
  });
});

describe("capDeadAtOldestLiveKnown — the boundary cap (dead adjudication stops at the live path's root)", () => {
  // the 17-boundary shape in miniature: originals, then two compaction
  // generations, each generation's fresh rows rooted at its boundary edge
  const KNOWN = [
    "o1",
    "o2",
    "o3",
    "o4", // the originals (generation zero)
    "g1a",
    "g1b",
    "g1c", // generation one's re-materialized rows
    "g2a",
    "g2b", // generation two's re-materialized rows
    "g2c",
    "g2d", // generation two's tail (the amputated part)
  ];

  test("a verdict inside the newest generation kills only that generation's dead tail — every earlier generation + the originals are exempt", () => {
    // the live path roots at the newest boundary's edge: the boundary
    // ceremony row (not a known row) → g2a → g2b (the settle) — everything
    // before g2a is pre-boundary history the file keeps by design
    const liveOrder = ["b2-ceremony", "g2a", "g2b"];
    const deadRaw = KNOWN.filter((u) => !liveOrder.includes(u)); // the uncapped massacre shape
    const dead = capDeadAtOldestLiveKnown(KNOWN, liveOrder, deadRaw);
    expect(dead).toEqual(["g2c", "g2d"]); // only the amputated newest-generation tail
  });

  test("a live path rooted at the session's first row (the removed-boundary surgery shape) caps nothing — deep adjudication stands", () => {
    const liveOrder = ["o1", "o2", "g1a"]; // rewound into the originals; no boundary edge on the path
    const deadRaw = KNOWN.filter((u) => !liveOrder.includes(u));
    const dead = capDeadAtOldestLiveKnown(KNOWN, liveOrder, deadRaw);
    expect(dead).toEqual(deadRaw); // the abandoned worlds die
  });

  test("an empty live order (rewind to the root) caps nothing", () => {
    const deadRaw = ["t1", "t2"];
    expect(capDeadAtOldestLiveKnown(KNOWN, [], deadRaw)).toEqual(deadRaw);
  });

  test("a live order with no known row (all ceremony) caps nothing", () => {
    const deadRaw = ["o1", "g1a"];
    expect(capDeadAtOldestLiveKnown(KNOWN, ["b2-ceremony"], deadRaw)).toEqual(deadRaw);
  });

  test("a dead row outside the known order stays dead (defensive)", () => {
    expect(capDeadAtOldestLiveKnown(KNOWN, ["g2a", "g2b"], ["mystery", "g2c"])).toEqual(["mystery", "g2c"]);
  });
});

describe("applyLiveRewind — the boundary cap rides the verdict", () => {
  test("knownOrder caps the dead set and logs the kept pre-boundary rows", async () => {
    const logs: string[] = [];
    const { deps: d, calls } = deps({
      liveOrderFor: async () => ["b2-ceremony", "g2a", "g2b"],
      deadPath: async () => ["o1", "o2", "g2c"],
      knownOrder: () => ["o1", "o2", "g1a", "g2a", "g2b", "g2c"],
      log: (line: string) => {
        logs.push(line);
        calls.push(`log:${line}`);
      },
    });
    const r = await applyLiveRewind(d, { settle: "g2b" });
    expect(r).toEqual({ quarantined: 1 });
    expect(calls).toContain("refold:b2-ceremony,g2a,g2b|dead:g2c");
    expect(calls).toContain("onDivergence:g2b:g2c");
    expect(logs.join("\n")).toContain("boundary cap");
    expect(logs.join("\n")).toContain("2 pre-boundary");
  });

  test("without knownOrder the dead set passes through unchanged (the bare contract)", async () => {
    const { deps: d, calls } = deps();
    await applyLiveRewind(d, { settle: "t1" });
    expect(calls).toContain("refold:b1,t1|dead:t2");
  });
});
