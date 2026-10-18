// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// The reuse-rebuild run — HOST PORT of src/commands/reuse-rebuild.ts (the pi
// file value-imports lifecycle/notify/triggers surfaces, so it is not
// vendored): re-build the graph STRUCTURE from the already-collected
// observation records, in original capture order, WITHOUT re-running the
// Observer LLM. Records stay DETACHED (outside the tree — no parking node)
// and attach as fresh `new` roots in batches (builderEveryNObservations),
// the Builder firing per batch via the injected maybeBuild seam (pi's
// makeMaybeBuilder — the trigger port supplies it). Every step persists at
// call time; a crash mid-rebuild reloads to the detached-pool state and a
// re-run CONTINUES. Never throws — the remainder stays detached.

import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { SessionOwlConfig } from "../../core/src/config/schema.js";
import {
  applyAttachObservation,
  applyCreateNode,
  applyMv,
  assertGraphStructure,
  type GraphDelta,
  MUTATE_SOURCE,
  parseSeq,
} from "../../core/src/graph/mutations.js";
import { RESCAN_MODE_REUSE, RESCAN_TYPE } from "../../core/src/store/codecs.js";
import type { StoreContext } from "../../core/src/store/graph-store.js";
import type { Observation } from "../../core/src/types.js";
import { N_GOAL, N_PENDING, O_INITIAL_PROMPT } from "../../core/src/types.js";
import { type CoreHandle, reassertCore } from "../core-instances.js";
import { goalExtractSettled } from "./goal-extract.js";
import { runsLog, type StageCore, type StageWidget } from "./seams.js";

// --- named constants -------------------------------------------------------

const WRAP_STAGE = "observe" as const;
const NO_RECORDS = 0;
const FIRST_BATCH = 0;

// --- input -----------------------------------------------------------------

/** Input to `runReuseRebuild`. Honors `signal` only — the caller owns the
 *  run-lock; `maybeBuild` is the Builder-cadence seam (pi's makeMaybeBuilder
 *  closure, supplied by the trigger/command wiring). */
export interface ReuseRebuildInput {
  core: StageCore;
  store: StoreContext;
  settings: SessionOwlConfig;
  signal: AbortSignal;
  widget: StageWidget;
  /** The Builder-cadence gate (fires per batch when the root view warrants). */
  maybeBuild: () => Promise<boolean>;
  /** The live master switch (default: enabled). */
  isEnabled?: () => boolean;
  /** Optional per-persist ledger flush (durability seam — the wiring passes
   *  the conversation's ledger flush + ctx refresh; each persisted batch is
   *  durable at persist time, the crash-resume contract the header states). */
  flushLedger?: () => Promise<void>;
  /** The chronological head's first user entry id — the carried oIP's
   *  provenance check (a stale capture cites a non-head row; the initial
   *  prompt is mechanically re-derivable, unlike goal summaries). */
  headUserEntryId?: () => string | null;
  /** Re-capture oInitialPrompt after a stale record was dropped — capture
   *  ONLY: the rebuild fires the goal extraction itself, once, on the final
   *  record (the same flow the turn-boundary capture uses). */
  recaptureInitialPrompt?: () => Promise<string | null>;
  /** Fire the goal extraction on the final initial prompt's verbatim — the
   *  same one-shot flow a fresh capture uses (wired to the goal-extract
   *  launcher; don't-clobber + Builder backstop apply as everywhere). */
  fireGoalExtract?: (verbatim: string) => void;
}

// --- helpers ---------------------------------------------------------------

/** Whether the latest rescan marker on the branch is a REUSE marker (an
 *  interrupted rebuild left it). Used for resume detection. */
function latestMarkerIsReuse(branch: readonly SessionEntry[]): boolean {
  for (let i = branch.length - 1; i >= 0; i -= 1) {
    const e = branch[i] as { type?: string; customType?: string; data?: { mode?: unknown } } | undefined;
    if (e === undefined || e.type !== "custom" || e.customType !== RESCAN_TYPE) continue;
    return e.data?.mode === RESCAN_MODE_REUSE;
  }
  return false;
}

/** Sort key: original capture order — timestamp first, then id sequence. */
function captureOrder(a: Observation, b: Observation): number {
  if (a.timestamp !== b.timestamp) return a.timestamp < b.timestamp ? -1 : 1;
  return parseSeq(a.id) - parseSeq(b.id);
}

/** Persist one applied delta (snapshotting record payloads — the live
 *  objects' parentNode mutates on later ops; the log freezes append time). */
function persist(core: CoreHandle, store: StoreContext, delta: GraphDelta): void {
  core.store.appendGraphDelta(store, delta.type === "record_observation" ? { ...delta, obs: { ...delta.obs } } : delta);
}

/** Persist a batch of applied deltas (same snapshot rule, one batch write). */
function persistBatch(core: CoreHandle, store: StoreContext, deltas: readonly GraphDelta[]): void {
  core.store.appendGraphDeltaBatch(
    store,
    deltas.map((d) => (d.type === "record_observation" ? { ...d, obs: { ...d.obs } } : d)),
  );
}

/** Fresh-start preamble: void the old structure (reuse marker), then re-seed
 *  the graph from its ground-truth record: a new nGoal wraps the FINAL
 *  initial prompt (fresh or carried) with an EMPTY summary, and the goal
 *  extraction re-fires on it — the same flow a fresh capture uses (one-shot
 *  distillation, don't-clobber, Builder backstop); a carried distillation
 *  never rides the rebuild. A carried oInitialPrompt whose source is NOT the
 *  conversation's head user row is stale (captured from a scrambled view or
 *  a rolled-back load): it is dropped and the capture re-runs from the true
 *  head BEFORE the re-seed, so the new nGoal always wraps the final record.
 *  The collected records stay DETACHED and attach progressively in batches
 *  (no parking node; the Builder organizes). */
async function startFresh(
  core: CoreHandle,
  store: StoreContext,
  headUserEntryId: string | null,
  recapture: (() => Promise<string | null>) | null,
  fireGoalExtract: ((verbatim: string) => void) | null,
): Promise<Observation[]> {
  const before = core.store.getGraphStore().graph;
  let promptObs = before.observations.get(O_INITIAL_PROMPT) ?? null;

  // the provenance check: the initial prompt must cite the head user row
  const carriedSource = promptObs?.sourceEntryIds[0] ?? null;
  const stale = promptObs !== null && headUserEntryId !== null && carriedSource !== headUserEntryId;
  if (stale) {
    runsLog(
      `reuse-rebuild: stale initial prompt (source ${carriedSource ?? "none"} ≠ head ${headUserEntryId}) — re-capturing from the head`,
    );
    promptObs = null;
  }

  core.store.resetGraphForReuse(store);

  const graph = core.store.getGraphStore().graph;
  if (stale) {
    // the reset keeps collected records — remove the stale one in-memory so
    // the capture gate re-arms; the fresh capture's delta supersedes the
    // stale one in every later replay (append order)
    graph.observations.delete(O_INITIAL_PROMPT);
  }

  // a stale (or lost) initial prompt re-captures from the true head BEFORE
  // the re-seed — capture ONLY (the extraction fires once, below, on the
  // final record — the same flow a fresh capture uses)
  if ((stale || promptObs === null) && recapture !== null && headUserEntryId !== null) {
    await recapture();
  }

  // the re-seed: the new nGoal wraps the FINAL initial-prompt record —
  // fresh or carried — with an EMPTY summary (the extraction below is the
  // seed's producer, exactly as at first capture). The re-seed ops run while
  // the records are still detached — the structural asserts re-arm after the
  // batches land every record
  const finalPrompt = graph.observations.get(O_INITIAL_PROMPT) ?? null;
  if (!graph.nodes.has(N_GOAL)) {
    persist(
      core,
      store,
      applyCreateNode(graph, {
        id: N_GOAL,
        summary: "",
        importance: "crit",
        parentNode: null,
        state: "active",
        skipStructural: true,
      }),
    );
  }
  if (finalPrompt !== null && !graph.nodes.get(N_GOAL)?.observationIds.includes(O_INITIAL_PROMPT)) {
    persist(core, store, applyAttachObservation(graph, { obsId: O_INITIAL_PROMPT, parentNode: N_GOAL }));
  }

  // the goal extraction fires ONCE on the final record — the same flow the
  // capture uses (fire-and-forget one-shot; don't-clobber protects anything
  // that lands first; a failure leaves the slot for the Builder backstop)
  if (finalPrompt !== null && fireGoalExtract !== null) {
    fireGoalExtract(finalPrompt.summary);
  }

  // The pending pool: every collected record except oInitialPrompt stays
  // DETACHED (outside the tree; graph.rebuildPending — armed by the reset —
  // keeps the relaxed assert live until the rebuild completes).
  return [...graph.observations.values()].filter((o) => o.id !== O_INITIAL_PROMPT).sort(captureOrder);
}

/** Resume path: the pending records are the DETACHED ones (the rebuild pool —
 *  outside the tree until their batch), plus the children of a legacy
 *  `nPending` from an older store (drained as ordinary pending; the
 *  emptied node dissolves on the last mv). Returns null when nothing is
 *  pending. */
function resumePending(core: CoreHandle): Observation[] | null {
  const graph = core.store.getGraphStore().graph;
  const listed = new Set<string>();
  for (const node of graph.nodes.values()) for (const id of node.observationIds) listed.add(id);
  const detached = [...graph.observations.values()]
    .filter((o) => o.id !== O_INITIAL_PROMPT && !listed.has(o.id))
    .sort(captureOrder);
  const legacy = graph.nodes.get(N_PENDING);
  const legacyPending =
    legacy === undefined
      ? []
      : legacy.observationIds.map((id) => graph.observations.get(id)).filter((o): o is Observation => o !== undefined);
  const pending = [...detached, ...legacyPending];
  if (pending.length === NO_RECORDS && legacy === undefined) return null;
  graph.rebuildPending = true;
  return pending;
}

// --- the run ---------------------------------------------------------------

/**
 * Run the structure rebuild over the collected observation records. Never
 * throws — aborts/errors stop the run with the remainder detached (a re-run
 * continues). Progress shows as an observe-style stage with batch counters.
 */
export async function runReuseRebuild(input: ReuseRebuildInput): Promise<void> {
  const isEnabled = input.isEnabled ?? (() => true);
  if (input.signal.aborted) return;
  const core = input.core;
  const store = input.store;
  // Re-pin before any graph/branch read: awaits above (goal-extract settle)
  // are a cross-key window for the process-global core.
  await reassertCore(core.key);

  // resume when a previous rebuild actually left records pending (detached
  // pool, or a legacy parked nPending); the MARKER alone never decides — a
  // completed rebuild's marker stays (the fresh path appends it via
  // resetGraphForReuse; completion never clears it), so an empty pool under a
  // stale marker must take the fresh start (void structure, re-seed, re-fire
  // the extraction) instead of a silent 'nothing collected to rebuild' no-op
  // (the branch cast: the store serves StoreEntry rows — the resume scan
  // reads them structurally, the capture layer's SessionEntry view rides the
  // same ids)
  const branch = store.getBranch(store.getLeafId()) as unknown as SessionEntry[];
  const parked = latestMarkerIsReuse(branch) ? resumePending(core) : null;
  const resuming = parked !== null && parked.length !== NO_RECORDS;
  const headUserEntryId = input.headUserEntryId?.() ?? null;
  const recapture = input.recaptureInitialPrompt ?? null;
  const fireGoalExtract = input.fireGoalExtract ?? null;
  const pending = resuming ? parked : await startFresh(core, store, headUserEntryId, recapture, fireGoalExtract);
  // the detached pool needs no persist (the records are already durable from
  // their original capture; the marker is already flushed) — but keep the
  // flush seam so a fresh start's re-seed ops are durable before batching
  if (!resuming && input.flushLedger !== undefined) await input.flushLedger();
  if (pending === null || pending.length === NO_RECORDS) {
    runsLog("reuse-rebuild: nothing collected to rebuild");
    return;
  }
  if (input.signal.aborted) return;
  // goal-first stage sequencing: the fresh start fires the goal extraction
  // (under this run's own compaction-class hold, un-locked) — settle it BEFORE
  // the batches and maybeBuild engage. Safe here: this run already holds the
  // lock, and awaiting while holding would be the deadlock the extraction's
  // un-locked branch avoids on purpose.
  await goalExtractSettled();
  if (input.signal.aborted) return;

  const batchSize = Math.max(1, input.settings.builderEveryNObservations);
  const totalBatches = Math.ceil(pending.length / batchSize);
  let stageOpened = false;
  let done = FIRST_BATCH;
  try {
    input.widget.startStage(WRAP_STAGE, { batch: { done, total: totalBatches } });
    stageOpened = true;
    for (let offset = 0; offset < pending.length; offset += batchSize) {
      if (input.signal.aborted) return;
      // live master switch: a disable mid-rebuild leaves the remainder
      // detached (durable)
      if (!isEnabled()) {
        runsLog(`reuse-rebuild: stopping: session-owl disabled (after ${done}/${totalBatches} batches)`);
        return;
      }
      const batch = pending.slice(offset, offset + batchSize);
      const g = core.store.getGraphStore().graph;
      // one wrapper per record — mirroring the Observer's capture pairing
      const ops: GraphDelta[] = [];
      for (const obs of batch) {
        const wrapperId = `n${g.nextNodeId}` as `n${number}`;
        ops.push(
          applyCreateNode(g, {
            id: wrapperId,
            summary: obs.summary,
            importance: obs.importance,
            parentNode: null,
            state: "new",
          }),
        );
        ops.push(applyMv(g, { sourceIds: [obs.id], destId: wrapperId }, MUTATE_SOURCE));
      }
      persistBatch(core, store, ops);
      // each applied batch is durable at persist time — the crash-resume
      // contract (an interrupted re-run CONTINUES from the flushed batches)
      if (input.flushLedger !== undefined) await input.flushLedger();

      done += 1;
      input.widget.setBatch(done, totalBatches);

      const built = await input.maybeBuild();
      if (input.signal.aborted) return;
      if (built) input.widget.startStage(WRAP_STAGE, { batch: { done, total: totalBatches } });
    }
    // full attachment re-arms: every collected record now lives in the tree
    core.store.getGraphStore().graph.rebuildPending = false;
    assertGraphStructure(core.store.getGraphStore().graph, "reuse_rebuild_complete");
    runsLog(`reuse-rebuild: complete (${pending.length} records in ${totalBatches} batches)`);
  } catch (cause) {
    // applied batches are durable; the remainder stays detached (pending) —
    // never throw; a re-run continues from the pool
    runsLog("reuse-rebuild failed (remainder stays pending; re-run continues)", cause);
  } finally {
    if (stageOpened) input.widget.endStage();
  }
}
