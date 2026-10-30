// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// The live chain processor — the steady-state rewind detector. Every
// session.append event queues zero-latency (the engine never waits); a
// deferred tick (re-armed on every event, ≥1 s after the LAST one — the
// engine's file writer is a 100 ms debounce queue with forced drains, so
// the file is always a beat ahead) or the turn-complete flush reads the
// transcript TAIL through the tier, verifies each queued captured row
// against owl's expected chain point, and feeds the file's true parent
// edges to the lineage seam (ledger + mirror — the ledger owns the chain
// the refold walks). An anchor mismatch REBASES the expectation and the
// batch keeps verifying: the whole new world is proven before the verdict
// fires, so the refold settles at the last verified row and nothing of
// the post-rewind world is ever quarantined. A boundary row (or a
// boundary anchor) resets the chain the same way — silently, never a
// verdict. Rewinds amputate the file, so a queued row ABSENT from the
// tail while a later queued row is present is itself amputation evidence
// (it leaves the queue; its mirror row dies in the refold), while a
// tail-end absence is only the debounce lag (it waits for the next tick).
// A torn tail (a mid-write last line — one row can be ~100 MB) backs off
// instead of judging; a missing tier (absent file, helper crash) retries
// with a growing window and a capped backoff — never a wrong verdict.

import type { TailFacts, TailRow } from "./tail-read.js";

export interface LiveChainDeps {
  /** the transcript's current byte size (null = the file is gone) */
  statSize: () => Promise<number | null>;
  /** the tail read (all tiers, degrading to null) */
  readTail: (maxRows: number) => Promise<TailFacts | null>;
  /** the chain's expected base: the mirror's last live row EXCLUDING the
   *  queued ones (capture happens at append time, so the mirror's tail
   *  already contains this batch — the base must name what came before). */
  owlTailExcluding: (exclude: ReadonlySet<string>) => string | null;
  /** does the mirror hold this row? (the anchor walk's known-row test) */
  isKnownRow: (uuid: string) => boolean;
  /** feed verified file edges to the lineage seam (the durable ledger
   *  record AND the mirror's own chain — the refold resolves live sets
   *  through the ledger, so both must carry the file's truth) */
  patchEdges: (edges: readonly { uuid: string; parent: string | null }[]) => void;
  /** a detected rewind: the settle point = the last verified row (null =
   *  the chain's root); everything else on the known path is dead */
  onRewind: (verdict: { settle: string | null }) => void | Promise<void>;
  /** dormant (disabled or conflict-paused): a deferred tick drops its
   *  queue instead of verifying — the flush path re-checks the same gate */
  dormant?: () => boolean;
  /** one-shot timer (the wiring's clock seam); returns a cancel */
  schedule: (ms: number, fn: () => void) => () => void;
  log: (message: string) => void;
}

export interface LiveChainOptions {
  /** the deferred tick's delay (default 1000 ms) */
  tickDelayMs?: number;
  /** the torn-tail retry delay (default 2500 ms) */
  tornBackoffMs?: number;
  /** the tail window's floor (default 64 rows) */
  minTailRows?: number;
  /** the retry backoff's ceiling (default 30000 ms) */
  maxRetryMs?: number;
  /** the tail window's ceiling (default 4096 rows) */
  maxTailRows?: number;
}

interface QueuedEvent {
  uuid: string;
  captured: boolean;
}

/** A pending batch larger than this can never resolve inside the read
 *  window — shed the oldest rows and keep the verifier live. */
const MAX_QUEUE = 4096;
/** Consecutive unresolved ticks before the pending batch is shed. */
const MAX_RETRIES = 5;
/** The window-growth ladder's cap (2^6 = 64x the floor). */
const GROWTH_LADDER_CAP = 6;
/** Uuid sanity bound — transcript rows are engine-written; anything past
 *  this is foreign padding, never a chain identity. */
const MAX_UUID = 128;

/** The anchor a row's walk-back names. */
interface Anchor {
  uuid: string | null;
  /** the anchor is a compaction boundary — the chain's fresh root */
  boundary: boolean;
}

export class LiveChainProcessor {
  private readonly deps: LiveChainDeps;
  private readonly tickDelayMs: number;
  private readonly tornBackoffMs: number;
  private readonly minTailRows: number;
  private readonly maxRetryMs: number;
  private readonly maxTailRows: number;
  private readonly queue: QueuedEvent[] = [];
  private timerArmed = false;
  private cancelTimer: (() => void) | null = null;
  private trackedSize: number | null = null;
  private processing: Promise<void> | null = null;
  private retries = 0;
  private disposed = false;

  constructor(deps: LiveChainDeps, options?: LiveChainOptions) {
    this.deps = deps;
    this.tickDelayMs = options?.tickDelayMs ?? 1000;
    this.tornBackoffMs = options?.tornBackoffMs ?? 2500;
    this.minTailRows = options?.minTailRows ?? 64;
    this.maxRetryMs = options?.maxRetryMs ?? 30000;
    this.maxTailRows = options?.maxTailRows ?? 4096;
  }

  /** Queue one append event. Rows of other loops (agentId — subagent
   *  transcripts are separate files) are refused. Re-arms the deferred
   *  tick so it fires after the LAST event, not the first. */
  enqueue(event: { uuid: string; door: string; captured: boolean; agentId?: unknown }): boolean {
    if (event.agentId !== undefined && event.agentId !== null) return false;
    if (event.uuid.length > MAX_UUID) return false; // engine uuids are sane
    if (this.queue.length >= MAX_QUEUE) {
      // an unbounded pending batch would wedge every later tick to the
      // same unread anchor — shed the oldest and keep detecting
      this.deps.log(`live chain: queue cap reached (${MAX_QUEUE}) — shedding the oldest pending rows`);
      this.queue.splice(0, this.queue.length - MAX_QUEUE + 1);
    }
    this.queue.push({ uuid: event.uuid, captured: event.captured });
    if (!this.stoodDown) this.armTimer(this.tickDelayMs, true);
    return true;
  }

  /** Stop the processor: cancel the pending tick, drop the queue, and pin
   *  it dead — an in-flight tick's completion paths all check the flag,
   *  so nothing re-arms, restores or reads after this (the session is
   *  over; a dangling chain must not outlive its storage). */
  dispose(): void {
    this.disposed = true;
    if (this.cancelTimer !== null) {
      this.cancelTimer();
      this.cancelTimer = null;
    }
    this.timerArmed = false;
    this.queue.length = 0;
  }

  /** A verdict detected in a deferring flush context, parked for its
   *  timer-lane application (the refold re-folds the whole ledger — on a
   *  multi-GB store that far exceeds a hook budget, so the hook returns
   *  and the plugin timer applies it). */
  private pendingRewind: { settle: string | null } | null = null;
  /** Whether the CURRENT flush context parks verdicts instead of applying
   *  them inline. */
  private deferVerdictsNow = false;

  /** The eager path (turn.complete — the engine's forced drain has made
   *  the whole turn durable). Supersedes any pending deferred tick; waits
   *  out an in-flight tick and runs once more so this flush never
   *  resolves while rows sit unverified. Never throws. `deferVerdicts`
   *  parks a detected verdict's application on the timer lane (a
   *  serve-class caller leaves it inline — the compaction gate must read
   *  a folded store). */
  async flush(opts: { deferVerdicts?: boolean } = {}): Promise<void> {
    if (this.cancelTimer !== null) {
      this.cancelTimer();
      this.cancelTimer = null;
      this.timerArmed = false;
    }
    if (this.processing !== null) {
      await this.processing; // process() never rejects (its catch arms the retry)
    }
    if (!opts.deferVerdicts) await this.applyPendingRewind();
    this.deferVerdictsNow = opts.deferVerdicts === true;
    try {
      await this.process();
    } finally {
      this.deferVerdictsNow = false;
    }
  }

  /** Whether a detected verdict sits parked awaiting its timer-lane
   *  application (the deferring flush returned before the refold ran). */
  hasPendingRewind(): boolean {
    return this.pendingRewind !== null;
  }

  /** Apply a parked verdict; a failure re-parks and re-arms (a detected
   *  rewind is never silently dropped). */
  private async applyPendingRewind(): Promise<void> {
    const verdict = this.pendingRewind;
    if (verdict === null) return;
    this.pendingRewind = null;
    try {
      await this.deps.onRewind(verdict);
    } catch (err) {
      this.deps.log(
        `live chain: parked verdict application failed — re-armed: ${String((err as { message?: unknown })?.message ?? err)}`,
      );
      this.pendingRewind = verdict;
      this.retry(this.backoffMs());
    }
  }

  private armTimer(ms: number, rearm = false): void {
    if (this.timerArmed && !rearm) return;
    if (this.cancelTimer !== null) this.cancelTimer();
    this.timerArmed = true;
    this.cancelTimer = this.deps.schedule(ms, () => {
      this.timerArmed = false;
      this.cancelTimer = null;
      // a parked verdict rides the head of the lane (applied before any
      // further verification)
      void (async () => {
        if (this.processing !== null) await this.processing;
        await this.applyPendingRewind();
        if (!this.disposed) await this.process();
      })();
    });
  }

  /** Detection stood down (the tail tier cannot serve this transcript):
   *  the TIMER LANE stops — no busy retry loop — while the per-turn eager
   *  check keeps attempting; a tier that serves again revives detection
   *  (the documented reconciliation: transient failures heal at the next
   *  successful check). */
  private stoodDown = false;

  private standDown(reason: string): void {
    if (this.stoodDown) return;
    this.stoodDown = true;
    if (this.cancelTimer !== null) {
      this.cancelTimer();
      this.cancelTimer = null;
    }
    this.timerArmed = false;
    this.deps.log(
      `live chain: detection stands down — ${reason} (the timer lane stops; the per-turn check keeps attempting, a serving tier revives it); capture/observation/compaction run as-is on inferred edges`,
    );
  }

  private revive(): void {
    if (!this.stoodDown) return;
    this.stoodDown = false;
    this.deps.log("live chain: detection resumed — the tail tier serves again");
  }

  private retry(ms: number): void {
    if (this.disposed || this.stoodDown) return;
    this.armTimer(ms);
  }

  /** Drop the pending batch after it stayed unresolved past the bound:
   *  the ticks were wedged on the same unreachable anchor — shedding lets
   *  later rows verify again (the shed rows keep their captures; the next
   *  sweep or rewind verdict re-adjudicates them). */
  private shedPending(): void {
    this.queue.length = 0;
    this.retries = 0;
  }

  private async process(): Promise<void> {
    if (this.disposed || this.processing !== null) return;
    const run = this.tick().catch((err: unknown) => {
      this.deps.log(`live chain tick failed: ${String((err as { message?: unknown })?.message ?? err)}`);
      this.retries = Math.min(this.retries + 1, MAX_RETRIES);
      this.retry(this.backoffMs());
    });
    this.processing = run;
    try {
      await run;
    } finally {
      this.processing = null;
    }
  }

  /** The retry delay grows with consecutive failures (torn reads, absent
   *  tiers, walk-offs) and caps; a clean tick resets the ladder. */
  private backoffMs(): number {
    return Math.min(this.tickDelayMs * 2 ** this.retries, this.maxRetryMs);
  }

  /** The tail window grows with consecutive failures: a walk-off means
   *  the anchor sits further back than the window reached. */
  private windowRows(): number {
    const grown = this.minTailRows * 2 ** Math.min(this.retries, GROWTH_LADDER_CAP);
    return Math.min(this.queue.length + grown, this.maxTailRows);
  }

  private async tick(): Promise<void> {
    if (this.queue.length === 0) return;
    if (this.deps.dormant?.()) {
      this.queue.length = 0;
      this.deps.log("live chain: dormant — queue dropped");
      return;
    }
    const size = await this.deps.statSize();
    if (size === null) {
      this.deps.log("live chain: the transcript is absent — retrying");
      this.retries = Math.min(this.retries + 1, MAX_RETRIES);
      this.retry(this.backoffMs());
      return;
    }
    if (this.trackedSize !== null && size < this.trackedSize) {
      // rows were removed from the file (a rewind or manual surgery); the
      // anchor resolution below decides where the chain settles
      this.deps.log(`live chain: transcript shrank ${this.trackedSize} -> ${size}`);
    }
    const tail = await this.deps.readTail(this.windowRows());
    if (tail === null) {
      this.retries = Math.min(this.retries + 1, MAX_RETRIES);
      if (this.retries >= MAX_RETRIES) {
        // the tier cannot serve this transcript (a surface without the
        // process seam, a broken helper) — the timer lane stops instead of
        // retrying forever; the per-turn eager check keeps attempting, and
        // a tier that serves again revives the lane (the reconciliation)
        this.standDown("the tail tier cannot serve this transcript");
        return;
      }
      this.retry(this.backoffMs());
      return;
    }
    this.revive();
    if (tail.torn) {
      this.retries = Math.min(this.retries + 1, MAX_RETRIES);
      this.retry(this.tornBackoffMs);
      return;
    }

    // absurd uuids never enter the window (the parentUuid is never read
    // for anchors — file order rules — and ceremony parents are fed only
    // when the window itself carries them, so a huge parent string is
    // inert comparison input, never stored)
    const sane = tail.rows.filter((r) => r.uuid.length <= MAX_UUID);
    const byUuid = new Map(sane.map((r) => [r.uuid, r] as const));
    // Partition the queue against the tail. The PRESENT rows (in queue
    // order == file order) are this tick's batch; an absent CAPTURED row
    // positioned before the last present one is amputation evidence (it
    // was mirrored — the file no longer carries it); an absent UNCERTAIN
    // row (ceremony the engine never persists) simply leaves the queue —
    // it never had a file slot, so its absence proves nothing; an absent
    // row after the last present one is only the debounce lag (kept).
    const present: QueuedEvent[] = [];
    const keep: QueuedEvent[] = [];
    const amputated: QueuedEvent[] = [];
    let sawPresent = false;
    for (let i = this.queue.length - 1; i >= 0; i -= 1) {
      const event = this.queue[i];
      if (event === undefined) continue;
      if (byUuid.has(event.uuid)) {
        sawPresent = true;
        present.unshift(event);
        continue;
      }
      if (!sawPresent) keep.unshift(event);
      else if (event.captured) amputated.unshift(event);
      // an uncaptured absent row behind a present one: never-persisted
      // ceremony — dropped without evidence
    }
    const deadAbsent = amputated.length;
    if (present.length === 0) {
      this.retries = Math.min(this.retries + 1, MAX_RETRIES);
      this.retry(this.backoffMs());
      return;
    }
    if (deadAbsent > 0) {
      this.deps.log(`live chain: ${deadAbsent} queued row(s) absent before a present one — amputation`);
    }
    const capturedByUuid = new Map(this.queue.map((e) => [e.uuid, e.captured] as const));
    const indexOfUuid = new Map(sane.map((r, i) => [r.uuid, i] as const));

    // Verify the whole batch against the expected chain point. A mismatch
    // does NOT fire immediately: the expectation rebases onto the row's
    // anchor and the batch keeps verifying, so the verdict (if one is due)
    // fires only after the new world is proven end-to-end — the settle
    // point is then the LAST VERIFIED row and the refold's live set (walked
    // through the freshly fed edges) contains every surviving row,
    // including the queued ones. A boundary anchor rebases silently.
    let expected = this.deps.owlTailExcluding(new Set(this.queue.map((e) => e.uuid)));
    let rewound = false;
    const edges: Array<{ uuid: string; parent: string | null }> = [];
    const ceremonyEdge = (row: TailRow): { uuid: string; parent: string | null } => ({
      uuid: row.uuid,
      parent: row.parentUuid !== null && byUuid.has(row.parentUuid) ? row.parentUuid : null,
    });
    for (const event of present) {
      const row = byUuid.get(event.uuid);
      if (row === undefined) continue; // unreachable (present membership)
      if (row.boundary) {
        // the chain's fresh root: the boundary edge marks it (the mirror
        // never holds the row; the ledger keeps the reset point)
        edges.push({ uuid: row.uuid, parent: null });
        // a compaction boundary: the chain's fresh root — never a rewind,
        // and the chain continues from it (captured or not: the boundary
        // row is ceremony the mirror never holds, but the file's truth is
        // that the chain restarted here)
        expected = row.uuid;
        continue;
      }
      if (row.parentUuid === null) {
        // a NON-boundary row with no parent: the chain's root. When owl
        // held nothing it is the first row of a fresh session; otherwise
        // the file was rebuilt past everything owl holds.
        if (expected === null) {
          if (event.captured) {
            edges.push({ uuid: row.uuid, parent: null });
            expected = row.uuid;
          }
          continue;
        }
        this.deps.log(`live chain: rewind detected — row ${row.uuid} is a fresh root (expected ${String(expected)})`);
        rewound = true;
        if (event.captured) {
          edges.push({ uuid: row.uuid, parent: null });
          expected = row.uuid;
        }
        continue;
      }
      if (!event.captured) {
        edges.push(ceremonyEdge(row)); // no owl-chain slot; the file's own
        // parent only when it names a window row
        continue;
      }
      const anchor = this.resolveAnchor(tail.rows, indexOfUuid, row, capturedByUuid, expected);
      if (anchor === undefined) {
        // the walk left the window before naming a known row — defer the
        // batch (never a wrong verdict); the window grows on retry, and a
        // batch that NEVER resolves is eventually shed so later rows can
        // still be verified
        this.retries = Math.min(this.retries + 1, MAX_RETRIES);
        if (this.retries >= MAX_RETRIES) {
          this.deps.log(
            `live chain: the anchor for row ${row.uuid} stayed outside the read window for ${this.retries} ticks — shedding the batch (detection continues with later rows)`,
          );
          this.shedPending();
          return;
        }
        this.retry(this.backoffMs());
        return;
      }
      // the edge this row contributes is its VERIFIED anchor (the nearest
      // preceding observable row) — never the raw file parent string
      const anchorEdge = { uuid: row.uuid, parent: anchor.uuid };
      if (anchor.uuid === expected && !anchor.boundary) {
        edges.push(anchorEdge);
        expected = row.uuid;
        continue;
      }
      if (anchor.boundary) {
        // the anchor is a compaction boundary (this batch's or a
        // historical one): the chain restarted there — rebase, never a
        // verdict
        edges.push(anchorEdge);
        expected = anchor.uuid;
        continue;
      }
      // the file says this row attaches at a DIFFERENT point than owl's
      // chain — a rewind; rebase and keep verifying the new world
      this.deps.log(
        `live chain: rewind detected — row ${row.uuid} anchors at ${String(anchor.uuid)} (expected ${String(expected)})`,
      );
      rewound = true;
      edges.push(anchorEdge);
      expected = row.uuid;
    }

    // the file's verified edges are durable BEFORE any verdict: the
    // refold resolves live sets through the ledger, and the dead-absent
    // rows' surviving siblings must already chain by file truth
    this.deps.patchEdges(edges);
    if (rewound || deadAbsent > 0) {
      // the settle point is the LAST VERIFIED row — the new world's tip.
      // The refold's live set (walked through the freshly fed edges)
      // contains every surviving row, queued ones included; everything
      // else on the known path is dead.
      this.deps.log(
        `live chain: ${deadAbsent} amputated row(s), settle at ${String(expected)} — refolding onto the verified chain`,
      );
      if (this.deferVerdictsNow) {
        // the application re-folds the whole ledger — park it on the timer
        // lane so this hook returns inside its budget; the serve-class
        // flushes apply it inline before they read the store
        this.deps.log(
          "live chain: verdict parked — the application runs on the timer lane (the hook budget stays free)",
        );
        this.pendingRewind = { settle: expected };
        this.armTimer(0);
      } else {
        await this.deps.onRewind({ settle: expected });
      }
    }
    this.finishTick(present, amputated, size);
  }

  /** End the tick: the processed rows leave the queue (anything enqueued
   *  DURING the tick — including through the refold's await — stays), the
   *  size baseline advances, a non-empty remainder retries on the deferred
   *  timer. */
  private finishTick(present: readonly QueuedEvent[], amputated: readonly QueuedEvent[], size: number): void {
    if (this.disposed) return;
    const done = new Set<string>();
    for (const e of present) done.add(e.uuid);
    for (const e of amputated) done.add(e.uuid); // dead rows never return
    const remaining = this.queue.filter((e) => !done.has(e.uuid));
    this.queue.length = 0;
    for (const e of remaining) this.queue.push(e);
    this.trackedSize = size;
    this.retries = 0;
    if (this.queue.length > 0) this.retry(this.tickDelayMs);
  }

  /** Name the row's owl-chain anchor: the nearest PRECEDING observable
   *  row by FILE ORDER (the file is serialized — event order == file
   *  order; call/result tree links are ignored by design). Observable = a
   *  row this batch captured or one the mirror already holds; a boundary
   *  row is named as the fresh root it is. Returns the anchor, or
   *  undefined when the walk runs off the window before naming one. */
  private resolveAnchor(
    rows: readonly TailRow[],
    indexOfUuid: ReadonlyMap<string, number>,
    row: TailRow,
    capturedByUuid: Map<string, boolean>,
    expected: string | null,
  ): Anchor | undefined {
    // PARENT-CHAIN-FIRST: the row's own parentUuid links are the file's
    // attachment truth. Walk up through transparent ceremony rows to the
    // nearest ancestor owl knows — a rewound conversation re-sends its
    // first row as a FRESH row forking at an earlier point, and that
    // fork is invisible to file-order proximity (the re-sent row sits at
    // the file tail, right after the rows it orphans).
    let cursor: string | null = row.parentUuid;
    const walked = new Set<string>();
    while (cursor !== null && !walked.has(cursor) && indexOfUuid.has(cursor)) {
      walked.add(cursor);
      const cr = rows[indexOfUuid.get(cursor) ?? -1];
      if (cr === undefined) break;
      if (cr.boundary) return { uuid: cursor, boundary: true }; // a compaction boundary — rebase, never a verdict
      if (cursor === expected) return { uuid: cursor, boundary: false }; // the chain tail itself
      if (capturedByUuid.get(cursor) === true || this.deps.isKnownRow(cursor)) {
        return { uuid: cursor, boundary: false }; // the true attach point
      }
      cursor = cr.parentUuid; // ceremony/unknown rows are transparent
    }
    const idx = indexOfUuid.get(row.uuid) ?? -1;
    if (idx <= 0) {
      // no predecessors in the window: a genuine root when owl holds
      // nothing, unknowable (defer) when it does
      return expected === null ? { uuid: null, boundary: false } : undefined;
    }
    for (let i = idx - 1; i >= 0; i -= 1) {
      const prev = rows[i];
      if (prev === undefined) break;
      if (capturedByUuid.get(prev.uuid) === true) return { uuid: prev.uuid, boundary: false };
      if (prev.boundary) return { uuid: prev.uuid, boundary: true };
      if (this.deps.isKnownRow(prev.uuid)) return { uuid: prev.uuid, boundary: false };
      if (prev.uuid === expected) return { uuid: prev.uuid, boundary: false }; // the chain tail itself
    }
    // the window holds no observable predecessor: with an empty chain this
    // row simply starts it; otherwise the anchor is unknowable here
    return expected === null ? { uuid: null, boundary: false } : undefined;
  }
}
