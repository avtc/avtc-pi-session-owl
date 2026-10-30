// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// The live rewind application — what the chain processor's onRewind seam
// runs when the transcript tail proves the conversation was amputated past
// owl's chain. The recipe is the reconcile divergence move, composed for
// the live path: abort in-flight stage runs first (their anchors point
// into the amputated world), then the settle point's live order and the
// dead path (everything owl held after it) feed the store refold — the
// same quarantine + marker-liveness move the checkpoint uses — and the
// divergence is recorded so future adjudication excludes the dead set.
// Failures PROPAGATE: the processor's tick retries and the rewind
// re-detects on the next tail read (a detected rewind is never silently
// dropped).

export interface LiveRewindDeps {
  /** Abort the conversation's in-flight stage runs and await their release. */
  abortAndAwaitInFlight: () => Promise<void>;
  /** The live chain order from the settle point (the surviving prefix,
   *  oldest first; empty when nothing survives). */
  liveOrderFor: (settle: string | null) => Promise<string[]>;
  /** Everything owl's current path holds AFTER the settle point — the
   *  amputated world (dead). */
  deadPath: (settle: string | null) => Promise<string[]>;
  /** owl's known path in ARRIVAL order (file order) — the boundary cap's
   *  axis: rows ordered before the live path's oldest known row are exempt
   *  from death. Absent = the dead set is taken as-is (already capped). */
  knownOrder?: () => readonly string[];
  /** Re-fold the store (quarantine + marker liveness) — the divergence move. */
  refold: (
    liveSet: ReadonlySet<string>,
    liveOrder: readonly string[],
    dead: ReadonlySet<string>,
  ) => Promise<{ quarantined: number }>;
  /** Divergence recording (the known path of future checks excludes dead). */
  onDivergence?: (settle: string | null, dead: string[]) => void;
  /** The logger line sink. */
  log: (line: string) => void;
}

/** The boundary cap: rows ordered before the live path's OLDEST known row
 *  are never adjudicated dead. The live path's root is the newest
 *  compaction boundary the file still holds (the lineage walk stops at its
 *  null-parent edge), and everything ordered before it is the summarized
 *  history the transcript keeps by design — re-materialized generations and
 *  their originals — not rewind damage. A live path with no known row (an
 *  empty survive set, or a root outside owl's path — the rewind-to-root and
 *  boundary-removed-at-surgery shapes) caps nothing: the whole path stays
 *  adjudicable. */
export function capDeadAtOldestLiveKnown(
  knownOrder: readonly string[],
  liveOrder: readonly string[],
  dead: readonly string[],
): string[] {
  const indexOf = new Map(knownOrder.map((u, i) => [u, i] as const));
  let oldest = -1;
  for (const u of liveOrder) {
    const i = indexOf.get(u);
    if (i !== undefined && (oldest === -1 || i < oldest)) oldest = i;
  }
  if (oldest === -1) return [...dead];
  return dead.filter((u) => {
    const i = indexOf.get(u);
    return i === undefined || i > oldest;
  });
}

/** Apply a live-detected rewind: abort in-flight stages, refold onto the
 *  settle point's live prefix, record the dead path. Throws on failure —
 *  the caller (the chain processor's tick) retries the whole detection. */
export async function applyLiveRewind(
  deps: LiveRewindDeps,
  verdict: { settle: string | null },
): Promise<{ quarantined: number }> {
  const { settle } = verdict;
  await deps.abortAndAwaitInFlight();
  const liveOrder = await deps.liveOrderFor(settle);
  const deadRaw = await deps.deadPath(settle);
  const dead =
    deps.knownOrder === undefined ? deadRaw : capDeadAtOldestLiveKnown(deps.knownOrder(), liveOrder, deadRaw);
  if (dead.length !== deadRaw.length) {
    deps.log(`live rewind: boundary cap kept ${deadRaw.length - dead.length} pre-boundary row(s) out of the dead set`);
  }
  const liveSet = new Set(liveOrder);
  deps.log(`live rewind: settle=${String(settle)} live=${liveOrder.length} dead=${dead.length} — refolding`);
  const { quarantined } = await deps.refold(liveSet, liveOrder, new Set(dead));
  if (deps.onDivergence !== undefined) deps.onDivergence(settle, dead);
  return { quarantined };
}
