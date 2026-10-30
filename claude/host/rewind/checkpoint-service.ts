// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// The rewind service: assembles the live chain's deps for a conversation
// key from the session storage + a registered prepared context. Every `$`
// literal stays OUT of this module — the register wiring injects the log
// seam (it spells log.info literally inside handler closures). One
// tripwire instance serves every key (series isolate inside); the run-lock
// surface is injected at wiring time (the same module the stage engine
// uses).

import { foldLedger } from "../storage/ledger.js";
import type { SessionStorage } from "../storage/session-storage.js";
import type { PreparedContext } from "../storage/store-context.js";
import { prepareStoreContext } from "../storage/store-context.js";
import { abortInFlight, inFlight } from "../triggers/run-locks.js";
import { foldLineage, type LineageEdge, livePathFor } from "./lineage.js";
import { TruncationTripwires } from "./tripwires.js";

/** The wiring-injected platform seams (no $ literals below this type). */
export interface PlatformThunks {
  /** The logger sink for reconciliation + skip lines. */
  logLine: (line: string) => void;
}

/** The deps the live chain (and the refold seam it drives) consumes. */
export interface CheckpointDeps {
  /** The conversation key (the main session). */
  key: string;
  /** The previously-known path (tip LAST). */
  knownPath: () => KnownRow[];
  /** The uuid-only chain tail, skipping dead + excluded rows (the live
   *  chain's per-tick base — no ts materialization); absent = derive
   *  from knownPath */
  knownTailExcluding?: (exclude: ReadonlySet<string>) => string | null;
  /** The current known tip. */
  knownTip: () => string | null;
  /** The per-conversation tripwires. */
  tripwires?: TruncationTripwires;
  /** Abort the conversation's in-flight stage runs and await their release. */
  abortAndAwaitInFlight: () => Promise<void>;
  /** The live path for a junction anchor (the mirror's edges, the lineage
   *  ledger's, or the arrival order — by edge authority). */
  liveSetFor: (p: string | null) => Promise<string[]>;
  /** Re-fold the store (quarantine + marker liveness) — the divergence
   *  move; the detected live set feeds marker liveness (the snapshot
   *  selection rule) and its order becomes the served branch. */
  refold: (
    liveSet: ReadonlySet<string>,
    liveOrder: readonly string[],
    dead: ReadonlySet<string>,
  ) => Promise<{ quarantined: number }>;
  /** Divergence notification (the caller records the dead set — the known
   *  path of FUTURE checks excludes it; a re-detected old divergence would
   *  otherwise re-fire on every clean turn). */
  onDivergence?: (p: string | null, dead: string[]) => void;
  /** Persist exact lineage edges from a verified pass (ledger + mirror). */
  appendEdges?: (edges: LineageEdge[], marker: string) => void;
  /** The logger line sink. */
  log: (line: string) => void;
}

/** One known row: its uuid and stored timestamp (arrival order lives in
 *  the mirror; the dead set is applied before the rows land here). */
export interface KnownRow {
  uuid: string;
  ts?: number;
}

/** The run-lock surface (overridable for tests; defaults to the real locks). */
export interface RunLockSurface {
  inFlight(key: string): boolean;
  abort(key: string): void;
  /** The release poll interval (ms). */
  waitMs: number;
}

const EMPTY_DEAD: ReadonlySet<string> = new Set<string>();

class RewindServiceImpl {
  private readonly tripwireState = new TruncationTripwires();
  private readonly preparedByKey = new Map<string, PreparedContext>();
  /** Dead rows per key, accumulated at each detected divergence — future
   *  checks exclude them from the known path (the detection is sticky). */
  private readonly deadByKey = new Map<string, Set<string>>();
  private locks: RunLockSurface = {
    inFlight: (key) => inFlight(key),
    abort: (key) => abortInFlight(key),
    waitMs: 25,
  };

  tripwires(): TruncationTripwires {
    return this.tripwireState;
  }

  /** Register the prepared context a key's core holds (the refold's live
   *  target — set at core creation, cleared at release). */
  register(key: string, prepared: PreparedContext): void {
    this.preparedByKey.set(key, prepared);
  }

  /** Drop a key's registered context (session end / storage release). */
  releaseKey(key: string): void {
    this.preparedByKey.delete(key);
    this.deadByKey.delete(key);
  }

  reset(): void {
    this.preparedByKey.clear();
    this.deadByKey.clear();
    this.locks = { inFlight: (key) => inFlight(key), abort: (key) => abortInFlight(key), waitMs: 25 };
  }

  /** Test seam for the run-lock surface. */
  installRunLocksForTest(locks: RunLockSurface): void {
    this.locks = locks;
  }

  /** Drop every key's state (the wiring's full reset). */
  releaseAll(): void {
    this.reset();
  }

  /** The reconciliation's dead rows for a conversation (empty until a
   *  divergence marks any): the served-branch filter's authority —
   *  dead rows never re-enter observation or the compaction context. */
  deadRowsFor(key: string): ReadonlySet<string> {
    return this.deadByKey.get(key) ?? EMPTY_DEAD;
  }

  /** Record divergence-dead rows for a conversation (the reconciliation's
   *  onDivergence seam — additive per key; the served-branch filter reads
   *  the result through deadRowsFor). */
  noteDivergenceDead(key: string, dead: readonly string[]): void {
    const set = this.deadByKey.get(key) ?? new Set<string>();
    for (const uuid of dead) set.add(uuid);
    this.deadByKey.set(key, set);
  }

  /** Assemble the deps for one conversation. */
  buildDeps(key: string, storage: SessionStorage, thunks: PlatformThunks): CheckpointDeps {
    return {
      key,
      knownPath: () => this.knownPathOf(key, storage, this.deadByKey.get(key)),
      knownTailExcluding: (exclude: ReadonlySet<string>): string | null => {
        const dead = this.deadByKey.get(key);
        const order = storage.mirror.arrivalOrder();
        for (let i = order.length - 1; i >= 0; i -= 1) {
          const uuid = order[i];
          if (uuid === undefined || exclude.has(uuid)) continue;
          if (dead?.has(uuid)) continue;
          return uuid;
        }
        return null;
      },
      knownTip: () => storage.mirror.tipUuid(),
      tripwires: this.tripwireState,
      abortAndAwaitInFlight: async () => {
        this.locks.abort(key);
        const deadline = Date.now() + 2000;
        while (this.locks.inFlight(key) && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, this.locks.waitMs));
        }
        if (this.locks.inFlight(key)) {
          thunks.logLine(
            `session-owl: rewind reconciliation — in-flight run on ${key} did not release within the deadline; continuing (the abort signal stands)`,
          );
        }
      },
      liveSetFor: async (p: string | null) => resolveLiveSet(storage, p),
      refold: async (liveSet: ReadonlySet<string>, liveOrder: readonly string[], dead: ReadonlySet<string>) => {
        const pred = (uuid: string) => liveSet.has(uuid);
        const registered = this.preparedByKey.get(key);
        if (registered !== undefined) {
          registered.setLiveBranch(liveOrder, dead);
          await registered.refresh(pred);
          return { quarantined: registered.recordsRef.quarantinedDropped };
        }
        // no core holds this key yet — an ephemeral fold still applies (and
        // counts) the quarantine; the next core creation folds the same truth
        const ephemeral = await prepareStoreContext(storage.fs, storage.dir, storage.ledger, storage.mirror);
        await ephemeral.refresh(pred);
        return { quarantined: ephemeral.recordsRef.quarantinedDropped };
      },
      onDivergence: (_p: string | null, dead: string[]) => {
        this.noteDivergenceDead(key, dead);
      },
      appendEdges: (edges: LineageEdge[], marker: string) => {
        storage.ledger.append("lineage", { edges }, marker);
        // the file's exact edges also true-up the mirror's chain: the
        // envelope carries no parentUuid, so live rows chain by arrival
        // inference — this is the pass that makes a rewound or
        // meta-row-interspersed chain real (resolve-through onto captured
        // ancestors happens inside the mirror)
        storage.mirror.patchEdges(edges);
        void storage.ledger.flush().catch((reason: unknown) => {
          thunks.logLine(
            `session-owl: lineage flush failed — buffered records kept for retry: ${reason instanceof Error ? reason.message : String(reason)}`,
          );
        });
      },
      log: (line: string) => thunks.logLine(line),
    };
  }

  /** The previously-known path (arrival order minus the dead set, each row
   *  with its stored timestamp where parseable). */
  private knownPathOf(key: string, storage: SessionStorage, dead: ReadonlySet<string> | undefined): KnownRow[] {
    void key;
    const known: KnownRow[] = [];
    for (const uuid of storage.mirror.arrivalOrder()) {
      if (dead?.has(uuid)) continue;
      const raw = storage.mirror.rowByUuid(uuid);
      const tsRaw = (raw?.row as { timestamp?: unknown } | undefined)?.timestamp;
      const ts = typeof tsRaw === "string" ? Date.parse(tsRaw) : Number.NaN;
      known.push(Number.isNaN(ts) ? { uuid } : { uuid, ts });
    }
    return known;
  }
}

/** The live path for a junction anchor, by edge authority (exported for the
 *  test harnesses — the production path routes through buildDeps):
 *  (1) the LINEAGE LEDGER — fold its exact/inferred edges and walk
 *  root..anchor (the production source: the platform append envelope
 *  carries no parentUuid, so the ledger owns the chain), (2) the mirror's
 *  own parentUuid chain when it holds real edges (length > 1, or the
 *  anchor IS the root row — a genuine rewind-to-root), (3) the arrival
 *  order. */
export async function resolveLiveSet(storage: SessionStorage, p: string | null): Promise<string[]> {
  const anchor = p ?? storage.mirror.tipUuid();
  if (anchor !== null) {
    const fold = await foldLedger(storage.fs, storage.dir);
    const edges = foldLineage([...fold.records, ...storage.ledger.bufferedRecords()]);
    const path = edges.size > 0 ? livePathFor(edges, anchor) : null;
    if (path !== null) return path;
    // The mirror fallback uses the SERVED branch (the parent chain PLUS
    // the one-level parallel-tool attachment), never the bare chain: a
    // SAME-parent parallel batch parents every result at its tool_use row
    // while the chain follows only one — the siblings are live served
    // content, and adjudicating them dead at a refold is the parallel-tool
    // defect class.
    const served = storage.mirror.servedBranch(anchor);
    const arrival = storage.mirror.arrivalOrder();
    const anchorIsRoot = arrival[0] === anchor && (storage.mirror.rowByUuid(anchor)?.parentUuid ?? null) === null;
    if (served !== null && (served.length > 1 || anchorIsRoot)) return served;
  }
  return storage.mirror.arrivalOrder();
}

const rewindServiceImpl = new RewindServiceImpl();
export const checkpointService = () => rewindServiceImpl;
