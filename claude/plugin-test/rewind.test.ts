// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// Engine-run rewind twins. KIT REALITY (same class as the conflicts twin):
// the kit's $ carries no session.messages view the test controls, and the
// plugin-under-test's session.start arm does not fire by itself — so the
// live chain choreography rides the Node harness suites. What this twin
// proves under the REAL kit loader: (a) the rewind modules load inside the
// plugin's closure (the loader accepts their import graph — the closure
// guarantee for the whole layer stack), (b) the layer stack decides over
// real module code: the live chain's verdict, the rewind application
// ordering (abort before refold), the lineage fold, and the tail tier's
// parse.
import { describe, expect, mock as kitMock, test } from "claude-code/testing";
import { checkpointService } from "../host/rewind/checkpoint-service.js";
import { appendEdges, foldLineage, livePathFor } from "../host/rewind/lineage.js";
import { LiveChainProcessor } from "../host/rewind/live-chain.js";
import { applyLiveRewind } from "../host/rewind/live-rewind.js";
import { parseCapsuleTail } from "../host/rewind/tail-read.js";
import { TruncationTripwires } from "../host/rewind/tripwires.js";
import { exactEdges, parseTranscript, verifyJunction } from "../host/rewind/verifier.js";

describe("rewind layers — engine-run twin (kit loader closure + decisions)", () => {
  test("the module graph loads inside the plugin closure (every layer importable)", () => {
    expect(typeof kitMock).toBeDefined();
    expect(typeof LiveChainProcessor).toBe("function");
    expect(typeof applyLiveRewind).toBe("function");
    expect(typeof parseTranscript).toBe("function");
  });

  test("the live chain detects an anchor mismatch over real module code", async () => {
    const patched: Array<{ uuid: string; parent: string | null }> = [];
    const rewinds: Array<{ settle: string | null }> = [];
    const proc = new LiveChainProcessor({
      statSize: async () => 1000,
      readTail: async () =>
        parseCapsuleTail(
          `${[JSON.stringify({ uuid: "t1", parentUuid: null }), JSON.stringify({ uuid: "u9", parentUuid: "t1" })].join(
            "\n",
          )}\n`,
          64,
        ),
      owlTailExcluding: () => "t2",
      isKnownRow: (uuid) => uuid === "t1",
      patchEdges: (edges) => {
        for (const e of edges) patched.push({ uuid: e.uuid, parent: e.parent });
      },
      onRewind: (v) => {
        rewinds.push(v);
      },
      schedule: () => () => {},
      log: () => {},
    });
    expect(proc.enqueue({ uuid: "u9", door: "response", captured: true })).toBe(true);
    await proc.flush();
    // the settle is the LAST VERIFIED row (the new world's tip), never the
    // pre-rewind anchor
    expect(rewinds).toEqual([{ settle: "u9" }]);
    expect(patched).toEqual([{ uuid: "u9", parent: "t1" }]);
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

  test("the rewind application ordering holds over the real deps (abort awaits BEFORE refold; divergence is recorded)", async () => {
    const order: string[] = [];
    const logs: string[] = [];
    await applyLiveRewind(
      {
        abortAndAwaitInFlight: async () => {
          order.push("abort");
        },
        liveOrderFor: async () => ["k1"],
        deadPath: async () => ["k2"],
        refold: async () => {
          order.push("refold");
          return { quarantined: 1 };
        },
        onDivergence: (_p, dead) => {
          order.push(`divergence:${dead.join(",")}`);
        },
        log: (line) => logs.push(line),
      },
      { settle: "k1" },
    );
    expect(order).toEqual(["abort", "refold", "divergence:k2"]);
    expect(logs[0]).toContain("live rewind");
  });

  test("the lineage ledger append feeds the fold the exact edges", () => {
    const records: unknown[] = [];
    appendEdges(
      {
        append: (kind: "lineage", payload: unknown, marker: string) => {
          records.push({ kind, payload, marker });
          return "x";
        },
      },
      [{ uuid: "r9", parent: "r1", exact: true }],
      "r9",
    );
    const edges = foldLineage(
      records.map((r, i) => ({
        producerId: "p1",
        seq: i + 1,
        ts: 1,
        marker: "r9",
        at: "r9",
        kind: "lineage" as const,
        payload: (r as { payload: unknown }).payload,
      })),
    );
    expect(edges.get("r9")).toEqual({ parent: "r1", exact: true });
  });

  test("the rewind service assembly exists (one tripwire instance per process)", () => {
    expect(checkpointService().tripwires()).toBe(checkpointService().tripwires());
    expect(typeof TruncationTripwires).toBe("function");
  });
});
