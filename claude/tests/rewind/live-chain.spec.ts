// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>
//
// The live chain processor: session.append events queue zero-latency; a
// deferred tick (re-armed per event, torn-tail backoff, eager at
// turn.complete) reads the transcript tail, verifies each queued row's
// anchor (the row's parent chain first for conversation rows, file order
// for tool_result rows and out-of-window chains) against
// owl's expected chain, feeds the VERIFIED edges to the lineage seam, and
// hands rewinds to the refold seam with the whole new world proven. All
// seams injected; the engine wiring spells the $ calls literally.

import { describe, expect, test, vi } from "vitest";
import { LiveChainProcessor } from "../../host/rewind/live-chain.js";
import { parseCapsuleTail, type TailFacts, type TailRow } from "../../host/rewind/tail-read.js";

function row(uuid: string, parent: string | null, boundary = false): TailRow {
  return { uuid, parentUuid: parent, boundary };
}

function facts(rows: TailRow[], torn = false): TailFacts {
  return { rows, torn };
}

interface Harness {
  proc: LiveChainProcessor;
  patched: Array<{ uuid: string; parent: string | null }>;
  rewinds: Array<{ settle: string | null }>;
  scheduled: number[];
  logs: string[];
  /** seam calls in arrival order: "patch" / "rewind" (the ordering pin) */
  order: string[];
  size: { value: number | null };
  setTail: (f: TailFacts | null) => void;
  setOwlTail: (t: string | null) => void;
  setDormant: (d: boolean) => void;
  /** run the newest armed deferred tick callback (the timer path) */
  fireScheduled: () => void;
  /** park the next statSize/readTail call on a manually-resolved promise */
  park: <T>(which: "stat" | "read") => { resolve: (v: T) => void };
  readCalls: number[];
}

function harness(init?: {
  owlTail?: string | null;
  size?: number | null;
  tail?: TailFacts | null;
  known?: string[];
  onRewind?: () => void | Promise<void>;
}): Harness {
  const patched: Array<{ uuid: string; parent: string | null }> = [];
  const rewinds: Array<{ settle: string | null }> = [];
  const scheduled: number[] = [];
  const size = { value: init?.size ?? 1000 };
  let tail: TailFacts | null = init?.tail ?? null;
  let owlTail: string | null = init?.owlTail ?? null;
  let dormant = false;
  let lastScheduled: (() => void) | null = null;
  const logs: string[] = [];
  const order: string[] = [];
  const readCalls: number[] = [];
  let parkWhich: "stat" | "read" | null = null;
  let parkedCb: ((resolve: (v: unknown) => void) => void) | null = null;
  const tryPark = (which: "stat" | "read"): Promise<unknown> | null => {
    if (parkedCb === null || parkWhich !== which) return null;
    const cb = parkedCb;
    parkedCb = null;
    parkWhich = null;
    return new Promise((res) => cb(res));
  };
  const known = new Set(init?.known ?? []);
  const proc = new LiveChainProcessor({
    statSize: async () => {
      const p = tryPark("stat");
      if (p !== null) return (await p) as number | null;
      return size.value;
    },
    readTail: async (maxRows) => {
      readCalls.push(maxRows);
      const p = tryPark("read");
      if (p !== null) return (await p) as TailFacts | null;
      return tail;
    },
    owlTailExcluding: () => owlTail,
    isKnownRow: (uuid) => known.has(uuid),
    patchEdges: (edges) => {
      order.push("patch");
      for (const e of edges) patched.push({ uuid: e.uuid, parent: e.parent });
    },
    onRewind: async (v) => {
      order.push("rewind");
      rewinds.push(v);
      if (init?.onRewind !== undefined) await init.onRewind();
    },
    dormant: () => dormant,
    schedule: (ms, fn) => {
      scheduled.push(ms);
      lastScheduled = fn;
      return () => {};
    },
    log: (m) => {
      logs.push(m);
    },
  });
  return {
    proc,
    patched,
    rewinds,
    scheduled,
    logs,
    order,
    readCalls,
    size,
    setTail: (f) => {
      tail = f;
    },
    setOwlTail: (t) => {
      owlTail = t;
    },
    setDormant: (d) => {
      dormant = d;
    },
    fireScheduled: () => {
      const fn = lastScheduled;
      lastScheduled = null;
      if (fn !== null) fn();
    },
    park: <T>(which: "stat" | "read") => {
      const holder: { resolve: (v: T) => void } = { resolve: () => {} };
      parkWhich = which;
      parkedCb = (res) => {
        holder.resolve = res as (v: T) => void;
      };
      return holder;
    },
  };
}

const ev = (uuid: string, captured: boolean, door = captured ? "response" : "attachment") => ({
  uuid,
  door,
  captured,
});

describe("live chain processor — enqueue", () => {
  test("main-conversation events queue; agent rows are refused", () => {
    const h = harness();
    expect(h.proc.enqueue({ ...ev("u1", true), agentId: "ag-1" })).toBe(false);
    expect(h.proc.enqueue(ev("u1", true))).toBe(true);
  });
  test("every enqueue re-arms the deferred tick (the wait adapts to the LAST event)", () => {
    const h = harness();
    h.proc.enqueue(ev("u1", true));
    h.proc.enqueue(ev("u2", true));
    expect(h.scheduled).toEqual([1000, 1000]);
  });
});

describe("live chain processor — the normal tick", () => {
  test("verified anchors flow to patchEdges; uncaptured ceremony carries only window-validated parents", async () => {
    const h = harness({ owlTail: "t0", size: 100, tail: facts([row("t0", "x"), row("j1", "t0"), row("u1", "j1")]) });
    h.proc.enqueue(ev("j1", false));
    h.proc.enqueue(ev("u1", true));
    await h.proc.flush();
    // the captured row's edge is its VERIFIED anchor (j1 is not
    // observable — the walk lands on t0, the design's parent rule); the
    // ceremony row keeps its own file parent, validated against the window
    expect(h.patched).toEqual([
      { uuid: "j1", parent: "t0" },
      { uuid: "u1", parent: "t0" },
    ]);
    expect(h.rewinds).toEqual([]);
    expect((h.size.value ?? 0) >= 0).toBe(true);
  });

  test("rows not yet in the tail stay queued (the debounce has not drained them)", async () => {
    const h = harness({ owlTail: "t0", tail: facts([row("t0", "x"), row("u1", "t0")]) });
    h.proc.enqueue(ev("u1", true));
    h.proc.enqueue(ev("u2", true)); // not persisted yet
    await h.proc.flush();
    expect(h.patched).toEqual([{ uuid: "u1", parent: "t0" }]);
  });

  test("a boundary row is the chain's fresh root; the row after it anchors there", async () => {
    const h = harness({
      owlTail: "old",
      tail: facts([row("old", "x"), row("b1", null, true), row("u1", "b1")]),
    });
    h.proc.enqueue(ev("b1", true, "compaction"));
    h.proc.enqueue(ev("u1", true));
    await h.proc.flush();
    expect(h.rewinds).toEqual([]);
    expect(h.patched).toEqual([
      { uuid: "b1", parent: null },
      { uuid: "u1", parent: "b1" },
    ]);
  });

  test("a fresh row over an unmirrored chrome row rebases when the expectation is its chrome sibling", async () => {
    // each retry prompt chains onto the SAME system row: the previous
    // attempt sits as a chrome sibling of the new row, so the anchor walk
    // lands on the mirrored row before it and the depth counts only
    // observable steps (the chrome row is transparent)
    const h = harness({
      owlTail: "f1",
      known: ["b0"],
      tail: facts([row("b0", "x"), row("sys", "b0"), row("f1", "sys"), row("f2", "sys")]),
    });
    h.proc.enqueue(ev("sys", false));
    h.proc.enqueue(ev("f2", true));
    await h.proc.flush();
    expect(h.rewinds).toEqual([]);
    expect(h.patched).toEqual([
      { uuid: "sys", parent: "b0" },
      { uuid: "f2", parent: "b0" },
    ]);
  });

  test.each([
    ["after", true],
    ["before", false],
  ])("a prompt whose file-history snapshot shares its id (written %s it) is no fresh root", async (_label, after) => {
    // the engine snapshots the prompt under the prompt's own id, with no
    // uuid and no parent; the real row (chained over a turn_duration
    // system row) must own the id whichever side the snapshot lands on
    const snapshot = JSON.stringify({ type: "file-history-snapshot", messageId: "p1", snapshot: {} });
    const prompt = JSON.stringify({ uuid: "p1", parentUuid: "td", type: "user" });
    const text = [
      JSON.stringify({ uuid: "a1", parentUuid: "x", type: "assistant" }),
      JSON.stringify({ uuid: "td", parentUuid: "a1", type: "system", subtype: "turn_duration" }),
      ...(after ? [prompt, snapshot] : [snapshot, prompt]),
      "",
    ].join("\n");
    const h = harness({ owlTail: "a1", known: ["a1"], tail: parseCapsuleTail(text, 10) });
    h.proc.enqueue(ev("td", false));
    h.proc.enqueue(ev("p1", true));
    await h.proc.flush();
    expect(h.rewinds).toEqual([]);
    expect(h.logs.some((m) => m.includes("fresh root"))).toBe(false);
    expect(h.patched).toContainEqual({ uuid: "p1", parent: "a1" });
  });

  test("file-history chrome written ahead of its message rows never reads as amputation", async () => {
    // the engine persists a Write turn as: file-history-delta (messageId =
    // the tool row's id, parentless), THEN the assistant rows — a tail read
    // catching that instant must keep the pending queue for the next retry,
    // never declare amputation/rewind for rows that are merely unflushed
    const delta = JSON.stringify({ type: "file-history-delta", messageId: "t05", snapshotMessageId: "t05" });
    const text = [
      JSON.stringify({ uuid: "d07", parentUuid: "a0", type: "user" }),
      delta, // the message rows after it have not landed yet
      "",
    ].join("\n");
    const h = harness({ owlTail: "d07", known: ["d07"], tail: parseCapsuleTail(text, 10) });
    h.proc.enqueue(ev("a07", true));
    h.proc.enqueue(ev("a08", true));
    h.proc.enqueue(ev("t05", true));
    await h.proc.flush();
    expect(h.rewinds).toEqual([]);
    expect(h.patched).toEqual([]);
    expect(h.logs.some((m) => m.includes("amputation"))).toBe(false);
    expect(h.logs.some((m) => m.includes("fresh root"))).toBe(false);
  });

  test("an expectation on a chain-id row with no deeper ancestry rebases quietly", async () => {
    // the tail names a row the engine wrote without a parent (command /
    // file-history chrome): its ancestry reaches nothing, so no jump is
    // provable and the rebase stands
    const h = harness({
      owlTail: "ct",
      known: ["b0"],
      tail: facts([row("b0", "x"), row("ct", null), row("sys", "b0"), row("n1", "sys")]),
    });
    h.proc.enqueue(ev("sys", false));
    h.proc.enqueue(ev("n1", true));
    await h.proc.flush();
    expect(h.rewinds).toEqual([]);
    expect(h.patched).toEqual([
      { uuid: "sys", parent: "b0" },
      { uuid: "n1", parent: "b0" },
    ]);
  });
});

describe("live chain processor — verdict application is single-flight across lanes", () => {
  test("two parked applications never overlap — the second waits for the first", async () => {
    let running = 0;
    let maxRunning = 0;
    const release: Array<() => void> = [];
    const h = harness({
      owlTail: "t0",
      tail: facts([row("t0", "x"), row("u2", "t0")]),
      onRewind: () =>
        new Promise<void>((resolve) => {
          running += 1;
          maxRunning = Math.max(maxRunning, running);
          release.push(() => {
            running -= 1;
            resolve();
          });
        }),
    });
    await h.proc.flush({ deferVerdicts: true }); // arm the defer flag
    // verdict A: parked, then applied on the timer lane (it hangs)
    h.proc.enqueue(ev("u1", true));
    h.proc.enqueue(ev("u2", true));
    h.fireScheduled(); // the tick parks the verdict
    h.fireScheduled(); // the timer applies it — onRewind A hangs
    await new Promise((r) => setTimeout(r, 0));
    expect(h.rewinds.length).toBe(1); // A started
    // verdict B: parked while A's application is in flight
    h.setTail(facts([row("t0", "x"), row("u4", "t0")]));
    h.proc.enqueue(ev("u3", true));
    h.proc.enqueue(ev("u4", true));
    h.fireScheduled(); // the tick parks verdict B
    h.fireScheduled(); // the timer would start B — it must WAIT for A
    await new Promise((r) => setTimeout(r, 5));
    expect(h.rewinds.length).toBe(1); // B has not started while A is in flight
    release[0]?.();
    await new Promise((r) => setTimeout(r, 5));
    release[1]?.();
    await vi.waitFor(() => expect(h.rewinds.length).toBe(2)); // both verdicts applied in the end
    expect(maxRunning).toBe(1); // never overlapped
  });
});

describe("live chain processor — the absent partition is door-aware", () => {
  test("an unknown-door captured row absent behind a present one is SKIPPED with a loud log — never amputation evidence", async () => {
    const h = harness({
      owlTail: "t0",
      tail: facts([row("t0", "x"), row("r1", "t0")]),
    });
    h.proc.enqueue({ uuid: "x1", door: "some-new-door", captured: true });
    h.proc.enqueue(ev("r1", true));
    await h.proc.flush();
    expect(h.rewinds).toEqual([]);
    expect(h.logs.some((l) => /some-new-door/.test(l) && /unknown door/.test(l))).toBe(true);
    expect(h.patched).toEqual([{ uuid: "r1", parent: "t0" }]);
  });

  test("a command-door captured row absent behind a present one IS amputation evidence (command rows persist)", async () => {
    const h = harness({
      owlTail: "t0",
      tail: facts([row("t0", "x"), row("r1", "t0")]),
    });
    h.proc.enqueue({ uuid: "cmd1", door: "command", captured: true });
    h.proc.enqueue(ev("r1", true));
    await h.proc.flush();
    expect(h.rewinds).toEqual([{ settle: "r1" }]);
    expect(h.logs.some((l) => /amputation \(cmd1/.test(l))).toBe(true);
  });

  test("a persisting-door captured row absent behind a present one IS amputation evidence", async () => {
    const h = harness({
      owlTail: "t0",
      tail: facts([row("t0", "x"), row("r1", "t0")]),
    });
    h.proc.enqueue(ev("x1", true)); // door=response by default in ev()
    h.proc.enqueue(ev("r1", true));
    await h.proc.flush();
    expect(h.rewinds).toEqual([{ settle: "r1" }]);
    expect(h.logs.some((l) => /amputation \(x1/.test(l))).toBe(true);
  });
});

describe("live chain processor — bounds, lifecycle and containment", () => {
  test("the queue cap sheds the OLDEST pending rows and detection stays live", async () => {
    const h = harness({ owlTail: "t0", known: ["t0"], tail: facts([row("t0", null)]) });
    for (let i = 1; i <= 4097; i += 1) h.proc.enqueue(ev(`q${i}`, true));
    expect(h.logs.some((l) => l.includes("queue cap reached"))).toBe(true);
    // the newest rows still verify once the file catches up
    const rows: TailRow[] = [row("t0", null)];
    for (let i = 2; i <= 4097; i += 1) rows.push(row(`q${i}`, `q${i - 1}`));
    h.setTail(facts(rows));
    await h.proc.flush();
    expect(h.patched.some((e) => e.uuid === "q4097")).toBe(true);
    // the shed oldest (q1) never returns
    expect(h.patched.some((e) => e.uuid === "q1")).toBe(false);
  });

  test("an anchor stuck outside the window for the bound's ticks is shed; detection continues", async () => {
    // the row's only predecessor is unobservable and owl holds a tail —
    // every tick defers until the shed bound
    const h = harness({ owlTail: "t2", tail: facts([row("u9", "ancient")]) });
    h.proc.enqueue(ev("u9", true));
    for (let i = 0; i < 4; i += 1) await h.proc.flush();
    expect(h.rewinds).toEqual([]);
    expect(h.logs.some((l) => l.includes("shedding the batch"))).toBe(false);
    await h.proc.flush(); // the 5th
    expect(h.logs.some((l) => l.includes("shedding the batch"))).toBe(true);
    // later rows verify again
    h.setOwlTail("t2");
    h.setTail(facts([row("t2", null), row("u10", "t2")]));
    h.proc.enqueue(ev("u10", true));
    await h.proc.flush();
    expect(h.patched.map((e) => e.uuid)).toContain("u10");
  });

  test("dispose pins the processor dead: an in-flight tick completes into nothing", async () => {
    const h = harness({ owlTail: "t0", known: ["t0"], tail: facts([row("t0", null), row("u1", "t0")]) });
    h.proc.enqueue(ev("u1", true));
    const parkedRead = h.park<TailFacts | null>("read");
    const tick = h.proc.flush(); // parks inside readTail
    await new Promise((r) => setTimeout(r, 0)); // let the tick reach the park
    h.proc.dispose();
    parkedRead.resolve(facts([row("t0", null), row("u1", "t0")]));
    await tick;
    expect(h.patched).toEqual([]);
    expect(h.rewinds).toEqual([]);
    const schedules = h.scheduled.length;
    await h.proc.flush(); // a no-op
    expect(h.scheduled.length).toBe(schedules); // nothing re-armed
    expect(h.readCalls.length).toBe(1); // no further reads
  });

  test("flush during an in-flight tick waits it out and runs once more", async () => {
    const h = harness({ owlTail: "t0", known: ["t0"], tail: facts([row("t0", null), row("u1", "t0")]) });
    h.proc.enqueue(ev("u1", true));
    const parkedRead = h.park<TailFacts | null>("read");
    const first = h.proc.flush(); // parks inside readTail
    await new Promise((r) => setTimeout(r, 0)); // let the tick reach the park
    const second = h.proc.flush(); // must wait the first, then process again
    expect(h.readCalls.length).toBe(1);
    // the parked read answers with a tail that does NOT hold u1 yet (a
    // defer); the complete file lands before the flush's own pass re-reads
    h.setTail(facts([row("t0", null), row("u1", "t0")]));
    parkedRead.resolve(facts([row("t0", null)]));
    await first;
    await second;
    expect(h.readCalls.length).toBe(2); // the flush's own pass ran
    expect(h.patched).toEqual([{ uuid: "u1", parent: "t0" }]);
  });

  test("a dormant tick drops its queue; the rows do not resurrect", async () => {
    const h = harness({ owlTail: "t0", known: ["t0"], tail: facts([row("t0", null), row("u1", "t0")]) });
    h.proc.enqueue(ev("u1", true));
    h.setDormant(true);
    await h.proc.flush();
    expect(h.logs.some((l) => l.includes("dormant — queue dropped"))).toBe(true);
    expect(h.patched).toEqual([]);
    h.setDormant(false);
    await h.proc.flush(); // the queue is gone — nothing verifies
    expect(h.patched).toEqual([]);
  });

  test("absurd uuids never enter the window: their edges never feed the lineage", async () => {
    const huge = "z".repeat(200);
    const h = harness({
      owlTail: "t0",
      known: ["t0"],
      // the captured row's FILE parent names the foreign padding row
      tail: facts([row("t0", null), row(huge, "t0"), row("u1", huge)]),
    });
    // the padding row itself is refused at the door (engine uuids are sane)
    expect(h.proc.enqueue(ev(huge, false))).toBe(false);
    h.proc.enqueue(ev("u1", true));
    await h.proc.flush();
    // u1's edge is its verified anchor (t0 — the walk skips the padding),
    // and the padding row contributes nothing
    expect(h.patched).toEqual([{ uuid: "u1", parent: "t0" }]);
  });

  test("an uncaptured row's OFF-WINDOW file parent is clamped to null, never fed raw", async () => {
    const h = harness({
      owlTail: "t0",
      known: ["t0"],
      tail: facts([row("t0", null), row("j1", "off-window"), row("u1", "t0")]),
    });
    h.proc.enqueue(ev("j1", false));
    h.proc.enqueue(ev("u1", true));
    await h.proc.flush();
    expect(h.patched).toContainEqual({ uuid: "j1", parent: null });
    expect(h.patched).not.toContainEqual({ uuid: "j1", parent: "off-window" });
  });

  test("uncaptured absent rows behind a present one are never amputation evidence", async () => {
    // engine ceremony (hook-context and its kin) is delivered through the
    // append event but never persisted — its absence proves nothing; only
    // a CAPTURED row vanishing from the file is amputation
    const h = harness({ owlTail: "t0", known: ["t0"] });
    h.proc.enqueue(ev("hc1", false)); // ceremony, never in the file
    h.proc.enqueue(ev("hc2", false));
    h.proc.enqueue(ev("u1", true));
    h.setTail(facts([row("t0", null), row("u1", "t0")]));
    await h.proc.flush();
    expect(h.patched).toEqual([{ uuid: "u1", parent: "t0" }]);
    expect(h.rewinds).toEqual([]); // no verdict, no refold
    expect(h.logs.some((l) => l.includes("amputat"))).toBe(false);
  });

  test("a batch entirely absent from the tail is debounce lag: retry, keep, no verdict", async () => {
    const h = harness({ owlTail: "t0", known: ["t0"], tail: facts([row("t0", null)]) });
    h.proc.enqueue(ev("u1", true));
    h.proc.enqueue(ev("u2", true));
    await h.proc.flush();
    expect(h.patched).toEqual([]);
    expect(h.rewinds).toEqual([]);
    // the deferred retry is armed
    expect(h.scheduled.length).toBeGreaterThanOrEqual(2);
    // once the file catches up, both verify
    h.setTail(facts([row("t0", null), row("u1", "t0"), row("u2", "u1")]));
    h.fireScheduled();
    await new Promise((r) => setTimeout(r, 10));
    expect(h.patched).toEqual([
      { uuid: "u1", parent: "t0" },
      { uuid: "u2", parent: "u1" },
    ]);
  });

  test("a throwing onRewind propagates: the tick fails, the retry is armed, the verdict re-detects", async () => {
    let fails = 0;
    const h = harness({
      owlTail: "t2",
      known: ["t1"],
      tail: facts([row("t1", null), row("u9", "t1")]),
      onRewind: () => {
        fails += 1;
        if (fails === 1) throw new Error("refold exploded");
      },
    });
    h.proc.enqueue(ev("u9", true));
    await h.proc.flush();
    expect(fails).toBe(1);
    expect(h.logs.some((l) => l.includes("tick failed"))).toBe(true);
    expect(h.scheduled.length).toBeGreaterThanOrEqual(2); // the retry armed
    // the retried tick re-detects and the refold succeeds
    h.fireScheduled();
    await new Promise((r) => setTimeout(r, 10));
    expect(fails).toBe(2);
    // the verdict was DELIVERED both times — a detected rewind is never
    // silently dropped, the refold retry re-receives it
    expect(h.rewinds).toEqual([{ settle: "u9" }, { settle: "u9" }]);
  });

  test("the deferred tick itself fires the verification (the timer path, no flush)", async () => {
    const h = harness({ owlTail: "t0", known: ["t0"] });
    h.proc.enqueue(ev("u1", true));
    h.setTail(facts([row("t0", null), row("u1", "t0")]));
    expect(h.patched).toEqual([]); // nothing yet
    h.fireScheduled();
    await new Promise((r) => setTimeout(r, 10));
    expect(h.patched).toEqual([{ uuid: "u1", parent: "t0" }]);
  });

  test("edges are durable BEFORE the verdict (patch precedes rewind)", async () => {
    const h = harness({
      owlTail: "t2",
      known: ["t1"],
      tail: facts([row("t1", null), row("u9", "t1")]),
    });
    h.proc.enqueue(ev("u9", true));
    await h.proc.flush();
    expect(h.order).toEqual(["patch", "rewind"]);
  });

  test("the retry ladder grows the window and backs off (capped)", async () => {
    const h = harness({ owlTail: "t2", tail: facts([row("u9", "ancient")]) });
    h.proc.enqueue(ev("u9", true));
    await h.proc.flush(); // defer 1
    await h.proc.flush(); // defer 2 (flush path resets processing each time)
    expect(h.readCalls.length).toBeGreaterThanOrEqual(2);
    expect(h.readCalls[1]).toBeGreaterThan(h.readCalls[0]); // the window grew
  });

  test("a walk off the window with an EMPTY chain starts the chain (never defers)", async () => {
    const h = harness({ owlTail: null, tail: facts([row("j1", "ancient"), row("u1", "j1")]) });
    h.proc.enqueue(ev("u1", true));
    await h.proc.flush();
    expect(h.patched).toEqual([{ uuid: "u1", parent: null }]);
    expect(h.rewinds).toEqual([]);
  });
});

describe("live chain processor — the torn and missing tails", () => {
  test("a torn tail backs off (longer delay) and keeps the queue", async () => {
    const h = harness({ owlTail: "t0", tail: facts([row("t0", "x")], true) });
    h.proc.enqueue(ev("u1", true));
    await h.proc.flush();
    expect(h.patched).toEqual([]);
    expect(h.scheduled).toContain(2500);
  });
  test("a missing tier stands the timer lane down: one line, no retry loop — the per-turn check keeps attempting and a success revives", async () => {
    // the file exists (size known) but the read tier cannot serve it (a
    // surface without the process seam, a broken helper) — the timer lane
    // stands down after the bounded ladder instead of retrying forever;
    // the per-turn eager check keeps attempting (the documented
    // reconciliation), and a tier that serves again revives detection
    const h = harness({ owlTail: "t0", tail: null, size: 1000 });
    h.proc.enqueue(ev("u1", true));
    for (let i = 0; i < 5; i += 1) await h.proc.flush();
    expect(h.logs.some((l) => l.includes("detection stands down"))).toBe(true);
    // the timer lane is off: an enqueue arms nothing
    const schedules = h.scheduled.length;
    h.proc.enqueue(ev("u2", true));
    expect(h.scheduled.length).toBe(schedules);
    // the eager per-turn check still attempts (and stays down while the
    // tier is missing) — never a wrong verdict
    await h.proc.flush();
    expect(h.rewinds).toEqual([]);
    // the tier serves again: the next eager check revives detection
    h.setTail(facts([row("t0", "x"), row("u1", "t0"), row("u2", "t0")]));
    await h.proc.flush();
    expect(h.logs.some((l) => l.includes("detection resumed"))).toBe(true);
    expect(h.patched.map((e) => e.uuid)).toContain("u1");
    expect(h.patched.map((e) => e.uuid)).toContain("u2");
    // revived: the timer lane arms again on the next enqueue
    h.proc.enqueue(ev("u3", true));
    expect(h.scheduled.length).toBe(schedules + 1);
  });

  test("a revived tier starts with a fresh retry budget — one flaky read must not re-stand-down", async () => {
    const h = harness({ owlTail: "t0", tail: null, size: 1000 });
    h.proc.enqueue(ev("u1", true));
    for (let i = 0; i < 5; i += 1) await h.proc.flush();
    expect(h.logs.some((l) => l.includes("detection stands down"))).toBe(true);
    // the tier serves again but the tail is TORN: the tick revives the
    // lane yet never reaches a clean finish — the retry budget must
    // already be fresh at the revival itself
    h.setTail(facts([row("t0", "x"), row("u1", "t0")], true));
    await h.proc.flush();
    expect(h.logs.some((l) => l.includes("detection resumed"))).toBe(true);
    // ONE missing-tier read after the revival must retry, not stand down again
    h.setTail(null);
    h.proc.enqueue(ev("u2", true));
    await h.proc.flush();
    expect(h.logs.filter((l) => l.includes("detection stands down"))).toHaveLength(1);
  });

  test("a null read (tier missing) retries the normal delay without state change", async () => {
    const h = harness({ owlTail: "t0", tail: null });
    h.proc.enqueue(ev("u1", true));
    await h.proc.flush();
    expect(h.patched).toEqual([]);
    expect(h.scheduled).toContain(1000);
  });
  test("an absent file (null size) retries later; the queue survives", async () => {
    const h = harness({ owlTail: "t0", size: null, tail: null });
    h.size.value = null;
    h.proc.enqueue(ev("u1", true));
    await h.proc.flush();
    expect(h.patched).toEqual([]);
    expect(h.scheduled.length).toBeGreaterThanOrEqual(1);
  });
});

describe("live chain processor — the mismatch depth rule", () => {
  // The engine writes a user-row candidate NEXT TO the assistant answer
  // (both children of one parent) and continues from the assistant. When
  // the candidate arrives after the answer, owl's expectation sits on it
  // and the next row anchors at the candidate's OWN parent — exactly one
  // step up from the expectation. A quiet rebase: the edge keeps the
  // file's parent truth.
  test("depth 1 — the orphan candidate: no verdict, the edge keeps the file's truth", async () => {
    const h = harness({
      owlTail: "P",
      known: ["P", "A"],
      tail: facts([row("P", "root"), row("A", "P"), row("U", "P")]),
    });
    h.proc.enqueue(ev("A", true));
    await h.proc.flush();
    h.setOwlTail("A");
    h.proc.enqueue(ev("U", true));
    await h.proc.flush();
    expect(h.rewinds).toEqual([]);
    expect(h.patched.at(-1)).toEqual({ uuid: "U", parent: "P" });
  });

  // The follow-up: the conversation continues from the SIBLING assistant
  // row, which is a child of the shared parent — never on the orphan's
  // own ancestry. A quiet rebase onto the sibling's line.
  test("anchor off the ancestry — the sibling continuation: no verdict", async () => {
    const h = harness({
      owlTail: "P",
      known: ["P", "A", "U"],
      tail: facts([row("P", "root"), row("A", "P"), row("U", "P"), row("T", "A")]),
    });
    h.proc.enqueue(ev("A", true));
    h.proc.enqueue(ev("U", true));
    await h.proc.flush();
    h.setOwlTail("U");
    h.proc.enqueue(ev("T", true));
    await h.proc.flush();
    expect(h.rewinds).toEqual([]);
    expect(h.patched.at(-1)).toEqual({ uuid: "T", parent: "A" });
    expect(h.logs.some((l) => /rewind detected/.test(l))).toBe(false);
  });

  // A re-sent prompt anchors at its turn's parent — deeper than one step
  // once the dead turn's rows sit between: the chain provably moved back.
  test("depth > 1 — a dead turn's re-sent prompt: the rewind verdict fires", async () => {
    const h = harness({
      owlTail: "P",
      known: ["P", "U", "C"],
      tail: facts([row("P", "root"), row("U", "P"), row("C", "U"), row("U2", "P")]),
    });
    h.proc.enqueue(ev("U", true));
    h.proc.enqueue(ev("C", true));
    await h.proc.flush();
    h.setOwlTail("C");
    h.proc.enqueue(ev("U2", true));
    await h.proc.flush();
    expect(h.rewinds).toEqual([{ settle: "U2" }]);
    expect(h.patched.at(-1)).toEqual({ uuid: "U2", parent: "P" });
  });
});

describe("live chain processor — rewind detection", () => {
  test("an anchor behind owl's tail is a rewind: the batch verifies on, edges feed the lineage, the settle is the last verified row", async () => {
    const h = harness({
      owlTail: "t2",
      known: ["t1"],
      tail: facts([row("t1", "x"), row("u9", "t1")]), // t2 amputated away
    });
    h.proc.enqueue(ev("u9", true));
    await h.proc.flush();
    // the file's true edge is durable BEFORE the verdict: the refold
    // resolves live sets through the ledger
    expect(h.patched).toEqual([{ uuid: "u9", parent: "t1" }]);
    // the settle is the LAST VERIFIED row (the new world's tip), never
    // the pre-rewind anchor — the new world survives the refold
    expect(h.rewinds).toEqual([{ settle: "u9" }]);
  });

  test("rows enqueued DURING the refold's await survive the tick (buffered, never discarded)", async () => {
    let rewinds = 0;
    const h = harness({
      owlTail: "t2",
      known: ["t1"],
      tail: facts([row("t1", "x"), row("u9", "t1")]),
      onRewind: async () => {
        rewinds += 1;
        // a streaming append lands while the refold awaits — it belongs to
        // the post-rewind world and must stay queued for the next tick
        h.proc.enqueue(ev("u10", true));
      },
    });
    h.proc.enqueue(ev("u9", true));
    await h.proc.flush();
    expect(rewinds).toBe(1);
    // the mid-refold row is still pending: the next tick (fed the file's
    // truth) verifies it — no silent loss
    h.setOwlTail("u9");
    h.setTail(facts([row("t1", "x"), row("u9", "t1"), row("u10", "u9")]));
    h.proc.enqueue(ev("u11", true));
    h.setTail(facts([row("t1", "x"), row("u9", "t1"), row("u10", "u9"), row("u11", "u10")]));
    await h.proc.flush();
    expect(rewinds).toBe(1);
    expect(h.patched.map((e) => e.uuid)).toContain("u10");
    expect(h.patched.map((e) => e.uuid)).toContain("u11");
  });

  test("a second clean turn after a mismatch rewind stays quiet (no cascade)", async () => {
    const h = harness({
      owlTail: "t2",
      known: ["t1"],
      tail: facts([row("t1", "x"), row("u9", "t1")]),
    });
    h.proc.enqueue(ev("u9", true));
    await h.proc.flush();
    expect(h.rewinds).toHaveLength(1);
    // the next turn chains from the new world's tip
    h.setOwlTail("u9");
    h.setTail(facts([row("t1", "x"), row("u9", "t1"), row("u10", "u9")]));
    h.proc.enqueue(ev("u10", true));
    await h.proc.flush();
    expect(h.rewinds).toHaveLength(1);
    expect(h.patched.at(-1)).toEqual({ uuid: "u10", parent: "u9" });
  });

  test("a size shrink alone logs but does not invent a rewind while the queue resolves cleanly", async () => {
    const h = harness({ owlTail: "t0", size: 5000, tail: facts([row("t0", "x"), row("u1", "t0")]) });
    h.proc.enqueue(ev("u1", true));
    h.size.value = 1000; // shrunk
    await h.proc.flush();
    expect(h.rewinds).toEqual([]);
    expect(h.patched).toEqual([{ uuid: "u1", parent: "t0" }]);
  });

  test("a queued row amputated between present ones: edges patch AND the refold fires onto the surviving tail", async () => {
    const h = harness({
      owlTail: "t0",
      tail: facts([row("t0", "x"), row("u1", "t0"), row("u3", "u1")]), // u2 amputated
    });
    h.proc.enqueue(ev("u1", true));
    h.proc.enqueue(ev("u2", true)); // dead-absent
    h.proc.enqueue(ev("u3", true));
    await h.proc.flush();
    expect(h.patched).toEqual([
      { uuid: "u1", parent: "t0" },
      { uuid: "u3", parent: "u1" },
    ]);
    expect(h.rewinds).toEqual([{ settle: "u3" }]);
  });

  test("a boundary anchor rebases the chain silently — never a verdict", async () => {
    const h = harness({
      owlTail: "gone",
      tail: facts([row("b1", null, true), row("u9", "b1")]),
    });
    h.proc.enqueue(ev("u9", true));
    await h.proc.flush();
    expect(h.rewinds).toEqual([]);
    expect(h.patched).toEqual([{ uuid: "u9", parent: "b1" }]);
  });

  test("a row parented at null (a fresh root after full amputation) settles at the root row", async () => {
    const h = harness({
      owlTail: "gone",
      tail: facts([row("u9", null)]),
    });
    h.proc.enqueue(ev("u9", true));
    await h.proc.flush();
    expect(h.rewinds).toEqual([{ settle: "u9" }]);
  });

  test("an anchor that resolves outside the window defers (never a wrong verdict)", async () => {
    const h = harness({ owlTail: "t2", tail: facts([row("u9", "ancient")]) });
    h.proc.enqueue(ev("u9", true));
    await h.proc.flush();
    expect(h.rewinds).toEqual([]);
    expect(h.patched).toEqual([]);
    expect(h.scheduled.length).toBeGreaterThanOrEqual(1);
  });
});

describe("live chain processor — the verdict deferral (a flush context can park the heavy refold)", () => {
  test("deferVerdicts parks the application: the hook returns fast, edges stay durable, the timer lane applies", async () => {
    const h = harness({
      owlTail: "t2",
      known: ["t1"],
      tail: facts([row("t1", "x"), row("u9", "t1")]),
    });
    h.proc.enqueue(ev("u9", true));
    await h.proc.flush({ deferVerdicts: true });
    // the file's edges are durable BEFORE any verdict — parked included
    expect(h.patched).toEqual([{ uuid: "u9", parent: "t1" }]);
    // the refold did NOT run inline (the hook budget stays free)
    expect(h.rewinds).toEqual([]);
    expect(h.proc.hasPendingRewind()).toBe(true);
    expect(h.logs.some((l) => l.includes("verdict parked"))).toBe(true);
    // the timer lane applies it
    h.fireScheduled();
    await new Promise((r) => setTimeout(r, 10));
    expect(h.rewinds).toEqual([{ settle: "u9" }]);
    expect(h.proc.hasPendingRewind()).toBe(false);
  });

  test("a flush arriving while the parked application is in flight waits it out", async () => {
    let releaseApply: (() => void) | undefined;
    const gate = new Promise<void>((r) => {
      releaseApply = r;
    });
    let applyStarted = false;
    const h = harness({
      owlTail: "t2",
      known: ["t1"],
      tail: facts([row("t1", "x"), row("u9", "t1")]),
      onRewind: async () => {
        applyStarted = true;
        await gate;
      },
    });
    h.proc.enqueue(ev("u9", true));
    await h.proc.flush({ deferVerdicts: true });
    expect(h.proc.hasPendingRewind()).toBe(true);
    // the timer lane starts applying and blocks mid-application
    h.fireScheduled();
    await new Promise((r) => setTimeout(r, 5));
    expect(applyStarted).toBe(true);
    // a flush that lands NOW must wait the application out — never a
    // concurrent verification tick against the mid-refold store
    let flushDone = false;
    const flushing = h.proc.flush().then(() => {
      flushDone = true;
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(flushDone).toBe(false);
    (releaseApply as (() => void) | undefined)?.();
    await flushing;
    expect(flushDone).toBe(true);
  });

  test("a later serve-class flush (deferVerdicts off) applies a parked verdict FIRST — the gate reads a folded store", async () => {
    const h = harness({
      owlTail: "t2",
      known: ["t1"],
      tail: facts([row("t1", "x"), row("u9", "t1")]),
    });
    h.proc.enqueue(ev("u9", true));
    await h.proc.flush({ deferVerdicts: true });
    expect(h.proc.hasPendingRewind()).toBe(true);
    await h.proc.flush();
    expect(h.rewinds).toEqual([{ settle: "u9" }]);
    expect(h.proc.hasPendingRewind()).toBe(false);
  });

  test("a parked verdict whose application fails on the lane re-arms — never silently dropped", async () => {
    let fails = 0;
    const h = harness({
      owlTail: "t2",
      known: ["t1"],
      tail: facts([row("t1", "x"), row("u9", "t1")]),
      onRewind: () => {
        fails += 1;
        if (fails === 1) throw new Error("refold exploded");
      },
    });
    h.proc.enqueue(ev("u9", true));
    await h.proc.flush({ deferVerdicts: true });
    h.fireScheduled(); // the first application attempt fails
    await new Promise((r) => setTimeout(r, 10));
    expect(fails).toBe(1);
    expect(h.proc.hasPendingRewind()).toBe(true);
    h.fireScheduled(); // the re-armed retry succeeds
    await new Promise((r) => setTimeout(r, 10));
    expect(fails).toBe(2);
    expect(h.rewinds).toEqual([{ settle: "u9" }, { settle: "u9" }]);
    expect(h.proc.hasPendingRewind()).toBe(false);
  });
});

describe("live chain processor — vi sanity", () => {
  test("flush with an empty queue touches nothing", async () => {
    const h = harness();
    await h.proc.flush();
    expect(h.patched).toEqual([]);
    expect(h.rewinds).toEqual([]);
    expect(h.scheduled).toEqual([]);
  });
});
