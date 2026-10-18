// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// The goal-extract run host port: the one-shot orchestration profile over an
// INJECTED completer seam ($.model.complete supplies it): 512-token
// cap, stage "extract" on the run-lock (the goal-first sequencing rule),
// don't-clobber guard,
// atomic set_meta + delta append, never throws, usage ignored.
import { beforeEach, describe, expect, test } from "vitest";
import { DEFAULT_CONFIG } from "../../core/src/config/schema.js";
import { GOAL_EXTRACT_SYSTEM } from "../../core/src/prompts/goal-extract.js";
import { getGraphStore } from "../../core/src/store/graph-store.js";
import {
  _resetGoalExtractRun,
  abortGoalExtract,
  goalExtractSettled,
  runGoalExtract,
} from "../../host/runs/goal-extract.js";
import { NO_OP_WIDGET } from "../../host/runs/seams.js";
import {
  _resetRunLocks,
  abortInFlight,
  acquireForExtract,
  acquireOrSkip,
  current,
} from "../../host/triggers/run-locks.js";
import { branchCustoms, entries, makeMemoryDumpFs, type Rig, rigUp } from "./helpers.js";

beforeEach(() => {
  _resetGoalExtractRun();
});

async function goalRig(sessionId: string): Promise<Rig> {
  const rig = await rigUp(sessionId, entries(2));
  // the capture path seeds nGoal EMPTY — the extraction's don't-clobber
  // guard must see the pristine state
  {
    const nGoalNode = getGraphStore().graph.nodes.get("nGoal" as never);
    if (nGoalNode !== undefined) nGoalNode.summary = "";
  }
  return rig;
}

describe("runGoalExtract — the one-shot stage dump", () => {
  test("debugDumpLimit > 0 writes the toolless one-shot dump (prompt + reply)", async () => {
    const rig = await rigUp("goal-dump-1", entries(2));
    // seed nGoal EMPTY (the capture path's shape) — else don't-clobber skips
    const nGoalNode = getGraphStore().graph.nodes.get("nGoal" as never);
    if (nGoalNode !== undefined) nGoalNode.summary = "";
    const dump = makeMemoryDumpFs();
    const widget = NO_OP_WIDGET;
    await runGoalExtract({
      core: rig.core,
      store: rig.store,
      settings: { ...DEFAULT_CONFIG, debugDumpLimit: 1 } as never,
      widget,
      verbatimText: "port the extension",
      completer: async () => "Port the extension",
      dumps: { fs: dump.fs, baseDir: "/owl-data", cwd: "E:\\goal" },
    });
    const text = dump.files.get("/owl-data/dumps/E-goal/goal-extract-0.txt") ?? "";
    expect(text).toContain('<dump stage="goal-extract" started="');
    expect(text).not.toContain("<tools>"); // a toolless run omits the section
    expect(text).toContain("<input>\n");
    expect(text).toContain("Port the extension");
    expect(text.endsWith("</dump>\n")).toBe(true);
  });
});

describe("runGoalExtract — the profile", () => {
  test("a good reply sets nGoal.summary (atomic applySetMeta + delta) and renders", async () => {
    const rig = await goalRig("g-good");
    const calls: unknown[] = [];
    const widget = { ...NO_OP_WIDGET, render: () => calls.push("render") };
    await runGoalExtract({
      core: rig.core,
      store: rig.store,
      settings: { ...DEFAULT_CONFIG, observerMaxTokens: 4096, observerThinkingLevel: "high" } as never,
      widget,
      verbatimText: "port the extension to Claude Code",
      completer: async (input) => {
        calls.push(input);
        return "Port the session-owl extension to Claude Code";
      },
    });
    expect(getGraphStore().graph.nodes.get("nGoal" as never)?.summary).toBe(
      "Port the session-owl extension to Claude Code",
    );
    const deltas = branchCustoms(rig, "session-owl.graph_delta");
    const setMeta = deltas.filter((d) => (d as { delta?: { type?: string } }).delta?.type === "set_meta");
    expect(setMeta).toHaveLength(1);
    expect(calls[0]).toMatchObject({ maxTokens: 4096, effort: "high" }); // the observer knobs (owner ruling)
    expect(calls).toContain("render");
  });

  test("completion is durable — flushLedger fires after the set_meta append (crash-window contract)", async () => {
    const rig = await goalRig("g-flush");
    const during: string[] = [];
    await runGoalExtract({
      core: rig.core,
      store: rig.store,
      settings: { ...DEFAULT_CONFIG, observerMaxTokens: 4096 } as never,
      widget: NO_OP_WIDGET,
      verbatimText: "port the extension",
      completer: async () => "Port the extension",
      flushLedger: async () => {
        during.push(getGraphStore().graph.nodes.get("nGoal" as never)?.summary ?? "");
      },
    });
    // the flush rides AFTER the apply: at flush time the summary is already set
    expect(during).toEqual(["Port the extension"]);
  });

  test("the completer prompt = the system prompt + the verbatim text; abortable; timeout rides", async () => {
    const rig = await goalRig("g-prompt");
    const seen: Record<string, unknown>[] = [];
    await runGoalExtract({
      core: rig.core,
      store: rig.store,
      settings: { ...DEFAULT_CONFIG, llmCallTimeoutMs: 12_000 } as never,
      widget: NO_OP_WIDGET,
      verbatimText: "the ask",
      completer: async (input) => {
        seen.push(input as unknown as Record<string, unknown>);
        return "goal line";
      },
    });
    expect(String(seen[0].prompt)).toContain(GOAL_EXTRACT_SYSTEM);
    expect(String(seen[0].prompt)).toContain("the ask");
    expect(seen[0].timeoutMs).toBe(12_000);
    expect(typeof (seen[0].signal as AbortSignal).aborted).toBe("boolean");
  });

  test("don't clobber: a non-empty nGoal.summary ⇒ no completer call, no write", async () => {
    const rig = await goalRig("g-clobber");
    {
      const nGoalNode = getGraphStore().graph.nodes.get("nGoal" as never);
      if (nGoalNode !== undefined) nGoalNode.summary = "Builder already set this";
    }
    let completerCalls = 0;
    await runGoalExtract({
      core: rig.core,
      store: rig.store,
      settings: { ...DEFAULT_CONFIG } as never,
      widget: NO_OP_WIDGET,
      verbatimText: "late extraction",
      completer: async () => {
        completerCalls += 1;
        return "too late";
      },
    });
    expect(completerCalls).toBe(0); // pi: the guard runs BEFORE the call
    expect(getGraphStore().graph.nodes.get("nGoal" as never)?.summary).toBe("Builder already set this");
  });

  test("an empty/blank/ANSI-only reply writes nothing (Builder backstop)", async () => {
    const rig = await goalRig("g-empty");
    for (const reply of ["", "   ", "\u001b[2m\u001b[0m"]) {
      _resetGoalExtractRun();
      await runGoalExtract({
        core: rig.core,
        store: rig.store,
        settings: { ...DEFAULT_CONFIG } as never,
        widget: NO_OP_WIDGET,
        verbatimText: "ask",
        completer: async () => reply,
      });
    }
    expect(getGraphStore().graph.nodes.get("nGoal" as never)?.summary).toBe("");
  });

  test("stripAnsi + trim: ANSI decoration does not reach the summary", async () => {
    const rig = await goalRig("g-ansi");
    await runGoalExtract({
      core: rig.core,
      store: rig.store,
      settings: { ...DEFAULT_CONFIG } as never,
      widget: NO_OP_WIDGET,
      verbatimText: "ask",
      completer: async () => "\u001b[1mBold goal\u001b[0m  ",
    });
    expect(getGraphStore().graph.nodes.get("nGoal" as never)?.summary).toBe("Bold goal");
  });

  test("never throws: a completer rejection logs and leaves the summary empty", async () => {
    const rig = await goalRig("g-throw");
    await expect(
      runGoalExtract({
        core: rig.core,
        store: rig.store,
        settings: { ...DEFAULT_CONFIG } as never,
        widget: NO_OP_WIDGET,
        verbatimText: "ask",
        completer: async () => {
          throw new Error("model.complete failed");
        },
      }),
    ).resolves.toBeUndefined();
    expect(getGraphStore().graph.nodes.get("nGoal" as never)?.summary).toBe("");
  });

  test("abort all: abortGoalExtract() stops every in-flight extraction", async () => {
    const rigA = await goalRig("g-abort-a");
    const rigB = await goalRig("g-abort-b");
    const signals: AbortSignal[] = [];
    // the completer resolves ONLY on abort — if the keyless sweep misses one,
    // that extraction never settles and the test times out (the failure signal)
    const mkCompleter = (slot: number) => (input: { signal?: AbortSignal | null }) =>
      new Promise<string>((resolve) => {
        signals[slot] = input.signal ?? new AbortController().signal;
        signals[slot].addEventListener("abort", () => resolve(""), { once: true });
      });
    const inFlightA = runGoalExtract({
      core: rigA.core,
      store: rigA.store,
      settings: { ...DEFAULT_CONFIG } as never,
      widget: NO_OP_WIDGET,
      verbatimText: "ask",
      completer: mkCompleter(0),
    });
    const inFlightB = runGoalExtract({
      core: rigB.core,
      store: rigB.store,
      settings: { ...DEFAULT_CONFIG } as never,
      widget: NO_OP_WIDGET,
      verbatimText: "ask",
      completer: mkCompleter(1),
    });
    await new Promise((r) => setImmediate(r));
    abortGoalExtract(); // keyless: EVERY conversation's extraction
    await Promise.all([inFlightA, inFlightB]);
    expect(signals[0].aborted).toBe(true);
    expect(signals[1].aborted).toBe(true);
    // neither extraction persisted a write — assert each rig's OWN branch
    // (the handle-view of the graph store is the swapped singleton, so the
    // per-rig persisted ledger is the faithful witness)
    expect(branchCustoms(rigA, "session-owl.graph_delta")).toEqual([]);
    expect(branchCustoms(rigB, "session-owl.graph_delta")).toEqual([]);
  });

  test("a second fire WAITS for the first to settle — never two at once, no abort", async () => {
    const rig = await goalRig("g-single");
    const signals: AbortSignal[] = [];
    let releaseFirst!: () => void;
    const gateFirst = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const mk = (gate: Promise<void> | null, reply: string): Promise<void> =>
      runGoalExtract({
        core: rig.core,
        store: rig.store,
        settings: { ...DEFAULT_CONFIG } as never,
        widget: NO_OP_WIDGET,
        verbatimText: "ask",
        completer: (input) => {
          signals.push(input.signal as AbortSignal);
          return new Promise<string>((resolve) => {
            if (gate === null) {
              setImmediate(() => resolve(reply));
              return;
            }
            void gate.then(() => resolve(reply));
          });
        },
      });
    const first = mk(gateFirst, ""); // empty reply: the slot stays open for the second
    const second = mk(null, "second wins");
    await new Promise((resolve) => setImmediate(resolve));
    // the second fire sits behind the first — only ONE completer call in flight
    expect(signals).toHaveLength(1);
    expect(signals[0]?.aborted).toBe(false); // NOT aborted by the second's launch
    releaseFirst();
    await Promise.all([first, second]);
    expect(signals).toHaveLength(2);
    expect(signals[0]?.aborted).toBe(false);
    expect(signals[1]?.aborted).toBe(false);
    expect(getGraphStore().graph.nodes.get("nGoal" as never)?.summary).toBe("second wins");
  });

  test("abortGoalExtract(key) aborts ONE conversation's extraction and leaves another's in flight", async () => {
    const rigA = await goalRig("goal-key-abort-a");
    const rigB = await goalRig("goal-key-abort-b");
    const gates = [1, 2].map(() => {
      let release: () => void = () => {};
      const gate = new Promise<void>((res) => {
        release = res;
      });
      return { gate, release };
    });
    const signals: AbortSignal[] = [];
    const mkRun = (rig: Awaited<ReturnType<typeof goalRig>>, gate: Promise<void>, slot: number) => () =>
      runGoalExtract({
        core: rig.core,
        store: rig.store,
        settings: { ...DEFAULT_CONFIG } as never,
        widget: NO_OP_WIDGET,
        verbatimText: "the ask",
        completer: async (input) => {
          signals[slot] = input.signal ?? new AbortController().signal;
          await gate;
          return "goal";
        },
      });
    const runA = mkRun(rigA, gates[0].gate, 0)();
    await new Promise((r) => setImmediate(r));
    const runB = mkRun(rigB, gates[1].gate, 1)();
    await new Promise((r) => setImmediate(r));
    abortGoalExtract(rigA.core.key); // targeted teardown: A only
    gates[0].release();
    gates[1].release();
    await Promise.all([runA, runB]);
    expect(signals[0].aborted).toBe(true); // A was torn down
    expect(signals[1].aborted).toBe(false); // B untouched
  });

  test("the abort seam is keyed per conversation: another conversation's launch does NOT cancel an in-flight extraction", async () => {
    const rigA = await goalRig("goal-key-a");
    const rigB = await goalRig("goal-key-b");
    expect(rigA.core.key).not.toBe(rigB.core.key);
    let releaseA: () => void = () => {};
    const gateA = new Promise<void>((res) => {
      releaseA = res;
    });
    let signalA: AbortSignal | null = null;
    let signalB: AbortSignal | null = null;
    const runA = runGoalExtract({
      core: rigA.core,
      store: rigA.store,
      settings: { ...DEFAULT_CONFIG } as never,
      widget: NO_OP_WIDGET,
      verbatimText: "the ask A",
      completer: async (input) => {
        signalA = input.signal ?? null;
        await gateA;
        return "goal A";
      },
    });
    // a SECOND conversation launches its own extraction meanwhile
    await runGoalExtract({
      core: rigB.core,
      store: rigB.store,
      settings: { ...DEFAULT_CONFIG } as never,
      widget: NO_OP_WIDGET,
      verbatimText: "the ask B",
      completer: async (input) => {
        signalB = input.signal ?? null;
        return "goal B";
      },
    });
    releaseA();
    await runA;
    // A's controller was never aborted by B's launch (each key owns its slot)
    expect((signalA as AbortSignal | null)?.aborted).toBe(false);
    expect((signalB as AbortSignal | null)?.aborted).toBe(false);
  });
});

describe("runGoalExtract — run-lock stage sequencing (owner ruling)", () => {
  test("holds the passed extract lock through the run — a same-queue boundary evaluation skips — and releases on settle", async () => {
    _resetRunLocks();
    const rig = await goalRig("goal-lock-1");
    const lock = acquireForExtract(rig.core.key); // the launch site's sync acquire
    expect(lock).not.toBeNull();
    let releaseCall!: (reply: string) => void;
    const blocked = new Promise<string>((resolve) => {
      releaseCall = resolve;
    });
    const run = runGoalExtract({
      core: rig.core,
      store: rig.store,
      settings: { ...DEFAULT_CONFIG } as never,
      widget: NO_OP_WIDGET,
      verbatimText: "port the extension",
      completer: () => blocked,
      lock,
    });
    expect(current(rig.core.key)).toBe("extract");
    expect(acquireOrSkip(rig.core.key, "observe")).toBeNull(); // same-queue skip
    releaseCall("Port the extension");
    await run;
    expect(current(rig.core.key)).toBeNull();
    expect(acquireOrSkip(rig.core.key, "observe")).not.toBeNull();
  });

  test("a compaction-style abort through the lock handle kills the one-shot and releases", async () => {
    _resetRunLocks();
    const rig = await goalRig("goal-lock-abort");
    const lock = acquireForExtract(rig.core.key);
    const run = runGoalExtract({
      core: rig.core,
      store: rig.store,
      settings: { ...DEFAULT_CONFIG } as never,
      widget: NO_OP_WIDGET,
      verbatimText: "port the extension",
      completer: (input) =>
        new Promise<string>((resolve) => {
          input.signal?.addEventListener("abort", () => resolve(""), { once: true });
        }),
      lock,
    });
    expect(current(rig.core.key)).toBe("extract");
    abortInFlight(rig.core.key); // acquireForCompaction's abort path
    await run;
    expect(current(rig.core.key)).toBeNull();
    expect(getGraphStore().graph.nodes.get("nGoal" as never)?.summary).toBe("");
  });

  test("goalExtractSettled stays pending until the lock release included, then resolves", async () => {
    _resetRunLocks();
    const rig = await goalRig("goal-lock-settled");
    const lock = acquireForExtract(rig.core.key);
    let releaseCall!: (reply: string) => void;
    const blocked = new Promise<string>((resolve) => {
      releaseCall = resolve;
    });
    const run = runGoalExtract({
      core: rig.core,
      store: rig.store,
      settings: { ...DEFAULT_CONFIG } as never,
      widget: NO_OP_WIDGET,
      verbatimText: "port the extension",
      completer: () => blocked,
      lock,
    });
    let settled = false;
    void goalExtractSettled().then(() => {
      settled = true;
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);
    expect(current(rig.core.key)).toBe("extract"); // still holding while unsettled
    releaseCall("Port the extension");
    await run;
    await new Promise((resolve) => setImmediate(resolve));
    expect(settled).toBe(true);
    expect(current(rig.core.key)).toBeNull();
  });

  test("an un-locked run (a holder exists) keeps the holder's lock and still settles", async () => {
    _resetRunLocks();
    const rig = await goalRig("goal-lock-holder");
    const holder = acquireForExtract(rig.core.key) ?? acquireOrSkip(rig.core.key, "observe");
    // hold exists: run WITHOUT a lock input — extraction under the holder's authority
    expect(acquireForExtract(rig.core.key)).toBeNull();
    let releaseCall!: (reply: string) => void;
    const blocked = new Promise<string>((resolve) => {
      releaseCall = resolve;
    });
    const run = runGoalExtract({
      core: rig.core,
      store: rig.store,
      settings: { ...DEFAULT_CONFIG } as never,
      widget: NO_OP_WIDGET,
      verbatimText: "port the extension",
      completer: () => blocked,
      lock: null,
    });
    expect(current(rig.core.key)).toBe("extract"); // the holder IS the extract lock from line 1
    releaseCall("Port the extension");
    await run;
    // releasing the holder releases the extract stage the run used
    expect(current(rig.core.key)).toBe("extract");
    holder?.release();
    expect(current(rig.core.key)).toBeNull();
    await goalExtractSettled();
  });
});
