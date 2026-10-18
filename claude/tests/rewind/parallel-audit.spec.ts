// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// The parallel-tool audit (S1): every consumer that derives liveness or
// ordering from parent links must treat a SAME-parent parallel batch the
// way the engine does — one assistant row, N tool_use blocks, N results
// all parented at that row; the parent chain follows ONE result, the
// siblings are live served content. resolveLiveSet's no-ledger-edges
// fallback must NOT use the BARE chain (a sibling would adjudicate dead
// at every refold).

import { beforeEach, describe, expect, test } from "vitest";
import { resolveLiveSet } from "../../host/rewind/checkpoint-service.js";
import { createMemoryFs } from "../../host/storage/fs-adapter.js";
import { LedgerWriter } from "../../host/storage/ledger.js";
import { type MirroredRow, MirrorWriter } from "../../host/storage/mirror.js";
import { branchForLeaf } from "../../host/storage/store-context.js";

const DIR = "/store";
let mem: ReturnType<typeof createMemoryFs>;

beforeEach(() => {
  mem = createMemoryFs();
});

function row(uuid: string, parent: string | null): MirroredRow {
  return { uuid, parentUuid: parent, row: { message: { content: [{ type: "text", text: uuid }] } } };
}

function resultRow(uuid: string, parent: string, toolUseId: string): MirroredRow {
  return {
    uuid,
    parentUuid: parent,
    row: { message: { content: [{ type: "tool_result", tool_use_id: toolUseId, content: "ok" }] } },
  };
}

function storageOf(rows: readonly MirroredRow[]): {
  mirror: MirrorWriter;
  ledger: LedgerWriter;
  fs: ReturnType<typeof createMemoryFs>["adapter"];
} {
  const mirror = new MirrorWriter(mem.adapter, DIR, "p-audit");
  const ledger = new LedgerWriter(mem.adapter, DIR, "p-audit");
  for (const r of rows) mirror.bufferRow(r);
  return { mirror, ledger, fs: mem.adapter };
}

describe("resolveLiveSet — parallel tool batches", () => {
  test("a same-parent parallel result stays LIVE (no ledger edges — the mirror fallback)", async () => {
    const { mirror, ledger, fs } = storageOf([
      row("u1", null),
      row("a1", "u1"), // one assistant row, two tool_use blocks
      resultRow("r1", "a1", "pt1"), // the OFF-chain sibling
      resultRow("r2", "a1", "pt2"), // the chain's result
      row("u2", "r2"),
    ]);
    const live = await resolveLiveSet({ key: "main", dir: DIR, fs, mirror, ledger, producerId: "p1" }, "u2");
    expect(live).toContain("r1");
    expect(live).toContain("r2");
    expect(live).toContain("a1");
  });

  test("the orphaned-reply shape stays dead in the fallback (a non-sibling continuation)", async () => {
    const { mirror, ledger, fs } = storageOf([
      row("u1", null),
      resultRow("rDead", "u1", "ptX"), // passed by — the chain continued through u1
      row("u2", "u1"),
    ]);
    const live = await resolveLiveSet({ key: "main", dir: DIR, fs, mirror, ledger, producerId: "p1" }, "u2");
    expect(live).not.toContain("rDead");
    expect(live).toContain("u2");
  });

  test("branchForLeaf (the fold's marker axis) serves the parallel sibling — records stamped there stay live", () => {
    const { mirror } = storageOf([
      row("u1", null),
      row("a1", "u1"),
      resultRow("r1", "a1", "pt1"),
      resultRow("r2", "a1", "pt2"),
      row("u2", "r2"),
    ]);
    expect(branchForLeaf(mirror, "u2")).toContain("r1");
  });
});
