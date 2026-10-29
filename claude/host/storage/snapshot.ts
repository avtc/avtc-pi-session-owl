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

/** Node ids a delta REQUIRES to exist for its replay to apply cleanly
 *  (the requireNode family — the invariant errors the tolerant loader
 *  logs as skipped deltas). */
function requiredNodeIds(delta: Record<string, unknown>): string[] {
  const out: string[] = [];
  const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
  switch (delta.type) {
    case "create_node": {
      const parent = str(delta.parentNode);
      if (parent !== null) out.push(parent);
      break;
    }
    case "record_observation": {
      const parent = str((delta.obs as Record<string, unknown> | undefined)?.parentNode);
      if (parent !== null && parent !== undefined) out.push(parent);
      break;
    }
    case "mv": {
      const dest = str(delta.destId);
      if (dest !== null) out.push(dest);
      if (Array.isArray(delta.sourceIds))
        out.push(...delta.sourceIds.filter((s): s is string => typeof s === "string"));
      break;
    }
    case "merge": {
      const dest = str(delta.destId);
      if (dest !== null) out.push(dest);
      if (Array.isArray(delta.sourceIds))
        out.push(...delta.sourceIds.filter((s): s is string => typeof s === "string"));
      break;
    }
    case "supersede": {
      const node = str(delta.nodeId);
      if (node !== null) out.push(node);
      if (Array.isArray(delta.supersededNodeIds))
        out.push(...delta.supersededNodeIds.filter((s): s is string => typeof s === "string"));
      break;
    }
    case "set_meta": {
      const node = str(delta.nodeId);
      if (node !== null) out.push(node);
      break;
    }
    case "flush_new": {
      if (Array.isArray(delta.nodeIds)) out.push(...delta.nodeIds.filter((s): s is string => typeof s === "string"));
      break;
    }
    default:
      break;
  }
  return out;
}

/** Node ids a delta BRINGS INTO EXISTENCE (replay-creatable). */
function createdNodeIds(delta: Record<string, unknown>): string[] {
  const out: string[] = [];
  if (delta.type === "create_node" && typeof delta.id === "string") out.push(delta.id);
  if (delta.type === "merge" && typeof delta.resolvedDestId === "string") out.push(delta.resolvedDestId);
  return out;
}

/** The graph_delta records the loader would replay AFTER a candidate
 *  snapshot — on the BRANCH axis (a record lands at its `at` row's branch
 *  position, tie-broken by fold order; dead-marker records never replay).
 *  The fold's write-time order and the branch's replay order diverge
 *  exactly in the damaged-fold shape this check exists for. */
function deltasAfterOnBranch(
  records: readonly LedgerRecord[],
  from: LedgerRecord,
  branch: readonly string[],
): Record<string, unknown>[] {
  const branchIndex = new Map(branch.map((uuid, i) => [uuid, i] as const));
  const posOf = (r: LedgerRecord): number => {
    if (r.at === "seed") return -1;
    const at = branchIndex.get(r.at);
    return at === undefined ? Number.NaN : at; // NaN = off-branch, never replays
  };
  const markerOnBranch = (r: LedgerRecord): boolean => r.marker === "seed" || branchIndex.has(r.marker);
  const fromPos = posOf(from);
  const fromFold = records.indexOf(from);
  const out: Record<string, unknown>[] = [];
  for (let i = 0; i < records.length; i += 1) {
    const r = records[i];
    if (r === undefined || r.kind !== "graph_delta") continue;
    if (!markerOnBranch(r)) continue;
    const pos = posOf(r);
    if (Number.isNaN(pos) || Number.isNaN(fromPos)) continue;
    const after = pos > fromPos || (pos === fromPos && i > fromFold);
    if (!after) continue;
    const payload = r.payload as { kind?: unknown; delta?: unknown; deltas?: unknown } | null;
    if (payload === null || payload.kind !== "graph_delta") continue;
    const batch = Array.isArray(payload.deltas)
      ? (payload.deltas as Record<string, unknown>[])
      : payload.delta !== undefined
        ? [payload.delta as Record<string, unknown>]
        : [];
    for (const delta of batch) {
      if (delta !== null && typeof delta === "object") out.push(delta);
    }
  }
  return out;
}

/** Resolve the snapshot to fold from: the NEWEST live candidate whose
 *  post-snapshot delta stream applies cleanly over its base (every required
 *  node exists at its replay point — a static replay of the requireNode
 *  invariants). A snapshot persisted over a DAMAGED fold (the collapse
 *  shape: a refold re-based the graph, later deltas reference nodes only
 *  the older snapshot carries) fails the check and the resolution walks to
 *  the next-older candidate — the ops are never pruned, so the older base
 *  plus the full delta stream rebuilds the true state. When NO candidate
 *  is consistent the NEWEST stands (the tolerant behavior — damage stays
 *  visible in the loader's skipped-delta warn). */
export async function resolveConsistentSnapshot(
  fs: FsAdapter,
  dir: string,
  records: readonly LedgerRecord[],
  isLive: LivePredicate,
  branch: readonly string[] = [],
): Promise<ResolvedSnapshot | null> {
  const candidates = await collectSnapshotCandidates(fs, dir, records, isLive);
  for (const candidate of candidates) {
    const baseIds = new Set<string>();
    const payload = candidate.details as { nodes?: unknown } | null;
    if (payload !== null && Array.isArray(payload.nodes)) {
      for (const node of payload.nodes) {
        if (node !== null && typeof node === "object" && typeof (node as { id?: unknown }).id === "string")
          baseIds.add((node as { id: string }).id);
      }
    }
    let consistent = true;
    for (const delta of deltasAfterOnBranch(records, candidate.record, branch)) {
      for (const id of createdNodeIds(delta)) baseIds.add(id);
      for (const id of requiredNodeIds(delta)) {
        if (!baseIds.has(id)) {
          consistent = false;
          log.warn(
            `snapshot resolve: candidate at ${candidate.record.ts} inconsistent (delta needs node ${id}) — trying the next-older snapshot`,
          );
          break;
        }
      }
      if (!consistent) break;
    }
    if (consistent) return candidate;
  }
  return candidates[0] ?? null;
}

/** A fresh snapshot id (one per compaction). */
export function newSnapshotId(): string {
  return randomUUID().slice(0, 8);
}
