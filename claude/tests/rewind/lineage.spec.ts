// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// The lineage ledger: owl owns the chain data (layer 1). Exact
// edges come from readable transcript passes; inferred edges (arrival order
// + tool_use_id links) are marked unverified; corrections append — a later
// record for the same uuid supersedes the earlier one, inert, never rewritten.

import { describe, expect, test } from "vitest";
import {
  appendEdges,
  foldLineage,
  inferEdgesFromArrival,
  type LineageEdge,
  type LineageMap,
  livePathFor,
} from "../../host/rewind/lineage.js";

const ed = (uuid: string, parent: string | null, exact = true): LineageEdge => ({ uuid, parent, exact });

describe("foldLineage — the append-only edge ledger", () => {
  test("exact edges from one record fold into the map", () => {
    const map = foldLineage([
      {
        producerId: "p1",
        seq: 1,
        ts: 1,
        marker: "r2",
        at: "r2",
        kind: "lineage",
        payload: { edges: [ed("r1", null), ed("r2", "r1"), ed("r3", "r2")] },
      },
    ]);
    expect(map.get("r3")).toEqual({ parent: "r2", exact: true });
    expect(map.get("r1")).toEqual({ parent: null, exact: true });
  });

  test("a later record for the same uuid SUPERSEDES the earlier one (corrections append)", () => {
    const map = foldLineage([
      rec(1, { edges: [ed("r3", "rX"), ed("r2", "r1")] }),
      rec(2, { edges: [ed("r3", "r2", false)] }),
    ]);
    expect(map.get("r3")).toEqual({ parent: "r2", exact: false });
    // untouched edges from the superseded record survive
    expect(map.get("r2")).toEqual({ parent: "r1", exact: true });
  });

  test("records are consumed in the GIVEN fold order — the later one wins (the fold sorts by ts, producerId, seq before this)", () => {
    const later = { ...rec(9, { edges: [ed("r2", "WRONG")] }), producerId: "a", ts: 10 };
    const earlier = { ...rec(5, { edges: [ed("r2", "r1", false)] }), producerId: "b", ts: 5 };
    const map = foldLineage([earlier, later]); // already in fold order
    expect(map.get("r2")).toEqual({ parent: "WRONG", exact: true });
  });

  test("non-lineage records and malformed payloads are skipped", () => {
    const map = foldLineage([
      { ...rec(1, {}), kind: "CHECK" },
      rec(2, { noEdges: true }),
      rec(3, { edges: [ed("r1", null)] }),
    ]);
    expect(map.size).toBe(1);
    expect(map.get("r1")).toEqual({ parent: null, exact: true });
  });
});

describe("livePathFor — root..leaf along the known edges", () => {
  const edges: LineageMap = new Map([
    ["r1", { parent: null, exact: true }],
    ["r2", { parent: "r1", exact: true }],
    ["r3", { parent: "r2", exact: true }],
  ]);

  test("walks the chain root..leaf", () => {
    expect(livePathFor(edges, "r3")).toEqual(["r1", "r2", "r3"]);
  });

  test("an unknown leaf or a broken chain (missing parent) yields null", () => {
    expect(livePathFor(edges, "nope")).toBeNull();
    const broken: LineageMap = new Map([...edges, ["r4", { parent: "gone", exact: true }]]);
    expect(livePathFor(broken, "r4")).toBeNull();
  });

  test("a cycle is not walked forever — null", () => {
    const cyclic: LineageMap = new Map([
      ["a", { parent: "b", exact: true }],
      ["b", { parent: "a", exact: true }],
    ]);
    expect(livePathFor(cyclic, "a")).toBeNull();
  });
});

describe("inferEdgesFromArrival — unverified linear edges + tool_use links", () => {
  test("arrival order yields linear unverified edges", () => {
    const edges = inferEdgesFromArrival(["r1", "r2", "r3"]);
    expect(edges).toEqual([ed("r1", null, false), ed("r2", "r1", false), ed("r3", "r2", false)]);
  });

  test("a tool_result row links to its tool_use row (overrides the linear neighbor)", () => {
    // rows: u1 (assistant with tool_use id=t9), u2 (user tool_result t9),
    // u3 (next user) — arrival linear would say u3.parent=u2, u2.parent=u1
    const rows: Array<{ uuid: string; toolUseIds?: string[]; toolResultIds?: string[] }> = [
      { uuid: "u1", toolUseIds: ["t9"] },
      { uuid: "u2", toolResultIds: ["t9"] },
      { uuid: "u3" },
    ];
    const edges = inferEdgesFromArrival(
      rows.map((r) => r.uuid),
      rows,
    );
    const byUuid = new Map(edges.map((e) => [e.uuid, e]));
    expect(byUuid.get("u2")).toEqual({ uuid: "u2", parent: "u1", exact: false }); // the link
    expect(byUuid.get("u3")).toEqual({ uuid: "u3", parent: "u2", exact: false });
    expect(byUuid.get("u1")).toEqual({ uuid: "u1", parent: null, exact: false });
  });

  test("empty arrival yields no edges", () => {
    expect(inferEdgesFromArrival([])).toEqual([]);
  });
});

describe("appendEdges — one lineage record per batch of edges", () => {
  test("writes a lineage record the fold reads back", async () => {
    const written: unknown[] = [];
    const fakeLedger = {
      append(kind: string, payload: unknown, marker: string) {
        written.push({ kind, payload, marker });
        return "p1:1";
      },
    };
    appendEdges(fakeLedger as never, [ed("r2", "r1")], "r2");
    expect(written).toEqual([{ kind: "lineage", payload: { edges: [ed("r2", "r1")] }, marker: "r2" }]);
  });
});

// ---- helpers ---------------------------------------------------------------------

function rec(seq: number, payload: Record<string, unknown>) {
  return {
    producerId: "p1",
    seq,
    ts: seq,
    marker: "r1",
    at: "r1",
    kind: "lineage" as const,
    payload,
  };
}
