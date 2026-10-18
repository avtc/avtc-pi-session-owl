// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import type { SessionEntry } from "@earendil-works/pi-coding-agent";
// /owl-reobserve-0-obs-chunks — pi's repair command ported: compute the
// zero-observation holes on the conversation's branch (the vendored
// computeUncoveredRanges over the coverage records), re-observe each
// oldest-first under one observe-lock acquire, fold the Builder mid-repair,
// notify the start/done/failure with pi's exact texts.
import { describe, expect, test, vi } from "vitest";
import { DEFAULT_CONFIG } from "../../core/src/config/schema.js";
import { encodeObservation, OBSERVATION_TYPE, type ObservationEntry } from "../../core/src/store/codecs.js";
import { makeObservation, type NodeId, type ObsId } from "../../core/src/types.js";
import type { OwlCommandDeps } from "../../host/commands/handlers.js";
import { runOwlReobserve } from "../../host/commands/handlers.js";
import type { NotifyFn } from "../../host/notify/adapter.js";
import type { RunHandle } from "../../host/triggers/run-locks.js";
import { entries, type Rig, rigUp } from "../runs/helpers.js";

interface Notified {
  level: string;
  text: string;
}

interface ReobserveRig {
  rig: Rig;
  /** The mixed branch view's building blocks (mutable — tests extend the
   *  lattice and re-point deps.getBranch at mixedBranch(msgs, customs)). */
  msgs: SessionEntry[];
  customs: SessionEntry[];
  deps: OwlCommandDeps;
  notified: Notified[];
  runObserver: ReturnType<typeof vi.fn>;
  runBuilder: ReturnType<typeof vi.fn>;
  acquire: ReturnType<typeof vi.fn>;
  handles: Array<{ released: boolean; controller: AbortController }>;
  launched: unknown[];
}

function obs(id: string, source: string) {
  return makeObservation({
    id: id as ObsId,
    summary: "obs",
    importance: "med",
    sourceEntryIds: [source],
    timestamp: "2026-10-07T00:00:00.000Z",
    parentNode: "n1" as unknown as NodeId,
  });
}

/** Append one coverage record spanning exactly `from`..`to` (a record-bearing
 *  chunk covering only its own span — the fixture's coverage lattice) and
 *  return the custom entry for the mixed branch view. */
function cover(rig: Rig, from: string, to: string, obsId: string): SessionEntry {
  const entry: ObservationEntry = {
    coversFromId: from,
    coversUpToId: to,
    tokenCount: 1,
    records: [encodeObservation(obs(obsId, from))],
  };
  rig.core.store.appendObservation(rig.store, entry);
  return {
    id: obsId,
    type: "custom",
    customType: OBSERVATION_TYPE,
    data: entry,
  } as unknown as SessionEntry;
}

/** The mixed branch view pi's sessionManager serves (messages + owl's
 *  coverage customs interleaved) — the command's getBranch contract. */
function mixedBranch(messages: SessionEntry[], customs: SessionEntry[]): SessionEntry[] {
  return [...messages, ...customs];
}

async function makeReobserveDeps(sessionId: string): Promise<ReobserveRig> {
  // six message rows (the first is a user message, so the range anchor sits
  // at the second row)
  const rig = await rigUp(sessionId, entries(6), true);
  // coverage lattice with one hole: row 2 covered, rows 3-5 open, row 6
  // covered (and the frontier lands on row 6 — closed territory ends there)
  const msgs: SessionEntry[] = entries(6);
  const customs = [cover(rig, "e2", "e2", "oA"), cover(rig, "e6", "e6", "oB")];
  const branchView = mixedBranch(msgs, customs);
  const notified: Notified[] = [];
  const notify: NotifyFn = (text, level) => notified.push({ level, text });
  const runObserver = vi.fn(async () => {});
  const runBuilder = vi.fn(async () => {});
  const handles: Array<{ released: boolean; controller: AbortController }> = [];
  const acquire = vi.fn((): RunHandle | null => {
    const entry = { released: false, controller: new AbortController() };
    handles.push(entry);
    return {
      release: () => {
        entry.released = true;
      },
      abortController: entry.controller,
      setStage: () => {},
    };
  });
  const launched: unknown[] = [];
  const deps: OwlCommandDeps = {
    key: sessionId,
    notify,
    confirm: async () => false,
    isEnabled: () => true,
    getSettings: () => ({ ...DEFAULT_CONFIG, enabled: true }),
    checkThenServe: async () => {},
    pinCore: async () => {},
    getGraphStore: () => rig.core.store.getGraphStore(),
    getLeafId: () => "e6",
    getBranch: () => branchView,
    resetGraphForRescan: () => {},
    relaunchMaintenance: () => {},
    acquireForCompaction: async () => {
      throw new Error("not used");
    },
    acquireOrSkipObserve: acquire,
    runReuseRebuild: async () => {},
    runObserver,
    runBuilder,
    onLaunched: (p) => launched.push(p),
  };
  return { rig, msgs, customs, deps, notified, runObserver, runBuilder, acquire, handles, launched };
}

describe("/owl-reobserve-0-obs-chunks — guards", () => {
  test("disabled: pi's exact warning", async () => {
    const { deps, notified, acquire } = await makeReobserveDeps("cmd-reobs-disabled");
    deps.isEnabled = () => false;
    await runOwlReobserve("", deps);
    expect(notified).toEqual([{ level: "warning", text: "session-owl is disabled (enable it first)." }]);
    expect(acquire).not.toHaveBeenCalled();
  });

  test("a busy observe lock: pi's exact in-flight warning, no launch", async () => {
    const { deps, notified, acquire, launched } = await makeReobserveDeps("cmd-reobs-busy");
    acquire.mockReturnValueOnce(null);
    await runOwlReobserve("", deps);
    expect(notified).toEqual([
      { level: "warning", text: "A maintenance run is in flight — try again once it finishes." },
    ]);
    expect(launched).toHaveLength(0);
  });
});

describe("/owl-reobserve-0-obs-chunks — the repair run", () => {
  test("no holes on the branch: pi's exact nothing-to-do notice", async () => {
    const healed = await makeReobserveDeps("cmd-reobs-none");
    // heal the lattice: one record spanning the whole closed territory
    const fullCustom = cover(healed.rig, "e2", "e6", "oFull");
    healed.deps.getBranch = () => mixedBranch(entries(6), [fullCustom]);
    await runOwlReobserve("", healed.deps);
    expect(healed.notified).toEqual([
      { level: "info", text: "No skipped or unobserved ranges — nothing to re-observe." },
    ]);
    expect(healed.acquire).not.toHaveBeenCalled();
  });

  test("holes found: pi's exact start notify with range + entry counts, then a run per range", async () => {
    const { deps, notified, runObserver, handles, launched } = await makeReobserveDeps("cmd-reobs-run");
    await runOwlReobserve("", deps);
    // the lattice leaves exactly one hole: rows 3-5 (3 entries)
    expect(notified[0]).toEqual({ level: "info", text: "Re-observing 1 skipped range(s) (3 entries)…" });
    expect(launched).toHaveLength(1);
    await (launched[0] as Promise<void>);
    expect(runObserver).toHaveBeenCalledTimes(1);
    expect(handles[0]?.released).toBe(true);
    const done = notified[notified.length - 1];
    expect(done).toEqual({ level: "info", text: "Re-observe done — 0 observation(s) recovered into new roots." });
  });

  test("the per-range observer receives the hole's entries and a mid-repair maybeBuild gate", async () => {
    const { deps, runObserver, runBuilder, launched } = await makeReobserveDeps("cmd-reobs-args");
    await runOwlReobserve("", deps);
    await (launched[0] as Promise<void>);
    const first = runObserver.mock.calls[0]?.[0] as {
      unobserved: Array<{ id: string }>;
      signal: AbortSignal;
      maybeBuild: () => Promise<boolean>;
    };
    expect(first.unobserved.map((e) => e.id)).toEqual(["e3", "e4", "e5"]);
    expect(first.signal.aborted).toBe(false);
    await expect(first.maybeBuild()).resolves.toBe(false);
    expect(runBuilder).not.toHaveBeenCalled(); // default cadence: nothing fires
  });

  test("a failure mid-repair: pi's exact failure notify, the lock still releases", async () => {
    const { deps, notified, runObserver, handles, launched } = await makeReobserveDeps("cmd-reobs-fail");
    runObserver.mockRejectedValueOnce(new Error("stage blew up"));
    await runOwlReobserve("", deps);
    await (launched[0] as Promise<void>);
    expect(notified[notified.length - 1]).toEqual({
      level: "error",
      text: "Re-observe failed — see the session-owl log for the error.",
    });
    expect(handles[0]?.released).toBe(true);
  });

  test("recovered counts the observations the runs actually added (multi-range, >0)", async () => {
    const rig = await makeReobserveDeps("cmd-reobs-multi");
    // widen the lattice: cover row 4 too — holes at rows 3 and 5 (two ranges)
    rig.customs.push(cover(rig.rig, "e4", "e4", "oC"));
    rig.deps.getBranch = () => mixedBranch(rig.msgs, rig.customs);
    // the runObserver fake "recovers" one observation per uncovered row
    rig.runObserver.mockImplementation(async (args: { unobserved: Array<{ id: string }> }) => {
      const graph = rig.deps.getGraphStore().graph;
      for (const e of args.unobserved) {
        graph.observations.set(`rec-${e.id}` as never, { id: `rec-${e.id}`, summary: "x" } as never);
      }
    });
    await runOwlReobserve("", rig.deps);
    expect(rig.notified[0]?.text).toBe("Re-observing 2 skipped range(s) (2 entries)…");
    await (rig.launched[0] as Promise<void>);
    const done = rig.notified[rig.notified.length - 1];
    expect(done?.text).toBe("Re-observe done — 2 observation(s) recovered into new roots.");
    expect(rig.runObserver).toHaveBeenCalledTimes(2); // one per hole, oldest-first
  });

  test("an abort on the FIRST of two ranges runs nothing further (multi-range break)", async () => {
    const rig = await makeReobserveDeps("cmd-reobs-multiabort");
    rig.customs.push(cover(rig.rig, "e4", "e4", "oC"));
    rig.deps.getBranch = () => mixedBranch(rig.msgs, rig.customs);
    rig.runObserver.mockImplementationOnce(async () => {
      rig.handles[0]?.controller.abort();
    });
    await runOwlReobserve("", rig.deps);
    await (rig.launched[0] as Promise<void>);
    expect(rig.runObserver).toHaveBeenCalledTimes(1); // the second range never ran
    expect(rig.notified.some((n) => n.text.includes("failed"))).toBe(false);
  });

  test("the loop re-pins between the run and the recovered-delta read", async () => {
    const pins: string[] = [];
    const rig = await makeReobserveDeps("cmd-reobs-repin");
    const inner = rig.deps.pinCore;
    rig.deps.pinCore = async () => {
      pins.push("pin");
      await inner();
    };
    await runOwlReobserve("", rig.deps);
    await (rig.launched[0] as Promise<void>);
    // one pin at entry + one before the range + one after the run (the delta read)
    expect(pins.length).toBe(3);
  });

  test("an abort mid-repair stops the loop without the failure notify", async () => {
    const { deps, notified, runObserver, handles, launched } = await makeReobserveDeps("cmd-reobs-abort");
    runObserver.mockImplementationOnce(async () => {
      handles[0]?.controller.abort();
    });
    await runOwlReobserve("", deps);
    await (launched[0] as Promise<void>);
    expect(runObserver).toHaveBeenCalledTimes(1); // the loop broke after the abort
    expect(notified.some((n) => n.text.includes("failed"))).toBe(false);
    expect(handles[0]?.released).toBe(true);
  });
});

describe("/owl-reobserve-0-obs-chunks — goal-extraction sequencing (owner ruling)", () => {
  test("an in-flight goal extraction settles BEFORE the observe lock is acquired", async () => {
    const { deps, acquire, launched } = await makeReobserveDeps("cmd-reobs-settle");
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    deps.goalExtractSettled = () => pending;
    const run = runOwlReobserve("", deps);
    await new Promise((resolve) => setImmediate(resolve));
    // suspended at the settle await — no acquire, no launch while unsettled
    expect(acquire).not.toHaveBeenCalled();
    expect(launched).toHaveLength(0);
    release();
    await run;
    expect(acquire).toHaveBeenCalledTimes(1);
  });
});
