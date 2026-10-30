// SPDX-License-Identifier: MIT;
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>
//
// The live chain processor: session.append events queue zero-latency; a
// deferred tick (≥1 s, torn-tail backoff, eager at turn.complete) reads the
// transcript tail, feeds the FILE's true parent edges to the mirror
// (patchEdges), and detects rewinds by resolving each queued row's anchor
// (its parent chain, walked through uncaptured ceremony rows) against
// owl's expected chain — a mismatch names the settle point and hands the
// refold to the rewind seam. All seams injected; the engine wiring
// spells the $ calls literally.

import { describe, expect, test, vi } from "vitest";
import { LiveChainProcessor } from "../../host/rewind/live-chain.js";
import type { TailFacts, TailRow } from "../../host/rewind/tail-read.js";

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
  size: { value: number | null };
  setTail: (f: TailFacts | null) => void;
  setOwlTail: (t: string | null) => void;
}

function harness(init?: {
  owlTail?: string | null;
  size?: number | null;
  tail?: TailFacts | null;
  known?: string[];
}): Harness {
  const patched: Array<{ uuid: string; parent: string | null }> = [];
  const rewinds: Array<{ settle: string | null }> = [];
  const scheduled: number[] = [];
  const size = { value: init?.size ?? 1000 };
  let tail: TailFacts | null = init?.tail ?? null;
  let owlTail: string | null = init?.owlTail ?? null;
  const known = new Set(init?.known ?? []);
  const proc = new LiveChainProcessor({
    statSize: async () => size.value,
    readTail: async () => tail,
    owlTailExcluding: () => owlTail,
    isKnownRow: (uuid) => known.has(uuid),
    patchEdges: (edges) => {
      for (const e of edges) patched.push({ uuid: e.uuid, parent: e.parent });
    },
    onRewind: (v) => {
      rewinds.push(v);
    },
    schedule: (ms, _fn) => {
      scheduled.push(ms);
      return () => {};
    },
    log: () => {},
  });
  return {
    proc,
    patched,
    rewinds,
    scheduled,
    size,
    setTail: (f) => {
      tail = f;
    },
    setOwlTail: (t) => {
      owlTail = t;
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
  test("the first enqueue arms the deferred tick; further enqueues do not stack timers", () => {
    const h = harness();
    h.proc.enqueue(ev("u1", true));
    h.proc.enqueue(ev("u2", true));
    expect(h.scheduled).toEqual([1000]);
  });
});

describe("live chain processor — the normal tick", () => {
  test("file parents flow to patchEdges; the anchor resolution walks through uncaptured ceremony", async () => {
    const h = harness({ owlTail: "t0", size: 100, tail: facts([row("t0", "x"), row("j1", "t0"), row("u1", "j1")]) });
    h.proc.enqueue(ev("j1", false));
    h.proc.enqueue(ev("u1", true));
    await h.proc.flush();
    // both queued rows' FILE parents are handed to the mirror verbatim
    expect(h.patched).toEqual([
      { uuid: "j1", parent: "t0" },
      { uuid: "u1", parent: "j1" },
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
});

describe("live chain processor — the torn and missing tails", () => {
  test("a torn tail backs off (longer delay) and keeps the queue", async () => {
    const h = harness({ owlTail: "t0", tail: facts([row("t0", "x")], true) });
    h.proc.enqueue(ev("u1", true));
    await h.proc.flush();
    expect(h.patched).toEqual([]);
    expect(h.scheduled).toContain(2500);
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

describe("live chain processor — rewind detection", () => {
  test("an anchor behind owl's tail is a rewind: no patch, settle named, queue drained after the refold", async () => {
    const h = harness({
      owlTail: "t2",
      known: ["t1"],
      tail: facts([row("t1", "x"), row("u9", "t1")]), // t2 amputated away
    });
    h.proc.enqueue(ev("u9", true));
    await h.proc.flush();
    expect(h.patched).toEqual([]);
    expect(h.rewinds).toEqual([{ settle: "t1" }]);
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

  test("a settle at a boundary row keeps it (drop everything after it)", async () => {
    const h = harness({
      owlTail: "gone",
      tail: facts([row("b1", null, true), row("u9", "b1")]),
    });
    h.proc.enqueue(ev("u9", true));
    await h.proc.flush();
    expect(h.rewinds).toEqual([{ settle: "b1" }]);
  });

  test("a row parented at null (a fresh root after full amputation) settles at null", async () => {
    const h = harness({
      owlTail: "gone",
      tail: facts([row("u9", null)]),
    });
    h.proc.enqueue(ev("u9", true));
    await h.proc.flush();
    expect(h.rewinds).toEqual([{ settle: null }]);
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

describe("live chain processor — vi sanity", () => {
  test("flush with an empty queue touches nothing", async () => {
    const h = harness();
    await h.proc.flush();
    expect(h.patched).toEqual([]);
    expect(h.rewinds).toEqual([]);
    expect(h.scheduled).toEqual([]);
    expect(vi.fn()).toBeDefined();
  });
});
