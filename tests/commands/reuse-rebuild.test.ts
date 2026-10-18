// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>
//
// Tests for the `/owl:rescan --reuse-observations` rebuild pipeline: re-wrap the
// collected observation records into a fresh structure in batches (original
// capture order), interleaving Builder runs per the configured cadence, without
// re-running the Observer LLM.

import type { Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { beforeEach, describe, expect, it } from "vitest";
import { runReuseRebuild } from "../../src/commands/reuse-rebuild.js";
import { DEFAULT_CONFIG } from "../../src/config/schema.js";
import { _setGoalExtractInFlightForTest } from "../../src/goal-extract/run.js";
import {
  applyAttachObservation,
  applyCreateNode,
  applyRecordObservation,
  assertGraphStructure,
} from "../../src/graph/mutations.js";
import { encodeObservation, OBSERVATION_TYPE, RESCAN_MODE_REUSE, RESCAN_TYPE } from "../../src/store/codecs.js";
import { getGraphStore, resetForNewSession, type StoreContext } from "../../src/store/graph-store.js";
import { makeObservation, N_GOAL, N_PENDING, type NodeId, O_INITIAL_PROMPT, type ObsId } from "../../src/types.js";
import { NO_OP_WIDGET } from "../../src/widget/tracker.js";

// --- helpers ---------------------------------------------------------------

function makeFakePi(): { pi: ExtensionAPI; appended: { type: string; data: unknown }[] } {
  const appended: { type: string; data: unknown }[] = [];
  const pi = {
    appended,
    appendEntry: (customType: string, data: unknown) => {
      appended.push({ type: customType, data });
    },
  } as unknown as ExtensionAPI;
  return { pi, appended };
}

function makeFakeCtx(branch: () => unknown[]): ExtensionContext {
  const _fakeModel = { provider: "test", id: "model" } as unknown as Model<never>;
  return {
    sessionManager: {
      getLeafId: () => "leaf",
      getBranch: () => branch(),
    },
    modelRegistry: {
      // no resolvable model: the fire-and-forget goal extraction takes its
      // documented skip path (model gap -> warn log) instead of an agent loop
      find: () => undefined,
      getApiKeyAndHeaders: async () => ({ ok: true as const, apiKey: "key" }),
    } as unknown as ExtensionContext,
    model: undefined,
    ui: { notify: () => {} } as unknown as ExtensionContext["ui"],
  } as unknown as ExtensionContext;
}

/** Seed a graph the way a live session would have: nGoal + oIP + records. */
function seedCollected(count: number): void {
  const g = getGraphStore().graph;
  applyCreateNode(g, {
    id: N_GOAL,
    summary: "the distilled goal",
    importance: "crit",
    parentNode: null,
    state: "active",
  });
  applyRecordObservation(g, {
    obs: makeObservation({
      id: O_INITIAL_PROMPT,
      summary: "verbatim prompt",
      importance: "crit",
      sourceEntryIds: ["u1"],
      timestamp: "2026-08-01T09:00:00.000Z",
      parentNode: N_GOAL,
    }),
  });
  for (let i = 1; i <= count; i += 1) {
    const nodeId = `n${i}` as NodeId;
    applyCreateNode(g, { id: nodeId, summary: `wrap ${i}`, importance: "med", parentNode: null, state: "active" });
    applyRecordObservation(g, {
      obs: makeObservation({
        id: `o${i}` as ObsId,
        summary: `observation ${i}`,
        importance: "med",
        sourceEntryIds: [`e${i}`],
        // descending timestamps on purpose: the rebuild must process in
        // ORIGINAL CAPTURE ORDER (timestamp, then id), not map order
        timestamp: `2026-08-${String(20 - Math.floor((i - 1) / 10)).padStart(2, "0")}T10:00:00.000Z`,
        parentNode: nodeId,
      }),
    });
  }
}

function makeInput(opts: {
  pi: ExtensionAPI;
  builderCalls?: number[];
  batchSize?: number;
  signal?: AbortSignal;
}): Parameters<typeof runReuseRebuild>[0] {
  const { pi } = opts;
  // the branch reflects what has been appended so far (resume detection reads it)
  const branch = () =>
    (pi as unknown as { appended: { type: string; data: unknown }[] }).appended.map((e, i) => ({
      id: `be${i + 1}`,
      type: "custom",
      customType: e.type,
      data: e.data,
    }));
  return {
    ctx: makeFakeCtx(branch),
    pi: opts.pi,
    settings: {
      ...DEFAULT_CONFIG,
      enabled: true,
      builderMode: "each-N-observations",
      builderEveryNObservations: opts.batchSize ?? 2,
    },
    signal: opts.signal ?? new AbortController().signal,
    widget: NO_OP_WIDGET,
    runBuilder: async () => {
      if (opts.builderCalls !== undefined) opts.builderCalls.push(Date.now());
    },
  };
}

// --- tests -----------------------------------------------------------------

describe("runReuseRebuild", () => {
  beforeEach(() => {
    resetForNewSession();
  });

  it("settles the in-flight goal extraction BEFORE the batch loop engages (goal-first sequencing)", async () => {
    seedCollected(4);
    const { pi } = makeFakePi();
    const builderCalls: number[] = [];
    const input = makeInput({ pi, builderCalls, batchSize: 2 });
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    _setGoalExtractInFlightForTest(pending);
    try {
      const run = runReuseRebuild(input);
      await new Promise((resolve) => setTimeout(resolve, 0)); // drain every queued microtask
      // suspended at extractionSettled — no batches ran, no builder cadence fired
      expect(builderCalls).toHaveLength(0);
      release();
      await run;
      expect(builderCalls.length).toBeGreaterThan(0); // proceeds once the extraction settled
    } finally {
      _setGoalExtractInFlightForTest(null);
    }
  });

  it("rebuilds from collected records in capture order, interleaving builder per cadence", async () => {
    seedCollected(5);
    const { pi, appended } = makeFakePi();
    const builderCalls: number[] = [];
    await runReuseRebuild(makeInput({ pi, builderCalls, batchSize: 2 }));

    const g = getGraphStore().graph;
    // nGoal re-seeded wrapping the oIP: summary = the oIP's own summary
    expect(g.nodes.get(N_GOAL)?.summary).toBe("");
    expect(g.nodes.get(N_GOAL)?.observationIds).toEqual([O_INITIAL_PROMPT]);
    expect(g.observations.get(O_INITIAL_PROMPT)?.parentNode).toBe(N_GOAL);
    // the parking node dissolved once emptied
    expect(g.nodes.has(N_PENDING)).toBe(false);
    // every record re-wrapped under a fresh root; none left detached
    assertGraphStructure(g, "post-rebuild");
    const roots = [...g.nodes.values()].filter((n) => n.parentNode === null && n.id !== N_GOAL);
    expect(roots).toHaveLength(5); // one wrapper per record (Observer pairing)
    expect(roots.flatMap((n) => n.observationIds).sort()).toEqual(["o1", "o2", "o3", "o4", "o5"]);
    // builder interleaved once per batch (each-N counts the fresh wrappers)
    expect(builderCalls).toHaveLength(3);
    // the reuse marker + parking + batches persisted
    const markers = appended.filter((e) => e.type === RESCAN_TYPE);
    expect(markers).toHaveLength(1);
    expect((markers[0]?.data as { mode?: string })?.mode).toBe(RESCAN_MODE_REUSE);
    expect(appended.filter((e) => e.type === "session-owl.graph_delta").length).toBeGreaterThan(0);
  });

  it("re-captures a stale initial prompt from the branch head (provenance check)", async () => {
    seedCollected(2);
    const { pi, appended } = makeFakePi();
    // the branch's head user entry cites a DIFFERENT row than the collected
    // oIP ("u1") — the carried record is stale and must not ride the rebuild
    const headEntry = {
      id: "head-true",
      type: "message",
      timestamp: "2026-08-01T08:59:00.000Z",
      message: { role: "user", content: "the true head prompt" },
    };
    const branch = () => [
      headEntry,
      ...appended.map((e, i) => ({ id: `be${i + 1}`, type: "custom", customType: e.type, data: e.data })),
    ];
    await runReuseRebuild({
      ctx: makeFakeCtx(branch),
      pi,
      settings: {
        ...DEFAULT_CONFIG,
        enabled: true,
        builderMode: "each-N-observations",
        builderEveryNObservations: 2,
      },
      signal: new AbortController().signal,
      widget: NO_OP_WIDGET,
      runBuilder: async () => {},
    });

    const g = getGraphStore().graph;
    const oip = g.observations.get(O_INITIAL_PROMPT);
    expect(oip?.sourceEntryIds).toEqual(["head-true"]);
    expect(oip?.summary).toBe("the true head prompt");
    expect(oip?.parentNode).toBe(N_GOAL);
    // the new nGoal wraps the FRESH record: summary = the head verbatim
    expect(g.nodes.get(N_GOAL)?.summary).toBe("");
  });

  it("a matching initial prompt is carried verbatim — no re-capture, summary preserved", async () => {
    seedCollected(2);
    const { pi, appended } = makeFakePi();
    const headEntry = {
      id: "u1",
      type: "message",
      timestamp: "2026-08-01T09:00:00.000Z",
      message: { role: "user", content: "verbatim prompt" },
    };
    const branch = () => [
      headEntry,
      ...appended.map((e, i) => ({ id: `be${i + 1}`, type: "custom", customType: e.type, data: e.data })),
    ];
    await runReuseRebuild({
      ctx: makeFakeCtx(branch),
      pi,
      settings: {
        ...DEFAULT_CONFIG,
        enabled: true,
        builderMode: "each-N-observations",
        builderEveryNObservations: 2,
      },
      signal: new AbortController().signal,
      widget: NO_OP_WIDGET,
      runBuilder: async () => {},
    });

    const g = getGraphStore().graph;
    expect(g.observations.get(O_INITIAL_PROMPT)?.summary).toBe("verbatim prompt");
    expect(g.observations.get(O_INITIAL_PROMPT)?.sourceEntryIds).toEqual(["u1"]);
    expect(g.nodes.get(N_GOAL)?.summary).toBe("");
  });

  it("resumes: an existing non-empty parking node continues instead of re-parking", async () => {
    seedCollected(4);
    const { pi, appended } = makeFakePi();
    // simulate a legacy interrupted rebuild: marker + nPending with 2 records parked
    pi.appendEntry(RESCAN_TYPE, { at: "t", mode: RESCAN_MODE_REUSE });
    const g = getGraphStore().graph;
    g.nodes.clear();
    // setup runs while the legacy-parked records are still detached — skip the
    // structural assert until the parking attaches land (mirrors startFresh)
    applyCreateNode(g, {
      id: N_GOAL,
      summary: "",
      importance: "crit",
      parentNode: null,
      state: "active",
      skipStructural: true,
    });
    applyAttachObservation(g, { obsId: O_INITIAL_PROMPT, parentNode: N_GOAL });
    applyCreateNode(g, {
      id: N_PENDING,
      summary: "pending",
      importance: "low",
      parentNode: null,
      state: "active",
      skipStructural: true,
    });
    applyAttachObservation(g, { obsId: "o1" as ObsId, parentNode: N_PENDING });
    applyAttachObservation(g, { obsId: "o2" as ObsId, parentNode: N_PENDING });

    const builderCalls: number[] = [];
    await runReuseRebuild(makeInput({ pi, builderCalls, batchSize: 2 }));

    // NO second marker was appended (resume, not a fresh rebuild)
    expect(appended.filter((e) => e.type === RESCAN_TYPE)).toHaveLength(1);
    // o1/o2 (legacy-parked) + o3/o4 (detached from their old wiped wrappers)
    // all end re-wrapped; nPending gone
    const g2 = getGraphStore().graph;
    expect(g2.nodes.has(N_PENDING)).toBe(false);
    assertGraphStructure(g2, "post-resume");
    const listed = new Set<string>();
    for (const n of g2.nodes.values()) for (const id of n.observationIds) listed.add(id);
    expect([...listed].sort()).toEqual(["o1", "o2", "o3", "o4", "oInitialPrompt"]);
  });

  it("a stale reuse marker with an empty pool falls back to a fresh rebuild (never a silent no-op)", async () => {
    seedCollected(4);
    const { pi } = makeFakePi();
    // a PREVIOUS rebuild completed and left its reuse marker behind (the fresh
    // path appends the marker; completion never clears it) — with every
    // record attached the detached pool is empty, and the next rescan must
    // still rebuild instead of hitting 'nothing collected to rebuild'
    pi.appendEntry(RESCAN_TYPE, { at: "t", mode: RESCAN_MODE_REUSE });

    const builderCalls: number[] = [];
    await runReuseRebuild(makeInput({ pi, builderCalls, batchSize: 2 }));

    // the fresh path runs: every collected record re-wrapped, nGoal re-seeded
    // with an EMPTY summary (the goal extraction re-fires from there) —
    // never the early return
    expect(builderCalls.length).toBeGreaterThanOrEqual(1);
    const g = getGraphStore().graph;
    expect(g.nodes.get(N_GOAL)?.summary).toBe("");
    const roots = [...g.nodes.values()].filter((n) => n.parentNode === null && n.id !== N_GOAL);
    expect(roots.flatMap((n) => n.observationIds).sort()).toEqual(["o1", "o2", "o3", "o4"]);
    expect(g.rebuildPending).toBe(false);
    assertGraphStructure(g, "post-stale-marker-fallback");
  });

  it("stops early on abort (the detached pool keeps the remainder for the next run)", async () => {
    seedCollected(4);
    const { pi } = makeFakePi();
    const controller = new AbortController();
    const builderCalls: number[] = [];
    const input = makeInput({ pi, builderCalls, batchSize: 2 });
    // abort after the first builder call
    const orig = input.runBuilder;
    input.runBuilder = async () => {
      builderCalls.push(1);
      controller.abort();
      await orig();
    };
    await runReuseRebuild({ ...input, signal: controller.signal });

    const g = getGraphStore().graph;
    // NO parking node exists, ever — the remainder is the detached pool
    expect(g.nodes.has(N_PENDING)).toBe(false);
    expect(g.rebuildPending).toBe(true); // the relaxed assert stays armed
    const listed = new Set<string>();
    for (const n of g.nodes.values()) for (const id of n.observationIds) listed.add(id);
    const detached = [...g.observations.values()].filter((o) => !listed.has(o.id));
    expect(detached.length).toBe(2); // batch 1 attached; batch 2 waits in the pool
    // a re-run drains the pool to completion (resume, no second marker)
    const controller2 = new AbortController();
    const _appended2 = makeFakePi();
    // reuse the SAME pi so the branch (marker) is visible
    await runReuseRebuild({ ...makeInput({ pi, batchSize: 2 }), signal: controller2.signal });
    const g2 = getGraphStore().graph;
    expect(g2.rebuildPending).toBe(false);
    assertGraphStructure(g2, "post-resume-complete");
    const listed2 = new Set<string>();
    for (const n of g2.nodes.values()) for (const id of n.observationIds) listed2.add(id);
    expect([...listed2].sort()).toEqual(["o1", "o2", "o3", "o4", "oInitialPrompt"]);
  });

  it("persists the re-seed + batch ops so a reload reconstructs the mid-rebuild state (detached pool)", async () => {
    seedCollected(2);
    const { pi } = makeFakePi();
    // the records' ORIGINAL capture entries (a real ledger carries them from
    // before the marker; the reload replays them into the detached pool)
    const g0 = getGraphStore().graph;
    pi.appendEntry(OBSERVATION_TYPE, {
      records: [g0.observations.get("o1" as ObsId), g0.observations.get("o2" as ObsId)]
        .filter((o): o is NonNullable<typeof o> => o !== undefined)
        .map((o) => encodeObservation(o)),
    });
    const controller = new AbortController();
    const input = makeInput({ pi, batchSize: 1 });
    input.runBuilder = async () => {
      controller.abort();
    };
    await runReuseRebuild({ ...input, signal: controller.signal });

    // reload from the appended log (fresh store)
    resetForNewSession();
    // reload from the appended log (fresh store): replay through the real store
    // with a context whose branch is the appended entries
    const entries = (pi as unknown as { appended: { type: string; data: unknown }[] }).appended.map((e, i) => ({
      id: `re${i + 1}`,
      type: "custom",
      customType: e.type,
      data: e.data,
    }));
    const { load } = await import("../../src/store/graph-store.js");
    const branch = () => entries as unknown as ReturnType<StoreContext["getBranch"]>;
    const reloadCtx: StoreContext = {
      appendEntry: () => {},
      getLeafId: () => (entries.length > 0 ? (entries[entries.length - 1]?.id ?? null) : null),
      getBranch: branch,
    };
    await load(reloadCtx);
    const g = getGraphStore().graph;
    expect(g.nodes.get(N_GOAL)?.summary).toBe("");
    expect(g.nodes.get(N_GOAL)?.observationIds).toEqual([O_INITIAL_PROMPT]);
    // NO parking node; the un-processed record is the DETACHED pool, and the
    // load derived rebuildPending from the reuse marker + detached records
    expect(g.nodes.has(N_PENDING)).toBe(false);
    expect(g.rebuildPending).toBe(true);
    const listed = new Set<string>();
    for (const n of g.nodes.values()) for (const id of n.observationIds) listed.add(id);
    const detachedIds = [...g.observations.values()].filter((o) => !listed.has(o.id)).map((o) => o.id);
    expect(detachedIds).toEqual(["o2"]); // batch 1 (o1) attached before the abort
    // the orphan re-wrap did NOT touch the pending record (no premature wrapper)
    assertGraphStructure(g, "post-reload-mid-rebuild");
  });

  it("an empty ledger rebuilds to just the re-seed (no parking, no batches)", async () => {
    const g0 = getGraphStore().graph;
    applyCreateNode(g0, { id: N_GOAL, summary: "goal", importance: "crit", parentNode: null, state: "active" });
    const { pi, appended } = makeFakePi();
    const builderCalls: number[] = [];
    await runReuseRebuild(makeInput({ pi, builderCalls }));
    expect(builderCalls).toHaveLength(0);
    expect(getGraphStore().graph.nodes.has(N_PENDING)).toBe(false);
    // no oIP collected and no head on the branch: the re-seed is a bare nGoal
    // create with an EMPTY summary (nothing to wrap; no carried text, no set_meta)
    expect(appended.filter((e) => e.type === "session-owl.graph_delta")).toHaveLength(1);
    expect(getGraphStore().graph.nodes.get(N_GOAL)?.summary).toBe("");
  });
});
