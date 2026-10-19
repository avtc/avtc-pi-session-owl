// SPDX-License-Identifier: MIT
// SPDXFileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// The own-summary identity registry (port-side): noteOwnSummary holds the
// normalized text per conversation store; collectOwnSummariesFromBranch
// re-derives the set from the interleaved branch entries (summary entries
// after the latest plain rescan marker); a plain rescan clears the set.

import { describe, expect, test } from "vitest";
import { RESCAN_TYPE } from "../../core/src/store/codecs.js";
import { getGraphStore, resetForNewSession, type StoreEntry } from "../../core/src/store/graph-store.js";
import {
  collectOwnSummariesFromBranch,
  normalizeSummaryText,
  noteOwnSummary,
  ownSummariesFor,
  setOwnSummaries,
} from "../../host/storage/summary-identity.js";

function summaryEntry(id: string, text: string): StoreEntry {
  return { type: "custom", id, customType: "session-owl.summary", data: { text } };
}

function rescanEntry(id: string, mode?: string): StoreEntry {
  return { type: "custom", id, customType: RESCAN_TYPE, data: mode === undefined ? {} : { mode } };
}

describe("summary-identity — the registry", () => {
  test("note + read; normalization applies at record time", () => {
    resetForNewSession();
    const store = getGraphStore();
    noteOwnSummary(store, "# Memory\nrendered  ");
    expect([...ownSummariesFor(store)]).toEqual(["# Memory\nrendered"]);
  });

  test("setOwnSummaries replaces wholesale (load re-derivation)", () => {
    resetForNewSession();
    const store = getGraphStore();
    noteOwnSummary(store, "one");
    setOwnSummaries(store, ["two"]);
    expect([...ownSummariesFor(store)]).toEqual(["two"]);
  });

  test("collect from branch entries: texts after the latest PLAIN rescan only", () => {
    const entries: StoreEntry[] = [
      summaryEntry("s-1", "older"),
      rescanEntry("r-1"),
      summaryEntry("s-2", "kept across a reuse rescan"),
      rescanEntry("r-2", "reuse"),
      summaryEntry("s-3", "newest"),
    ];
    expect(collectOwnSummariesFromBranch(entries)).toEqual(["kept across a reuse rescan", "newest"]);
    // no plain rescan: everything collects
    expect(collectOwnSummariesFromBranch([summaryEntry("s-0", "only")])).toEqual(["only"]);
  });

  test("normalizeSummaryText trims", () => {
    expect(normalizeSummaryText("  x ")).toBe("x");
  });
});
