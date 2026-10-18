// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// The checkpoint service: assembles reconcile deps for a conversation key
// from the session storage + a registered prepared context, keeping every
// `$` literal OUT of this module (the register wiring owns those). One
// tripwire instance serves every key (keys isolate their series inside).

import { beforeEach, describe, expect, test, vi } from "vitest";
import type { Fingerprint } from "../../host/rewind/canonical-check.js";
import { checkpointService } from "../../host/rewind/checkpoint-service.js";
import { createMemoryFs } from "../../host/storage/fs-adapter.js";
import { LedgerWriter } from "../../host/storage/ledger.js";
import { type MirroredRow, MirrorWriter } from "../../host/storage/mirror.js";
import { prepareStoreContext } from "../../host/storage/store-context.js";

const mem = createMemoryFs();
const DIR = "/sess";

function row(uuid: string, parentUuid: string | null, content: unknown[] = []): MirroredRow {
  return { uuid, parentUuid, row: { uuid, parentUuid, message: { content } } };
}

async function makeStorage(key: string) {
  const ledger = new LedgerWriter(mem.adapter, DIR, "p1", () => 1);
  const mirror = new MirrorWriter(mem.adapter, DIR, "p1");
  return { key, dir: DIR, fs: mem.adapter, mirror, ledger, producerId: "p1" };
}

beforeEach(() => {
  mem.files.clear();
  checkpointService().reset();
});

describe("checkpointService — the per-key dep assembly", () => {
  test("knownPath serves the mirror branch tip-LAST with fingerprints off row content", async () => {
    const storage = await makeStorage("s1");
    storage.mirror.bufferRow(row("r1", null, [{ type: "tool_use", id: "t1", name: "x", input: {} }]));
    storage.mirror.bufferRow(row("r2", "r1", [{ type: "text", text: "hello" }]));
    const deps = checkpointService().buildDeps("s1", storage, {
      apiFingerprints: async () => [],
      logLine: () => {},
    });
    const path = deps.knownPath();
    expect(path.map((r) => r.uuid)).toEqual(["r1", "r2"]);
    expect(path[0].f.toolUseIds).toEqual(["t1"]);
    expect(path[1].f.textSig).toBe("hello");
    expect(deps.knownTip()).toBe("r2");
  });

  test("knownPath fingerprints cache per row (identity-invalidated) — no per-turn recompute", async () => {
    const storage = await makeStorage("s-cached");
    storage.mirror.bufferRow(row("c1", null, [{ type: "text", text: "one" }]));
    storage.mirror.bufferRow(row("c2", "c1", [{ type: "text", text: "two" }]));
    const svc = checkpointService();
    const deps = svc.buildDeps("s-cached", storage, {
      apiFingerprints: async () => [],
      logLine: () => {},
    });
    deps.knownPath();
    deps.knownPath(); // the second call (alignCanonical + knownUuids double-dip class)
    expect(svc._fpComputesForTest()).toBe(2); // computed once per row, not per call
    storage.mirror.bufferRow(row("c3", "c2", [{ type: "text", text: "three" }]));
    deps.knownPath();
    expect(svc._fpComputesForTest()).toBe(3); // only the NEW row pays
    // a REPLACED row (same uuid, fresh object) recomputes — re-mirror safe
    storage.mirror.bufferRow(row("c3", "c2", [{ type: "text", text: "three-changed" }]));
    deps.knownPath();
    expect(svc._fpComputesForTest()).toBe(4);
  });

  test("one tripwire instance serves all keys (series isolate inside)", () => {
    const t = checkpointService().tripwires();
    expect(t).toBe(checkpointService().tripwires());
  });

  test("registerPrepared: refold refreshes THE registered context (the core's own object)", async () => {
    const storage = await makeStorage("s1");
    storage.ledger.append("observation", { coversUpToId: "r1" }, "r1");
    await storage.ledger.flush();
    const prepared = await prepareStoreContext(mem.adapter, DIR, storage.ledger, storage.mirror);
    checkpointService().registerPrepared("s1", prepared);
    const deps = checkpointService().buildDeps("s1", storage, {
      apiFingerprints: async () => [],
      logLine: () => {},
    });
    const { quarantined } = await deps.refold(
      new Set(storage.mirror.arrivalOrder()),
      storage.mirror.arrivalOrder(),
      new Set(),
    );
    expect(quarantined).toBe(0);
    // the SAME instance is exposed back to the wiring
    expect(checkpointService().preparedFor("s1")).toBe(prepared);
    expect(checkpointService().preparedFor("other")).toBeNull();
  });

  test("without a registered prepared context, refold still folds + counts the quarantine (ephemeral)", async () => {
    const storage = await makeStorage("s1");
    storage.mirror.bufferRow(row("r1", null));
    storage.ledger.append("CHECK", {}, "r1");
    storage.ledger.append("observation", { coversUpToId: "r1" }, "r1");
    await storage.ledger.flush();
    const deps = checkpointService().buildDeps("s1", storage, {
      apiFingerprints: async () => [],
      logLine: () => {},
    });
    const { quarantined } = await deps.refold(new Set(["r1"]), ["r1"], new Set());
    expect(quarantined).toBe(1); // the post-CHECK observation
  });

  test("appendCheck/appendEdges route into the ledger; the log line routes to the sink", async () => {
    const storage = await makeStorage("s1");
    const lines: string[] = [];
    const deps = checkpointService().buildDeps("s1", storage, {
      apiFingerprints: async () => [],
      logLine: (l) => lines.push(l),
    });
    deps.appendCheck("r9");
    deps.appendEdges?.([{ uuid: "r9", parent: "r1", exact: true }], "r9");
    deps.log("line");
    // appendCheck/appendEdges flush immediately (boundary unit) — the kinds
    // land on disk, not in the live buffer
    await vi.waitFor(() => {
      const text = [...mem.files.values()].join("\n");
      expect(text).toContain('"CHECK"');
      expect(text).toContain('"lineage"');
    });
    expect(lines).toEqual(["line"]);
  });

  test("appendCheck and appendEdges persist immediately — the boundary product never rides an unrelated flush", async () => {
    const storage = await makeStorage("s-imm");
    const deps = checkpointService().buildDeps("s-imm", storage, {
      apiFingerprints: async () => [],
      logLine: () => {},
    });
    deps.appendCheck("r5");
    // no other activity flushes for us: the CHECK must reach a file by itself
    await vi.waitFor(() => {
      const landed = [...mem.files.values()].filter((t) => t.includes('"CHECK"'));
      expect(landed).toHaveLength(1);
    });
    deps.appendEdges?.([{ uuid: "r5", parent: "r1", exact: true }], "r5");
    await vi.waitFor(() => {
      const landed = [...mem.files.values()].filter((t) => t.includes('"lineage"'));
      expect(landed).toHaveLength(1);
    });
  });

  test("abortAndAwaitInFlight aborts the key's in-flight run and awaits release", async () => {
    const storage = await makeStorage("s1");
    const deps = checkpointService().buildDeps("s1", storage, {
      apiFingerprints: async () => [],
      logLine: () => {},
    });
    // an in-flight "run" the poll waits for
    let released = false;
    const fakeLocks = {
      inFlight: (key: string) => key === "s1" && !released,
      abort: (key: string) => {
        expect(key).toBe("s1");
        setTimeout(() => {
          released = true;
        }, 10);
      },
      waitMs: 5,
    };
    checkpointService().installRunLocksForTest(fakeLocks);
    await deps.abortAndAwaitInFlight();
    expect(released).toBe(true);
  });

  test("apiFingerprints passes through (the wiring's $ literal lives above)", async () => {
    const storage = await makeStorage("s1");
    const fps: Fingerprint[] = [{ toolUseIds: ["t1"], toolResultIds: [], textSig: "" }];
    const deps = checkpointService().buildDeps("s1", storage, {
      apiFingerprints: async () => fps,
      logLine: () => {},
    });
    await expect(deps.apiMessages()).resolves.toBe(fps);
  });
});
