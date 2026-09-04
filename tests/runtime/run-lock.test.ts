// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import { beforeEach, describe, expect, it } from "vitest";
import {
  _resetRunLock,
  abortAndAwaitIdle,
  abortInFlight,
  acquireForCompaction,
  acquireOrSkip,
  current,
  inFlight,
  type RunHandle,
} from "../../src/runtime/run-lock.js";

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
