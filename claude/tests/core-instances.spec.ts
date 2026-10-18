// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import * as fsSync from "node:fs";
import * as path from "node:path";
// The core multiplexer suite: the serialized
// swap that gives every conversation the state isolation pi gets from
// running one process per session. Test doubles: a minimal in-file fake
// StoreContext (appendEntry collects; getBranch replays the collected
// entries, counting reads = load replays) — the real storage adapter replaces
// these in its own suite, not here.
import { beforeEach, describe, expect, test, vi } from "vitest";
import { applyCreateNode, applyRecordObservation } from "../core/src/graph/mutations.js";
import { log } from "../core/src/log.js";
import { _resetRunLock } from "../core/src/runtime/run-lock.js";
import { _resetSessionAffinity } from "../core/src/runtime/session-affinity.js";
import { encodeObservation, OBSERVATION_TYPE, type ObservationEntry } from "../core/src/store/codecs.js";
import type { StoreCustomEntry } from "../core/src/store/graph-store.js";
import { makeObservation, type NodeId, type ObsId } from "../core/src/types.js";
import {
  _resetCoreInstances,
  currentCoreKey,
  getCore,
  type Resolver,
  reassertCore,
  reloadCoreFor,
  type StoreContext,
} from "../host/core-instances.js";
import * as state from "../host/state.js";

// ---- fake StoreContext --------------------------------------------------------

interface FakeCtx extends StoreContext {
  /** Custom entries collected via appendEntry. */
  entries: StoreCustomEntry[];
  /** How many times load() replayed this context (getBranch reads). */
  replays: number;
}

function makeFakeCtx(): FakeCtx {
  const entries: StoreCustomEntry[] = [];
  let nextId = 0;
  let replays = 0;
  return {
    entries,
    get replays() {
      return replays;
    },
    appendEntry: (customType: string, data: unknown) => {
      entries.push({ type: "custom", id: `e${nextId++}`, customType, data });
    },
    getLeafId: () => (entries.length > 0 ? entries[entries.length - 1].id : null),
    getBranch: () => {
      replays += 1;
      return [...entries];
    },
  };
}

function obs(id: string, summary: string) {
  return makeObservation({
    id: id as ObsId,
    summary,
    importance: "med",
    sourceEntryIds: [],
    timestamp: "2026-10-06T00:00:00.000Z",
    parentNode: "n1" as unknown as NodeId,
  });
}

function appendObs(core: Awaited<ReturnType<typeof getCore>>, ctx: FakeCtx, id: string, summary: string) {
  const record = obs(id, summary);
  const entry: ObservationEntry = {
    coversFromId: "e0",
    coversUpToId: ctx.getLeafId() ?? "e-none",
    tokenCount: 1,
    records: [encodeObservation(record)],
  };
  core.store.appendObservation(ctx, entry);
  // the production persist seam writes the CONTEXT row and applies the
  // record to the LIVE graph in the same step — the resident state never
  // re-folds, so its in-memory twin must land here (parent wrapper first)
  const graph = core.store.getGraphStore().graph;
  if (!graph.nodes.has(record.parentNode as NodeId)) {
    applyCreateNode(graph, {
      id: record.parentNode as NodeId,
      summary: "observation parent",
      importance: "med",
      parentNode: null,
      state: "active",
    });
  }
  applyRecordObservation(graph, { obs: record });
}

function observationsInGraph(core: Awaited<ReturnType<typeof getCore>>): string[] {
  const store = core.store.getGraphStore();
  return [...store.graph.observations.values()].map((o) => o.id).sort();
}

beforeEach(() => {
  _resetRunLock();
  _resetSessionAffinity();
  state._resetForTest();
  _resetCoreInstances();
});

describe("core multiplexer — serialized swap", () => {
  test("getCore bootstraps the conversation registry lazily (no entry before first use)", async () => {
    expect(state.registry.size).toBe(0);
    const core = await getCore("s1");
    expect(state.registry.has("s1")).toBe(true);
    expect(core.conversation.key).toBe("s1");
    expect(core.conversation.agentId).toBeNull();
  });

  test("a subagent key bootstraps with its agentId parsed from the key", async () => {
    const core = await getCore("s1|agent-7");
    expect(core.conversation.agentId).toBe("agent-7");
    expect(core.conversation.sessionId).toBe("s1");
  });

  test("reassertCore re-pins a run's key after a parallel conversation stole the live key", async () => {
    const ctxA = makeFakeCtx();
    const ctxB = makeFakeCtx();
    await getCore("sX-runA", { ctxFactory: () => ctxA });
    // a parallel conversation's event swaps the process-global mid-run —
    // the observer/builder persist seam must not mint/apply against this
    await getCore("sY-runB", { ctxFactory: () => ctxB });
    expect(currentCoreKey()).toBe("sY-runB");
    await reassertCore("sX-runA");
    expect(currentCoreKey()).toBe("sX-runA");
    // already pinned → no reload (the fast path stays a fast path)
    const replays = ctxA.replays;
    await reassertCore("sX-runA");
    expect(ctxA.replays).toBe(replays);
  });

  test("two keys are isolated: switching drops the previous graph, switching back reloads it", async () => {
    const ctxA = makeFakeCtx();
    const ctxB = makeFakeCtx();
    const coreA = await getCore("sA", { ctxFactory: () => ctxA });
    // appendObservation is the PERSIST path (ctx.appendEntry) — the graph
    // itself fills from the load() replay, so assert the persist landed:
    appendObs(coreA, ctxA, "o1", "A's observation");
    expect(ctxA.entries).toHaveLength(1);
    expect(ctxA.entries[0].customType).toBe(OBSERVATION_TYPE);

    // switch to B: A's mutations must be gone from the live graph
    const coreB = await getCore("sB", { ctxFactory: () => ctxB });
    expect(currentCoreKey()).toBe("sB");
    expect(observationsInGraph(coreB)).toEqual([]);

    // B persists its own observation (its ctx, isolated from A's)
    appendObs(coreB, ctxB, "oB", "B's observation");
    expect(ctxB.entries).toHaveLength(1);

    // switch back to A: the fake ctx replay restores A's observation only
    const coreA2 = await getCore("sA");
    expect(observationsInGraph(coreA2)).toEqual(["o1"]);
    expect(observationsInGraph(coreA2)).not.toContain("oB");

    // and B reloads its own on the next switch (round-trip proof)
    const coreB2 = await getCore("sB");
    expect(observationsInGraph(coreB2)).toEqual(["oB"]);
    expect(observationsInGraph(coreB2)).not.toContain("o1");
  });

  test("switching BACK is a resident activation: the same loaded graph returns with zero replays", async () => {
    const ctxA = makeFakeCtx();
    const ctxB = makeFakeCtx();
    const coreA = await getCore("s-resA", { ctxFactory: () => ctxA });
    appendObs(coreA, ctxA, "o1", "A's observation");
    const replaysAfterLoad = ctxA.replays;
    await getCore("s-resB", { ctxFactory: () => ctxB }); // B is a miss (fresh load)
    const coreA2 = await getCore("s-resA"); // RED today: another full ctx re-fold
    expect(ctxA.replays).toBe(replaysAfterLoad); // resident ⇒ no reset, no disk refresh
    expect(observationsInGraph(coreA2)).toEqual(["o1"]); // contents intact
  });

  test("same-key getCore is a fast path: no reload, no re-bootstrap", async () => {
    const ctxA = makeFakeCtx();
    await getCore("sA", { ctxFactory: () => ctxA });
    const readsAfterFirst = ctxA.replays;
    await getCore("sA");
    await getCore("sA");
    expect(ctxA.replays).toBe(readsAfterFirst);
  });

  test("reloadCoreFor re-derives the observer frontier after an in-place rewind refold", async () => {
    // The resume shape: the ledger holds user row + two assistant rows + an
    // observation covering through the LAST assistant row (the forked-off
    // dead tail). The load derives the frontier there; the rewind
    // reconciliation then quarantines that observation and drops the dead
    // row from the live branch while post-resume rows arrive — WITHOUT a
    // same-key reload the stale frontier never resolves again and
    // computeUnobserved answers [] forever (the observer
    // goes silent for the rest of the session).
    const ctx = makeFakeCtx();
    const row = (id: string, role: "user" | "assistant"): StoreCustomEntry =>
      ({ type: "message", id, message: { role, content: `row ${id}` } }) as unknown as StoreCustomEntry;
    ctx.entries.push(row("e0", "user"), row("e1", "assistant"), row("e2", "assistant"), {
      type: "custom",
      id: "e-obs",
      customType: OBSERVATION_TYPE,
      data: {
        coversFromId: "e0",
        coversUpToId: "e2",
        tokenCount: 1,
        records: [encodeObservation(obs("o1", "covers the dead tail"))],
      },
    });
    const core = await getCore("sA", { ctxFactory: () => ctx });
    expect(core.store.getGraphStore().observerFrontier).toBe("e2");

    // the refold: the observation is quarantined (it covered dead rows), the
    // dead tail row leaves the live branch, and the continued conversation
    // appends fresh rows
    const kept = ctx.entries.filter((e) => e.id !== "e2" && e.id !== "e-obs");
    ctx.entries.length = 0;
    ctx.entries.push(...kept, row("e3", "assistant"), row("e4", "user"));
    const { computeUnobserved } = await import("../core/src/triggers.js");
    const stale = computeUnobserved(ctx.getBranch(null) as never, core.store.getGraphStore().observerFrontier);
    expect(stale).toEqual([]); // the bug: unresolvable frontier silences the observer

    // the refold asks the multiplexer to reload the SAME key
    const reloaded = await reloadCoreFor("sA");
    expect(reloaded).toBe(true);
    expect(ctx.replays).toBeGreaterThan(1); // a fresh load replayed the refolded branch
    const core2 = await getCore("sA");
    expect(core2.store.getGraphStore().observerFrontier).toBeNull(); // re-derived: no live observation
    const unobserved = computeUnobserved(ctx.getBranch(null) as never, core2.store.getGraphStore().observerFrontier);
    expect(unobserved.map((e) => e.id)).toEqual(["e1", "e3", "e4"]); // the observer sees work again
  });

  test("reloadCoreFor is a no-op for a key that is not live (the next swap loads fresh)", async () => {
    const ctxA = makeFakeCtx();
    await getCore("sA", { ctxFactory: () => ctxA });
    const reads = ctxA.replays;
    expect(await reloadCoreFor("sB")).toBe(false);
    expect(ctxA.replays).toBe(reads);
  });

  test("factories are sticky: a later getCore without options reuses the registered ones", async () => {
    const ctxA = makeFakeCtx();
    const coreA = await getCore("sA", { ctxFactory: () => ctxA });
    appendObs(coreA, ctxA, "o1", "x");
    await getCore("sB", { ctxFactory: () => makeFakeCtx() });
    // no options here — the sticky ctxFactory for sA must serve the reload
    const coreA2 = await getCore("sA");
    expect(observationsInGraph(coreA2)).toEqual(["o1"]);
  });

  test("reader-class switches DEFER: a switch waits for the in-flight run to release", async () => {
    const run = (await import("../core/src/runtime/run-lock.js")).acquireOrSkip("observe");
    if (run === null) throw new Error("lock unexpectedly busy");
    const switched = getCore("sB", { ctxFactory: () => makeFakeCtx() });
    let resolved = false;
    void switched.then(() => {
      resolved = true;
    });
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 5));
    expect(resolved).toBe(false);
    expect(currentCoreKey()).toBe(null);
    run.release();
    await switched;
    expect(currentCoreKey()).toBe("sB");
  });

  test("takeover-class switches ABORT the in-flight run first (compaction/rewind precedence)", async () => {
    const run = (await import("../core/src/runtime/run-lock.js")).acquireOrSkip("observe");
    if (run === null) throw new Error("lock unexpectedly busy");
    const switched = getCore("sB", { ctxFactory: () => makeFakeCtx(), mode: "takeover" });
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 5));
    expect(run.abortController.signal.aborted).toBe(true);
    run.release();
    await switched;
    expect(currentCoreKey()).toBe("sB");
  });

  test("each key gets its own session-affinity base, stable across switches", async () => {
    const affinity = await import("../core/src/runtime/session-affinity.js");
    await getCore("sA", { ctxFactory: () => makeFakeCtx() });
    const baseA = affinity.getStageAffinityId("observe");
    expect(baseA).not.toBeNull();
    await getCore("sB", { ctxFactory: () => makeFakeCtx() });
    const baseB = affinity.getStageAffinityId("observe");
    expect(baseB).not.toBeNull();
    expect(baseB).not.toBe(baseA);
    await getCore("sA");
    expect(affinity.getStageAffinityId("observe")).toBe(baseA);
  });

  test("a failed load rejects the caller, leaves no live key, and the old key fully reloads next time", async () => {
    const ctxA = makeFakeCtx();
    const coreA = await getCore("sA", { ctxFactory: () => ctxA });
    appendObs(coreA, ctxA, "o1", "x");
    const boom = makeFakeCtx();
    boom.getBranch = () => {
      throw new Error("disk exploded");
    };
    const failed = getCore("sBad", { ctxFactory: () => boom });
    await expect(failed).rejects.toThrow("disk exploded");
    // no live conversation after a failed swap — never fast-path into the gutted store
    expect(currentCoreKey()).toBeNull();
    // the pump survives; the old key does a FULL swap (replay) and restores
    const readsBefore = ctxA.replays;
    const coreA2 = await getCore("sA");
    expect(ctxA.replays).toBeGreaterThan(readsBefore);
    expect(observationsInGraph(coreA2)).toEqual(["o1"]);
  });

  test("switch requests serialize in call order (fast path resolves, queued switch follows)", async () => {
    const order: string[] = [];
    const p1 = getCore("qA", { ctxFactory: () => makeFakeCtx() }).then((c) => {
      order.push(`A:${c.key}`);
      return c;
    });
    const p2 = getCore("qA").then((c) => {
      order.push(`A2:${c.key}`);
      return c;
    });
    const p3 = getCore("qB", { ctxFactory: () => makeFakeCtx() }).then((c) => {
      order.push(`B:${c.key}`);
      return c;
    });
    await Promise.all([p1, p2, p3]);
    expect(order).toEqual(["A:qA", "A2:qA", "B:qB"]);
    expect(currentCoreKey()).toBe("qB");
  });

  test("a resolverFactory registered while the key is live applies only at the NEXT swap", async () => {
    const first: Resolver = () => ["first"] as readonly unknown[];
    const second: Resolver = () => ["second"] as readonly unknown[];
    await getCore("sA", { ctxFactory: () => makeFakeCtx(), resolverFactory: () => first });
    // live-key re-registration: stored, not applied
    await getCore("sA", { resolverFactory: () => second });
    const mid = await getCore("sA");
    expect(mid.store.getGraphStore().resolveEntries).toBe(first);
    // applied after a real swap away and back
    await getCore("sB", { ctxFactory: () => makeFakeCtx() });
    const back = await getCore("sA");
    expect(back.store.getGraphStore().resolveEntries).toBe(second);
  });

  test("a swap parked behind a run cannot resurrect a torn-down conversation", async () => {
    const runLockMod = await import("../core/src/runtime/run-lock.js");
    const run = runLockMod.acquireOrSkip("observe");
    if (run === null) throw new Error("lock unexpectedly busy");
    // this switch parks behind the held run (defer mode)
    const parked = getCore("sA", { ctxFactory: () => makeFakeCtx() });
    await new Promise((r) => setTimeout(r, 2));
    // session.end teardown races it (sA's dispose was registered at call time)
    for (const cs of state.registry.values()) {
      for (const d of cs.dispose) await d();
    }
    run.release();
    await expect(parked).rejects.toThrow(/ended during the switch/);
    expect(currentCoreKey()).toBeNull();
  });

  test("a request QUEUED behind a parked swap is also staled by teardown", async () => {
    const runLockMod = await import("../core/src/runtime/run-lock.js");
    const run = runLockMod.acquireOrSkip("observe");
    if (run === null) throw new Error("lock unexpectedly busy");
    const parked = getCore("sA", { ctxFactory: () => makeFakeCtx() });
    // queued BEHIND the parked switch (call time BEFORE the teardown)
    const queued = getCore("sB", { ctxFactory: () => makeFakeCtx() });
    await new Promise((r) => setTimeout(r, 2));
    for (const cs of state.registry.values()) {
      for (const d of cs.dispose) await d();
    }
    run.release();
    await expect(parked).rejects.toThrow(/ended during the switch/);
    await expect(queued).rejects.toThrow(/ended during the switch/);
    expect(currentCoreKey()).toBeNull();
  });

  test("conversation teardown drops the key's factories and live-key status", async () => {
    const ctxA = makeFakeCtx();
    const coreA = await getCore("sA", { ctxFactory: () => ctxA });
    appendObs(coreA, ctxA, "o1", "x");
    // run the registry's dispose callbacks (sessionEndBody does this at session end)
    for (const cs of state.registry.values()) {
      for (const d of cs.dispose) await d();
    }
    expect(currentCoreKey()).toBeNull();
    // post-teardown getCore is a FULL swap with NO factories (resolver cleared)
    const again = await getCore("sA");
    expect(again.store.getGraphStore().resolveEntries).toBeNull();
    expect(observationsInGraph(again)).toEqual([]);
  });

  test("resolver handling: a key with a resolverFactory installs it; without one, the resolver is cleared", async () => {
    const marker: Resolver = () => ["resolved"] as readonly unknown[];
    const core = await getCore("sA", { ctxFactory: () => makeFakeCtx(), resolverFactory: () => marker });
    expect(core.store.getGraphStore().resolveEntries).toBe(marker);
    // a key without a resolverFactory must not inherit the previous conversation's
    await getCore("sB", { ctxFactory: () => makeFakeCtx() });
    const coreB = await getCore("sB");
    expect(coreB.store.getGraphStore().resolveEntries).toBeNull();
  });
  test("teardown evicts the resident state — the next arrival cold-loads (no zombie graph)", async () => {
    const ctxE = makeFakeCtx();
    await getCore("sEvict", { ctxFactory: () => ctxE });
    expect(currentCoreKey()).toBe("sEvict");
    // run the registered session.end dispositions
    for (const conv of state.registry.values()) {
      for (const d of conv.dispose) await d();
    }
    expect(currentCoreKey()).toBeNull();
    // a fresh registration for the SAME key must take the COLD path — the
    // evicted resident would have returned without any ctx replay
    const ctxE2 = makeFakeCtx();
    await getCore("sEvict", { ctxFactory: () => ctxE2 });
    expect(ctxE2.replays).toBeGreaterThan(0);
  });

  test("activation trace: cold loads log resident=no (load Nms), returns log resident=yes (load 0ms)", async () => {
    const lines: string[] = [];
    const spy = vi.spyOn(log, "info").mockImplementation(((...args: unknown[]) => {
      lines.push(args.map(String).join(" "));
    }) as typeof log.info);
    try {
      await getCore("sTraceA", { ctxFactory: () => makeFakeCtx() });
      await getCore("sTraceB", { ctxFactory: () => makeFakeCtx() });
      await getCore("sTraceA"); // resident return — no ctx work at all
    } finally {
      spy.mockRestore();
    }
    const cold = lines.find((l) => l.includes("activate: key=sTraceA resident=no"));
    expect(cold).toBeDefined();
    expect(cold).toMatch(/\(load \d+ms\)/);
    const warm = lines.find((l) => l.includes("activate: key=sTraceA resident=yes (load 0ms)"));
    expect(warm).toBeDefined();
  });
});

describe("core multiplexer — static-import rule (stateful set via getCore only)", () => {
  test("every long-running stage run re-pins its own key before graph reads (cross-key bleed guard)", () => {
    const seams: [string, string][] = [
      ["host/runs/observer.ts", "await reassertCore(core.key)"], // mint/apply seam
      ["host/runs/builder.ts", "await reassertCore(core.key)"], // run-start capture
      ["host/runs/selector.ts", "await reassertCore(core.key)"],
      ["host/runs/goal-extract.ts", "await reassertCore(input.core.key)"],
      ["host/runs/reuse-rebuild.ts", "await reassertCore(core.key)"],
    ];
    const root = path.resolve(__dirname, "..");
    for (const [rel, needle] of seams) {
      const text = fsSync.readFileSync(path.join(root, rel), "utf8");
      expect(text, `${rel} must re-pin its key before graph reads`).toContain(needle);
    }
    // the builder's final flush must ride the captured graph, never a live
    // process-global re-read
    const builder = fsSync.readFileSync(path.join(root, "host/runs/builder.ts"), "utf8");
    expect(builder).toContain("flushNew(input.widget, core, graph, store)");
  });

  test("no host/hooks file statically imports the stateful core modules except core-instances.ts", () => {
    const stateful = ["store/graph-store", "format/details", "runtime/run-lock", "runtime/session-affinity"];
    const root = path.resolve(__dirname, "..");
    const scanDirs = [path.join(root, "host"), path.join(root, "hooks")];
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const name of fsSync.readdirSync(dir)) {
        const file = path.join(dir, name);
        if (fsSync.statSync(file).isDirectory()) {
          walk(file);
          continue;
        }
        if (!name.endsWith(".ts")) continue;
        let text = fsSync.readFileSync(file, "utf8");
        // TYPE-ONLY imports are erased at runtime — no singleton coupling —
        // so they are legal anywhere (storage maps graph-store's contract
        // shapes through `import type`); strip them before matching.
        text = text.replace(/^\s*import\s+type\s[^;]*;\s*$/gm, "");
        // static `from "..."` AND dynamic `import("...")` spellings, with or
        // without the .js extension — host code reaches the stateful set only
        // through getCore (core-instances.ts is the single legal importer).
        const rel = path.relative(root, file).split(path.sep).join("/");
        for (const mod of stateful) {
          const re = new RegExp(`(?:from|import)\\s*\\(?\\s*["'][^"']*${mod.replace("/", "\\/")}(?:\\.js)?["']`);
          if (re.test(text) && rel !== "host/core-instances.ts") {
            offenders.push(`${rel} -> ${mod}`);
          }
        }
      }
    };
    for (const dir of scanDirs) walk(dir);
    expect(offenders).toEqual([]);
  });

  test("core-instances.ts itself imports exactly the stateful set (the rule has a real subject)", async () => {
    const text = fsSync.readFileSync(path.resolve(__dirname, "../host/core-instances.ts"), "utf8");
    expect(text).toContain('from "../core/src/store/graph-store.js"');
    expect(text).toContain('from "../core/src/format/details.js"');
    expect(text).toContain('from "../core/src/runtime/run-lock.js"');
    expect(text).toContain('from "../core/src/runtime/session-affinity.js"');
  });
});
