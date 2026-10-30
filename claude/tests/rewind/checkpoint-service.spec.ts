// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// The rewind service: assembles the live chain's deps for a conversation
// key from the session storage + a registered prepared context, keeping
// every `$` literal OUT of this module (the register wiring owns those).
// One tripwire instance serves every key (keys isolate their series
// inside).

import { beforeEach, describe, expect, test, vi } from "vitest";
import { checkpointService } from "../../host/rewind/checkpoint-service.js";
import { createMemoryFs } from "../../host/storage/fs-adapter.js";
import { LedgerWriter } from "../../host/storage/ledger.js";
import { type MirroredRow, MirrorWriter } from "../../host/storage/mirror.js";

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
  test("knownPath serves the mirror branch tip-LAST (uuid + stored timestamp)", async () => {
    const storage = await makeStorage("s1");
    storage.mirror.bufferRow(row("r1", null, [{ type: "tool_use", id: "t1", name: "x", input: {} }]));
    storage.mirror.bufferRow(
      (() => {
        const r = row("r2", "r1", [{ type: "text", text: "hello" }]);
        (r.row as { timestamp?: unknown }).timestamp = "2026-10-30T00:00:00.000Z";
        return r;
      })(),
    );
    const deps = checkpointService().buildDeps("s1", storage, { logLine: () => {} });
    const path = deps.knownPath();
    expect(path.map((r) => r.uuid)).toEqual(["r1", "r2"]);
    expect(typeof path[1]?.ts).toBe("number");
    expect(deps.knownTip()).toBe("r2");
  });

  test("dead rows are excluded from knownPath and knownTailExcluding", async () => {
    const storage = await makeStorage("s1");
    storage.mirror.bufferRow(row("r1", null));
    storage.mirror.bufferRow(row("r2", "r1"));
    storage.mirror.bufferRow(row("r3", "r2"));
    checkpointService().noteDivergenceDead("s1", ["r2"]);
    const deps = checkpointService().buildDeps("s1", storage, { logLine: () => {} });
    expect(deps.knownPath().map((r) => r.uuid)).toEqual(["r1", "r3"]);
    expect(deps.knownTailExcluding?.(new Set(["r3"]))).toBe("r1");
    expect(deps.knownTailExcluding?.(new Set(["r1", "r3"]))).toBeNull();
  });

  test("refold without a registered context applies an ephemeral fold", async () => {
    const storage = await makeStorage("s1");
    storage.mirror.bufferRow(row("r1", null));
    storage.mirror.bufferRow(row("r2", "r1"));
    await storage.mirror.flush();
    const deps = checkpointService().buildDeps("s1", storage, { logLine: () => {} });
    const { quarantined } = await deps.refold(new Set(["r1"]), ["r1"], new Set());
    expect(quarantined).toBe(0); // nothing observed yet — nothing to drop
  });

  test("appendEdges routes into the ledger and true-ups the mirror; the log line routes to the sink", async () => {
    const storage = await makeStorage("s1");
    const lines: string[] = [];
    const deps = checkpointService().buildDeps("s1", storage, {
      logLine: (l) => lines.push(l),
    });
    storage.mirror.bufferRow(row("r1", null));
    storage.mirror.bufferRow(row("r9", "r-wrong"));
    deps.appendEdges?.([{ uuid: "r9", parent: "r1", exact: true }], "r9");
    deps.log("line");
    await vi.waitFor(() => {
      const text = [...mem.files.values()].join("\n");
      expect(text).toContain('"lineage"');
    });
    expect(storage.mirror.rowByUuid("r9")?.parentUuid).toBe("r1");
    expect(lines).toEqual(["line"]);
  });

  test("abortAndAwaitInFlight aborts the key's in-flight run and awaits release", async () => {
    const storage = await makeStorage("s1");
    const deps = checkpointService().buildDeps("s1", storage, { logLine: () => {} });
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

  test("the tripwire instance is shared per process", () => {
    expect(checkpointService().tripwires()).toBe(checkpointService().tripwires());
  });
});
