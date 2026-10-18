// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// The Claude StoreContext: the pi contract (appendEntry / getLeafId /
// getBranch) over owl's own ledger + mirror. The core's GraphStore runs
// byte-identical on top; this adapter is the only thing that changed.
//
// SYNC MODEL: pi's getBranch is synchronous, and the fold needs async file
// reads — so the fold is prepared ONCE per load (prepareStoreContext) and
// getBranch serves from in-memory state: the flushed fold cached at prepare
// + the ledger's buffered records (pi's session log shows just-appended
// entries the same way). Rows come from the mirror's in-memory index (the
// live session) or the sweep (a restart).
//
// BRANCH = LIVE PATH: getBranch(leafId) walks parentUuid from the leaf
// through the row index (a linear arrival-order fallback covers resumed
// sessions whose edges are still inferred). Owl records interleave
// immediately AFTER their marker row's entry — a record whose marker row is
// not on the branch is skipped, which IS the marker-liveness rule. The
// liveness PRIMITIVE isMarkerLive(uuid) answers branch membership; until the
// layered detection lands, the branch is the full arrival order (the
// fresh-session truth).
//
// ENTRY MAPPING (the shapes the core fold consumes):
//   rows        -> {type:"custom", id:<uuid>, customType:"session-owl.row"} (inert; supplies entry ids)
//   observation/graph_delta/usage/selection/rescan -> {type:"custom", customType:<pi type>, data:<payload>}
//   snapshot    -> ONE {type:"compaction", details} for the newest live snapshot (single or parts)
//   CHECK/lineage are fold metadata, never entries.

import { log } from "../../core/src/log.js";
import {
  GRAPH_DELTA_TYPE,
  OBSERVATION_TYPE,
  RESCAN_TYPE,
  SELECTION_TYPE,
  USAGE_TYPE,
} from "../../core/src/store/codecs.js";
import type {
  StoreCompactionEntry,
  StoreContext,
  StoreCustomEntry,
  StoreEntry,
} from "../../core/src/store/graph-store.js";
import type { FsAdapter } from "./fs-adapter.js";
import {
  foldLedger,
  type LedgerRecord,
  LedgerWriter,
  type LivePredicate,
  newestLiveCheck,
  quarantineAfterLastLiveCheck,
} from "./ledger.js";
import { type MirroredRow, MirrorWriter, type SweepResult, sweepMirror } from "./mirror.js";
import { resolveConsistentSnapshot } from "./snapshot.js";

export type { SessionMarker } from "./session-marker.js";
export { SESSION_MARKER_FILENAME } from "./session-marker.js";

/** The row custom type the port's branch entries carry (inert to the fold). */
export const ROW_TYPE = "session-owl.row";

const KIND_TO_TYPE: Record<string, string> = {
  observation: OBSERVATION_TYPE,
  graph_delta: GRAPH_DELTA_TYPE,
  usage: USAGE_TYPE,
  selection: SELECTION_TYPE,
  rescan: RESCAN_TYPE,
};
const TYPE_TO_KIND: Record<string, string> = Object.fromEntries(Object.entries(KIND_TO_TYPE).map(([k, t]) => [t, k]));

function rowEntry(uuid: string): StoreCustomEntry {
  return { type: "custom", id: uuid, customType: ROW_TYPE, data: { uuid } };
}

/** Trace helper: delta op summary ("type:id|type:id"). */
function payloadOf(data: unknown): string {
  const p = data as {
    deltas?: Array<{ type?: string; id?: string; nodeId?: string }>;
    delta?: { type?: string; id?: string; nodeId?: string };
  };
  const list = p.deltas ?? (p.delta !== undefined ? [p.delta] : []);
  return list.map((d) => `${String(d.type)}:${String(d.id ?? d.nodeId ?? "")}`).join("|");
}

// ---- branch building (pure, in-memory) ------------------------------------------

/** Interleave the record entries after their ORDER row (`at` — the write
 *  tip, pi's append position) along the branch; LIVENESS is decided by the
 *  `marker` row (a record whose marker is off-branch is skipped). The split
 *  keeps a backward-covering re-observe AFTER an earlier rescan (pi's log
 *  order) while a rewind still drops it by its marker. `onSkip` reports the
 *  two silent drop points (marker off-branch / `at` off-branch) once per
 *  record per prepared context — the trace seam for the skip forensics. */
function buildBranch(
  branch: readonly string[],
  records: readonly LedgerRecord[],
  snapshot: { details: unknown; record: LedgerRecord } | null,
  onSkip?: (r: LedgerRecord, reason: "marker" | "at") => void,
): StoreEntry[] {
  const rowsInBranch = new Set(branch);
  const byAtRow = new Map<string, StoreEntry[]>();
  const seedFirst: StoreEntry[] = []; // records written at the pre-rows origin
  const seenRecordIds = new Set<string>(); // once each across fold ∪ live views
  for (const r of records) {
    if (r.kind === "CHECK" || r.kind === "lineage") continue;
    const recordId = `${r.producerId}:${r.seq}`;
    if (seenRecordIds.has(recordId)) continue; // the re-fold overlap corner
    seenRecordIds.add(recordId);
    // "seed" is the pre-rows write tip (a record persisted while the mirror
    // was still empty — e.g. the nGoal seed at session start), not a row
    // uuid: it is always on-branch and lands BEFORE every row
    const onBranch = r.marker === "seed" || rowsInBranch.has(r.marker);
    if (!onBranch) {
      onSkip?.(r, "marker");
      continue; // dead marker — skipped
    }
    if (r.kind === "snapshot" || r.kind === "SNAPSHOT_PARTS") {
      if (snapshot !== null && r === snapshot.record) {
        const entry: StoreCompactionEntry = {
          type: "compaction",
          id: `${r.producerId}:${r.seq}`,
          details: snapshot.details,
        };
        if (r.at === "seed") seedFirst.push(entry);
        else place(byAtRow, r.at, entry, rowsInBranch, () => onSkip?.(r, "at"));
      }
      continue;
    }
    const customType = KIND_TO_TYPE[r.kind];
    if (customType === undefined) continue;
    const entry: StoreCustomEntry = { type: "custom", id: `${r.producerId}:${r.seq}`, customType, data: r.payload };
    if (r.at === "seed") seedFirst.push(entry);
    else place(byAtRow, r.at, entry, rowsInBranch, () => onSkip?.(r, "at"));
  }
  const entries: StoreEntry[] = [...seedFirst];
  for (const uuid of branch) {
    entries.push(rowEntry(uuid));
    for (const e of byAtRow.get(uuid) ?? []) entries.push(e);
  }
  return entries;
}

function place(
  byAtRow: Map<string, StoreEntry[]>,
  at: string,
  entry: StoreEntry,
  rowsInBranch: Set<string>,
  onSkip?: () => void,
): void {
  if (!rowsInBranch.has(at)) {
    onSkip?.();
    return; // written off-branch — skipped
  }
  const list = byAtRow.get(at) ?? [];
  list.push(entry);
  byAtRow.set(at, list);
}

/** The branch for a leaf: the SERVED branch (the parent chain plus the
 *  rows attached to it one level deep — the engine's parallel-tool results),
 *  or the linear fallback. */
export function branchForLeaf(mirror: MirrorWriter, leafId: string | null): string[] {
  if (leafId !== null) {
    const served = mirror.servedBranch(leafId);
    if (served !== null) return served;
  }
  return mirror.arrivalOrder();
}

// ---- the prepared context --------------------------------------------------------

export interface PreparedContext {
  ctx: StoreContext;
  /** The records the next getBranch serves (flushed fold + buffered). */
  recordsRef: { flushed: LedgerRecord[]; quarantinedDropped: number };
  /** The marker-liveness primitive over the CURRENT branch. */
  isMarkerLive: LivePredicate;
  /** The last served branch (uuid order). */
  lastBranch(): string[];
  /** The reconciliation's live-branch override: after a detected rewind the
   *  served branch is the detected live path (the mirror's own edges may be
   *  inferred/absent — the platform append envelope carries no parentUuid);
   *  the dead set keeps the growth slice from leaking dead-tail rows back
   *  (they can arrive AFTER the anchor in the rewind-while-absent shape);
   *  null clears both (the mirror chain/arrival rules apply again). */
  setLiveBranch(uuids: readonly string[] | null, dead?: ReadonlySet<string>): void;
  /** Re-fold + re-resolve (call at every load — the ctxFactory pattern).
   *  `isLive` overrides the constructed predicate for this re-fold (the
   *  rewind reconciliation feeds the detected live set; the default is the
   *  constructed one). */
  refresh(isLive?: LivePredicate): Promise<void>;
}

/**
 * Build the StoreContext over a mirror row index. The flushed fold is
 * snapshotted here (async) and served synchronously afterwards; live appends
 * flow through the ledger's buffer. `isLive` defaults to all-live (the
 * fresh-session truth; the layered detection supersedes it).
 */
export async function prepareStoreContext(
  fs: FsAdapter,
  dir: string,
  ledger: LedgerWriter,
  mirror: MirrorWriter,
  opts: { isLive?: LivePredicate; clock?: () => number } = {},
): Promise<PreparedContext> {
  const isLive = opts.isLive ?? (() => true);
  let snapshot: { details: unknown; record: LedgerRecord } | null = null;
  let flushed: LedgerRecord[] = [];
  let droppedCount = 0;
  // The blind-window DROPS this context has already decided (the start
  // fold's crash window + every detection refold's verdict), sticky for the
  // context's life: a detection verdict must not resurrect at the next
  // swap. Ordinary swap re-folds do NOT evaluate the window themselves —
  // durable in-process stage writes are visible again on every re-fold
  // (write-through makes them current-process writes from the moment they
  // exist), and only already-decided drops stay out. Records the design
  // re-derives (observations) arrive as fresh verdicts after a detection.
  const blindDropped = new Set<string>();
  const recordIdOf = (r: LedgerRecord): string => `${r.producerId}:${r.seq}`;
  // The silent-drop trace: a record the branch fold skips (marker row or
  // `at` row off-branch) is logged ONCE per prepared context — getBranch runs
  // on every render, dedup keeps the trace to the first sighting.
  const reportedSkips = new Set<string>();
  const reportSkip = (r: LedgerRecord, reason: "marker" | "at"): void => {
    const id = recordIdOf(r);
    if (reportedSkips.has(id)) return;
    reportedSkips.add(id);
    const row = String(r[reason]);
    log.warn(
      `branch-drop: record ${id} (${r.kind}) dropped — ${reason} row ${row} not on the served branch ` +
        `(${lastBranch.length}/${mirror.arrivalOrder().length} rows served)`,
    );
  };
  const refresh = async (override?: LivePredicate): Promise<void> => {
    const live = override ?? isLive;
    const fold = await foldLedger(fs, dir);
    let records = fold.records;
    let freshDrops = 0;
    if (override !== undefined) {
      const q = quarantineAfterLastLiveCheck(records, live);
      for (const r of q.dropped) {
        const id = recordIdOf(r);
        if (!blindDropped.has(id)) {
          blindDropped.add(id);
          freshDrops += 1;
        }
      }
      records = q.kept;
    }
    const kept = records.filter((r) => !blindDropped.has(recordIdOf(r)));
    if (freshDrops > 0) {
      log.info(
        `blind-window quarantine: ${freshDrops} record(s) past the last live CHECK dropped (fold=${fold.records.length} kept=${kept.length})`,
      );
    }
    flushed = kept;
    // the fold-level view: how many records the blind set keeps out of THIS
    // fold (sticky across refreshes — construction drops count from the start)
    droppedCount = fold.records.length - kept.length;
    ledger.dropWrittenForRefold(); // the disk read re-claimed them (liveRecords shrinks to buffer)
    // the branch axis the loader's replay walks (a record lands at its `at`
    // row's position — the fold's write-time order diverges from it exactly
    // in the damaged-fold shape the consistent resolution guards against)
    const branch = branchForLeaf(mirror, mirror.tipUuid());
    snapshot = await resolveConsistentSnapshot(fs, dir, kept, live, branch);
  };
  // the context-construction fold keeps every record: process start has no
  // transcript, so no liveness predicate exists yet — evaluating the blind
  // window here (with the all-live default) would drop every record ordered
  // after the last CHECK, amputating live persisted work (mid-gate stage
  // writes, snapshots) on every plain resume. Liveness verdicts belong to
  // the detection refolds (the rewind reconciliation feeds the detected
  // live set, process-start checkpoint included); off-branch records are
  // dropped per-record by the marker/`at` branch axis until then
  await refresh();
  let lastBranch: string[] = mirror.arrivalOrder();
  // membership mirror of lastBranch: the CHECK/snapshot resolution asks
  // per record, so a linear scan is O(branch) per record at fold time —
  // the Set answers O(1). Rebuilt at every assignment via setLastBranch.
  let lastBranchSet = new Set<string>(lastBranch);
  const setLastBranch = (v: string[]): void => {
    lastBranch = v;
    lastBranchSet = new Set(v);
  };
  // The append pipeline buffers: nothing reaches a file on append. Durability
  // is coalesced to the study's unit boundaries (the observer's every-N-chunk
  // checkpoints, builder/selector run end, checkpoint/turn/session boundaries).
  // Failure keeps the buffer (flush restores its tail) for the next flush.
  let liveBranchOverride: string[] | null = null;
  let liveBranchDead: ReadonlySet<string> = new Set();
  const ctx: StoreContext = {
    appendEntry(customType: string, data: unknown): void {
      if (customType === OBSERVATION_TYPE) {
        const marker = (data as { coversUpToId?: unknown } | null)?.coversUpToId;
        if (typeof marker !== "string") {
          throw new Error("session-owl: observation record missing coversUpToId");
        }
        // the ids-drill shortcut: resolve the covered range's mirror batches
        // (flushed rows only — unflushed/adopted rows carry no ref) onto the
        // observation record, so a cold ids drill reads exactly the covering
        // batches without the sweep
        const coversFrom = (data as { coversFromId?: unknown }).coversFromId;
        if (typeof coversFrom === "string") {
          const covered = mirror.arrivalSlice(coversFrom, marker); // one walk
          if (covered !== null) {
            const refs = new Map<string, { producer: string; seq: number }>();
            for (const uuid of covered) {
              const ref = mirror.batchRefFor(uuid);
              if (ref !== null) refs.set(`${ref.producer}:${ref.seq}`, ref);
            }
            if (refs.size > 0) ledger.refsForNextObservation([...refs.values()]);
          }
        }
        // liveness = the covered range's END row; order = the write tip
        ledger.append("observation", data, marker, mirror.tipUuid() ?? marker);
        return;
      }
      const kind = TYPE_TO_KIND[customType];
      if (kind === undefined) {
        throw new Error(`session-owl: unmapped custom entry type ${customType}`);
      }
      if (kind === "graph_delta") {
        const p = payloadOf(data);
        log.info(`append Δ store=${dir.slice(-14)} ops=${p}`);
      }
      // every other record rides the position it was written at: the live tip
      ledger.append(kind as LedgerRecord["kind"], data, mirror.tipUuid() ?? "seed");
    },
    getLeafId(): string | null {
      return mirror.tipUuid();
    },
    getBranch(leafId: string | null): StoreEntry[] {
      if (liveBranchOverride !== null) {
        // the reconciliation's live path PLUS every row observed after its
        // anchor (post-divergence arrivals serve — the branch grows, it
        // never freezes) minus the DEAD set (a dead-tail row that arrived
        // after the anchor must not leak back in)
        const arrival = mirror.arrivalOrder();
        const anchorIdx = arrival.indexOf(liveBranchOverride[liveBranchOverride.length - 1] ?? "");
        const inOverride = new Set(liveBranchOverride);
        const after =
          anchorIdx >= 0
            ? arrival.slice(anchorIdx + 1).filter((u) => !inOverride.has(u) && !liveBranchDead.has(u))
            : [];
        setLastBranch([...liveBranchOverride, ...after]);
      } else {
        setLastBranch(branchForLeaf(mirror, leafId));
      }
      const records = [...flushed, ...ledger.liveRecords()];
      return buildBranch(lastBranch, records, snapshot, reportSkip);
    },
  };
  // The core's swap re-fold hook (duck-typed at the swap site — the
  // vendored StoreContext type stays byte-identical): a context served
  // again after records flushed past its construction-time fold MUST
  // re-fold first, or the reload builds the graph over a stale record
  // view (an empty past).
  Object.assign(ctx, { refresh });

  return {
    ctx,
    recordsRef: {
      get flushed() {
        return flushed;
      },
      get quarantinedDropped() {
        return droppedCount;
      },
    },
    isMarkerLive: (uuid: string) => lastBranchSet.has(uuid),
    lastBranch: () => lastBranch,
    setLiveBranch: (uuids: readonly string[] | null, dead?: ReadonlySet<string>) => {
      liveBranchOverride = uuids === null ? null : [...uuids];
      liveBranchDead = dead ?? new Set();
      if (liveBranchOverride !== null) setLastBranch(liveBranchOverride);
    },
    /** Re-fold + re-resolve (call at every load — the ctxFactory pattern). */
    refresh,
  };
}

/** The one-time sweep (first recall after resume; live sessions never). */
export function sweepSession(fs: FsAdapter, dir: string): Promise<SweepResult> {
  return sweepMirror(fs, dir);
}

export type { LedgerRecord, LivePredicate, MirroredRow, SweepResult };
// re-exports for the session-storage assembly (the capture wiring)
export { foldLedger, LedgerWriter, MirrorWriter, newestLiveCheck };
