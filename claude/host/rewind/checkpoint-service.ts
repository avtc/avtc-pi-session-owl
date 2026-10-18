// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// The checkpoint service: assembles the reconciliation deps for a
// conversation key from the session storage + a registered prepared
// context. Every `$` literal stays OUT of this module — the register
// wiring injects the api-fingerprint and transcript-text thunks (they
// spell $.session.messages / $.fs.read literally inside handler closures).
// One tripwire instance serves every key (series isolate inside); the
// run-lock surface is injected at wiring time (the same module the stage
// engine uses).

import { foldLedger } from "../storage/ledger.js";
import type { SessionStorage } from "../storage/session-storage.js";
import type { PreparedContext } from "../storage/store-context.js";
import { prepareStoreContext } from "../storage/store-context.js";
import { abortInFlight, inFlight } from "../triggers/run-locks.js";
import type { Fingerprint, KnownRow } from "./canonical-check.js";
import { fingerprintBlocks } from "./canonical-check.js";
import { foldLineage, type LineageEdge, livePathFor } from "./lineage.js";
import { type CheckpointDeps, runCheckpoint } from "./reconcile.js";
import { TruncationTripwires } from "./tripwires.js";
import type { TranscriptPass } from "./verifier.js";

/** The wiring-injected platform thunks (no $ literals below this type). */
export interface PlatformThunks {
  /** The canonical view's fingerprints — `messages({as:"api"})` mapped. */
  apiFingerprints: () => Promise<Fingerprint[]>;
  /** The messages() rows form uuids where available (null = unavailable). */
  rowUuids?: () => Promise<string[] | null>;
  /** The transcript file's text where readable; null = unavailable. */
  transcriptText?: () => Promise<string | null>;
  /** The pre-parsed transcript pass (the over-cap CLI helper route);
   *  null = the tier is missing. Preferred over transcriptText. */
  transcriptPass?: () => Promise<TranscriptPass | null>;
  /** The logger sink for reconciliation + skip lines. */
  logLine: (line: string) => void;
}

/** The run-lock surface (overridable for tests; defaults to the real locks). */
export interface RunLockSurface {
  inFlight(key: string): boolean;
  abort(key: string): void;
  /** The release poll interval (ms). */
  waitMs: number;
}

const EMPTY_DEAD: ReadonlySet<string> = new Set<string>();

class CheckpointServiceImpl {
  private readonly tripwireState = new TruncationTripwires();
  private readonly preparedByKey = new Map<string, PreparedContext>();
  /** Cached fingerprints per key → uuid. The value keeps the row OBJECT the
   *  fingerprint was computed from: a re-buffered/re-adopted row (same uuid,
   *  fresh object) invalidates by identity — mirror rows are immutable in
   *  practice, and the reference compare makes the cache safe even where
   *  they are not. Keeps the per-turn checkpoint off the O(session-content)
   *  recompute path (it runs at EVERY turn.complete). */
  private readonly fpByKey = new Map<string, Map<string, { src: object; f: Fingerprint }>>();
  private fpComputes = 0;
  /** Dead rows per key, accumulated at each detected divergence — future
   *  checks exclude them from the known path (the detection is sticky). */
  private readonly deadByKey = new Map<string, Set<string>>();

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
  /** The newest observed door-compaction row per key (the alignment's
   *  prefix exemption boundary). The arrival time rides along for the
   *  inert-anchor fallback (a cut uuid that never reached the mirror). */
  private readonly compactionBoundaryByKey = new Map<string, { uuid: string; at: number | null }>();
  /** The one-shot resume exemption per key: a check right after a
   *  resume/clear start must not misread owl's capture-ahead residue
   *  (rows mirrored live that the engine never persists — the command/
   *  exit ceremony) for a rewind. The boundary is the pre-start mirror tip
   *  (persisted fallback when the assembly is fresh); it exempts exactly
   *  the rows at-or-below it at the first KNOWN-rows check, which clears it
   *  — a knowledge-less process-start clean never consumes it. */
  private readonly resumeBoundaryByKey = new Map<string, { uuid: string; at: number }>();
  private locks: RunLockSurface = {
    inFlight: (key) => inFlight(key),
    abort: (key) => abortInFlight(key),
    waitMs: 25,
  };

  tripwires(): TruncationTripwires {
    return this.tripwireState;
  }

  /** Record an observed compaction-boundary row (the alignment exemption). */
  noteCompactionBoundary(key: string, uuid: string, at: number | null = null): void {
    this.compactionBoundaryByKey.set(key, { uuid, at });
  }

  /** Seed the one-shot resume exemption (the pre-start mirror tip). */
  noteResumeBoundary(key: string, uuid: string, at: number): void {
    this.resumeBoundaryByKey.set(key, { uuid, at });
  }

  /** Clear the one-shot resume exemption (the first clean verdict). */
  clearResumeBoundary(key: string): void {
    this.resumeBoundaryByKey.delete(key);
  }

  /** The armed one-shot resume exemption, or null (observability seam — a
   *  check that knows no rows must leave this non-null after a resume). */
  resumeBoundaryOf(key: string): { uuid: string; at: number } | null {
    return this.resumeBoundaryByKey.get(key) ?? null;
  }

  /** Register the prepared context the core was built over — refold must
   *  refresh THAT object (the ctxFactory closure holds it). */
  registerPrepared(key: string, prepared: PreparedContext): void {
    this.preparedByKey.set(key, prepared);
  }

  preparedFor(key: string): PreparedContext | null {
    return this.preparedByKey.get(key) ?? null;
  }

  releaseKey(key: string): void {
    this.preparedByKey.delete(key);
    this.deadByKey.delete(key);
    this.compactionBoundaryByKey.delete(key);
    this.resumeBoundaryByKey.delete(key);
    this.fpByKey.delete(key);
  }

  /** Release every key's checkpoint state (session end — the tripwire
   *  series follow the session out too). */
  releaseAll(): void {
    this.preparedByKey.clear();
    this.deadByKey.clear();
    this.compactionBoundaryByKey.clear();
    this.resumeBoundaryByKey.clear();
    this.fpByKey.clear();
    this.tripwireState.releaseAll();
  }

  reset(): void {
    this.preparedByKey.clear();
    this.deadByKey.clear();
    this.compactionBoundaryByKey.clear();
    this.resumeBoundaryByKey.clear();
    this.fpByKey.clear();
    this.fpComputes = 0;
    this.locks = { inFlight: (key) => inFlight(key), abort: (key) => abortInFlight(key), waitMs: 25 };
  }

  /** Test seam: how many fingerprint computations the cache actually paid. */
  _fpComputesForTest(): number {
    return this.fpComputes;
  }

  /** Test seam for the run-lock surface. */
  installRunLocksForTest(locks: RunLockSurface): void {
    this.locks = locks;
  }

  /** Assemble the deps for one conversation. */
  buildDeps(key: string, storage: SessionStorage, thunks: PlatformThunks): CheckpointDeps {
    const transcriptThunk = thunks.transcriptText;
    const transcriptPassThunk = thunks.transcriptPass;
    const rowUuidsThunk = thunks.rowUuids;
    return {
      key,
      apiMessages: () => thunks.apiFingerprints(),
      knownPath: () => this.knownPathOf(key, storage, this.deadByKey.get(key)),
      knownTip: () => storage.mirror.tipUuid(),
      ...(transcriptThunk !== undefined ? { transcriptText: () => transcriptThunk() } : {}),
      ...(transcriptPassThunk !== undefined ? { transcriptPass: () => transcriptPassThunk() } : {}),
      ...(rowUuidsThunk !== undefined ? { rowUuids: () => rowUuidsThunk() } : {}),
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
      // file-proven rows for the absent-row verdict: exact edges folded from
      // the durable lineage (past verifier passes) + this boundary's buffer
      fileProvenUuids: async () => {
        const fold = await foldLedger(storage.fs, storage.dir);
        const edges = foldLineage([...fold.records, ...storage.ledger.bufferedRecords()]);
        const proven = new Set<string>();
        for (const [uuid, edge] of edges) {
          if (edge.exact) proven.add(uuid);
        }
        return proven;
      },
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
      compactionBoundary: () => this.compactionBoundaryByKey.get(key)?.uuid ?? null,
      compactionBoundaryAt: () => this.compactionBoundaryByKey.get(key)?.at ?? null,
      resumeBoundary: () => this.resumeBoundaryByKey.get(key)?.uuid ?? null,
      resumeBoundaryAt: () => this.resumeBoundaryByKey.get(key)?.at ?? null,
      clearResumeBoundary: () => {
        this.resumeBoundaryByKey.delete(key);
      },
      appendCheck: (marker: string) => {
        storage.ledger.append("CHECK", {}, marker);
        // the CHECK seals the blind window — its durability is immediate: a
        // boundary product never rides an unrelated stage flush
        void storage.ledger.flush().catch((reason: unknown) => {
          thunks.logLine(
            `session-owl: checkpoint CHECK flush failed — buffered records kept for retry: ${reason instanceof Error ? reason.message : String(reason)}`,
          );
        });
      },
      appendEdges: (edges: LineageEdge[], marker: string) => {
        storage.ledger.append("lineage", { edges }, marker);
        // the file's exact edges also true-up the mirror's chain: the
        // envelope carries no parentUuid, so live rows chain by arrival
        // inference — this is the pass that makes a rewound or
        // meta-row-interspersed chain real (resolve-through onto captured
        // ancestors happens inside the mirror)
        storage.mirror.patchEdges(edges);
        // lineage is a boundary product too — durable with its CHECK
        void storage.ledger.flush().catch((reason: unknown) => {
          thunks.logLine(
            `session-owl: lineage flush failed — buffered records kept for retry: ${reason instanceof Error ? reason.message : String(reason)}`,
          );
        });
      },
      log: (line: string) => thunks.logLine(line),
    };
  }
  /** The previously-known path with per-row fingerprint caching (see
   *  fpByKey): each row's fingerprint computes once per key lifetime; a
   *  replaced row object recomputes (identity invalidation). */
  private knownPathOf(key: string, storage: SessionStorage, dead: ReadonlySet<string> | undefined): KnownRow[] {
    let cache = this.fpByKey.get(key);
    if (cache === undefined) {
      cache = new Map();
      this.fpByKey.set(key, cache);
    }
    const known: KnownRow[] = [];
    for (const uuid of storage.mirror.arrivalOrder()) {
      if (dead?.has(uuid)) continue;
      const raw = storage.mirror.rowByUuid(uuid);
      const src =
        (raw?.row as { message?: { content?: unknown }; timestamp?: unknown } | undefined)?.message?.content ?? [];
      const rowObj = raw as object | undefined;
      const hit = cache.get(uuid);
      let f: Fingerprint;
      if (hit !== undefined && hit.src === rowObj) {
        f = hit.f;
      } else {
        f = fingerprintBlocks(src);
        this.fpComputes += 1;
        if (rowObj !== undefined) cache.set(uuid, { src: rowObj, f });
      }
      const tsRaw = (raw?.row as { timestamp?: unknown } | undefined)?.timestamp;
      const ts = typeof tsRaw === "string" ? Date.parse(tsRaw) : Number.NaN;
      known.push(Number.isNaN(ts) ? { uuid, f } : { uuid, f, ts });
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

let instance: CheckpointServiceImpl | null = null;

/** The process-wide service (mirrors the other host singletons). */
export function checkpointService(): CheckpointServiceImpl {
  if (instance === null) instance = new CheckpointServiceImpl();
  return instance;
}

export type { CheckpointDeps };
export { runCheckpoint };
