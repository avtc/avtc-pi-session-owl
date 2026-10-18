// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// The ledger: owl's append-only record batches. One NEW ledger-<batchUuid>.jsonl
// file per flushed batch (per-process-unique names — two terminals on one
// session never share a file, so the directory listing IS the union). Every
// record carries its order triple and position marker:
//
//   { producerId, seq, ts, marker, kind, payload }
//
// The fold's total order = (stored ts, producerId, seq) — deterministic, clock
// skew tolerated as accepted divergence, mtime never consulted. CHECK records
// (order fields + marker, no payload) make the blind-window quarantine
// evaluable at any process start: "records ordered after the newest LIVE
// check" are quarantined. Batch refs {producer, seq} — the mirror batch a
// record's source rows live in — are resolved onto observation records at
// record-persist time.

import { log } from "../../core/src/log.js";
import { byteLength, type FsAdapter, ROLL_MARGIN } from "./fs-adapter.js";
import { randomUUID } from "./id.js";

/** The ledger record kinds (the pi custom-entry inventory + port records). */
export type LedgerKind =
  | "observation"
  | "graph_delta"
  | "usage"
  | "selection"
  | "rescan"
  | "snapshot"
  | "SNAPSHOT_PARTS"
  | "CHECK"
  | "lineage";

/** The ledger envelope — the fold's order triple + the two position fields:
 *  `marker` (LIVENESS — the row uuid the record's content covers/rode) and
 *  `at` (ORDER — the write-tip row where pi's append position was; records
 *  interleave after their `at` row, so a backward-covering re-observe still
 *  lands AFTER a rescan written earlier, exactly pi's log order). */
export interface LedgerRecord<K extends LedgerKind = LedgerKind> {
  producerId: string;
  /** Per-producer monotonic sequence (assigned at append). */
  seq: number;
  /** Stored timestamp (ms, the producer's clock at encode time). */
  ts: number;
  /** The liveness marker: the row uuid this record was written at/covers. */
  marker: string;
  /** The write-tip row at append time (defaults to `marker`; "seed" for a
   *  record written before any row existed — the degenerate empty-session
   *  case, conservative under the all-live default). */
  at: string;
  kind: K;
  payload: unknown;
}

export interface BatchRef {
  producer: string;
  seq: number;
}

export type LivePredicate = (markerUuid: string) => boolean;

const LEDGER_PREFIX = "ledger-";
const LEDGER_SUFFIX = ".jsonl";

function batchFileName(batchUuid: string, part: number): string {
  return part === 0
    ? `${LEDGER_PREFIX}${batchUuid}${LEDGER_SUFFIX}`
    : `${LEDGER_PREFIX}${batchUuid}.${part}${LEDGER_SUFFIX}`;
}

// ---- writer ---------------------------------------------------------------------

export class LedgerWriter {
  readonly producerId: string;
  private seq = 0;
  private buffer: string[] = [];
  /** Mirror batch refs awaiting the NEXT observation record (one slot:
   *  resolved at record-persist time; unflushed rows carry no ref). */
  private nextObsRefs: BatchRef[] | null = null;

  constructor(
    private readonly fs: FsAdapter,
    private readonly dir: string,
    producerId: string,
    private clock: () => number = Date.now,
  ) {
    this.producerId = producerId;
  }

  /** Append a record; returns its ledger id (producerId:seq). */
  append(kind: LedgerKind, payload: unknown, marker: string, at: string = marker): string {
    this.seq += 1;
    const record: LedgerRecord = {
      producerId: this.producerId,
      seq: this.seq,
      ts: this.clock(),
      marker,
      at,
      kind,
      payload,
    };
    if (kind === "observation" && this.nextObsRefs !== null) {
      (record as LedgerRecord & { batchRefs?: BatchRef[] }).batchRefs = this.nextObsRefs;
      this.nextObsRefs = null;
    }
    this.buffer.push(JSON.stringify(record));
    return `${this.producerId}:${this.seq}`;
  }

  /** Attach the mirror batch refs to the NEXT observation record (resolved at
   *  record-persist time; rows not yet flushed carry no ref — callers pass
   *  refs only for rows already in a flushed batch). */
  refsForNextObservation(refs: BatchRef[]): void {
    this.nextObsRefs = refs;
  }

  /** Records skipped at flush for exceeding the unsplittable-line budget. */
  skippedOversized = 0;

  /** The running flush (serialized — see flush()). */
  private activeFlush: Promise<string[]> | null = null;
  /** The one queued trailing flush (coalesced). */
  private queuedFlush: Promise<string[]> | null = null;

  /** Write the buffered records as one-or-more NEW batch files.
   *
   *  SERIALIZED (one writer at a time): a call while a flush is in flight
   *  QUEUES exactly one trailing run behind it (coalesced) instead of
   *  starting a second writer — no overlapping file writes ever, and a
   *  record appended during an active flush rides the trailing run. Every
   *  batch also gets a fresh uuid (later flushes never rewrite an earlier
   *  file); the serialization is what makes the buffer hand-off itself
   *  exactly-once under the mutate → flush pipeline.
   *
   *  One run: records of one hook dispatch coalesce into the same batch;
   *  the split only fires past the roll margin. A SINGLE record whose line
   *  exceeds the margin is unsplittable (lines are atomic) and would poison
   *  the whole buffer — it is skipped with a warn instead (the
   *  tolerant-reader class; the record's range re-observes on the next
   *  pass). The buffer is consumed per written part, so a mid-flush write
   *  failure retries without duplicating the already-written prefix. */
  flush(): Promise<string[]> {
    if (this.queuedFlush !== null) return this.queuedFlush;
    if (this.activeFlush !== null) {
      const queued = this.activeFlush.then(
        () => this.flushBuffered(),
        () => this.flushBuffered(),
      );
      this.queuedFlush = queued;
      const clearQueued = (): void => {
        if (this.queuedFlush === queued) this.queuedFlush = null;
      };
      queued.then(clearQueued, clearQueued);
      return queued;
    }
    const active = this.flushBuffered();
    this.activeFlush = active;
    const clearActive = (): void => {
      if (this.activeFlush === active) this.activeFlush = null;
    };
    active.then(clearActive, clearActive);
    return active;
  }

  private async flushBuffered(): Promise<string[]> {
    if (this.buffer.length === 0) return [];
    const batchUuid = randomUUID();
    const written: string[] = [];
    // PRE-FILTER: oversized lines are unsplittable (atomic) and are skipped
    // up front — before any partial write — so a mid-flush failure never
    // strands a fitting record between the local lines[] and the buffer.
    const pending: string[] = [];
    for (const line of this.buffer) {
      if (byteLength(line) + 1 > ROLL_MARGIN) {
        console.warn(`session-owl: ledger record exceeds the split budget (${byteLength(line)} bytes) — skipped`);
        this.skippedOversized += 1;
        continue;
      }
      pending.push(line);
    }
    this.buffer = [];
    // sync visibility: the drained records stay SERVABLE (liveRecords) the
    // moment the flush starts — the branch view never flaps mid-await
    this.writtenSinceFlush.push(...pending.map((line) => JSON.parse(line) as LedgerRecord));
    let consumed = 0; // fitting lines already durable
    try {
      let part = 0;
      let lines: string[] = [];
      let bytes = 0;
      const writePart = async () => {
        if (lines.length === 0) return;
        const name = batchFileName(batchUuid, part);
        await this.fs.writeText(`${this.dir}/${name}`, `${lines.join("\n")}\n`);
        written.push(name);
        consumed += lines.length; // the written prefix is durable
        part += 1;
        lines = [];
        bytes = 0;
      };
      for (const line of pending) {
        if (bytes + byteLength(line) + 1 > ROLL_MARGIN) await writePart();
        lines.push(line);
        bytes += byteLength(line) + 1;
      }
      await writePart();
    } finally {
      // the unwritten fitting tail stays retryable — PREPENDED to whatever
      // arrived while the flush awaited (appends during a flush are kept,
      // never overwritten); it leaves the live view once it returns to the
      // buffer (the retry re-registers it exactly once)
      const unwritten = pending.slice(consumed);
      if (unwritten.length > 0) {
        const back = new Set(
          unwritten.map((line) => {
            const record = JSON.parse(line) as LedgerRecord;
            return `${record.producerId}:${record.seq}`;
          }),
        );
        this.writtenSinceFlush = this.writtenSinceFlush.filter(
          (record) => !back.has(`${record.producerId}:${record.seq}`),
        );
        this.buffer = [...unwritten, ...this.buffer];
      }
    }
    return written;
  }

  /** Records already durable in THIS process's batch files, oldest first —
   *  the live branch view keeps serving them until the next re-fold reads
   *  them from disk (the mutate → flush pipeline drained them out of
   *  `bufferedRecords()`). */
  private writtenSinceFlush: LedgerRecord[] = [];

  /** The live view: this process's durable writes ∪ the still-buffered
   *  records (what the branch serves alongside the load-time fold). */
  liveRecords(): LedgerRecord[] {
    return [...this.writtenSinceFlush, ...this.bufferedRecords()];
  }

  /** Called at a re-fold (the disk read just re-claimed these records). */
  dropWrittenForRefold(): void {
    this.writtenSinceFlush = [];
  }

  /** Test/inspect: records currently buffered (not yet flushed). */
  pendingCount(): number {
    return this.buffer.length;
  }

  /** The buffered records parsed back (the live in-memory view a sync
   *  getBranch serves alongside the flushed fold — pi's session log shows
   *  just-appended entries the same way). */
  bufferedRecords(): LedgerRecord[] {
    return this.buffer.map((line) => JSON.parse(line) as LedgerRecord);
  }
}

// ---- fold -----------------------------------------------------------------------

export interface FoldResult {
  /** All records in fold order (ts, producerId, seq). */
  records: LedgerRecord[];
  /** Batch files that failed to read/parse entirely (orphans, tolerated). */
  unreadableFiles: string[];
  /** Individual lines skipped (corrupt, tolerated — same class as pi's
   *  skipped bad deltas). */
  skippedLines: number;
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Fold every ledger batch in the directory into the total order. */
export async function foldLedger(fs: FsAdapter, dir: string): Promise<FoldResult> {
  let names: string[];
  try {
    names = await fs.listDir(dir);
  } catch (err) {
    log.info(`ledger fold: session dir unreadable (${dir}) — fresh-session truth: ${errText(err)}`);
    // a missing session directory is the fresh-session truth: no records
    names = [];
  }
  const records: LedgerRecord[] = [];
  const unreadableFiles: string[] = [];
  let skippedLines = 0;
  for (const name of names) {
    if (!name.startsWith(LEDGER_PREFIX) || !name.endsWith(LEDGER_SUFFIX)) continue;
    let text: string;
    try {
      text = await fs.readText(`${dir}/${name}`);
    } catch (err) {
      log.info(`ledger fold: batch unreadable, skipped (${name}): ${errText(err)}`);
      unreadableFiles.push(name);
      continue;
    }
    for (const line of text.split("\n")) {
      if (line.length === 0) continue;
      try {
        records.push(JSON.parse(line) as LedgerRecord);
      } catch (err) {
        log.info(`ledger fold: malformed line dropped in ${name}: ${line.slice(0, 60)} — ${errText(err)}`);
        skippedLines += 1;
      }
    }
  }
  records.sort((a, b) => {
    if (a.ts !== b.ts) return a.ts - b.ts;
    if (a.producerId !== b.producerId) return a.producerId < b.producerId ? -1 : 1;
    return a.seq - b.seq;
  });
  return { records, unreadableFiles, skippedLines };
}

// ---- quarantine -----------------------------------------------------------------

/** The newest live CHECK record in fold order (null when none). */
export function newestLiveCheck(records: LedgerRecord[], isLive: LivePredicate): LedgerRecord | null {
  let newest: LedgerRecord | null = null;
  for (const r of records) {
    if (r.kind !== "CHECK") continue;
    if (!isLive(r.marker)) continue;
    if (newest === null || newer(r, newest)) newest = r;
  }
  return newest;
}

function newer(a: LedgerRecord, b: LedgerRecord): boolean {
  if (a.ts !== b.ts) return a.ts > b.ts;
  if (a.producerId !== b.producerId) return a.producerId > b.producerId;
  return a.seq > b.seq;
}

/**
 * The blind-window quarantine: every record ordered AFTER the newest live
 * CHECK is dropped (its content may derive from undetected dead-tail state);
 * records up to and including that check are kept. With no live check,
 * everything is kept (the fresh-session truth).
 */
export function quarantineAfterLastLiveCheck(
  records: LedgerRecord[],
  isLive: LivePredicate,
): { kept: LedgerRecord[]; dropped: LedgerRecord[] } {
  const check = newestLiveCheck(records, isLive);
  if (check === null) return { kept: [...records], dropped: [] };
  const kept: LedgerRecord[] = [];
  const dropped: LedgerRecord[] = [];
  for (const r of records) {
    if (newer(r, check)) dropped.push(r);
    else kept.push(r);
  }
  return { kept, dropped };
}
