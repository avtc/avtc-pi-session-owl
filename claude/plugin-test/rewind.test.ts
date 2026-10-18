// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// Engine-run rewind twins. KIT REALITY (same class as the conflicts twin):
// the kit's $ carries no session.messages view the test controls, and the
// plugin-under-test's session.start arm does not fire by itself — so the
// live boundary choreography rides the Node harness suites. What this twin
// proves under the REAL kit loader: (a) the rewind modules load inside the
// plugin's closure (the loader accepts their import graph — the closure
// guarantee for the whole layer stack), (b) the layer stack decides over
// real module code: the canonical alignment, the tripwire degrade, the
// checkpoint dep assembly, and the reconciliation ordering (abort before
// refold, CHECK after).
import { describe, expect, mock as kitMock, test } from "claude-code/testing";
import { alignCanonical, type Fingerprint, fingerprintBlocks } from "../host/rewind/canonical-check.js";
import { checkpointService } from "../host/rewind/checkpoint-service.js";
import { appendEdges, foldLineage, type LineageEdge, livePathFor } from "../host/rewind/lineage.js";
import { runCheckpoint } from "../host/rewind/reconcile.js";
import { TruncationTripwires } from "../host/rewind/tripwires.js";
import { exactEdges, parseTranscript, verifyJunction } from "../host/rewind/verifier.js";

const fp = (o: Partial<Fingerprint> = {}): Fingerprint => ({ toolUseIds: [], toolResultIds: [], textSig: "", ...o });

describe("rewind layers — engine-run twin (kit loader closure + decisions)", () => {
  test("the module graph loads inside the plugin closure (every layer importable)", () => {
    expect(typeof kitMock).toBeDefined();
    expect(typeof alignCanonical).toBe("function");
    expect(typeof runCheckpoint).toBe("function");
    expect(typeof parseTranscript).toBe("function");
  });

  test("the canonical alignment decides a rewind over real module code", () => {
    const known = [
      { uuid: "r1", f: fingerprintBlocks([{ type: "tool_use", id: "t1", name: "x", input: {} }]) },
      { uuid: "r2", f: fingerprintBlocks([{ type: "tool_result", tool_use_id: "t1", content: "ok" }]) },
      { uuid: "r3", f: fingerprintBlocks([{ type: "tool_use", id: "t2", name: "x", input: {} }]) },
    ];
    const api = [
      fingerprintBlocks([{ type: "tool_use", id: "t1", name: "x", input: {} }]),
      fingerprintBlocks([{ type: "tool_result", tool_use_id: "t1", content: "ok" }]),
      fingerprintBlocks([{ type: "tool_use", id: "t9", name: "x", input: {} }]),
    ];
    const v = alignCanonical(known, api);
    if (v.kind !== "divergence") throw new Error(`expected divergence, got ${v.kind}`);
    expect(v.P).toBe("r2");
    expect(v.provisional).toBe(false);
  });

  test("the transcript pass resolves the tip from the last-prompt marker + exact edges fold into a live path", () => {
    const text = [
      JSON.stringify({ uuid: "r1", parentUuid: null }),
      JSON.stringify({ uuid: "r2", parentUuid: "r1" }),
      JSON.stringify({ uuid: "r3", parentUuid: "r2" }),
      JSON.stringify({ type: "last-prompt", leafUuid: "r2", rewound: true }),
    ].join("\n");
    const pass = parseTranscript(text);
    if (pass.kind !== "ok") throw new Error("expected ok");
    expect(pass.tip).toBe("r2");
    expect(verifyJunction(pass.rows, "r2")).toEqual({ present: true, exactParent: "r1" });
    const edges = foldLineage([
      {
        producerId: "p1",
        seq: 1,
        ts: 1,
        marker: "r2",
        at: "r2",
        kind: "lineage" as const,
        payload: { edges: exactEdges(pass.rows) },
      },
    ]);
    expect(livePathFor(edges, "r3")).toEqual(["r1", "r2", "r3"]);
  });

  test("the reconciliation ordering holds over the real deps (abort awaits BEFORE refold; the divergence CHECK lands after)", async () => {
    const order: string[] = [];
    const tripwires = new TruncationTripwires();
    const logs: string[] = [];
    const deps = {
      key: "twin-main",
      apiMessages: async () => [fp({ toolUseIds: ["t1"] }), fp({ toolUseIds: ["t9"] })],
      knownPath: () => [
        { uuid: "k1", f: fp({ toolUseIds: ["t1"] }) },
        { uuid: "k2", f: fp({ toolUseIds: ["t2"] }) },
      ],
      knownTip: () => "k2",
      tripwires,
      abortAndAwaitInFlight: async () => {
        order.push("abort");
      },
      liveSetFor: async (p: string | null) => (p !== null ? ["k1"] : []),
      refold: async () => {
        order.push("refold");
        return { quarantined: 1 };
      },
      appendCheck: (marker: string) => {
        order.push(`check:${marker}`);
      },
      appendEdges: (edges: LineageEdge[], marker: string) => {
        appendEdges(
          {
            append: (_kind: "lineage", _payload: unknown, _marker: string) => "x",
          },
          edges,
          marker,
        );
        order.push("edges");
      },
      log: (line: string) => logs.push(line),
    };
    const v = await runCheckpoint(deps, { persist: true });
    if (v.kind !== "divergence") throw new Error(`expected divergence, got ${v.kind}`);
    expect(v.P).toBe("k1");
    expect(v.quarantined).toBe(1);
    expect(order).toEqual(["abort", "refold", "check:k1"]);
    expect(logs[0]).toContain("rewind detected");
    expect(logs[0]).toContain("twin-main");
  });

  test("the tripwire degrade: api unavailable + suspected ⇒ skipped-and-logged (never a blind call)", async () => {
    const tripwires = new TruncationTripwires();
    tripwires.observeMeasure("twin-main", 100);
    tripwires.observeMeasure("twin-main", 40);
    const logs: string[] = [];
    const v = await runCheckpoint(
      {
        key: "twin-main",
        apiMessages: async () => {
          throw new Error("no messages noun");
        },
        knownPath: () => [],
        knownTip: () => null,
        tripwires,
        abortAndAwaitInFlight: async () => {},
        liveSetFor: async () => [],
        refold: async () => ({ quarantined: 0 }),
        appendCheck: () => {},
        log: (line: string) => logs.push(line),
      },
      { persist: true },
    );
    expect(v.kind).toBe("skipped");
    // the unreadable-api note precedes the skip warning — nothing silent
    expect(logs.some((l) => l.includes("rewind check skipped"))).toBe(true);
    expect(logs.some((l) => l.includes("api view unreadable"))).toBe(true);
  });

  test("the checkpoint service assembly exists (one tripwire instance per process)", () => {
    expect(checkpointService().tripwires()).toBe(checkpointService().tripwires());
  });
});
