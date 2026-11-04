// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// Snapshot persistence: a compaction snapshot is ONE logical record — the
// SessionOwlDetails JSON text. Under the roll margin it is an ordinary single
// ledger record (the common case). Past it, the text is sliced at ~2.5 MiB
// CHARACTER boundaries (never mid-surrogate), written parts-first as
// snap-<compactionId>-<part>-<of>.json (WAL discipline — a crash between
// parts leaves orphans, ignored), then ONE small SNAPSHOT_PARTS ledger line
// {snapId, files, totalChars} names them. Individual parts are not valid
// JSON; only the joined whole parses. Load = the newest LIVE snapshot line in
// fold order (single or parts), read, join, parse — superseded snapshot parts
// are dead weight until the prune helper sweeps (never replaced in place).

import { log } from "../../core/src/log.js";
import type { FsAdapter } from "./fs-adapter.js";
import { byteLength, PART_SLICE, ROLL_MARGIN, sliceToByteParts } from "./fs-adapter.js";
import { randomUUID } from "./id.js";
import type { LedgerRecord, LedgerWriter, LivePredicate } from "./ledger.js";
import { normalizeSummaryText } from "./summary-identity.js";

/** The ledger line wraps the payload in an envelope (producerId/seq/ts/
 *  marker/at/kind JSON) whose flush pre-filter re-checks against the roll
 *  margin — a text sized in the window just under the margin would produce
 *  a line OVER it and be silently skipped (no re-observe exists for
 *  snapshots). The single-record predicate stays this far under so an
 *  envelope-padded line can never cross. */
const SNAPSHOT_ENVELOPE_SAFETY = 256;

/** The resolved snapshot for a fold: the decoded details object + its record. */
function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export interface ResolvedSnapshot {
  details: unknown;
  record: LedgerRecord;
}

function safeId(id: string): string {
  const clean = id.replace(/[^a-zA-Z0-9-]/g, "");
  return clean.length > 0 ? clean : "snap";
}

export function snapPartName(compactionId: string, part: number, of: number): string {
  return `snap-${safeId(compactionId)}-${part + 1}-of-${of}.json`;
}

/**
 * Persist a snapshot's JSON TEXT: single ledger record under the guard, else
 * parts-first + the SNAPSHOT_PARTS line. Returns the ledger id of the line
 * that names the snapshot (the flush lands it on disk with its batch).
 */
export async function persistSnapshotText(
  fs: FsAdapter,
  dir: string,
  ledger: LedgerWriter,
  compactionId: string,
  text: string,
  marker: string,
): Promise<string> {
  if (byteLength(text) <= ROLL_MARGIN - SNAPSHOT_ENVELOPE_SAFETY) {
    // common case: a 700-node graph serializes to ~300 KB
    const id = ledger.append("snapshot", JSON.parse(text), marker);
    // the snapshot is durable at persist time (the compaction product must
    // not ride a later turn flush — a crash between them would leave the
    // previous snapshot authoritative)
    await ledger.flush();
    return id;
  }
  // parts: text slices at character boundaries (never mid-surrogate), sized
  // so each part's UTF-8 byte size stays within the part budget (the shared
  // slicer; PART_SLICE is the ceiling, not the slice length).
  const parts = sliceToByteParts(text, PART_SLICE);
  const files: string[] = [];
  for (let i = 0; i < parts.length; i += 1) {
    const name = snapPartName(compactionId, i, parts.length);
    await fs.writeText(`${dir}/${name}`, parts[i]);
    files.push(name);
  }
  const id = ledger.append("SNAPSHOT_PARTS", { snapId: compactionId, files, totalChars: text.length }, marker);
  // parts-first WAL: the part files are on disk; the naming line must be
  // too (a buffered line lost at teardown orphans the parts)
  await ledger.flush();
  return id;
}

/**
 * Resolve the newest LIVE snapshot from a fold (single-record or parts):
 * returns null when none is live or a parts snapshot is unreadable/corrupt
 * (the orphan class — the caller falls back to the previous snapshot or a
 * deltas-only fold, exactly pi's corrupt-snapshot path).
 */
export async function resolveNewestSnapshot(
  fs: FsAdapter,
  dir: string,
  records: readonly LedgerRecord[],
  isLive: LivePredicate,
): Promise<ResolvedSnapshot | null> {
  const candidates = await collectSnapshotCandidates(fs, dir, records, isLive);
  return candidates[0] ?? null;
}

/**
 * Resolve the load anchor: the newest LIVE snapshot whose compaction the
 * transcript still carries — the session file is the source of truth, so a
 * snapshot newer than the transcript's last compaction (a trimmed session
 * file, a store record the conversation never referenced) is never the
 * anchor, and a snapshot whose summary pair is missing (the crash window
 * between the two writes, a damaged store) is skipped in favor of the
 * previous transcript-backed compaction, all the way to the session start.
 * Damage past the anchor stays the replay's problem (skipped-delta
 * warnings): a deeper base would tolerantly replay the whole history and
 * orphan the tree into an unprocessable root view. Returns null when no
 * compact-matched snapshot exists (a deltas-only fold).
 */
export async function resolveLoadSnapshot(
  fs: FsAdapter,
  dir: string,
  records: readonly LedgerRecord[],
  isLive: LivePredicate,
  ownSummaries: ReadonlySet<string>,
): Promise<ResolvedSnapshot | null> {
  const candidates = await collectSnapshotCandidates(fs, dir, records, isLive);
  const summaryByMarker = new Map<string, string>();
  for (const record of records) {
    if (String(record.kind) !== "summary") continue;
    const text = (record.payload as { text?: unknown } | null)?.text;
    if (typeof text === "string" && text.length > 0) {
      summaryByMarker.set(String(record.at), normalizeSummaryText(text));
    }
  }
  for (const candidate of candidates) {
    const marker = String(candidate.record.at);
    const summary = summaryByMarker.get(marker);
    if (summary === undefined) {
      log.warn(
        `snapshot resolve: snapshot at ${candidate.record.ts} has no summary pair — skipping, trying the previous compaction`,
      );
      continue;
    }
    if (!ownSummaries.has(summary)) {
      log.warn(
        `snapshot resolve: snapshot at ${candidate.record.ts} has no matching compaction in the transcript — skipping, trying the previous compaction`,
      );
      continue;
    }
    return candidate;
  }
  return null;
}

/** Collect the LIVE snapshot candidates, NEWEST first (single-record and
 *  parts snapshots both; an orphaned/corrupt parts candidate is skipped —
 *  same rules as the newest-only walk). */
async function collectSnapshotCandidates(
  fs: FsAdapter,
  dir: string,
  records: readonly LedgerRecord[],
  isLive: LivePredicate,
): Promise<ResolvedSnapshot[]> {
  const out: ResolvedSnapshot[] = [];
  for (let i = records.length - 1; i >= 0; i -= 1) {
    const r = records[i];
    if (r === undefined) continue;
    if (r.kind !== "snapshot" && r.kind !== "SNAPSHOT_PARTS") continue;
    if (!isLive(r.marker)) continue;
    if (r.kind === "snapshot") {
      out.push({ details: r.payload, record: r });
      continue;
    }
    const meta = r.payload as { snapId?: unknown; files?: unknown; totalChars?: unknown } | null;
    if (meta === null || !Array.isArray(meta.files) || typeof meta.totalChars !== "number") continue;
    let joined = "";
    let orphan = false;
    for (const f of meta.files) {
      if (typeof f !== "string" || f.includes("/") || f.includes("\\") || f.startsWith(".")) {
        orphan = true; // corrupt or traversal-attempting line
        break;
      }
      try {
        joined += await fs.readText(`${dir}/${f}`);
      } catch (err) {
        log.info(`snapshot resolve: part unreadable, snapshot orphaned (${f}): ${errText(err)}`);
        orphan = true; // missing part (crash between part and line)
        break;
      }
    }
    if (!orphan && joined.length !== meta.totalChars) orphan = true; // truncated
    if (!orphan) {
      try {
        out.push({ details: JSON.parse(joined), record: r });
      } catch (err) {
        log.info(`snapshot resolve: corrupt joined whole, orphaned: ${errText(err)}`);
      }
    }
  }
  return out;
}

/** A fresh snapshot id (one per compaction). */
export function newSnapshotId(): string {
  return randomUUID().slice(0, 8);
}
