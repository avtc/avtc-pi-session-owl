// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// The KEYED run-lock — the host port of the vendored runtime/run-lock.ts
// (pi's module singleton is safe only because pi runs one session per
// process; one host process serves many conversations, each with its own
// lock). Semantics are pi's verbatim per key: at most one maintenance run
// per conversation; background triggers that collide SKIP (the MAP arms the
// settle-rearm, fired once at release); compaction is EXCLUSIVE (aborts the in-flight run via
// its OWN controller, awaits the release, then acquires unconditionally).
import { describe, expect, test } from "vitest";
import {
  _resetRunLocks,
  abortActiveFor,
  abortAllForSessionEnd,
  abortAndAwaitIdle,
  abortInFlight,
  acquireForCompaction,
  acquireOrSkip,
  awaitIdle,
  current,
  inFlight,
  pruneIdleLocks,
} from "../../host/triggers/run-locks.js";

const settle = (): Promise<void> => new Promise<void>((r) => setImmediate(r));

describe("run-locks — keyed per conversation", () => {
  test("acquireOrSkip: idle acquires, a colliding trigger on the SAME key skips, another conversation is unaffected", () => {
    _resetRunLocks();
    const h1 = acquireOrSkip("s1", "observe");
    expect(h1).not.toBeNull();
    expect(acquireOrSkip("s1", "build")).toBeNull(); // SKIP — batches on the next run
    const h2 = acquireOrSkip("s2", "observe");
    expect(h2).not.toBeNull(); // another conversation's lock is independent
    expect(inFlight("s1")).toBe(true);
    expect(current("s1")).toBe("observe");
    h1?.release();
    h2?.release();
    expect(inFlight("s1")).toBe(false);
    expect(current("s1")).toBeNull();
  });

  test("release is idempotent and re-acquisition succeeds after release", () => {
    _resetRunLocks();
    const h = acquireOrSkip("s1", "build");
    expect(h).not.toBeNull();
    h?.release();
    h?.release(); // the finally's double-release is safe
    expect(acquireOrSkip("s1", "select")).not.toBeNull();
  });

  test("setStage relabels mid-run and release still clears the lock after it", () => {
    _resetRunLocks();
    const h = acquireOrSkip("s1", "observe");
    expect(current("s1")).toBe("observe");
    h?.setStage("build");
    expect(current("s1")).toBe("build");
    h?.release(); // the relabeled run is still the active one — release clears it
    expect(inFlight("s1")).toBe(false);
    expect(acquireOrSkip("s1", "observe")).not.toBeNull();
  });

  test("abortInFlight aborts the run's OWN controller; the lock itself stays held until the run releases", () => {
    _resetRunLocks();
    const h = acquireOrSkip("s1", "observe");
    let aborted = false;
    h?.abortController.signal.addEventListener("abort", () => {
      aborted = true;
    });
    abortInFlight("s1");
    expect(aborted).toBe(true);
    expect(inFlight("s1")).toBe(true); // not released by the abort itself
    h?.release();
  });

  test("abortInFlight on an idle key is a no-op", () => {
    _resetRunLocks();
    expect(() => abortInFlight("s-never")).not.toThrow();
  });

  test("abortAndAwaitIdle resolves only after the run actually released; every idle waiter wakes", async () => {
    _resetRunLocks();
    const h = acquireOrSkip("s1", "observe");
    const waiter1 = abortAndAwaitIdle("s1");
    const waiter2 = abortAndAwaitIdle("s1"); // two concurrent waiters — both must wake
    let waiter1Done = false;
    void waiter1.then(() => {
      waiter1Done = true;
    });
    await settle();
    expect(h?.abortController.signal.aborted).toBe(true); // aborted first
    expect(waiter1Done).toBe(false); // still held — the run has not released
    h?.release();
    await waiter1;
    await waiter2;
    expect(waiter1Done).toBe(true);
    expect(inFlight("s1")).toBe(false);
  });

  test("acquireForCompaction never skips: aborts, awaits release, then acquires unconditionally", async () => {
    _resetRunLocks();
    const h = acquireOrSkip("s1", "observe");
    const acquiring = acquireForCompaction("s1");
    await settle();
    expect(h?.abortController.signal.aborted).toBe(true);
    expect(inFlight("s1")).toBe(true); // still the old run until it releases
    h?.release();
    const compaction = await acquiring;
    expect(inFlight("s1")).toBe(true);
    expect(current("s1")).toBe("select"); // pi: compaction runs observe/build/select under one acquire
    compaction.release();
  });

  test("acquireForCompaction on an idle key acquires immediately", async () => {
    _resetRunLocks();
    const compaction = await acquireForCompaction("s1");
    expect(current("s1")).toBe("select");
    compaction.release();
  });
});

describe("abortAllForSessionEnd — the user's exit cancels every live gate", () => {
  test("aborts every active run's own controller across keys; idle keys untouched", async () => {
    _resetRunLocks();
    const main = await acquireForCompaction("exit-main");
    const sub = await acquireForCompaction("exit-main|sub1");
    abortAllForSessionEnd();
    expect(main.abortController.signal.aborted).toBe(true);
    expect(sub.abortController.signal.aborted).toBe(true);
    expect(() => abortAllForSessionEnd()).not.toThrow(); // idempotent
    main.release();
    sub.release();
  });
});

describe("pruneIdleLocks — production teardown", () => {
  test("drops idle entries, keeps in-flight ones", () => {
    _resetRunLocks();
    const idle = acquireOrSkip("s-idle", "observe");
    expect(idle).not.toBeNull();
    const busy = acquireOrSkip("s-busy", "observe");
    expect(busy).not.toBeNull();
    idle?.release();
    const pruned = pruneIdleLocks();
    expect(pruned).toBe(1);
    expect(inFlight("s-idle")).toBe(false);
    expect(current("s-busy")).toBe("observe"); // untouched
    busy?.release();
  });
});

describe("run-locks — awaitIdle (handoff eviction waits for a draining run)", () => {
  test("awaitIdle resolves immediately for an idle or never-seen key", async () => {
    _resetRunLocks();
    let done = false;
    void awaitIdle("never-ran").then(() => {
      done = true;
    });
    await settle();
    expect(done).toBe(true);
  });
  test("awaitIdle waits for the in-flight run's release, then resolves", async () => {
    _resetRunLocks();
    const held = acquireOrSkip("busy-idle", "observe");
    expect(held).not.toBeNull();
    let done = false;
    void awaitIdle("busy-idle").then(() => {
      done = true;
    });
    await settle();
    expect(done).toBe(false); // still draining — the eviction must wait
    held?.release();
    await settle();
    expect(done).toBe(true); // released ⇒ the deferred eviction proceeds
  });
});

describe("abortActiveFor — the user-cancel wire (Esc aborts one conversation's gate)", () => {
  test("aborts ONLY the named key's active controller; other keys run on", async () => {
    _resetRunLocks();
    const a = await acquireForCompaction("conv-target");
    const b = acquireOrSkip("conv-other", "observe");
    expect(b).not.toBeNull(); // the observe lock holds alongside the gate
    abortActiveFor("conv-target");
    expect(a.abortController.signal.aborted).toBe(true);
    expect((b as NonNullable<typeof b>).abortController.signal.aborted).toBe(false);
    a.release();
    (b as NonNullable<typeof b>).release();
  });

  test("a key with no active run is a no-op (never throws)", () => {
    _resetRunLocks();
    expect(() => abortActiveFor("conv-none")).not.toThrow();
  });
});
