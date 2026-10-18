// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// Layer 4 / the exact-edge source: the readable-transcript pass. The file
// is the authoritative verification — `last-prompt` rows name the live tip
// (leafUuid), every chain row carries parentUuid, and the pass yields EXACT
// edges for the lineage ledger.

import { describe, expect, test } from "vitest";
import { exactEdges, parseTranscript, verifyJunction } from "../../host/rewind/verifier.js";

const chainRow = (uuid: string, parentUuid: string | null, extra: Record<string, unknown> = {}) => ({
  uuid,
  parentUuid,
  type: "user",
  message: { type: "user", content: [] },
  ...extra,
});

const jsonl = (rows: unknown[]) => rows.map((r) => JSON.stringify(r)).join("\n");

describe("parseTranscript", () => {
  test("chain rows round-trip; the last last-prompt leafUuid is the tip", () => {
    const text = jsonl([
      chainRow("r1", null),
      chainRow("r2", "r1"),
      { type: "last-prompt", leafUuid: "r1", explicit: false },
      chainRow("r3", "r2"),
      { type: "last-prompt", leafUuid: "r3", leafExplicit: true, rewound: true },
      { type: "summary", leafUuid: "r2", summary: "…" },
    ]);
    const pass = parseTranscript(text);
    if (pass.kind !== "ok") throw new Error("expected ok");
    expect(pass.rows.map((r) => r.uuid)).toEqual(["r1", "r2", "r3"]);
    expect(pass.tip).toBe("r3");
  });

  test("no marker: the tip falls back to the LAST childless row (file order — dead leaves sit earlier)", () => {
    // r4 is a dead fork leaf written before the live r5'
    const text = jsonl([chainRow("r1", null), chainRow("r2", "r1"), chainRow("r4", "r2"), chainRow("r5prime", "r2")]);
    const pass = parseTranscript(text);
    if (pass.kind !== "ok") throw new Error("expected ok");
    expect(pass.tip).toBe("r5prime");
  });

  test("an explicit null leafUuid marker is not treated as a tip (the chain fallback applies)", () => {
    const text = jsonl([chainRow("r1", null), { type: "last-prompt", leafUuid: null }, chainRow("r2", "r1")]);
    const pass = parseTranscript(text);
    if (pass.kind !== "ok") throw new Error("expected ok");
    expect(pass.tip).toBe("r2");
  });

  test("tolerant: blank lines, non-JSON lines, and non-row objects are skipped", () => {
    const text = [
      "",
      "not json at all",
      JSON.stringify(chainRow("r1", null)),
      JSON.stringify({ just: "metadata" }),
      "   ",
      JSON.stringify(chainRow("r2", "r1")),
    ].join("\n");
    const pass = parseTranscript(text);
    if (pass.kind !== "ok") throw new Error("expected ok");
    expect(pass.rows.map((r) => r.uuid)).toEqual(["r1", "r2"]);
  });

  test("over 4 MiB reports over-cap (the CLI Node helper covers those files)", () => {
    const big = "x".repeat(4 * 1024 * 1024 + 1);
    expect(parseTranscript(big)).toEqual({ kind: "over-cap" });
  });

  test("an empty transcript parses clean with no rows and no tip", () => {
    expect(parseTranscript("")).toEqual({ kind: "ok", rows: [], tip: null, rewound: false });
  });
});

describe("exactEdges", () => {
  test("one exact edge per row, first occurrence wins (duplicates await the next pass's supersede)", () => {
    const pass = parseTranscript(
      jsonl([
        chainRow("r1", null),
        chainRow("r2", "r1"),
        chainRow("r2", "rOTHER"), // engine rewrite — ignored this pass
      ]),
    );
    if (pass.kind !== "ok") throw new Error("expected ok");
    expect(exactEdges(pass.rows)).toEqual([
      { uuid: "r1", parent: null, exact: true },
      { uuid: "r2", parent: "r1", exact: true },
    ]);
  });
});

describe("verifyJunction", () => {
  const pass = parseTranscript(jsonl([chainRow("r1", null), chainRow("r2", "r1"), chainRow("r3", "r2")]));

  test("a present junction returns its exact parent (the provisional correction source)", () => {
    expect(verifyJunction(pass.kind === "ok" ? pass.rows : [], "r2")).toEqual({
      present: true,
      exactParent: "r1",
    });
  });

  test("an absent junction reports present:false (a text-fingerprint false match)", () => {
    expect(verifyJunction(pass.kind === "ok" ? pass.rows : [], "nope")).toEqual({
      present: false,
      exactParent: null,
    });
  });
});
