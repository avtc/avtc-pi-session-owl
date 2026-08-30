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
import {
  applyAttachObservation,
  applyCreateNode,
  applyRecordObservation,
  assertGraphStructure,
} from "../../src/graph/mutations.js";
import { RESCAN_MODE_REUSE, RESCAN_TYPE } from "../../src/store/codecs.js";
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
  const fakeModel = { provider: "test", id: "model" } as unknown as Model<never>;
  return {
    sessionManager: {
      getLeafId: () => "leaf",
      getBranch: () => branch(),
    },
    modelRegistry: {
      find: () => fakeModel,
      getApiKeyAndHeaders: async () => ({ ok: true as const, apiKey: "key" }),
    } as unknown as ExtensionContext,
    model: fakeModel,
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

  it("rebuilds from collected records in capture order, interleaving builder per cadence", async () => {
    seedCollected(5);
    const { pi, appended } = makeFakePi();
    const builderCalls: number[] = [];
    await runReuseRebuild(makeInput({ pi, builderCalls, batchSize: 2 }));

    const g = getGraphStore().graph;
    // nGoal re-seeded with its summary + oIP attached
    expect(g.nodes.get(N_GOAL)?.summary).toBe("the distilled goal");
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

  it("resumes: an existing non-empty parking node continues instead of re-parking", async () => {
    seedCollected(4);
    const { pi, appended } = makeFakePi();
    // simulate a crashed first rebuild: marker + parking with 2 records parked
    pi.appendEntry(RESCAN_TYPE, { at: "t", mode: RESCAN_MODE_REUSE });
    const g = getGraphStore().graph;
    g.nodes.clear();
    // setup runs while the un-parked records are still detached — skip the
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
    // o1/o2 (parked) + o3/o4 (still under their old wiped wrappers → re-parked)
    // all end re-wrapped; parking gone
    const g2 = getGraphStore().graph;
    expect(g2.nodes.has(N_PENDING)).toBe(false);
    assertGraphStructure(g2, "post-resume");
    const listed = new Set<string>();
    for (const n of g2.nodes.values()) for (const id of n.observationIds) listed.add(id);
    expect([...listed].sort()).toEqual(["o1", "o2", "o3", "o4", "oInitialPrompt"]);
  });

  it("stops early on abort (the parking node keeps the remainder for the next run)", async () => {
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
    // parking still exists holding the un-processed remainder
    expect(g.nodes.has(N_PENDING)).toBe(true);
    expect(g.nodes.get(N_PENDING)?.observationIds.length ?? 0).toBeGreaterThan(0);
  });

  it("persists the re-seed + parking ops so a reload reconstructs the mid-rebuild state", async () => {
    seedCollected(2);
    const { pi } = makeFakePi();
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
    expect(g.nodes.get(N_GOAL)?.summary).toBe("the distilled goal");
    expect(g.nodes.get(N_GOAL)?.observationIds).toEqual([O_INITIAL_PROMPT]);
    expect(g.nodes.has(N_PENDING)).toBe(true);
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
    expect(appended.filter((e) => e.type === "session-owl.graph_delta")).toHaveLength(2); // nGoal create + summary set_meta
  });
});
