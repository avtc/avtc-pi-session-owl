// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// Snapshot persistence: single-record path under the guard, part-splitting
// round-trip past it (byte-exact reassembly), WAL crash orphans, newest-LIVE
// selection, surrogate-safe part boundaries.
import { beforeEach, describe, expect, test } from "vitest";
import { byteLength, createMemoryFs, ROLL_MARGIN } from "../../host/storage/fs-adapter.js";
import { foldLedger, type LedgerRecord, LedgerWriter } from "../../host/storage/ledger.js";
import { persistSnapshotText, resolveNewestSnapshot, snapPartName } from "../../host/storage/snapshot.js";

const mem = createMemoryFs();
const fs = mem.adapter;
const DIR = "/sess";

function rec(kind: "snapshot" | "SNAPSHOT_PARTS", payload: unknown, marker: string, ts: number): LedgerRecord {
  return { producerId: "A", seq: ts, ts, marker, at: marker, kind, payload };
}

beforeEach(() => {
  mem.files.clear();
});

describe("snapshot — single-record path", () => {
  test("a small snapshot rides one ordinary ledger record, load resolves it", async () => {
    const ledger = new LedgerWriter(fs, DIR, "A");
    const details = { type: "session-owl", version: "v1", nodes: [] };
    await persistSnapshotText(fs, DIR, ledger, "snap1", JSON.stringify(details), "u5");
    const fold = await foldLedger(fs, DIR);
    const resolved = await resolveNewestSnapshot(fs, DIR, fold.records, () => true);
    expect(resolved?.details).toEqual(details);
    expect(resolved?.record.kind).toBe("snapshot");
    expect(resolved?.record.marker).toBe("u5");
    // DURABILITY: the snapshot line is on disk at persist time (parts-first
    // WAL — the part files already are; the naming line must not ride a
    // later turn flush)
    expect(ledger.bufferedRecords()).toHaveLength(0);
  });
});

describe("snapshot — the envelope-overhead window (never silently dropped)", () => {
  test("a text just under the roll margin takes the PARTS path (the ledger line carries an envelope)", async () => {
    const ledger = new LedgerWriter(fs, DIR, "A");
    // land INSIDE the window: text bytes > margin - 256 (beyond the envelope
    // safety) but <= margin — the ledger line would cross the flush
    // pre-filter and be silently skipped on the single-record path
    const target = ROLL_MARGIN - 120; // inside the envelope window, under the margin
    const wrap = (b: string) => JSON.stringify({ type: "session-owl", version: "v1", blob: b });
    const overhead = byteLength(wrap("")) - "".length; // the wrapper's own bytes
    const blob = "z".repeat(target - overhead); // exact: text lands AT target
    const text = wrap(blob);
    expect(byteLength(text)).toBeLessThanOrEqual(ROLL_MARGIN);
    expect(byteLength(text)).toBeGreaterThan(ROLL_MARGIN - 256);
    await persistSnapshotText(fs, DIR, ledger, "snapwin", text, "u7");
    await ledger.flush();
    const listing = await fs.listDir(DIR);
    expect(listing.some((n) => n.startsWith("snap-snapwin-"))).toBe(true); // parts, not a dropped line
    const fold = await foldLedger(fs, DIR);
    const resolved = await resolveNewestSnapshot(fs, DIR, fold.records, () => true);
    expect(resolved).not.toBeNull(); // the snapshot SURVIVED — not the previous-snapshot fallback
    expect(JSON.stringify(resolved?.details)).toBe(text);
  });
});

describe("snapshot — part-splitting", () => {
  test("a >2.5 MiB snapshot splits into part files + one SNAPSHOT_PARTS line, reassembles byte-exact", async () => {
    const ledger = new LedgerWriter(fs, DIR, "A");
    const filler = `${"z".repeat(1023)}x`;
    const count = Math.ceil((3 * 1024 * 1024 + 65536) / filler.length);
    const details = { type: "session-owl", version: "v1", blob: filler.repeat(count) };
    const text = JSON.stringify(details);
    expect(text.length).toBeGreaterThan(2.5 * 1024 * 1024);
    await persistSnapshotText(fs, DIR, ledger, "snapbig", text, "u9");
    await ledger.flush();
    // parts-first WAL: part files exist BEFORE the line — after flush both exist
    const listing = await fs.listDir(DIR);
    const partFiles = listing.filter((n) => n.startsWith("snap-snapbig-"));
    expect(partFiles.length).toBeGreaterThanOrEqual(2);
    expect(partFiles).toContain(snapPartName("snapbig", 0, partFiles.length));
    const fold = await foldLedger(fs, DIR);
    const line = fold.records.find((r) => r.kind === "SNAPSHOT_PARTS");
    expect(line).toBeDefined();
    if (line === undefined) throw new Error("SNAPSHOT_PARTS line missing");
    expect((line.payload as { files: string[] }).files).toEqual(partFiles);
    const resolved = await resolveNewestSnapshot(fs, DIR, fold.records, () => true);
    expect(resolved).not.toBeNull();
    expect(JSON.stringify(resolved?.details)).toBe(text); // byte-exact
  });

  test("part boundaries never land mid-surrogate", async () => {
    const ledger = new LedgerWriter(fs, DIR, "A");
    // a string of surrogate pairs sized so slices must cut inside pairs
    const pairs = "😀".repeat(2_000_000);
    const text = JSON.stringify({ type: "session-owl", version: "v1", pairs });
    expect(text.length).toBeGreaterThan(2.5 * 1024 * 1024);
    await persistSnapshotText(fs, DIR, ledger, "snapuni", text, "u1");
    await ledger.flush();
    const fold = await foldLedger(fs, DIR);
    const resolved = await resolveNewestSnapshot(fs, DIR, fold.records, () => true);
    expect(JSON.stringify(resolved?.details)).toBe(text);
  });
});

describe("snapshot — byte-budget parts", () => {
  test("astral-heavy text splits so every part file stays within the byte budget", async () => {
    const ledger = new LedgerWriter(fs, DIR, "A");
    // 1.4M emoji pairs: 2.8M chars, ~5.6 MB UTF-8 — every part must stay
    // within the ~2.5 MiB BYTE budget while never cutting a pair
    const pairs = "\ud83d\ude00".repeat(1_400_000);
    const text = JSON.stringify({ type: "session-owl", version: "v1", pairs });
    const { byteLength, PART_SLICE } = await import("../../host/storage/fs-adapter.js");
    expect(byteLength(text)).toBeGreaterThan(3 * 1024 * 1024);
    await persistSnapshotText(fs, DIR, ledger, "snapemoji", text, "u1");
    await ledger.flush();
    const fold = await foldLedger(fs, DIR);
    const meta = fold.records.find((r) => r.kind === "SNAPSHOT_PARTS")?.payload as { files: string[] };
    expect((meta.files ?? []).length).toBeGreaterThanOrEqual(3); // 5.6 MB / 2.62 MB part budget
    for (const f of meta.files ?? []) {
      expect((await fs.stat(`${DIR}/${f}`))?.size ?? 0).toBeLessThanOrEqual(PART_SLICE);
    }
    const resolved = await resolveNewestSnapshot(fs, DIR, fold.records, () => true);
    expect(JSON.stringify(resolved?.details)).toBe(text);
  });
});

describe("snapshot — crash orphans + liveness", () => {
  test("a missing part (crash between part and line) resolves null — previous snapshot wins", async () => {
    const older = rec("snapshot", { type: "session-owl", version: "v1", n: 1 }, "u3", 3);
    const meta = { snapId: "s", files: ["snap-s-1-of-2.json", "snap-s-2-of-2.json"], totalChars: 100 };
    const newer = rec("SNAPSHOT_PARTS", meta, "u7", 7);
    // part 2 was never written (crash) — only part 1 exists
    await fs.writeText(`${DIR}/snap-s-1-of-2.json`, "aaaa");
    const resolved = await resolveNewestSnapshot(fs, DIR, [older, newer], () => true);
    expect(resolved?.record).toBe(older); // fell back past the orphan
  });

  test("a DEAD newest snapshot is skipped; the newest live one loads (rewind rule)", async () => {
    const s1 = rec("snapshot", { type: "session-owl", version: "v1", n: 1 }, "u3", 3);
    const s2 = rec("snapshot", { type: "session-owl", version: "v1", n: 2 }, "u6", 6);
    const live = (m: string) => m !== "u6"; // s2's marker is off-path
    const resolved = await resolveNewestSnapshot(fs, DIR, [s1, s2], live);
    expect(resolved?.record).toBe(s1);
  });

  test("no live snapshot resolves null (deltas-only fallback signal)", async () => {
    const s1 = rec("snapshot", { type: "session-owl", version: "v1" }, "u3", 3);
    const resolved = await resolveNewestSnapshot(fs, DIR, [s1], () => false);
    expect(resolved).toBeNull();
  });

  test("a truncated part (size mismatch) is the orphan class", async () => {
    const meta = { snapId: "s", files: ["snap-s-1-of-1.json"], totalChars: 100 };
    const r = rec("SNAPSHOT_PARTS", meta, "u2", 2);
    await fs.writeText(`${DIR}/snap-s-1-of-1.json`, "short");
    const resolved = await resolveNewestSnapshot(fs, DIR, [r], () => true);
    expect(resolved).toBeNull();
  });
});
