// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// The reconciliation orchestration — on-change handling for the layered
// rewind check: abort/await in-flight runs, quarantine the blind window
// (records after the last clean CHECK drop), re-fold by marker liveness,
// log. Fixture scenarios: detection at the turn boundary, orphan forks
// (dead-marked, never repaired), deep rewinds, inferred edges corrected by
// the verifier, skip-and-log, per-loop scoping, and the crash-between-CHECK
// window bound.

import { beforeEach, describe, expect, test } from "vitest";
import { type Fingerprint, fingerprintBlocks, type KnownRow } from "../../host/rewind/canonical-check.js";
import { resolveLiveSet } from "../../host/rewind/checkpoint-service.js";
import { _cleanWatermark, type CheckpointDeps, clearWatermarks, runCheckpoint } from "../../host/rewind/reconcile.js";
import { TruncationTripwires } from "../../host/rewind/tripwires.js";
import { createMemoryFs } from "../../host/storage/fs-adapter.js";
import { LedgerWriter } from "../../host/storage/ledger.js";
import { type MirroredRow, MirrorWriter } from "../../host/storage/mirror.js";
import { prepareStoreContext } from "../../host/storage/store-context.js";

// ---- the fixture kit ----------------------------------------------------------------

const mem = createMemoryFs();
const DIR = "/sess";

interface Harness {
  deps: CheckpointDeps;
  ledger: LedgerWriter;
  mirror: MirrorWriter;
  logs: string[];
  checks: string[];
  aborts: number;
  apiFps: () => Promise<Fingerprint[]>;
}

function row(
  uuid: string,
  parentUuid: string | null,
  content: unknown[] = [{ type: "text", text: `t ${uuid}` }],
): MirroredRow {
  return { uuid, parentUuid, row: { uuid, parentUuid, message: { content } } };
}

function toolUse(id: string) {
  return { type: "tool_use", id, name: "x", input: {} };
}
function toolResult(id: string) {
  return { type: "tool_result", tool_use_id: id, content: "ok" };
}

/** Build a full store harness: mirror + ledger + prepared context. */
async function makeHarness(): Promise<Harness> {
  mem.files.clear();
  const ledger = new LedgerWriter(mem.adapter, DIR, "p1", () => 1000);
  const mirror = new MirrorWriter(mem.adapter, DIR, "p1");
  const prepared = await prepareStoreContext(mem.adapter, DIR, ledger, mirror);
  const logs: string[] = [];
  const checks: string[] = [];
  const harness: Harness = {
    ledger,
    mirror,
    logs,
    checks,
    aborts: 0,
    apiFps: async () => [],
    deps: null as unknown as CheckpointDeps,
  };
  const apiThrow: Error | null = null;
  harness.apiFps = () => {
    if (apiThrow !== null) throw apiThrow;
    return Promise.resolve([]);
  };
  const deadSet = new Set<string>();
  const deps: CheckpointDeps = {
    key: "main",
    apiMessages: () => harness.apiFps(),
    knownPath: () => {
      const branch = prepared.lastBranch().length > 0 ? prepared.lastBranch() : mirror.arrivalOrder();
      const known: KnownRow[] = [];
      for (const uuid of branch.filter((u) => !deadSet.has(u))) {
        const r = mirror.chainTo(uuid); // presence probe only
        void r;
        const raw = (mirror as unknown as { rowsById: Map<string, MirroredRow> }).rowsById.get(uuid);
        const content = (raw?.row as { message?: { content?: unknown } } | undefined)?.message?.content ?? [];
        known.push({ uuid, f: fingerprintBlocks(content) });
      }
      return known;
    },
    knownTip: () => mirror.tipUuid(),
    tripwires: new TruncationTripwires(),
    abortAndAwaitInFlight: async () => {
      harness.aborts += 1;
    },
    liveSetFor: async (p: string | null) =>
      resolveLiveSet({ key: "main", dir: DIR, fs: mem.adapter, mirror, ledger, producerId: "p1" }, p),
    refold: async (liveSet: ReadonlySet<string>, liveOrder: readonly string[], dead: ReadonlySet<string>) => {
      prepared.setLiveBranch(liveOrder, dead);
      await prepared.refresh((uuid: string) => liveSet.has(uuid));
      return { quarantined: prepared.recordsRef.quarantinedDropped };
    },
    appendCheck: (marker: string) => {
      checks.push(marker);
      ledger.append("CHECK", {}, marker);
    },
    appendEdges: (edges, marker) => {
      ledger.append("lineage", { edges }, marker);
    },
    onDivergence: (_p: string | null, dead: string[]) => {
      for (const uuid of dead) deadSet.add(uuid);
    },
    log: (line: string) => logs.push(line),
  };
  harness.deps = deps;
  (harness as Harness & { prepared: typeof prepared }).prepared = prepared;
  return harness;
}

// ---- unit behavior ---------------------------------------------------------------------

describe("runCheckpoint — the layered order", () => {
  test("clean via api: no CHECK persisted at a non-persist point (recall entry = watermark only)", async () => {
    const h = await makeHarness();
    h.mirror.bufferRow(row("r1", null));
    h.mirror.bufferRow(row("r2", "r1"));
    h.apiFps = async () => [
      fingerprintBlocks([{ type: "text", text: "t r1" }]),
      fingerprintBlocks([{ type: "text", text: "t r2" }]),
    ];
    const v = await runCheckpoint(h.deps, { persist: false });
    expect(v).toEqual({ kind: "clean", via: "api" });
    expect(h.checks).toEqual([]);
  });

  test("clean at a persist point appends exactly one CHECK at the known tip", async () => {
    const h = await makeHarness();
    h.mirror.bufferRow(row("r1", null));
    h.apiFps = async () => [fingerprintBlocks([{ type: "text", text: "t r1" }])];
    const v = await runCheckpoint(h.deps, { persist: true });
    expect(v.kind).toBe("clean");
    expect(h.checks).toEqual(["r1"]);
  });

  test("api unavailable + tripwires clean ⇒ clean-by-tripwire (the continuity assumption)", async () => {
    const h = await makeHarness();
    h.apiFps = () => Promise.reject(new Error("api unavailable"));
    const v = await runCheckpoint(h.deps, { persist: true });
    expect(v).toEqual({ kind: "clean", via: "tripwire" });
  });

  test("api unavailable + tripwire suspected ⇒ skipped-and-logged (never a blind divergence call)", async () => {
    const h = await makeHarness();
    h.apiFps = () => Promise.reject(new Error("api unavailable"));
    (h.deps.tripwires as TruncationTripwires).observeMeasure("main", 100);
    (h.deps.tripwires as TruncationTripwires).observeMeasure("main", 50);
    const v = await runCheckpoint(h.deps, { persist: true });
    expect(v.kind).toBe("skipped");
    expect(h.logs.some((l) => l.includes("rewind check skipped"))).toBe(true);
    expect(h.checks).toEqual([]);
  });

  test("api unavailable + no tripwires ⇒ skipped-and-logged (the accepted degrade)", async () => {
    const h = await makeHarness();
    h.apiFps = () => Promise.reject(new Error("api unavailable"));
    const bareDeps: CheckpointDeps = { ...h.deps, tripwires: undefined };
    const v = await runCheckpoint(bareDeps, { persist: true });
    expect(v.kind).toBe("skipped");
    // the unreadable-api note + the skip warning — nothing silent
    expect(h.logs.length).toBe(2);
    expect(h.logs.some((l) => l.includes("rewind check skipped"))).toBe(true);
    expect(h.logs.some((l) => l.includes("api view unreadable"))).toBe(true);
  });

  test("per-loop scoping: keys are isolated series (a suspected loop never skips the main check)", async () => {
    const h = await makeHarness();
    h.mirror.bufferRow(row("r1", null));
    h.apiFps = () => Promise.reject(new Error("api unavailable"));
    (h.deps.tripwires as TruncationTripwires).observeMeasure("loop-1", 100);
    (h.deps.tripwires as TruncationTripwires).observeMeasure("loop-1", 50);
    const v = await runCheckpoint({ ...h.deps, key: "main" }, { persist: true });
    expect(v).toEqual({ kind: "clean", via: "tripwire" });
  });
});

// ---- the rewind fixture (the plan's scenario) -------------------------------------------

describe("runCheckpoint — detection + quarantine + re-fold", () => {
  let h: Harness;

  beforeEach(async () => {
    clearWatermarks();
    h = await makeHarness();
    // live path root..P4, then a tail P5..P6 (about to be rewound away)
    h.mirror.bufferRow(row("P1", null, [toolUse("t1")]));
    h.mirror.bufferRow(row("P2", "P1", [toolResult("t1")]));
    h.mirror.bufferRow(row("P3", "P2", [toolUse("t2")]));
    h.mirror.bufferRow(row("P4", "P3", [toolResult("t2")]));
    // an observation covering P1..P4 rides the ledger (live marker P4)
    h.ledger.append("observation", { coversUpToId: "P4", summary: "obs …P4" }, "P4");
    // clean check at the boundary (the pre-rewind CHECK)
    h.ledger.append("CHECK", {}, "P4");
    // the dead tail + a blind-window observation on it
    h.mirror.bufferRow(row("P5", "P4", [toolUse("t3")]));
    h.mirror.bufferRow(row("P6", "P5", [toolResult("t3")]));
    h.ledger.append("observation", { coversUpToId: "P6", summary: "obs dead tail" }, "P6");
    await h.ledger.flush();
    // the rewind: the user rewound to P4 and sent P5'
    h.mirror.bufferRow(row("P5prime", "P4", [toolUse("t4")]));
    // the api form now shows the canonical chain root..P4 + P5'
    h.apiFps = async () => [
      fingerprintBlocks([toolUse("t1")]),
      fingerprintBlocks([toolResult("t1")]),
      fingerprintBlocks([toolUse("t2")]),
      fingerprintBlocks([toolResult("t2")]),
      fingerprintBlocks([toolUse("t4")]),
    ];
  });

  test("divergence detected at P4: in-flight aborted, blind window quarantined, the …P4 observation survives the re-fold", async () => {
    const v = await runCheckpoint(h.deps, { persist: true });
    if (v.kind !== "divergence") throw new Error(`expected divergence, got ${v.kind}`);
    // the junction anchors the LIVE path: P5' (already mirrored + present in
    // the api form) — chainTo(P5') IS root..P4..P5'
    expect(v.P).toBe("P5prime");
    expect(v.deadRows).toBe(2); // P5, P6
    expect(h.aborts).toBe(1);
    expect(h.logs.some((l) => l.includes("rewind detected"))).toBe(true);
    // divergence-verify is a persist point — the new CHECK rides the junction
    expect(h.checks).toEqual(["P5prime"]);
    // the re-fold: getBranch serves rows root..P4..P5' + the live observation
    const branch = await branchEntries(h);
    const uuids = branch.filter((e) => e.kind === "row").map((e) => e.uuid);
    expect(uuids).toEqual(["P1", "P2", "P3", "P4", "P5prime"]);
    const observations = branch.filter((e) => e.kind === "observation");
    expect(observations).toHaveLength(1); // the dead-tail observation dropped
  });

  test("the blind-window snapshot drops even with a LIVE marker (records after the last clean CHECK)", async () => {
    // a compaction fired during the blind turn: snapshot marked at P5' (live!)
    h.ledger.append("snapshot", { details: { nodes: [] } }, "P5prime");
    await h.ledger.flush();
    const v = await runCheckpoint(h.deps, { persist: true });
    if (v.kind !== "divergence") throw new Error(`expected divergence, got ${v.kind}`);
    expect(v.quarantined).toBeGreaterThanOrEqual(2); // dead observation + blind snapshot
    const branch = await branchEntries(h);
    expect(branch.some((e) => e.kind === "compaction")).toBe(false);
  });

  test("the orphan-fork class: the engine attached the prompt to an error branch — the orphaned reply is dead-marked, NEVER repaired", async () => {
    // sibling fork: the error branch child of P4 + its reply + the next
    // prompt P5x rides the error branch — the reply orphaned, excluded from
    // the model's context
    h.mirror.bufferRow(row("errBranch", "P4", [toolUse("te")]));
    h.mirror.bufferRow(row("orphReply", "errBranch", [toolResult("te")]));
    h.mirror.bufferRow(row("P5x", "errBranch", [toolUse("t5")]));
    h.apiFps = async () => [
      fingerprintBlocks([toolUse("t1")]),
      fingerprintBlocks([toolResult("t1")]),
      fingerprintBlocks([toolUse("t2")]),
      fingerprintBlocks([toolResult("t2")]),
      fingerprintBlocks([toolUse("te")]),
      fingerprintBlocks([toolUse("t5")]),
    ];
    const v = await runCheckpoint(h.deps, { persist: true });
    if (v.kind !== "divergence") throw new Error(`expected divergence, got ${v.kind}`);
    // dead: the pre-rewind tail (P5, P6), the never-sent P5prime, AND the
    // orphaned reply; the junction anchors the engine's truth —
    // root..P4, the error branch, P5x
    expect(v.P).toBe("P5x");
    expect(v.deadRows).toBe(4);
    // truth is the engine chain: the reply stays mirrored but dead — nothing "repairs" it
    const uuids = (await branchEntries(h)).filter((e) => e.kind === "row").map((e) => e.uuid);
    expect(uuids).not.toContain("orphReply");
    expect(uuids).toContain("P5x");
    expect(uuids).not.toContain("P5");
    expect(uuids).not.toContain("P5prime");
  });

  test("deep rewind: the junction sits at the window tail — P* found from the api form alone", async () => {
    // known path P1..P12; the api window shows only P8..P10 + the new row
    const h2 = await makeHarness();
    let prev: string | null = null;
    for (let i = 1; i <= 12; i += 1) {
      const uuid = `D${i}`;
      h2.mirror.bufferRow(row(uuid, prev, [toolUse(`td${i}`)]));
      prev = uuid;
    }
    h2.ledger.append("CHECK", {}, "D12");
    await h2.ledger.flush();
    h2.apiFps = async () => [
      fingerprintBlocks([toolUse("td8")]),
      fingerprintBlocks([toolUse("td9")]),
      fingerprintBlocks([toolUse("td10")]),
      fingerprintBlocks([toolUse("tdNEW")]),
    ];
    const v = await runCheckpoint(h2.deps, { persist: true });
    if (v.kind !== "divergence") throw new Error(`expected divergence, got ${v.kind}`);
    expect(v.P).toBe("D10");
  });

  test("the FIRST-TURN lag: no watermark and nothing matched in the api view defers — never a 6-dead-rows rewind on turn one", async () => {
    // The first-turn false rewind: a fresh session
    // starts with an empty transcript (the start check sets no watermark),
    // the first turn's rows arrive in the mirror, and at the boundary BOTH
    // views lag (the request built before the rows; the file unflushed) —
    // the api view matches NOTHING of ours. Adjudicating that dead aborted
    // the in-flight observer every fresh session.
    const hf = await makeHarness();
    hf.mirror.bufferRow(row("f1", null, [toolUse("tf1")]));
    hf.mirror.bufferRow(row("f2", "f1", [toolResult("tf1")]));
    hf.mirror.bufferRow(row("f3", "f2", [toolUse("tf3")]));
    // the api view carries none of it (empty), the file too
    hf.apiFps = async () => [];
    hf.deps.transcriptText = async () => "";
    const v = await runCheckpoint(hf.deps, { persist: false });
    expect(v).toEqual({ kind: "clean", via: "lag" });
    expect(hf.aborts).toBe(0);
    expect(hf.logs.some((l) => l.includes("rewind detected"))).toBe(false);
    // a REAL rewind one turn later: the view carries the rewound branch —
    // its junction sits at/below the watermark set by the defer, so it
    // adjudicates (not deferred forever)
    hf.mirror.bufferRow(row("f4", "f2", [toolUse("tf4")]));
    hf.apiFps = async () => [
      fingerprintBlocks([toolUse("tf1")]),
      fingerprintBlocks([toolResult("tf1")]),
      fingerprintBlocks([toolUse("tf4")]),
    ];
    // the REWOUND file now carries the branch without the dead row (flushed by then)
    hf.deps.transcriptText = async () =>
      [
        JSON.stringify({ uuid: "f1", parentUuid: null }),
        JSON.stringify({ uuid: "f2", parentUuid: "f1" }),
        JSON.stringify({ uuid: "f4", parentUuid: "f2" }),
      ].join("\n");
    const v2 = await runCheckpoint(hf.deps, { persist: false });
    if (v2.kind !== "divergence") throw new Error(`expected divergence, got ${v2.kind}`);
    expect(v2.deadRows).toBe(1); // the middle row died (rewound past it)
  });

  test("parallel tool results hang off the live chain WITHOUT a rewind — file presence is liveness", async () => {
    // The engine's parallel-tool shape (one turn, two chained tool_use
    // rows, each result parented at ITS tool_use): the tip chain
    // runs through the second result while the first hangs off the first
    // tool_use as a sibling — a
    // normal transcript, no rewind anywhere. A resumed session's api view
    // re-renders history (fingerprint mismatch after the prompt) so the
    // junction candidate sits at u1; the file check must read tr1 as LIVE
    // (present in the file), not as a dead-fork row off the live chain —
    // parent-chain-only liveness would quarantine live records on every
    // clean exit+resume.
    const h = await makeHarness();
    h.mirror.bufferRow(row("u1", null, [{ type: "text", text: "prompt" }]));
    h.mirror.bufferRow(row("a1", "u1", [toolUse("t1")]));
    h.mirror.bufferRow(row("a2", "a1", [toolUse("t2")]));
    h.mirror.bufferRow(row("tr1", "a1", [toolResult("t1")])); // parallel sibling
    h.mirror.bufferRow(row("tr2", "a2", [toolResult("t2")]));
    h.mirror.bufferRow(row("a3", "tr2", [{ type: "text", text: "done" }]));
    // the resumed api view re-renders: the prompt matches, the rest drifts
    h.apiFps = async () => [
      fingerprintBlocks([{ type: "text", text: "prompt" }]),
      fingerprintBlocks([{ type: "text", text: "RE-RENDERED" }]),
    ];
    h.deps.transcriptText = async () =>
      [
        JSON.stringify({ uuid: "u1", parentUuid: null }),
        JSON.stringify({ uuid: "a1", parentUuid: "u1" }),
        JSON.stringify({ uuid: "a2", parentUuid: "a1" }),
        JSON.stringify({ uuid: "tr1", parentUuid: "a1" }), // off the tip chain
        JSON.stringify({ uuid: "tr2", parentUuid: "a2" }),
        JSON.stringify({ uuid: "a3", parentUuid: "tr2" }),
      ].join("\n");
    const v = await runCheckpoint(h.deps, { persist: false });
    expect(v).toEqual({ kind: "clean", via: "file" });
    expect(h.logs.some((l) => l.includes("rewind detected"))).toBe(false);
    expect(h.aborts).toBe(0);
  });

  test("ZERO dead rows after the live-set read = view shape, not a rewind — no abort, no quarantine (the mid-rebuild 71-record case)", async () => {
    // The api view omits a mid-conversation tool row (the engine condensed
    // it away) — the aligner adjudicates it absent, but the live set (the
    // mirror chain) holds every known row: a 0-dead divergence must NOT
    // abort in-flight runs or quarantine the blind window.
    const h = await makeHarness();
    h.mirror.bufferRow(row("u1", null, [{ type: "text", text: "prompt" }]));
    h.mirror.bufferRow(row("tr", "u1", [toolResult("t1")]));
    h.mirror.bufferRow(row("u3", "tr", [{ type: "text", text: "close" }]));
    // the condensed api view carries only the two text rows
    h.apiFps = async () => [
      fingerprintBlocks([{ type: "text", text: "prompt" }]),
      fingerprintBlocks([{ type: "text", text: "close" }]),
    ];
    const v = await runCheckpoint(h.deps, { persist: false });
    expect(v).toEqual({ kind: "clean", via: "file" });
    expect(h.logs.some((l) => l.includes("ZERO dead rows"))).toBe(true);
    expect(h.logs.some((l) => l.includes("rewind detected"))).toBe(false);
    expect(h.aborts).toBe(0);
  });

  test("a PROVISIONAL (text-only) junction at the watermark with a tail-only absence still defers — the unflushed-turn shape", async () => {
    // The unflushed-turn false rewind: the just-finished turn's rows sat
    // in the mirror only — the api view reflected the previous request and
    // the file had not flushed yet. The junction (deepest present row) was
    // the PREVIOUS tip = the watermark itself, matched on TEXT only (the
    // row was a plain prompt) — exactly the shape the lag defer must
    // still take.
    const hp = await makeHarness();
    hp.mirror.bufferRow(row("p1", null, [{ type: "text", text: "alpha" }]));
    hp.mirror.bufferRow(row("p2", "p1", [{ type: "text", text: "beta" }]));
    // a CLEAN check over p1..p2 — sets the watermark at p2
    hp.apiFps = async () => [
      fingerprintBlocks([{ type: "text", text: "alpha" }]),
      fingerprintBlocks([{ type: "text", text: "beta" }]),
    ];
    const v1 = await runCheckpoint(hp.deps, { persist: true });
    expect(v1.kind).toBe("clean");
    expect(_cleanWatermark("main")).toBe("p2");
    // the fresh turn arrives in the mirror only; both views still end at p2
    hp.mirror.bufferRow(row("p3", "p2", [{ type: "text", text: "gamma" }]));
    hp.apiFps = async () => [
      fingerprintBlocks([{ type: "text", text: "alpha" }]),
      fingerprintBlocks([{ type: "text", text: "beta" }]),
    ];
    hp.deps.transcriptText = async () =>
      [JSON.stringify({ uuid: "p1", parentUuid: null }), JSON.stringify({ uuid: "p2", parentUuid: "p1" })].join("\n");
    const v2 = await runCheckpoint(hp.deps, { persist: true });
    expect(v2).toEqual({ kind: "clean", via: "lag" });
    expect(hp.aborts).toBe(0);
    expect(hp.logs.some((l) => l.includes("rewind detected"))).toBe(false);
  });

  test("the WATERMARK LAG TEST — dead rows all NEWER than the last clean check are view lag, never a rewind", async () => {
    // The engine's api view AND the transcript file can both trail the live
    // rows at a turn boundary (the file flushes asynchronously). Rows that
    // arrived AFTER the last clean CHECK were never yet seen by any view —
    // adjudicating them dead on a lagging view fired a false rewind every
    // turn. They are re-adjudicated at the NEXT check once views catch up.
    const hw = await makeHarness();
    hw.mirror.bufferRow(row("w1", null, [toolUse("tw1")]));
    hw.mirror.bufferRow(row("w2", "w1", [toolResult("tw1")]));
    // a CLEAN check over w1..w2 — sets the watermark at w2
    hw.apiFps = async () => [fingerprintBlocks([toolUse("tw1")]), fingerprintBlocks([toolResult("tw1")])];
    const v1 = await runCheckpoint(hw.deps, { persist: true });
    expect(v1.kind).toBe("clean");
    expect(_cleanWatermark("main")).toBe("w2");
    // the fresh turn arrives in the mirror only
    hw.mirror.bufferRow(row("w3", "w2", [toolUse("tw3")]));
    hw.mirror.bufferRow(row("w4", "w3", [toolResult("tw3")]));
    // both views still end at w2 (api AND file lag)
    hw.apiFps = async () => [fingerprintBlocks([toolUse("tw1")]), fingerprintBlocks([toolResult("tw1")])];
    hw.deps.transcriptText = async () =>
      [JSON.stringify({ uuid: "w1", parentUuid: null }), JSON.stringify({ uuid: "w2", parentUuid: "w1" })].join("\n");
    const v2 = await runCheckpoint(hw.deps, { persist: true });
    expect(v2).toEqual({ kind: "clean", via: "lag" });
    expect(hw.aborts).toBe(0);
    expect(hw.logs.some((l) => l.includes("rewind detected"))).toBe(false);
    // a LATER check whose views now carry w3..w4 stays clean (no deferred
    // false rewind when the rows are simply present)
    hw.apiFps = async () => [
      fingerprintBlocks([toolUse("tw1")]),
      fingerprintBlocks([toolResult("tw1")]),
      fingerprintBlocks([toolUse("tw3")]),
      fingerprintBlocks([toolResult("tw3")]),
    ];
    const v3 = await runCheckpoint(hw.deps, { persist: true });
    expect(v3.kind).toBe("clean");
    expect(_cleanWatermark("main")).toBe("w4");
    // and a REAL rewind of CHECKED rows (at/below the watermark) still fires
    hw.mirror.bufferRow(row("w5", "w4", [toolUse("tw5")]));
    hw.apiFps = async () => [fingerprintBlocks([toolUse("tw1")]), fingerprintBlocks([toolResult("tw1")])];
    const v4 = await runCheckpoint(hw.deps, { persist: true });
    if (v4.kind !== "divergence") throw new Error(`expected divergence, got ${v4.kind}`);
    expect(hw.aborts).toBe(1);
  });

  test("the FILE VETO — an api view a turn behind the file is view lag, never a rewind", async () => {
    // The engine's messages({as:'api'}) reflects the last built request; at
    // a turn boundary it can lack the whole finished turn while the
    // transcript FILE already carries it on its live chain. The file is the
    // durable truth (a real rewind rewrites it) — the divergence is vetoed.
    const h2 = await makeHarness();
    h2.mirror.bufferRow(row("r1", null));
    h2.mirror.bufferRow(row("r2", "r1"));
    h2.mirror.bufferRow(row("r3", "r2"));
    h2.ledger.append("CHECK", {}, "r3");
    await h2.ledger.flush();
    // the api view still shows the previous request (through r1 only)
    h2.apiFps = async () => [fingerprintBlocks([{ type: "text", text: "t r1" }])];
    const transcript = [
      JSON.stringify({ uuid: "r1", parentUuid: null }),
      JSON.stringify({ uuid: "r2", parentUuid: "r1" }),
      JSON.stringify({ uuid: "r3", parentUuid: "r2" }),
      // a STALE last-prompt marker (lags the newest append) must not defeat
      // the veto — the newest-append chain carries the known tip
      JSON.stringify({ type: "last-prompt", leafUuid: "r1" }),
    ].join("\n");
    h2.deps.transcriptText = async () => transcript;
    const v = await runCheckpoint(h2.deps, { persist: true });
    expect(v).toEqual({ kind: "clean", via: "file" });
    expect(h2.aborts).toBe(0);
    expect(h2.logs.some((l) => l.includes("rewind detected"))).toBe(false);
    // the persist point still lands its CHECK at the known tip
    expect(h2.checks).toContain("r3");
  });

  test("the HELPER TIER — transcriptPass feeds the same file veto (the over-cap CLI route); a missing tier never blocks the layer-2 verdict", async () => {
    // $.fs.read refuses files over the 4 MiB cap; on CLI surfaces the Node
    // helper streams the same facts and hands the ALREADY-PARSED pass to
    // the checkpoint — the veto logic must consume it identically.
    const hh = await makeHarness();
    hh.mirror.bufferRow(row("q1", null));
    hh.mirror.bufferRow(row("q2", "q1"));
    hh.mirror.bufferRow(row("q3", "q2"));
    hh.ledger.append("CHECK", {}, "q3");
    await hh.ledger.flush();
    // the api view still shows the previous request (through q1 only)
    hh.apiFps = async () => [fingerprintBlocks([{ type: "text", text: "t q1" }])];
    hh.deps.transcriptPass = async () =>
      ({
        kind: "ok",
        rows: [
          { uuid: "q1", parentUuid: null },
          { uuid: "q2", parentUuid: "q1" },
          { uuid: "q3", parentUuid: "q2" },
        ],
        tip: "q3",
        rewound: false,
      }) as const;
    const v1 = await runCheckpoint(hh.deps, { persist: true });
    expect(v1).toEqual({ kind: "clean", via: "file" });
    expect(hh.aborts).toBe(0);
    // transcriptPass WINS over a stale transcriptText (the richer tier is
    // the one the wiring armed)
    hh.deps.transcriptText = async () => "";
    const v1b = await runCheckpoint(hh.deps, { persist: true });
    expect(v1b).toEqual({ kind: "clean", via: "file" });
    // a MISSING tier (non-CLI over-cap, helper failed): no transcript deps
    // at all — the layer-2 api verdict proceeds (the documented degrade,
    // never a blocked check)
    const hm = await makeHarness();
    hm.mirror.bufferRow(row("m1", null));
    hm.mirror.bufferRow(row("m2", "m1"));
    hm.mirror.bufferRow(row("m3", "m2"));
    hm.ledger.append("CHECK", {}, "m3");
    await hm.ledger.flush();
    hm.apiFps = async () => [fingerprintBlocks([{ type: "text", text: "t m1" }])];
    const v2 = await runCheckpoint(hm.deps, { persist: true });
    expect(v2.kind).toBe("divergence");
    expect(hm.aborts).toBe(1);
  });

  test("the file veto never saves a DEAD fork — the known tip off the file's live chains still reconciles", async () => {
    const h2 = await makeHarness();
    h2.mirror.bufferRow(row("f1", null));
    h2.mirror.bufferRow(row("f2", "f1"));
    h2.mirror.bufferRow(row("f3", "f2")); // the dead fork leaf (our known tip)
    h2.ledger.append("CHECK", {}, "f3");
    await h2.ledger.flush();
    // the api view moved to the surviving fork
    h2.apiFps = async () => [
      fingerprintBlocks([{ type: "text", text: "t f1" }]),
      fingerprintBlocks([{ type: "text", text: "t f2" }]),
      fingerprintBlocks([{ type: "text", text: "t f3new" }]),
    ];
    const transcript = [
      JSON.stringify({ uuid: "f1", parentUuid: null }),
      JSON.stringify({ uuid: "f2", parentUuid: "f1" }),
      JSON.stringify({ uuid: "f3", parentUuid: "f2" }), // dead branch, still in the file
      JSON.stringify({ uuid: "f3new", parentUuid: "f2" }), // the live fork
      JSON.stringify({ type: "last-prompt", leafUuid: "f3new" }),
    ].join("\n");
    h2.deps.transcriptText = async () => transcript;
    const v = await runCheckpoint(h2.deps, { persist: true });
    if (v.kind !== "divergence") throw new Error(`expected divergence, got ${v.kind}`);
    expect(h2.aborts).toBe(1);
  });

  test("the verifier confirms a tool-id junction and appends its exact edges", async () => {
    const transcript = [
      JSON.stringify({ uuid: "P1", parentUuid: null }),
      JSON.stringify({ uuid: "P2", parentUuid: "P1" }),
      JSON.stringify({ uuid: "P3", parentUuid: "P2" }),
      JSON.stringify({ uuid: "P4", parentUuid: "P3" }),
      JSON.stringify({ uuid: "P5prime", parentUuid: "P4" }),
      JSON.stringify({ type: "last-prompt", leafUuid: "P5prime" }),
    ].join("\n");
    h.deps.transcriptText = async () => transcript;
    const v = await runCheckpoint(h.deps, { persist: true });
    if (v.kind !== "divergence") throw new Error(`expected divergence, got ${v.kind}`);
    expect(v.verified).toBe(true);
    // the exact edges landed as lineage records
    const lineage = h.ledger.bufferedRecords().filter((r) => r.kind === "lineage");
    expect(lineage.length).toBeGreaterThan(0);
    expect(v.provisional).toBe(false);
  });

  test("a text-only junction with no verifier stays provisional but still reconciles", async () => {
    // text-only fingerprints: same text on the junction row
    const h3 = await makeHarness();
    h3.mirror.bufferRow(row("txtRoot", null, [{ type: "text", text: "alpha" }]));
    h3.mirror.bufferRow(row("txtMid", "txtRoot", [{ type: "text", text: "beta" }]));
    h3.mirror.bufferRow(row("txtTip", "txtMid", [{ type: "text", text: "gamma" }]));
    h3.ledger.append("CHECK", {}, "txtTip");
    h3.ledger.append("observation", { coversUpToId: "txtTip" }, "txtTip");
    await h3.ledger.flush();
    h3.mirror.bufferRow(row("txtNew", "txtRoot", [{ type: "text", text: "new" }]));
    h3.apiFps = async () => [
      fingerprintBlocks([{ type: "text", text: "alpha" }]),
      fingerprintBlocks([{ type: "text", text: "new" }]),
    ];
    const v = await runCheckpoint(h3.deps, { persist: true });
    if (v.kind !== "divergence") throw new Error(`expected divergence, got ${v.kind}`);
    // the junction anchors the live path: the mirrored new prompt (present
    // via its text); the two older rows are the dead tail. Text-only ⇒
    // provisional.
    expect(v.P).toBe("txtNew");
    expect(v.deadRows).toBe(2);
    expect(v.provisional).toBe(true);
    expect(v.verified).toBe(false);
  });

  test("detection is STICKY: the next clean turn after a divergence does not re-fire", async () => {
    const v1 = await runCheckpoint(h.deps, { persist: true });
    if (v1.kind !== "divergence") throw new Error(`expected divergence, got ${v1.kind}`);
    expect(v1.deadRows).toBe(2);
    // the dead set accumulated — the SAME api view is clean on the next check
    const v2 = await runCheckpoint(h.deps, { persist: true });
    expect(v2).toEqual({ kind: "clean", via: "api" });
    expect(h.aborts).toBe(1); // no second abort
    expect(h.logs.filter((l) => l.includes("rewind detected"))).toHaveLength(1);
  });

  test("snapshot selection feeds marker liveness: a dead-marker NEWEST snapshot yields to the older LIVE one", async () => {
    // an older live snapshot (marker P4, pre-CHECK)…
    h.ledger.append("snapshot", { nodes: ["live-snap"] }, "P4");
    h.ledger.append("CHECK", {}, "P4");
    await h.ledger.flush();
    // …then the blind-window snapshot at a LIVE marker P5' (post-CHECK)
    h.ledger.append("snapshot", { nodes: ["blind-snap"] }, "P5prime");
    await h.ledger.flush();
    const v = await runCheckpoint(h.deps, { persist: true });
    if (v.kind !== "divergence") throw new Error(`expected divergence, got ${v.kind}`);
    // the fixture's own mid-window CHECK is the newest live boundary: the
    // blind snapshot (its only successor) drops
    expect(v.quarantined).toBeGreaterThanOrEqual(1);
    const branch = await branchEntries(h);
    // the blind snapshot is quarantined AND the dead-marker rule cannot
    // select it — the older live snapshot serves (never "no compaction")
    const compactions = branch.filter((e) => e.kind === "compaction");
    expect(compactions).toHaveLength(1);
    expect(compactions[0]?.nodes).toEqual(["live-snap"]);
  });

  test("a snapshot written on the DEAD TAIL (crash shape) is dead-marked, never selected — the older live one serves", async () => {
    // pre-boundary: an observation + a LIVE snapshot + the clean CHECK
    h.ledger.append("snapshot", { nodes: ["live-snap"] }, "P4");
    h.ledger.append("CHECK", {}, "P4");
    // the dead-tail snapshot: marker P6 (off the live path), written AFTER
    // the boundary — dead by BOTH rules (marker liveness and quarantine)
    h.ledger.append("snapshot", { nodes: ["dead-snap"] }, "P6");
    await h.ledger.flush();
    const v = await runCheckpoint(h.deps, { persist: true });
    if (v.kind !== "divergence") throw new Error(`expected divergence, got ${v.kind}`);
    // the dead-tail snapshot (post-boundary) drops by quarantine; the dead
    // observation below the mid-fixture CHECK dies by MARKER liveness
    expect(v.quarantined).toBeGreaterThanOrEqual(1);
    const branch = await branchEntries(h);
    const compactions = branch.filter((e) => e.kind === "compaction");
    expect(compactions).toHaveLength(1); // the LIVE snapshot, never the dead one
    expect(compactions[0]?.nodes).toEqual(["live-snap"]);
  });

  test("the production edge world: rows carry NO parentUuid — the LIVE set comes from the lineage ledger, the served branch follows it", async () => {
    // fresh storage: same ledger/mirror dirs, but rows buffered WITHOUT edges
    const h4 = await makeHarness();
    const noEdge = (uuid: string): MirroredRow => ({
      uuid,
      parentUuid: null,
      row: {
        uuid,
        parentUuid: null,
        message: { content: [{ type: "tool_use", id: `t-${uuid}`, name: "x", input: {} }] },
      },
    });
    h4.mirror.bufferRow(noEdge("Q1"));
    h4.mirror.bufferRow(noEdge("Q2"));
    h4.mirror.bufferRow(noEdge("Q3"));
    h4.ledger.append("observation", { coversUpToId: "Q2", summary: "obs Q1..Q2" }, "Q2");
    h4.ledger.append("CHECK", {}, "Q2");
    // the rewind: Q3 died, Q4 is the new prompt; a lineage pass recorded the
    // true chain (exact edges from the transcript verifier)
    h4.mirror.bufferRow(noEdge("Q3x"));
    h4.mirror.bufferRow(noEdge("Q4"));
    h4.ledger.append(
      "lineage",
      {
        edges: [
          { uuid: "Q1", parent: null, exact: true },
          { uuid: "Q2", parent: "Q1", exact: true },
          { uuid: "Q3x", parent: "Q2", exact: false },
          { uuid: "Q4", parent: "Q3x", exact: true },
        ],
      },
      "Q4",
    );
    await h4.ledger.flush();
    h4.apiFps = async () => [
      fingerprintBlocks([{ type: "tool_use", id: "t-Q1", name: "x", input: {} }]),
      fingerprintBlocks([{ type: "tool_use", id: "t-Q2", name: "x", input: {} }]),
      fingerprintBlocks([{ type: "tool_use", id: "t-Q3x", name: "x", input: {} }]),
      fingerprintBlocks([{ type: "tool_use", id: "t-Q4", name: "x", input: {} }]),
    ];
    const v = await runCheckpoint(h4.deps, { persist: true });
    if (v.kind !== "divergence") throw new Error(`expected divergence, got ${v.kind}`);
    expect(v.deadRows).toBe(1); // Q3 (dead tail; Q3x/Q4 live via the ledger)
    const branch = await branchEntries(h4);
    const uuids = branch.filter((e) => e.kind === "row").map((e) => e.uuid);
    expect(uuids).toEqual(["Q1", "Q2", "Q3x", "Q4"]); // the ledger's live order served
  });

  test("the rewind-while-absent shape: dead-tail rows arriving AFTER the anchor never leak back into the served branch", async () => {
    // the start-checkpoint world: the junction is the rewind point P4 and
    // the dead tail P5..P6 arrived (were mirrored) BEFORE detection
    const v = await runCheckpoint(h.deps, { persist: true });
    if (v.kind !== "divergence") throw new Error(`expected divergence, got ${v.kind}`);
    const branch = await branchEntries(h);
    const uuids = branch.filter((e) => e.kind === "row").map((e) => e.uuid);
    expect(uuids).toEqual(["P1", "P2", "P3", "P4", "P5prime"]); // P5, P6 stay out
  });

  test("the served branch GROWS after a divergence: rows observed later join it (never a freeze)", async () => {
    const v = await runCheckpoint(h.deps, { persist: true });
    if (v.kind !== "divergence") throw new Error(`expected divergence, got ${v.kind}`);
    // the post-rewind turn's rows arrive AFTER the reconciliation…
    h.mirror.bufferRow(row("P6prime", "P5prime", [toolUse("t6")]));
    const branch = await branchEntries(h);
    const uuids = branch.filter((e) => e.kind === "row").map((e) => e.uuid);
    expect(uuids).toEqual(["P1", "P2", "P3", "P4", "P5prime", "P6prime"]);
  });

  test("crash between records and their CHECK widens the quarantine by ONE window only", async () => {
    // the pre-rewind CHECK sits at P4; a crash left TWO more clean windows
    // un-CHECKed — the quarantine still starts after the newest live CHECK,
    // so at most the records since that check drop (bounded, never older)
    h.ledger.append("observation", { coversUpToId: "P4", summary: "obs window 2" }, "P4");
    await h.ledger.flush();
    const v = await runCheckpoint(h.deps, { persist: true });
    if (v.kind !== "divergence") throw new Error(`expected divergence, got ${v.kind}`);
    // dead-tail observation (P6) + the post-CHECK window-2 observation drop;
    // the pre-CHECK …P4 observation (flushed before the CHECK) survives
    const branch = await branchEntries(h);
    const observations = branch.filter((e) => e.kind === "observation").map((e) => e.summary);
    expect(observations).toEqual(["obs …P4"]);
  });
});

// ---- helpers ------------------------------------------------------------------------

interface BranchEntry {
  kind: "row" | "observation" | "compaction" | "other";
  uuid?: string;
  summary?: string;
  nodes?: string[];
}

async function branchEntries(h: Harness): Promise<BranchEntry[]> {
  // reuse the harness's OWN prepared context when it has one (the live-
  // branch override lives there); else fold fresh over the directory
  const prepared =
    (h as Harness & { prepared?: Awaited<ReturnType<typeof prepareStoreContext>> }).prepared ??
    (await prepareStoreContext(mem.adapter, DIR, h.ledger, h.mirror));
  const ctx = prepared.ctx;
  const entries = ctx.getBranch(ctx.getLeafId());
  return entries.map((e) => {
    if (e.type === "custom" && e.customType === "session-owl.row") {
      return { kind: "row" as const, uuid: e.id };
    }
    if (e.type === "custom" && e.customType === "session-owl.observation") {
      return { kind: "observation" as const, summary: (e.data as { summary?: string }).summary };
    }
    if (e.type === "compaction") {
      return { kind: "compaction" as const, nodes: (e.details as { nodes?: string[] }).nodes ?? [] };
    }
    return { kind: "other" as const };
  });
}

describe("FR5 — the append-only multi-segment transcript", () => {
  beforeEach(() => {
    clearWatermarks();
  });

  test("the first turn boundary on a chain-restarted transcript with mirror residue never reads as a rewind (the false re-anchor shape)", async () => {
    // The chain-restarted transcript: the engine RESTARTS
    // the parent chain (parentUuid null roots — resume/compaction restarts),
    // so the transcript is stacked segments. The mirror's arrival set spans
    // everything (its inferred-edge bridge), while the file's liveChainSet
    // walk stops at each null root and covers only the tail segment. Plus
    // mirror-only capture residue the engine never persists, which disables
    // the all-present file veto. At the first turn boundary the api view has
    // not seen the fresh tail yet — every historical row outside the
    // tail segment is adjudicated dead.
    const h = await makeHarness();
    // pre-restart history backfilled into the mirror (classic.SessionStart)
    h.mirror.bufferRow(row("s1", null, [{ type: "text", text: "h1" }]));
    h.mirror.bufferRow(row("s2", "s1", [{ type: "text", text: "h2" }]));
    h.mirror.bufferRow(row("s3", "s2", [{ type: "text", text: "h3" }]));
    // mirror-only capture residue — never a transcript file row
    h.mirror.bufferRow(row("residue", "s3", [{ type: "text", text: "ceremony" }]));
    // the resumed turn: the engine restarts the chain at n1
    h.mirror.bufferRow(row("n1", null, [{ type: "text", text: "q" }]));
    h.mirror.bufferRow(row("n2", "n1", [toolResult("t9")]));
    h.mirror.bufferRow(row("n3", "n2", [{ type: "text", text: "a" }]));
    // api view at the first boundary = the pre-turn request: history
    // matches, the fresh tail + residue are unseen (watermark is null — a
    // fresh writer's process-start check validated nothing)
    h.apiFps = async () => [
      fingerprintBlocks([{ type: "text", text: "h1" }]),
      fingerprintBlocks([{ type: "text", text: "h2" }]),
      fingerprintBlocks([{ type: "text", text: "h3" }]),
    ];
    // the provenance tier: no past pass ever filed the residue (or any of
    // the absent rows) — production folds this from the lineage ledger
    h.deps.fileProvenUuids = async () => new Set<string>();
    // the FILE: append-only, BOTH roots present (the resume never rewrites)
    h.deps.transcriptText = async () =>
      [
        JSON.stringify({ uuid: "s1", parentUuid: null }),
        JSON.stringify({ uuid: "s2", parentUuid: "s1" }),
        JSON.stringify({ uuid: "s3", parentUuid: "s2" }),
        JSON.stringify({ uuid: "n1", parentUuid: null }),
        JSON.stringify({ uuid: "n2", parentUuid: "n1" }),
        JSON.stringify({ uuid: "n3", parentUuid: "n2" }),
      ].join("\n");
    const v = await runCheckpoint(h.deps, { persist: true });
    expect(h.logs.some((l) => l.includes("rewind detected"))).toBe(false);
    expect(h.logs.some((l) => l.includes("ZERO dead rows"))).toBe(true);
    expect(v.kind).toBe("clean");
    expect(h.aborts).toBe(0);
  });
});

// ---- the RESTORE-FORK contract (a fork IS a rewind) ---------------------------
// A real /rewind → "Restore conversation" NEVER removes transcript rows: the
// engine keeps the whole file and the re-sent prompt parent-links BACK into
// history as a SIBLING of the abandoned branch (bytes preserved, re-send
// parents at the old pivot). The abandoned rows are PRESENT in the
// file but OFF its live chain and ABSENT from the api view — the exact dead
// set the layered rule defines (a rewound file drops known rows off the
// live chain). The checkpoint DETECTS it: abort + await in-flight
// runs, blind-window quarantine, re-fold by marker liveness, watermark
// re-anchored at the junction — owl state rewinds with the conversation.
// The newer-engine rewound:true last-prompt marker corroborates the verdict
// where present. What must NEVER die: rows a view still carries (parallel
// tool_results sit off-chain but stay in the api form) and rows absent from
// the file without once-filed proof (capture residue).
describe("runCheckpoint — the restore-fork contract (detected; owl state re-folds)", () => {
  let h: Harness;

  beforeEach(async () => {
    clearWatermarks();
    h = await makeHarness();
    // alpha chain — CHECKED at the pre-rewind boundary
    h.mirror.bufferRow(row("P1", null, [toolUse("t1")]));
    h.mirror.bufferRow(row("P2", "P1", [toolResult("t1")]));
    // the alpha boundary's CHECK — the boundary the blind window arms from
    // once the beta tip's own CHECK goes dead with the branch
    h.ledger.append("CHECK", {}, "P2");
    // the abandoned beta turn ("say beta")
    h.mirror.bufferRow(row("P3", "P2"));
    h.mirror.bufferRow(row("P4", "P3"));
    h.ledger.append("CHECK", {}, "P4");
    await h.ledger.flush();
    h.apiFps = async () => [
      fingerprintBlocks([toolUse("t1")]),
      fingerprintBlocks([toolResult("t1")]),
      fingerprintBlocks([{ type: "text", text: "t P3" }]),
      fingerprintBlocks([{ type: "text", text: "t P4" }]),
    ];
    const pre = await runCheckpoint(h.deps, { persist: true });
    expect(pre.kind).toBe("clean");
    expect(_cleanWatermark("main")).toBe("P4");
  });

  /** The transcript after the fork: byte-truth as observed — only the re-send
   *  appended; the abandoned branch is STILL THERE. An optional last-prompt
   *  marker names the live tip (the newer engine stamps rewound:true on
   *  restore markers — corroborated where present). */
  const forkedTranscript = (marker?: Record<string, unknown>) =>
    [
      JSON.stringify({ uuid: "P1", parentUuid: null }),
      JSON.stringify({ uuid: "P2", parentUuid: "P1" }),
      JSON.stringify({ uuid: "P3", parentUuid: "P2" }),
      JSON.stringify({ uuid: "P4", parentUuid: "P3" }),
      JSON.stringify({ uuid: "P5prime", parentUuid: "P2" }),
      ...(marker !== undefined ? [JSON.stringify({ type: "last-prompt", ...marker })] : []),
    ].join("\n");

  const forkedApi = async () => [
    fingerprintBlocks([toolUse("t1")]),
    fingerprintBlocks([toolResult("t1")]),
    fingerprintBlocks([{ type: "text", text: "t P5prime" }]),
  ];

  test("forked re-send: the abandoned branch present in the file but off its live chain and absent from the api ⇒ REWIND DETECTED", async () => {
    // Restore with the draft: the re-send's parentUuid equals beta's parent
    // (a sibling) — known arrival = the alpha chain, the beta turn, the
    // re-send; the api view carries alpha + the re-send only.
    h.mirror.bufferRow(row("P5prime", "P2", [{ type: "text", text: "t P5prime" }]));
    h.deps.transcriptText = async () => forkedTranscript();
    h.apiFps = forkedApi;
    const v = await runCheckpoint(h.deps, { persist: true });
    if (v.kind !== "divergence") throw new Error(`expected divergence, got ${JSON.stringify(v)}`);
    // the junction anchors on the fork row (the deepest known row the api
    // still carries); the dead set is EXACTLY the abandoned interior
    expect(v.P).toBe("P5prime");
    expect(v.deadRows).toBe(2);
    expect(h.aborts).toBe(1);
    expect(h.logs.some((l) => l.includes("rewind detected"))).toBe(true);
    expect(h.logs.some((l) => l.includes("ZERO dead rows"))).toBe(false);
    // the watermark re-anchors at the junction; the CHECK rides it
    expect(_cleanWatermark("main")).toBe("P5prime");
    expect(h.checks).toContain("P5prime");
    // the re-fold moved the branch truth: the NEXT check is clean via api
    // (the abandoned rows left the known path with the divergence record)
    const v2 = await runCheckpoint(h.deps, { persist: true });
    if (v2.kind !== "clean") throw new Error(`expected clean after the re-anchor, got ${v2.kind}`);
    expect(v2.via).toBe("api");
    expect(h.aborts).toBe(1);
  });

  test("the abandoned-turn observation stops serving at the re-fold (blind window from the last LIVE check)", async () => {
    // an alpha-side CHECK exists (production checks every boundary): the
    // blind window arms from the newest LIVE check — the beta-marked record
    // rides past it and drops; the branch fold would drop it regardless
    h.mirror.bufferRow(row("P5prime", "P2", [{ type: "text", text: "t P5prime" }]));
    h.ledger.append("observation", { coversUpToId: "P4", summary: "obs beta turn" }, "P4");
    h.deps.transcriptText = async () => forkedTranscript();
    h.apiFps = forkedApi;
    const prepared =
      (h as Harness & { prepared?: Awaited<ReturnType<typeof prepareStoreContext>> }).prepared ?? (undefined as never);
    const before = prepared?.recordsRef.quarantinedDropped ?? 0;
    const v = await runCheckpoint(h.deps, { persist: true });
    if (v.kind !== "divergence") throw new Error(`expected divergence, got ${JSON.stringify(v)}`);
    expect(h.aborts).toBe(1);
    expect(h.logs.some((l) => l.includes("rewind detected"))).toBe(true);
    // the abandoned observation is out of the served branch AND counted
    const branch = await branchEntries(h);
    expect(branch.filter((e) => e.kind === "observation")).toHaveLength(0);
    expect(prepared?.recordsRef.quarantinedDropped ?? 0).toBeGreaterThan(before);
    expect(v.quarantined).toBeGreaterThanOrEqual(1);
  });

  test("parallel tool_results stay ALIVE: off-chain rows the api view still carries never enter the dead set", async () => {
    clearWatermarks();
    h = await makeHarness();
    // a turn whose parallel batch parents a sibling result off the chain,
    // then an abandoned branch, then the fork re-send
    h.mirror.bufferRow(row("K1", null, [toolUse("k1")]));
    h.mirror.bufferRow(row("K2", "K1", [toolResult("k1")]));
    h.mirror.bufferRow(row("S1", "K2", [toolResult("k9")])); // the parallel sibling
    h.mirror.bufferRow(row("B1", "K2", [{ type: "text", text: "the beta prompt" }]));
    h.mirror.bufferRow(row("K5", "K2", [{ type: "text", text: "the fork re-send" }]));
    h.ledger.append("CHECK", {}, "K5");
    await h.ledger.flush();
    // the api view carries the sibling result AND the fork — not the beta row
    h.apiFps = async () => [
      fingerprintBlocks([toolUse("k1")]),
      fingerprintBlocks([toolResult("k1")]),
      fingerprintBlocks([toolResult("k9")]),
      fingerprintBlocks([{ type: "text", text: "the fork re-send" }]),
    ];
    h.deps.transcriptText = async () =>
      [
        JSON.stringify({ uuid: "K1", parentUuid: null }),
        JSON.stringify({ uuid: "K2", parentUuid: "K1" }),
        JSON.stringify({ uuid: "S1", parentUuid: "K2" }),
        JSON.stringify({ uuid: "B1", parentUuid: "K2" }),
        JSON.stringify({ uuid: "K5", parentUuid: "K2" }),
      ].join("\n");
    const v = await runCheckpoint(h.deps, { persist: true });
    if (v.kind !== "divergence") throw new Error(`expected divergence, got ${JSON.stringify(v)}`);
    // the dead set is EXACTLY the abandoned branch — the parallel sibling
    // (off the file's live chain, present in the api view) survives
    expect(v.deadRows).toBe(1);
    expect(h.logs.some((l) => l.includes("rewind detected"))).toBe(true);
    // the survivor stays on the known path: the follow-up check is clean
    const v2 = await runCheckpoint(h.deps, { persist: true });
    if (v2.kind !== "clean") throw new Error(`expected clean after the re-anchor, got ${v2.kind}`);
  });

  test("the live boundary shape: the just-finished turn's own rows trail the request — only the abandoned branch dies", async () => {
    // At the re-send's turn.complete the mirror already holds the turn's
    // reply rows while the api form still reflects the request that drove
    // the turn (the reply is not in any request yet) — those rows sit ON
    // the live chain and are api-absent at EVERY turn boundary. The view
    // stays coherent for previously-carried rows; the dead set is exactly
    // the abandoned interior.
    h.mirror.bufferRow(row("P5prime", "P2", [{ type: "text", text: "t P5prime" }]));
    h.mirror.bufferRow(row("P6prime", "P5prime", [toolUse("t9")]));
    h.mirror.bufferRow(row("P7prime", "P6prime", [toolResult("t9")]));
    h.deps.transcriptText = async () =>
      [
        JSON.stringify({ uuid: "P1", parentUuid: null }),
        JSON.stringify({ uuid: "P2", parentUuid: "P1" }),
        JSON.stringify({ uuid: "P3", parentUuid: "P2" }),
        JSON.stringify({ uuid: "P4", parentUuid: "P3" }),
        JSON.stringify({ uuid: "P5prime", parentUuid: "P2" }),
        JSON.stringify({ uuid: "P6prime", parentUuid: "P5prime" }),
        JSON.stringify({ uuid: "P7prime", parentUuid: "P6prime" }),
      ].join("\n");
    // the api view: the alpha chain + the re-send — no beta, no reply rows
    h.apiFps = async () => [
      fingerprintBlocks([toolUse("t1")]),
      fingerprintBlocks([toolResult("t1")]),
      fingerprintBlocks([{ type: "text", text: "t P5prime" }]),
    ];
    const v = await runCheckpoint(h.deps, { persist: true });
    if (v.kind !== "divergence") throw new Error(`expected divergence, got ${JSON.stringify(v)}`);
    expect(v.P).toBe("P5prime");
    // the reply rows survive (on-chain, fresh); the beta branch dies
    expect(h.logs.some((l) => l.includes("rewind detected"))).toBe(true);
    const v2 = await runCheckpoint(h.deps, { persist: true });
    if (v2.kind !== "clean") throw new Error(`expected clean after the re-anchor, got ${v2.kind}`);
  });

  test("the rewound:true last-prompt marker corroborates the verdict (and surfaces in the log)", async () => {
    h.mirror.bufferRow(row("P5prime", "P2", [{ type: "text", text: "t P5prime" }]));
    h.deps.transcriptText = async () => forkedTranscript({ leafUuid: "P5prime", rewound: true });
    h.apiFps = forkedApi;
    const v = await runCheckpoint(h.deps, { persist: true });
    if (v.kind !== "divergence") throw new Error(`expected divergence, got ${JSON.stringify(v)}`);
    expect(v.verified).toBe(true);
    expect(h.logs.some((l) => l.includes("rewound:true"))).toBe(true);
  });

  test("a stale rewound marker with the chain intact stays CLEAN (observability line only)", async () => {
    // no divergence at all: every known row on the chain and in the api —
    // the marker is history; nothing dies, the line notes it
    h.apiFps = async () => [
      fingerprintBlocks([toolUse("t1")]),
      fingerprintBlocks([toolResult("t1")]),
      fingerprintBlocks([{ type: "text", text: "t P3" }]),
      fingerprintBlocks([{ type: "text", text: "t P4" }]),
    ];
    h.deps.transcriptText = async () =>
      [
        JSON.stringify({ uuid: "P1", parentUuid: null }),
        JSON.stringify({ uuid: "P2", parentUuid: "P1" }),
        JSON.stringify({ uuid: "P3", parentUuid: "P2" }),
        JSON.stringify({ uuid: "P4", parentUuid: "P3" }),
        JSON.stringify({ type: "last-prompt", leafUuid: "P4", rewound: true }),
      ].join("\n");
    const v = await runCheckpoint(h.deps, { persist: true });
    if (v.kind !== "clean") throw new Error(`expected clean, got ${JSON.stringify(v)}`);
    expect(h.aborts).toBe(0);
    expect(h.logs.some((l) => l.includes("rewound:true"))).toBe(true);
    expect(h.logs.some((l) => l.includes("rewind detected"))).toBe(false);
  });
});
