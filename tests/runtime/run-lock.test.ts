// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  _resetRunLock,
  abortAndAwaitIdle,
  abortInFlight,
  acquireForCompaction,
  acquireForExtract,
  acquireOrSkip,
  armRearmOnRelease,
  current,
  inFlight,
  type RunHandle,
} from "../../src/runtime/run-lock.js";
import { activateConversation, resetConversationStates } from "../../src/store/graph-store.js";

describe("run-lock (single run-lock — at most one stage active at a time)", () => {
  // Each test starts from a clean idle lock (module singleton shared across tests
  // under isolate:false — reset explicitly so ordering is robust).
  beforeEach(() => _resetRunLock());

  it("acquireOrSkip returns a handle when idle", () => {
    const handle = acquireOrSkip("observe");
    expect(handle).not.toBeNull();
    expect(inFlight()).toBe(true);
    expect(current()).toBe("observe");
  });

  it("acquireOrSkip returns null (SKIP) when a run is already in flight", () => {
    const first = acquireOrSkip("observe");
    expect(first).not.toBeNull();
    const second = acquireOrSkip("build");
    expect(second).toBeNull();
    // the first run is still the active one
    expect(current()).toBe("observe");
  });

  it("acquireForExtract takes stage extract synchronously when idle (same-tick skip)", () => {
    const handle = acquireForExtract();
    expect(handle).not.toBeNull();
    expect(current()).toBe("extract");
    // the capture's trailing turn_end trigger in the same tick skips
    expect(acquireOrSkip("observe")).toBeNull();
    handle?.release();
    expect(current()).toBeNull();
    expect(acquireOrSkip("observe")).not.toBeNull();
  });

  it("acquireForExtract returns null under an existing holder — no steal, no wait", () => {
    const holder = acquireOrSkip("observe");
    expect(holder).not.toBeNull();
    expect(acquireForExtract()).toBeNull();
    // the holder keeps the lock (the extraction runs under its authority)
    expect(current()).toBe("observe");
    holder?.release();
    expect(current()).toBeNull();
    expect(acquireForExtract()).not.toBeNull();
    expect(current()).toBe("extract");
  });

  it("release allows a new run to acquire", () => {
    const handle = acquireOrSkip("observe");
    expect(handle).not.toBeNull();
    handle?.release();
    expect(inFlight()).toBe(false);
    expect(current()).toBeNull();
    const next = acquireOrSkip("build");
    expect(next).not.toBeNull();
    expect(current()).toBe("build");
  });

  it("abortAndAwaitIdle resolves immediately when idle (no run to stop)", async () => {
    await abortAndAwaitIdle();
    expect(inFlight()).toBe(false);
  });

  it("abortAndAwaitIdle aborts the in-flight run and resolves only after it releases", async () => {
    const handle = acquireOrSkip("observe") as RunHandle;
    let released = false;
    const done = abortAndAwaitIdle();
    // aborted immediately, but the lock is still held until the run unwinds
    expect(handle.abortController.signal.aborted).toBe(true);
    expect(inFlight()).toBe(true);
    handle.release(); // the aborted run's finally
    released = true;
    await done;
    expect(released).toBe(true);
    expect(inFlight()).toBe(false);
  });

  it("wakes EVERY idle waiter on release — compaction and tree navigation waiting concurrently never lose one", async () => {
    const handle = acquireOrSkip("observe") as RunHandle;
    // a compaction AND a /tree branch navigation both wait for the same run to
    // unwind (a single-slot waiter would drop one of them — it would hang forever)
    const compactionDone = acquireForCompaction();
    const treeDone = abortAndAwaitIdle();
    handle.release(); // the aborted run's finally
    const compactionHandle = await compactionDone;
    await treeDone;
    // the compaction acquired the freed lock; releasing it ends the test idle
    expect(inFlight()).toBe(true);
    compactionHandle.release();
    expect(inFlight()).toBe(false);
  });

  it("each handle owns its own AbortController", () => {
    const handle = acquireOrSkip("observe") as RunHandle;
    expect(handle.abortController).toBeInstanceOf(AbortController);
    expect(handle.abortController.signal.aborted).toBe(false);
  });

  it("abortInFlight aborts the active handle's controller", () => {
    const handle = acquireOrSkip("observe") as RunHandle;
    expect(handle.abortController.signal.aborted).toBe(false);
    abortInFlight();
    expect(handle.abortController.signal.aborted).toBe(true);
    // abort does NOT release — the run still owns the lock until it releases
    expect(inFlight()).toBe(true);
    handle.release();
  });

  it("abortInFlight is a no-op when nothing is in flight", () => {
    expect(inFlight()).toBe(false);
    expect(() => abortInFlight()).not.toThrow();
  });

  it("release is idempotent (safe to call from a finally twice)", () => {
    const handle = acquireOrSkip("observe") as RunHandle;
    handle.release();
    expect(inFlight()).toBe(false);
    expect(() => handle.release()).not.toThrow(); // second release is a no-op
    expect(current()).toBeNull();
    // a new run can still acquire after a double-release
    const next = acquireOrSkip("build");
    expect(next).not.toBeNull();
  });

  it("abort then release: release still frees the lock after an abort", () => {
    const handle = acquireOrSkip("observe") as RunHandle;
    abortInFlight();
    expect(handle.abortController.signal.aborted).toBe(true);
    expect(inFlight()).toBe(true); // abort does not release
    handle.release();
    expect(inFlight()).toBe(false); // release frees it
  });

  it("setStage relabels the active stage mid-run (a chained turn_end run)", () => {
    const handle = acquireOrSkip("observe") as RunHandle;
    expect(current()).toBe("observe");
    handle.setStage("build");
    expect(current()).toBe("build");
    handle.setStage("select");
    expect(current()).toBe("select");
    handle.release();
  });

  it("setStage is a no-op once released", () => {
    const handle = acquireOrSkip("observe") as RunHandle;
    handle.release();
    handle.setStage("build"); // already released — does not resurrect
    expect(current()).toBeNull();
  });

  it("acquireForCompaction acquires immediately when nothing is in flight", async () => {
    const handle = await acquireForCompaction();
    expect(handle).toBeDefined();
    expect(inFlight()).toBe(true);
    handle.release();
  });

  it("acquireForCompaction awaits the in-flight run's release BEFORE resolving", async () => {
    // A background run is in flight.
    const bg = acquireOrSkip("observe") as RunHandle;
    let released = false;

    // acquireForCompaction aborts the background run first...
    const compactionPromise = acquireForCompaction();

    // ...the run is aborted but the lock is NOT released yet (release is in the
    // run's finally, which we simulate here). The compaction acquire must NOT
    // have resolved before the run actually releases.
    const raced = await Promise.race([
      compactionPromise.then(() => "resolved"),
      new Promise<string>((resolve) => setTimeout(() => resolve("pending"), 20)),
    ]);
    expect(raced).toBe("pending"); // still waiting — release() not called yet
    expect(bg.abortController.signal.aborted).toBe(true); // aborted at entry

    // Now the background run reaches its release point.
    bg.release();
    released = true;

    const handle = await compactionPromise; // resolves AFTER release
    expect(released).toBe(true);
    expect(inFlight()).toBe(true);
    expect(current()).toBe("select"); // compaction stage label
    handle.release();
  });

  it("acquireForCompaction is exclusive — never skips (always acquires)", async () => {
    const compactionHandle = await acquireForCompaction();
    // a background acquireOrSkip while compaction holds must skip
    const skipped = acquireOrSkip("observe");
    expect(skipped).toBeNull();
    compactionHandle.release();
  });
});

// A boundary evaluation that collides with an in-flight chain arms ONE
// coalesced re-entry; the holder's successful release fires it outside the
// release call (microtask), and an aborted holder drops it.
describe("run-lock settle-rearm (the skipped gap re-evaluates on release)", () => {
  beforeEach(() => _resetRunLock());

  const tick = () => new Promise<void>((r) => setTimeout(r, 0));

  it("fires the armed re-entry exactly once, AFTER the lock cleared — never inside release", async () => {
    const handle = acquireOrSkip("observe");
    expect(handle).not.toBeNull();
    const calls: boolean[] = [];
    armRearmOnRelease(() => {
      calls.push(inFlight()); // the state the re-entry observes
    });

    handle?.release();
    expect(calls).toEqual([]); // dispatch is deferred past this call
    expect(inFlight()).toBe(false);

    await tick();
    expect(calls).toEqual([false]); // once, with the lock already free

    handle?.release(); // idempotent release: no second dispatch
    await tick();
    expect(calls).toEqual([false]);
  });

  it("a later arm replaces the earlier one (coalesced, latest gap wins)", async () => {
    const handle = acquireOrSkip("observe");
    const fired: string[] = [];
    armRearmOnRelease(() => fired.push("first"));
    armRearmOnRelease(() => fired.push("second"));

    handle?.release();
    await tick();
    expect(fired).toEqual(["second"]);
  });

  it("an ABORTED holder's release drops the armed re-entry", async () => {
    const handle = acquireOrSkip("observe");
    const vi2 = vi.fn();
    armRearmOnRelease(vi2);

    abortInFlight(); // the takeover aborts the holder…
    handle?.release(); // …the run unwinds and releases from its finally
    await tick();

    expect(vi2).not.toHaveBeenCalled();
    expect(inFlight()).toBe(false);
  });

  it("dispatch works in a runtime without a queueMicrotask global", async () => {
    // some worker scopes lack the identifier; the dispatch must not depend on
    // it (Promise-based microtask only)
    vi.stubGlobal("queueMicrotask", undefined);
    try {
      const handle = acquireOrSkip("observe");
      let fired = false;
      armRearmOnRelease(() => {
        fired = true;
      });
      handle?.release();
      await tick();
      expect(fired).toBe(true);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("run-lock — per-conversation partitions (resident conversation states)", () => {
  beforeEach(() => {
    _resetRunLock();
    resetConversationStates();
    activateConversation("default-again"); // settle the ambient key (returns to default in teardown)
  });

  it("locks partition by conversation: another key holds its own run in parallel", () => {
    activateConversation("rkA");
    const hA = acquireOrSkip("observe");
    expect(hA).not.toBeNull();
    expect(acquireOrSkip("build")).toBeNull(); // same key: SKIP
    expect(acquireForExtract()).toBeNull(); // same key: no steal

    activateConversation("rkB");
    const hB = acquireOrSkip("observe");
    expect(hB).not.toBeNull(); // RED today: one global lock ⇒ null
    expect(acquireOrSkip("select")).toBeNull(); // B is also serialized with itself

    hA?.release();
    activateConversation("rkA");
    expect(acquireOrSkip("build")).not.toBeNull(); // A idle again after its own release
    resetConversationStates();
  });

  it("each key's armed gap fires on ITS OWN release (never a foreign key's)", async () => {
    const fired: string[] = [];
    activateConversation("rmA");
    const hA = acquireOrSkip("observe");
    armRearmOnRelease(() => fired.push("A"));

    activateConversation("rmB");
    const hB = acquireOrSkip("observe");
    armRearmOnRelease(() => fired.push("B"));

    hB?.release(); // owns only B's arm
    await Promise.resolve().then(() => undefined);
    await Promise.resolve().then(() => undefined);
    expect(fired).toEqual(["B"]); // A's arm must NOT ride B's release

    hA?.release(); // and A's own release fires A's arm
    await Promise.resolve().then(() => undefined);
    await Promise.resolve().then(() => undefined);
    expect(fired).toEqual(["B", "A"]);
    resetConversationStates();
  });
});
