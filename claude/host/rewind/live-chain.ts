// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// The live chain processor — the steady-state rewind detector. Every
// session.append event queues zero-latency (the engine never waits); a
// deferred tick (≥1 s after the first queued event — the engine's file
// writer is a 100 ms debounce queue with forced drains, so the file is
// always a beat ahead) reads the transcript TAIL through the tier, feeds
// the file's true parent edges to the mirror (patchEdges — it resolves
// through uncaptured ceremony onto the nearest captured ancestor), and
// detects rewinds: each queued row's anchor (its parent chain walked back
// to a known row, the chain tail, or a root) must equal owl's expected
// chain point. A mismatch names the settle point — everything owl holds
// after it belongs to the amputated world — and hands the refold to the
// rewind seam; nothing is patched in that tick. Rewinds amputate the file
// (the engine's own /rewind removes rows), so a queued row ABSENT from the
// tail while a later queued row is present is itself amputation evidence
// (it leaves the queue; its mirror row dies in the refold), while a
// tail-end absence is only the debounce lag (it waits for the next tick).
// A torn tail (a mid-write last line — one row can be ~100 MB) backs off
// instead of judging; a missing tier (absent file, helper crash) retries
// later — never a wrong verdict.

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
  /** feed verified file edges to the mirror (patchEdges) */
  patchEdges: (edges: readonly { uuid: string; parent: string | null }[]) => void;
  /** a detected rewind: the settle point, null = the chain's root */
  onRewind: (verdict: { settle: string | null }) => void | Promise<void>;
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
}

interface QueuedEvent {
  uuid: string;
  door: string;
  captured: boolean;
}

export class LiveChainProcessor {
  private readonly deps: LiveChainDeps;
  private readonly tickDelayMs: number;
  private readonly tornBackoffMs: number;
  private readonly minTailRows: number;
  private readonly queue: QueuedEvent[] = [];
  private timerArmed = false;
  private cancelTimer: (() => void) | null = null;
  private trackedSize: number | null = null;
  private processing = false;

  constructor(deps: LiveChainDeps, options?: LiveChainOptions) {
    this.deps = deps;
    this.tickDelayMs = options?.tickDelayMs ?? 1000;
    this.tornBackoffMs = options?.tornBackoffMs ?? 2500;
    this.minTailRows = options?.minTailRows ?? 64;
  }

  /** Queue one append event. Rows of other loops (agentId — subagent
   *  transcripts are separate files) are refused. */
  enqueue(event: { uuid: string; door: string; captured: boolean; agentId?: unknown }): boolean {
    if (event.agentId !== undefined && event.agentId !== null) return false;
    this.queue.push({ uuid: event.uuid, door: event.door, captured: event.captured });
    this.armTimer(this.tickDelayMs);
    return true;
  }

  /** Stop the processor: cancel the pending tick and drop the queue (the
   *  session is over — a dangling timer chain must not outlive it). */
  dispose(): void {
    if (this.cancelTimer !== null) {
      this.cancelTimer();
      this.cancelTimer = null;
    }
    this.timerArmed = false;
    this.queue.length = 0;
  }

  /** The eager path (turn.complete — the engine's forced drain has made
   *  the whole turn durable). Supersedes any pending deferred tick. Never
   *  throws. */
  async flush(): Promise<void> {
    if (this.cancelTimer !== null) {
      this.cancelTimer();
      this.cancelTimer = null;
      this.timerArmed = false;
    }
    await this.process();
  }

  private armTimer(ms: number): void {
    if (this.timerArmed) return;
    this.timerArmed = true;
    this.cancelTimer = this.deps.schedule(ms, () => {
      this.timerArmed = false;
      this.cancelTimer = null;
      void this.process();
    });
  }

  private retry(ms: number): void {
    this.armTimer(ms);
  }

  private async process(): Promise<void> {
    if (this.processing) return;
    this.processing = true;
    try {
      await this.tick();
    } catch (err) {
      this.deps.log(`live chain tick failed: ${String((err as { message?: unknown })?.message ?? err)}`);
      this.retry(this.tickDelayMs);
    } finally {
      this.processing = false;
    }
  }

  private async tick(): Promise<void> {
    if (this.queue.length === 0) return;
    const size = await this.deps.statSize();
    if (size === null) {
      this.deps.log("live chain: the transcript is absent — retrying");
      this.retry(this.tickDelayMs);
      return;
    }
    if (this.trackedSize !== null && size < this.trackedSize) {
      // rows were removed from the file (a rewind or manual surgery); the
      // anchor resolution below decides where the chain settles
      this.deps.log(`live chain: transcript shrank ${this.trackedSize} -> ${size}`);
    }
    const tail = await this.deps.readTail(this.queue.length + this.minTailRows);
    if (tail === null) {
      this.retry(this.tickDelayMs);
      return;
    }
    if (tail.torn) {
      this.retry(this.tornBackoffMs);
      return;
    }

    const byUuid = new Map(tail.rows.map((r) => [r.uuid, r] as const));
    // Partition the queue against the tail. The PRESENT rows (in queue
    // order == file order) are this tick's batch; an ABSENT row positioned
    // before the last present one is amputation evidence (dead); an absent
    // row after it is only the debounce lag (kept for the next tick).
    const present: QueuedEvent[] = [];
    const keep: QueuedEvent[] = [];
    let deadAbsent = 0;
    let sawPresent = false;
    for (let i = this.queue.length - 1; i >= 0; i -= 1) {
      const event = this.queue[i];
      if (event === undefined) continue;
      if (byUuid.has(event.uuid)) {
        sawPresent = true;
        present.unshift(event);
        continue;
      }
      if (sawPresent) deadAbsent += 1;
      else keep.unshift(event);
    }
    if (present.length === 0) {
      this.retry(this.tickDelayMs);
      return;
    }
    if (deadAbsent > 0) {
      this.deps.log(`live chain: ${deadAbsent} queued row(s) absent before a present one — amputation`);
    }
    const capturedByUuid = new Map(this.queue.map((e) => [e.uuid, e.captured] as const));

    let expected = this.deps.owlTailExcluding(new Set(this.queue.map((e) => e.uuid)));
    const edges: Array<{ uuid: string; parent: string | null }> = [];
    for (const event of present) {
      const row = byUuid.get(event.uuid);
      if (row === undefined) continue; // unreachable (present membership)
      edges.push({ uuid: row.uuid, parent: row.parentUuid });
      if (row.boundary) {
        // a compaction boundary: the chain's fresh root — never a rewind,
        // and the chain continues from it (captured or not: the boundary
        // row is ceremony the mirror never holds, but the file's truth is
        // that the chain restarted here)
        expected = row.uuid;
        continue;
      }
      if (row.parentUuid === null) {
        // a NON-boundary row with no parent mid-batch: the file was
        // rebuilt past everything owl holds — a rewind to the root when
        // owl had a tail, or an acceptable root when it had none
        if (expected === null) {
          if (event.captured) expected = row.uuid;
          continue;
        }
        this.deps.log(`live chain: rewind detected — row ${row.uuid} is a fresh root (expected ${String(expected)})`);
        await this.deps.onRewind({ settle: null });
        this.finishTick(keep, size);
        return;
      }
      if (!event.captured) continue; // ceremony: no owl-chain slot, no check
      const anchor = this.resolveAnchor(tail.rows, row, capturedByUuid, expected);
      if (anchor === undefined) {
        // the walk left the window before naming a known row — defer the
        // whole batch (never a wrong verdict)
        this.retry(this.tickDelayMs);
        return;
      }
      if (anchor !== expected) {
        // the file says this row attaches at a DIFFERENT point than owl's
        // chain — a rewind; the settle point names what survives
        this.deps.log(
          `live chain: rewind detected — row ${row.uuid} anchors at ${String(anchor)} (expected ${String(expected)})`,
        );
        await this.deps.onRewind({ settle: anchor });
        this.finishTick(keep, size);
        return;
      }
      expected = row.uuid;
    }

    this.deps.patchEdges(edges);
    if (deadAbsent > 0) {
      // The anchors line up, but queued rows DIED between them (the file
      // was amputated mid-chain): the surviving edges are patched first,
      // then the refold quarantines the dead (the live set runs to the
      // surviving tail; everything else on the known path is dead).
      this.deps.log(
        `live chain: rewind detected — ${deadAbsent} queued row(s) amputated before the surviving chain; refolding onto ${String(expected)}`,
      );
      await this.deps.onRewind({ settle: expected });
    }
    this.finishTick(keep, size);
  }

  /** End the tick: the queue keeps only the debounce-lag tail; the size
   *  baseline advances; a non-empty tail retries on the deferred timer. */
  private finishTick(keep: readonly QueuedEvent[], size: number): void {
    this.queue.length = 0;
    for (const event of keep) this.queue.push(event);
    this.trackedSize = size;
    if (this.queue.length > 0) this.retry(this.tickDelayMs);
  }

  /** Name the row's owl-chain anchor: the nearest PRECEDING observable
   *  row by FILE ORDER (the file is serialized — event order == file
   *  order; call/result tree links are ignored by design). Observable =
   *  a row this batch captured or one the mirror already holds. A
   *  boundary row of THIS batch names itself (the fresh root the chain
   *  restarted at); a historical boundary is walked past like any other
   *  ceremony. Returns the anchor uuid, null = the chain's root, or
   *  undefined when the walk runs off the window before naming one. */
  private resolveAnchor(
    rows: readonly TailRow[],
    row: TailRow,
    capturedByUuid: Map<string, boolean>,
    expected: string | null,
  ): string | null | undefined {
    const idx = rows.findIndex((r) => r.uuid === row.uuid);
    if (idx <= 0) {
      // no predecessors in the window: a genuine root when owl holds
      // nothing, unknowable (defer) when it does
      return expected === null ? null : undefined;
    }
    for (let i = idx - 1; i >= 0; i -= 1) {
      const prev = rows[i];
      if (prev === undefined) break;
      if (capturedByUuid.get(prev.uuid) === true) return prev.uuid;
      if (prev.boundary) return prev.uuid; // the chain's fresh root
      if (this.deps.isKnownRow(prev.uuid)) return prev.uuid;
      if (prev.uuid === expected) return prev.uuid; // the chain tail itself
    }
    return undefined;
  }
}
