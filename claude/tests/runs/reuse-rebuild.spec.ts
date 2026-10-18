// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// The reuse-rebuild run host port: fresh-start (void structure + reseed +
// detached collected records) vs resume (detached + strays), batch re-wrap
// with the Builder cadence, and the parity property — a rebuild from
// collected records
// matches the graph shape the live Observer produced.
import { beforeEach, describe, expect, test } from "vitest";
import type { DEFAULT_CONFIG } from "../../core/src/config/schema.js";
import { clearDetailsCache } from "../../core/src/format/details.js";
import { applyRecordObservation, applySetMeta, MUTATE_SOURCE, parseSeq } from "../../core/src/graph/mutations.js";
import { getGraphStore, resetForNewSession } from "../../core/src/store/graph-store.js";
import { makeObservation, N_GOAL, O_INITIAL_PROMPT } from "../../core/src/types.js";
import { _resetCoreInstances } from "../../host/core-instances.js";
import { _setGoalExtractInFlightForTest } from "../../host/runs/goal-extract.js";
import { runObserver } from "../../host/runs/observer.js";
import { runReuseRebuild } from "../../host/runs/reuse-rebuild.js";
import { NO_OP_WIDGET } from "../../host/runs/seams.js";
import { captureInitialPrompt } from "../../host/start/initial-prompt.js";
import { entries, makeRunner, mem, PAD, type Rig, rigUp, SETTINGS, useTool } from "./helpers.js";

const R_SETTINGS = { ...SETTINGS, builderEveryNObservations: 2 } as typeof DEFAULT_CONFIG;

async function rebuild(rig: Rig, over: Partial<Parameters<typeof runReuseRebuild>[0]> = {}) {
  let built = 0;
  await runReuseRebuild({
    core: rig.core,
    store: rig.store,
    settings: R_SETTINGS as never,
    signal: new AbortController().signal,
    widget: NO_OP_WIDGET,
    maybeBuild: async () => {
      built += 1;
      return true;
    },
    ...over,
  } as Parameters<typeof runReuseRebuild>[0]);
  return built;
}

beforeEach(() => {
  mem.files.clear();
  _resetCoreInstances();
  resetForNewSession();
  clearDetailsCache();
});

/** Seed collected observations the way the Observer leaves them: wrapper `new`
 *  roots + records via the REAL observer run over `rows`. */
async function observe(sessionId: string, rows: ReturnType<typeof entries>): Promise<Rig> {
  const rig = await rigUp(sessionId, rows);
  // one record per chunk, citing THAT chunk's first entry id (parsed from the
  // chunk prompt's E=<id> line — the same source the model reads)
  const firstIdOf = (input: { messages: Array<{ content: unknown }> }): string => {
    const text = String(input.messages[0]?.content ?? "");
    const m = /entryId=([A-Za-z0-9_-]+)/.exec(text);
    return m === null ? "" : (m[1] as string);
  };
  let call = 0;
  const fx = makeRunner(
    [
      async (input: { messages: Array<{ content: unknown }> }, ag: string) => {
        const id = firstIdOf(input);
        await useTool(ag, "record_observations", {
          observations: [{ summary: `obs ${++call} of ${id}`, importance: "med", sourceEntryIds: [id] }],
        });
        return {};
      },
    ],
    true,
  );
  await runObserver({
    core: rig.core,
    store: rig.store,
    settings: { ...SETTINGS, observerThresholdTokens: 60 },
    unobserved: rows,
    signal: new AbortController().signal,
    widget: NO_OP_WIDGET,
    notify: () => {},
    runStageFn: fx.runner,
  } as never);
  return rig;
}

describe("runReuseRebuild — fresh start", () => {
  test("voids the structure, reseeds nGoal (+ oInitialPrompt attach), re-wraps every record in capture order (no parking node, ever)", async () => {
    const rows = entries(9);
    const rig = await observe("r-fresh", rows);
    const before = getGraphStore().graph;
    const obsCount = before.observations.size;
    expect(obsCount).toBeGreaterThanOrEqual(2);

    // capture order BEFORE the run: timestamp, then id sequence
    const expectedOrder = [...before.observations.values()]
      .sort((a, b) =>
        a.timestamp === b.timestamp ? parseSeq(a.id) - parseSeq(b.id) : a.timestamp < b.timestamp ? -1 : 1,
      )
      .map((o) => o.id);

    await rebuild(rig);
    const graph = getGraphStore().graph;
    // nGoal reseeded; NO parking node exists at any point; completion re-armed
    // the full attachment invariant
    expect(graph.nodes.has("nGoal")).toBe(true);
    expect(graph.nodes.has("nPending")).toBe(false);
    expect(graph.rebuildPending).toBe(false);
    // every collected record now sits under a FRESH `new` wrapper root
    let newWrappers = 0;
    for (const node of graph.nodes.values()) if (node.state === "new") newWrappers += 1;
    expect(newWrappers).toBe(obsCount);
    // capture order REPLAYED: the wrappers were created in the original
    // record order, so wrapper-id order (creation order) maps 1:1 onto the
    // pre-run capture order
    const wrappersByCreation = [...graph.nodes.values()]
      .filter((n) => n.state === "new")
      .sort((a, b) => parseSeq(a.id) - parseSeq(b.id));
    const replayedIds = wrappersByCreation.map((n) => n.observationIds[0]);
    expect(replayedIds).toEqual(expectedOrder);
  });

  test("nothing collected ⇒ the no-records log path (no parking, no batches)", async () => {
    const rig = await rigUp("r-empty", entries(2));
    getGraphStore().graph.observations.clear();
    await expect(rebuild(rig)).resolves.toBe(0);
    expect(getGraphStore().graph.nodes.has("nPending")).toBe(false);
  });
});

describe("runReuseRebuild — initial-prompt verification", () => {
  function firstUserId(rows: ReturnType<typeof entries>): string | null {
    const hit = rows.find(
      (r) => r.type === "message" && (r as { message?: { role?: string } }).message?.role === "user",
    );
    return hit?.id ?? null;
  }

  test("a stale oIP (source ≠ the head user entry) is dropped, the summary blanked, and the capture re-runs from the head", async () => {
    const rows = entries(4);
    const rig = await rigUp("r-stale-oip", rows);
    const headId = firstUserId(rows);
    expect(headId).toBe("e1");
    const g = getGraphStore().graph;
    // the collected state: a WRONG initial prompt (cites a mid-conversation
    // row) + nGoal summary distilled from that wrong verbatim
    applyRecordObservation(g, {
      obs: makeObservation({
        id: O_INITIAL_PROMPT,
        summary: "Where have we stopped?",
        importance: "crit",
        sourceEntryIds: ["stale-row"],
        timestamp: "2026-10-10T21:06:05.472Z",
        parentNode: N_GOAL,
      }),
    });
    applySetMeta(
      g,
      { nodeId: N_GOAL, importance: null, archived: null, obsolete: null, summary: "stale distilled goal" },
      MUTATE_SOURCE,
    );

    let fired = 0;
    const firedVerbatim: string[] = [];
    await rebuild(rig, {
      headUserEntryId: () => headId,
      recaptureInitialPrompt: async () => {
        fired += 1;
        return captureInitialPrompt(rig.core, rig.store, rows, () => {});
      },
      fireGoalExtract: (verbatim) => {
        firedVerbatim.push(verbatim);
      },
    });

    expect(fired).toBe(1);
    const after = getGraphStore().graph;
    const oip = after.observations.get(O_INITIAL_PROMPT);
    expect(oip?.sourceEntryIds).toEqual(["e1"]);
    expect(oip?.summary).toBe(`entry 1 ${PAD}`);
    // the new nGoal wraps the FRESH record with an EMPTY summary; the goal
    // extraction re-fires ONCE on the fresh verbatim — the same flow a
    // fresh capture uses
    expect(after.nodes.get(N_GOAL)?.summary).toBe("");
    expect(firedVerbatim).toEqual([`entry 1 ${PAD}`]);
    expect(after.nodes.get(N_GOAL)?.observationIds).toContain(O_INITIAL_PROMPT);
  });

  test("a matching oIP is carried verbatim — no re-capture, summary preserved", async () => {
    const rows = entries(4);
    const rig = await rigUp("r-good-oip", rows);
    const headId = firstUserId(rows);
    const g = getGraphStore().graph;
    applyRecordObservation(g, {
      obs: makeObservation({
        id: O_INITIAL_PROMPT,
        summary: "the true head prompt",
        importance: "crit",
        sourceEntryIds: [headId ?? "e1"],
        timestamp: "2026-10-10T17:26:55.932Z",
        parentNode: N_GOAL,
      }),
    });
    applySetMeta(
      g,
      { nodeId: N_GOAL, importance: null, archived: null, obsolete: null, summary: "the distilled goal" },
      MUTATE_SOURCE,
    );

    let fired = 0;
    const firedVerbatim: string[] = [];
    await rebuild(rig, {
      headUserEntryId: () => headId,
      recaptureInitialPrompt: async () => {
        fired += 1;
        return null;
      },
      fireGoalExtract: (verbatim) => {
        firedVerbatim.push(verbatim);
      },
    });

    expect(fired).toBe(0);
    const after = getGraphStore().graph;
    expect(after.observations.get(O_INITIAL_PROMPT)?.summary).toBe("the true head prompt");
    // a matching oIP is carried as-is; the summary slot re-seeds EMPTY and
    // the extraction re-fires on the carried verbatim — the builder-evolved
    // text is re-derived by the rebuild's Builder passes, not carried
    expect(after.nodes.get(N_GOAL)?.summary).toBe("");
    expect(firedVerbatim).toEqual(["the true head prompt"]);
    expect(after.nodes.get(N_GOAL)?.observationIds).toContain(O_INITIAL_PROMPT);
  });

  test("no head resolver wired (legacy input) ⇒ the carried oIP is trusted as before", async () => {
    const rows = entries(2);
    const rig = await rigUp("r-no-resolver", rows);
    const g = getGraphStore().graph;
    applyRecordObservation(g, {
      obs: makeObservation({
        id: O_INITIAL_PROMPT,
        summary: "carried verbatim",
        importance: "crit",
        sourceEntryIds: ["whatever-row"],
        timestamp: "2026-10-10T17:26:55.932Z",
        parentNode: N_GOAL,
      }),
    });
    const firedVerbatim: string[] = [];
    await rebuild(rig, { fireGoalExtract: (verbatim) => firedVerbatim.push(verbatim) });
    const after = getGraphStore().graph;
    expect(after.observations.get(O_INITIAL_PROMPT)?.summary).toBe("carried verbatim");
    // the wrap + extraction flow holds without a head resolver too: the seed
    // is empty and the extraction fires on the carried verbatim
    expect(after.nodes.get(N_GOAL)?.summary).toBe("");
    expect(firedVerbatim).toEqual(["carried verbatim"]);
    expect(after.nodes.get(N_GOAL)?.observationIds).toContain(O_INITIAL_PROMPT);
  });
});

describe("runReuseRebuild — resume", () => {
  test("an interrupted rebuild resumes from the detached pool (no fresh reset, remainder re-wrapped)", async () => {
    const rows = entries(9);
    const rig = await observe("r-resume", rows);
    const controller = new AbortController();
    // first run: abort after the FIRST batch (one maybeBuild call in)
    await runReuseRebuild({
      core: rig.core,
      store: rig.store,
      settings: R_SETTINGS as never,
      signal: controller.signal,
      widget: NO_OP_WIDGET,
      maybeBuild: async () => {
        controller.abort(); // stop mid-rebuild after batch 1
        return false;
      },
    } as never);
    const graph1 = getGraphStore().graph;
    expect(graph1.nodes.has("nPending" as never)).toBe(false); // no parking node, ever
    expect(graph1.rebuildPending).toBe(true); // the relaxed assert stays armed
    const listed = new Set<string>();
    for (const n of graph1.nodes.values()) for (const id of n.observationIds) listed.add(id);
    const detachedCount = [...graph1.observations.values()].filter((o) => !listed.has(o.id)).length;
    expect(detachedCount).toBeGreaterThanOrEqual(1); // the remainder waits in the detached pool

    // resume: the marker + detached pool make it continue (not restart)
    const controller2 = new AbortController();
    await runReuseRebuild({
      core: rig.core,
      store: rig.store,
      settings: R_SETTINGS as never,
      signal: controller2.signal,
      widget: NO_OP_WIDGET,
      maybeBuild: async () => true,
    } as never);
    expect(getGraphStore().graph.nodes.has("nPending")).toBe(false); // drained
    expect(getGraphStore().graph.rebuildPending).toBe(false);
  });

  test("detached (unlisted) records ARE the pending pool — the resume re-wraps them (no re-parking step)", async () => {
    const rows = entries(9);
    const rig = await observe("r-stray", rows);
    // simulate a crash mid-rebuild: the reset voided the structure; the
    // collected records sit in the DETACHED pool (no parking node;
    // unlisted records ARE the pending signal)
    const { resetGraphForReuse } = await import("../../core/src/store/graph-store.js");
    resetGraphForReuse(rig.store);
    const strays = [...getGraphStore().graph.observations.keys()].filter((id) => id !== "oInitialPrompt");
    expect(strays.length).toBeGreaterThanOrEqual(1);
    await rebuild(rig);
    expect(getGraphStore().graph.nodes.has("nPending")).toBe(false); // never created
    expect(getGraphStore().graph.rebuildPending).toBe(false);
    for (const id of strays) {
      const parent = getGraphStore().graph.observations.get(id)?.parentNode;
      expect(parent).toBeDefined();
      expect(parent).not.toBe("nPending");
    }
  });

  test("a stale reuse marker with an empty pool falls back to a fresh rebuild (silent no-op killers)", async () => {
    const rows = entries(9);
    const rig = await observe("r-stale-marker", rows);
    // run 1: fresh start (appends the reuse marker) → abort mid-rebuild
    const c1 = new AbortController();
    await runReuseRebuild({
      core: rig.core,
      store: rig.store,
      settings: R_SETTINGS as never,
      signal: c1.signal,
      widget: NO_OP_WIDGET,
      maybeBuild: async () => {
        c1.abort();
        return false;
      },
    } as never);
    // run 2: the resume completes — every record attached, pool empty, yet the
    // marker row (appended by run 1's fresh path) is still the newest scan row
    await runReuseRebuild({
      core: rig.core,
      store: rig.store,
      settings: R_SETTINGS as never,
      signal: new AbortController().signal,
      widget: NO_OP_WIDGET,
      maybeBuild: async () => true,
    } as never);
    expect(getGraphStore().graph.rebuildPending).toBe(false);

    // run 3: the stale-marker scenario — resume branch would find ZERO
    // detached records; the rebuild must fall back to a fresh start
    const headId =
      rows.find((r) => r.type === "message" && (r as { message?: { role?: string } }).message?.role === "user")?.id ??
      null;
    const fired: string[] = [];
    const built = await rebuild(rig, {
      headUserEntryId: () => headId,
      recaptureInitialPrompt: async () => captureInitialPrompt(rig.core, rig.store, rows, () => {}),
      fireGoalExtract: (verbatim) => {
        fired.push(verbatim);
      },
    });

    // batches ran (zero here is the 'nothing collected to rebuild' failure)
    expect(built).toBeGreaterThanOrEqual(1);
    // the fresh path re-captured the initial prompt and re-fired the goal
    // extraction on it
    expect(fired.length).toBe(1);
    expect(fired[0]).not.toBe("");
    const graph = getGraphStore().graph;
    expect(graph.nodes.has(N_GOAL)).toBe(true);
    expect(graph.rebuildPending).toBe(false);
    let newWrappers = 0;
    for (const node of graph.nodes.values()) if (node.state === "new") newWrappers += 1;
    const records = [...graph.observations.keys()].filter((id) => id !== O_INITIAL_PROMPT);
    expect(newWrappers).toBe(records.length);
  });
});

describe("runReuseRebuild — cadence + parity", () => {
  test("the Builder fires once per batch (builderEveryNObservations = 2 ⇒ 2 folds for 4 records)", async () => {
    const rows = entries(9);
    const rig = await observe("r-cadence", rows);
    const built = await rebuild(rig);
    const obsCount = getGraphStore().graph.observations.size;
    expect(built).toBe(Math.ceil(obsCount / R_SETTINGS.builderEveryNObservations));
  });

  test("PARITY: the rebuilt graph matches the live Observer's shape (one fresh `new` wrapper per record, same summaries)", async () => {
    const rows = entries(9);
    // 1) the live Observer's graph
    const _liveRig = await observe("r-parity-live", rows);
    const live = getGraphStore().graph;
    const liveWrappers = new Map(
      [...live.nodes.values()].filter((n) => n.state === "new").map((n) => [n.summary, n.observationIds] as const),
    );
    expect(liveWrappers.size).toBeGreaterThanOrEqual(2);

    // 2) the rebuild over the SAME record set (fresh rig, records replayed)
    const rig2 = await observe("r-parity-rebuild", rows);
    await rebuild(rig2);
    const rebuilt = getGraphStore().graph;
    const rebuiltWrappers = [...rebuilt.nodes.values()].filter((n) => n.state === "new");
    expect(rebuiltWrappers.map((n) => n.summary).sort()).toEqual([...liveWrappers.keys()].sort());
    // every record lands under exactly one wrapper (one obs per wrapper here)
    for (const w of rebuiltWrappers) {
      expect(w.observationIds.length).toBe(1);
      const obs = rebuilt.observations.get(w.observationIds[0] as never);
      expect(obs?.summary).toBe(w.summary); // the wrapper carries the record's summary at birth
    }
  });

  test("a disable mid-rebuild leaves the remainder detached (durable) — never throws", async () => {
    const rows = entries(9);
    const rig = await observe("r-disable", rows);
    let enabled = true;
    let maybeBuildCalls = 0;
    const built = await rebuild(rig, {
      isEnabled: () => enabled,
      maybeBuild: async () => {
        maybeBuildCalls += 1;
        enabled = false; // flip after the first batch
        return false;
      },
    });
    // the run stopped after ONE maybeBuild call (the disable detached the rest)
    expect(maybeBuildCalls).toBe(1);
    expect(built).toBe(0); // the override folds nothing
    expect(getGraphStore().graph.nodes.has("nPending" as never)).toBe(false); // no parking node
    expect(getGraphStore().graph.rebuildPending).toBe(true); // the pool holds the remainder
  });

  test("an error inside a batch stops the run with the remainder detached (never throws)", async () => {
    const rows = entries(9);
    const rig = await observe("r-error", rows);
    const boom = new Error("disk full");
    await expect(
      rebuild(rig, {
        maybeBuild: async () => {
          throw boom;
        },
      }),
    ).resolves.toBe(0);
    expect(getGraphStore().graph.nodes.has("nPending" as never)).toBe(false);
    expect(getGraphStore().graph.rebuildPending).toBe(true);
  });

  test("the re-seed state and every completed batch reach disk at persist time (flushLedger seam)", async () => {
    const rig = await observe("s-flush", entries(6));
    let flushCalls = 0;
    const built = await rebuild(rig, {
      flushLedger: async () => {
        flushCalls += 1;
      },
    });
    expect(built).toBeGreaterThan(0);
    // the fresh-start re-seed flush + every rebuild batch flush (a hard crash
    // after any flush keeps that progress — the resume contract)
    expect(flushCalls).toBeGreaterThanOrEqual(2);
  });
});

describe("runReuseRebuild — goal-extraction sequencing (owner ruling)", () => {
  test("the batches + builder cadence wait for the in-flight goal extraction to settle", async () => {
    const rows = entries(9);
    const rig = await observe("r-settle", rows);
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    _setGoalExtractInFlightForTest(rig.core.key, pending);
    let built = 0;
    try {
      const run = runReuseRebuild({
        core: rig.core,
        store: rig.store,
        settings: R_SETTINGS as never,
        signal: new AbortController().signal,
        widget: NO_OP_WIDGET,
        maybeBuild: async () => {
          built += 1;
          return true;
        },
      } as Parameters<typeof runReuseRebuild>[0]);
      await new Promise((resolve) => setTimeout(resolve, 0)); // drain every queued microtask
      expect(built).toBe(0); // suspended at goalExtractSettled — no batches ran
      release();
      await run;
      expect(built).toBeGreaterThan(0); // proceeds once the extraction settled
    } finally {
      _setGoalExtractInFlightForTest(rig.core.key, null);
    }
  });
});
