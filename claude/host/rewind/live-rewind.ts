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
  const dead = await deps.deadPath(settle);
  const liveSet = new Set(liveOrder);
  deps.log(`live rewind: settle=${String(settle)} live=${liveOrder.length} dead=${dead.length} — refolding`);
  const { quarantined } = await deps.refold(liveSet, liveOrder, new Set(dead));
  if (deps.onDivergence !== undefined) deps.onDivergence(settle, dead);
  return { quarantined };
}
