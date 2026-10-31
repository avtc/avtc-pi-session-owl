// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// The mid-chain rewind fork (a live probe shape, isolated 2026-10-30): the
// engine's rewind re-sends the rewound-to message as a FRESH row forking at
// the ORIGINAL turn's system row — two children of one parent (old beta and
// the re-stamped beta). Owl's known path ends at the dead branch's tip
// (delta's answer); the new world's first queued row anchors at the fork
// parent's era. The processor must raise exactly one rewind verdict.
import { describe, expect, test } from "vitest";
import { LiveChainProcessor } from "../../host/rewind/live-chain.js";
import type { TailFacts, TailRow } from "../../host/rewind/tail-read.js";

const A = "a08c4e12-0000-4000-8000-000000000001"; // alpha assistant
const SYS = "fd64ae1d-0000-4000-8000-000000000002"; // alpha-era system row (uncaptured ceremony)
const OLD_BETA = "49c692e5-0000-4000-8000-000000000003"; // old beta user (captured)
const OLD_BETA_A = "645f52cf-0000-4000-8000-000000000004"; // old beta answer (captured)
const GAMMA = "a687ee10-0000-4000-8000-000000000005"; // gamma user (captured)
const GAMMA_A = "36c3f449-0000-4000-8000-000000000006";
const SYS2 = "31d7aea4-0000-4000-8000-000000000007"; // uncaptured ceremony
const DELTA = "3a75d2d4-0000-4000-8000-000000000008"; // delta user (captured)
const DELTA_A = "bdf05bea-0000-4000-8000-000000000009"; // delta answer (captured) — owl's tail
const SYS3 = "634e654f-0000-4000-8000-00000000000a"; // uncaptured ceremony
const BETA_RE = "59b30ef9-0000-4000-8000-00000000000b"; // re-stamped beta (captured, forks at SYS)
const EPSILON_A = "3478423e-0000-4000-8000-00000000000c"; // the post-rewind answer (captured)

function tail(): TailFacts {
  const rows: TailRow[] = [
    { uuid: A, parentUuid: null, boundary: false },
    { uuid: SYS, parentUuid: A, boundary: false },
    { uuid: OLD_BETA, parentUuid: SYS, boundary: false },
    { uuid: OLD_BETA_A, parentUuid: OLD_BETA, boundary: false },
    { uuid: GAMMA, parentUuid: OLD_BETA_A, boundary: false },
    { uuid: GAMMA_A, parentUuid: GAMMA, boundary: false },
    { uuid: SYS2, parentUuid: GAMMA_A, boundary: false },
    { uuid: DELTA, parentUuid: SYS2, boundary: false },
    { uuid: DELTA_A, parentUuid: DELTA, boundary: false },
    { uuid: SYS3, parentUuid: DELTA_A, boundary: false },
    { uuid: BETA_RE, parentUuid: SYS, boundary: false }, // THE FORK
    { uuid: EPSILON_A, parentUuid: BETA_RE, boundary: false },
  ];
  return { rows, torn: false };
}

const known = new Set([A, OLD_BETA, OLD_BETA_A, GAMMA, GAMMA_A, DELTA, DELTA_A, BETA_RE, EPSILON_A]);

test("the mid-chain fork raises exactly one rewind verdict (live probe shape)", async () => {
  const logs: string[] = [];
  const rewinds: Array<{ settle: string | null }> = [];
  const patched: Array<{ uuid: string; parent: string | null }> = [];
  let _fire: (() => void) | null = null;
  const proc = new LiveChainProcessor({
    statSize: async () => 1000,
    readTail: async () => tail(),
    owlTailExcluding: (exclude: ReadonlySet<string>) => {
      // owl's known path tip minus the queued rows = delta's answer
      if (exclude.has(DELTA_A)) return GAMMA_A;
      return DELTA_A;
    },
    isKnownRow: (uuid: string) => known.has(uuid),
    patchEdges: (edges) => {
      for (const e of edges) patched.push({ uuid: e.uuid, parent: e.parent });
    },
    onRewind: async (v) => {
      rewinds.push(v);
    },
    dormant: () => false,
    schedule: (_ms, fn) => {
      _fire = fn;
      return () => {};
    },
    log: (m) => {
      logs.push(m);
    },
  });
  proc.enqueue({ uuid: BETA_RE, door: "response", captured: true });
  proc.enqueue({ uuid: EPSILON_A, door: "response", captured: true });
  // the eager turn.complete flush (inline processing)
  await proc.flush();
  expect(logs.join("\n")).toContain("rewind detected");
  expect(rewinds).toHaveLength(1);
  // the settle point = the last verified row of the new world
  expect(rewinds[0]?.settle).toBe(EPSILON_A);
});

describe("the anchor walk tolerates same-parent shapes (no false rewind)", () => {
  const T0 = "t0-0000-4000-8000-000000000000";
  const USE1 = "a1-0000-4000-8000-000000000000"; // the tool_use row
  const R1 = "r1-0000-4000-8000-000000000000"; // tool_result 1 (parents at USE1)
  const R2 = "r2-0000-4000-8000-000000000000"; // tool_result 2 (SAME parent — parallel batch)
  const U1 = "u1-0000-4000-8000-000000000000"; // sibling user rows (a skipped reply)
  const U2 = "u2-0000-4000-8000-000000000000";

  function h(tailRows: TailRow[], toolFlags: Record<string, boolean>) {
    const logs: string[] = [];
    const rewinds: Array<{ settle: string | null }> = [];
    const patched: Array<{ uuid: string; parent: string | null }> = [];
    const known = new Set(tailRows.map((r) => r.uuid));
    const proc = new LiveChainProcessor({
      statSize: async () => 1000,
      readTail: async () => ({ rows: tailRows, torn: false }),
      owlTailExcluding: (exclude: ReadonlySet<string>) => {
        const order = tailRows.map((r) => r.uuid).filter((u) => !exclude.has(u));
        return order.length > 0 ? order[order.length - 1] : null;
      },
      isKnownRow: (uuid: string) => known.has(uuid),
      patchEdges: (edges) => {
        for (const e of edges) patched.push({ uuid: e.uuid, parent: e.parent });
      },
      onRewind: async (v) => {
        rewinds.push(v);
      },
      dormant: () => false,
      schedule: () => () => {},
      log: (m) => {
        logs.push(m);
      },
    });
    return { proc, logs, rewinds, patched, toolFlags };
  }

  test("parallel tool_results share a parent — no verdict, chain continues in file order", async () => {
    const rows: TailRow[] = [
      { uuid: T0, parentUuid: null, boundary: false },
      { uuid: USE1, parentUuid: T0, boundary: false },
      { uuid: R1, parentUuid: USE1, boundary: false, toolResult: true },
      { uuid: R2, parentUuid: USE1, boundary: false, toolResult: true },
    ];
    const x = h(rows, {});
    x.proc.enqueue({ uuid: R1, door: "attachment", captured: true });
    x.proc.enqueue({ uuid: R2, door: "attachment", captured: true });
    await x.proc.flush();
    expect(x.rewinds).toEqual([]);
    expect(x.logs.join("\n")).not.toContain("rewind detected");
    // both results chain in FILE order (the sibling semantics)
    expect(x.patched).toEqual([
      { uuid: R1, parent: USE1 },
      { uuid: R2, parent: R1 },
    ]);
  });

  test("sibling conversation rows (a skipped reply) — no verdict", async () => {
    const rows: TailRow[] = [
      { uuid: T0, parentUuid: null, boundary: false },
      { uuid: U1, parentUuid: T0, boundary: false },
      { uuid: U2, parentUuid: T0, boundary: false },
    ];
    const x = h(rows, {});
    x.proc.enqueue({ uuid: U1, door: "response", captured: true });
    x.proc.enqueue({ uuid: U2, door: "response", captured: true });
    await x.proc.flush();
    expect(x.rewinds).toEqual([]);
    expect(x.logs.join("\n")).not.toContain("rewind detected");
  });

  test("a tool_result whose parent differs from the chain stays file-ordered (no walk)", async () => {
    const rows: TailRow[] = [
      { uuid: T0, parentUuid: null, boundary: false },
      { uuid: USE1, parentUuid: T0, boundary: false },
      { uuid: R1, parentUuid: USE1, boundary: false, toolResult: true },
      { uuid: U2, parentUuid: USE1, boundary: false },
      { uuid: R2, parentUuid: USE1, boundary: false, toolResult: true },
    ];
    const x = h(rows, {});
    x.proc.enqueue({ uuid: R1, door: "attachment", captured: true });
    x.proc.enqueue({ uuid: U2, door: "response", captured: true });
    x.proc.enqueue({ uuid: R2, door: "attachment", captured: true });
    await x.proc.flush();
    expect(x.rewinds).toEqual([]);
    expect(x.patched.at(-1)).toEqual({ uuid: R2, parent: U2 });
  });
});
