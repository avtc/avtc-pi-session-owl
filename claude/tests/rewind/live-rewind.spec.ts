// SPDX-License-Identifier: MIT;
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
import { applyLiveRewind } from "../../host/rewind/live-rewind.js";

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
