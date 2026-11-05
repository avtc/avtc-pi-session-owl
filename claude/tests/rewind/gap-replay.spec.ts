// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// Scratch replay (manual, real store copy at D:/temp/rwprobe-store): the
// verdict's exact adjudication chain — resolveLiveSet → knownPath → the
// boundary cap — over a real gap-bearing store, for the real-rewind shape
// (a settle a few rows from the tip). Decides whether a REAL rewind on this
// store mass-adjudicates rows dead through lineage gaps.
import { existsSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { resolveLiveSet } from "../../host/rewind/checkpoint-service.js";
import { capDeadAtOldestLiveKnown } from "../../host/rewind/live-rewind.js";
import { foldLedger, LedgerWriter } from "../../host/storage/ledger.js";
import { MirrorWriter } from "../../host/storage/mirror.js";

const STORE_DIR = "D:/temp/rwprobe-store/16f51f7d-bbc8-49da-9854-016ea0b59dc0";

function nodeAdapter() {
  // the spec runs under vitest (node) — the memory adapter can't read a real
  // dir, so build a thin FsAdapter over the node fs
  const { readFileSync, readdirSync, statSync, writeFileSync } = require("node:fs") as typeof import("node:fs");
  return {
    readText: async (p: string) => readFileSync(p, "utf8"),
    writeText: async (p: string, t: string) => writeFileSync(p, t, "utf8"),
    listDir: async (p: string) => readdirSync(p) as unknown as string[],
    stat: async (p: string) => {
      try {
        return { size: statSync(p).size, mtimeMs: statSync(p).mtimeMs };
      } catch {
        return null;
      }
    },
    exists: async (p: string) => existsSync(p),
  };
}

describe.skipIf(!existsSync(STORE_DIR))("gap replay — the verdict's adjudication on the real store copy", () => {
  test("a real-rewind settle near the tip: live set, dead set, and the cap", async () => {
    const fs = nodeAdapter();
    const mirror = new MirrorWriter(fs, STORE_DIR, "replay");
    const ledger = new LedgerWriter(fs, STORE_DIR, "replay");
    const storage = {
      key: "replay",
      dir: STORE_DIR,
      fs,
      mirror,
      ledger,
      producerId: "replay",
      runAnchor: { current: null },
    };

    // sweep the mirror to load rows into the writer's index
    const swept = await import("../../host/storage/mirror.js").then((m) => m.sweepMirror(fs, STORE_DIR));
    console.log("mirror rows:", swept.rows.length, "unique:", swept.uniqueUuids, "overCap:", swept.overCapFiles);
    mirror.adoptRows(swept.rows); // the boot backfill's adoption into the live writer

    const arrival = mirror.arrivalOrder();
    console.log("arrival order (knownPath source):", arrival.length);

    // the fold + lineage edges (resolveLiveSet's source (1))
    const fold = await foldLedger(fs, STORE_DIR);
    console.log("ledger records folded:", fold.records.length);

    // settle = the tip (no rewind) and a few rows back (a real rewind shape)
    const SETTLE_YESTERDAY = "687c5771-ff10-4995-92cf-a3be4b571637";
    for (const anchor of [SETTLE_YESTERDAY, mirror.tipUuid()]) {
      const settle = anchor;
      const live = await resolveLiveSet(storage, settle);
      const liveSet = new Set(live);
      const dead = arrival.filter((u) => !liveSet.has(u));
      const capped = capDeadAtOldestLiveKnown(arrival, live, dead);
      console.log(
        `settle ${String(settle).slice(0, 8)}: live=${live.length} dead-raw=${dead.length} dead-capped=${capped.length}`,
      );
    }
    expect(true).toBe(true);
  }, 240_000);
});
