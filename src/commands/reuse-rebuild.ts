// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// The `/owl:rescan --reuse-observations` rebuild: re-build the graph STRUCTURE
// from the already-collected observation records, in their original capture
// order, WITHOUT re-running the Observer LLM over the session. Records live
// OUTSIDE the tree until their batch — no parking node; each batch attaches
// them as fresh `new` roots, after which the Builder runs per the configured
// cadence (plus the compaction-style root-view safeguard — the root view stays
// bounded so the Builder never faces thousands of roots at once).
//
// Durability + resumability: every step persists at call time (marker, re-seed,
// per-batch create+mv). A crash mid-rebuild reloads to the detached-pool
// state (structure ≤ the marker replays from the log); re-running the
// command CONTINUES (the pending pool is non-empty) instead of restarting.
// When the last batch empties the pool the run stops there — the tail (`new`
// nodes below the cadence) is picked up by the normal triggers (threshold /
// compaction), per the command's contract.

import type { ExtensionAPI, ExtensionContext, SessionMessageEntry } from "@earendil-works/pi-coding-agent";
import type { SessionOwlConfig } from "../config/schema.js";
import { getSessionOwlSettings } from "../config/schema.js";
import { extractionSettled, runGoalExtract } from "../goal-extract/run.js";
import {
  applyAttachObservation,
  applyCreateNode,
  applyMv,
  assertGraphStructure,
  type GraphDelta,
  MUTATE_SOURCE,
  parseSeq,
} from "../graph/mutations.js";
import { captureInitialPromptIfAbsent, toStoreContext } from "../lifecycle.js";
import { log } from "../log.js";
import { RESCAN_MODE_REUSE, RESCAN_TYPE } from "../store/codecs.js";
import {
  appendGraphDelta,
  appendGraphDeltaBatch,
  getGraphStore,
  resetGraphForReuse,
  type StoreContext,
} from "../store/graph-store.js";
import { makeMaybeBuilder } from "../triggers.js";
import { N_GOAL, N_PENDING, O_INITIAL_PROMPT, type Observation } from "../types.js";
import type { WidgetController } from "../widget/tracker.js";

// --- named constants (no bare literals at call sites) ----------------------

const WRAP_STAGE = "observe" as const;
const NO_RECORDS = 0;
const FIRST_BATCH = 0;

// --- input -----------------------------------------------------------------

/** Input to `runReuseRebuild`. Honors `signal` only — the caller (the command
 *  handler) owns the run-lock lifecycle. `runBuilder` is the Builder run
 *  closure (test seam; production passes the wired Builder). */
export interface ReuseRebuildInput {
  ctx: ExtensionContext;
  pi: ExtensionAPI;
  settings: SessionOwlConfig;
  signal: AbortSignal;
  widget: WidgetController;
  /** The Builder run invoked by the cadence gate (test seam). */
  runBuilder: () => Promise<void>;
}

// --- helpers ---------------------------------------------------------------

/** Whether the latest rescan marker on the branch is a REUSE marker (a
 *  crashed/interrupted rebuild left it). Used for resume detection. */
function latestMarkerIsReuse(ctx: ExtensionContext): boolean {
  const branch = ctx.sessionManager.getBranch(ctx.sessionManager.getLeafId() ?? undefined);
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
function persist(store: StoreContext, delta: GraphDelta): void {
  appendGraphDelta(store, delta.type === "record_observation" ? { ...delta, obs: { ...delta.obs } } : delta);
}

/** Fresh-start preamble: void the old structure (reuse marker), then re-seed
 *  the graph from its ground-truth record: a new nGoal wraps the FINAL
 *  initial prompt (fresh or carried) with an EMPTY summary, and the goal
 *  extraction re-fires on it — the same flow a fresh capture uses (one-shot
 *  distillation, don't-clobber, Builder backstop); a carried distillation
 *  never rides the rebuild. A carried oInitialPrompt whose source is NOT the
 *  branch's head user row is stale (captured from a scrambled view or a
 *  rolled-back load): it is dropped and the capture re-runs from the true
 *  head BEFORE the re-seed, so the new nGoal always wraps the final record.
 *  The collected records stay DETACHED and attach progressively in batches
 *  (no parking node; the Builder organizes). Returns the
 *  pending records, or an empty list when there is nothing to rebuild. */
function startFresh(input: ReuseRebuildInput, store: StoreContext): Observation[] {
  const before = getGraphStore().graph;
  let promptObs = before.observations.get(O_INITIAL_PROMPT) ?? null;

  // the provenance check: the initial prompt must cite the branch's head
  // user entry (the same selection the capture itself uses)
  const branch = input.ctx.sessionManager.getBranch(input.ctx.sessionManager.getLeafId() ?? undefined);
  const firstUser = branch.find(
    (entry): entry is SessionMessageEntry => entry.type === "message" && entry.message.role === "user",
  );
  const headId = firstUser?.id ?? null;
  const carriedSource = promptObs?.sourceEntryIds[0] ?? null;
  const stale = promptObs !== null && headId !== null && carriedSource !== headId;
  if (stale) {
    log.info(
      `reuse-rebuild: stale initial prompt (source ${carriedSource ?? "none"} ≠ head ${headId}) — re-capturing from the head`,
    );
    promptObs = null;
  }

  resetGraphForReuse(store);

  const graph = getGraphStore().graph;
  if (stale) {
    // the reset keeps collected records — remove the stale one in-memory so
    // the capture gate re-arms; the fresh capture's delta supersedes the
    // stale one in every later replay (append order)
    graph.observations.delete(O_INITIAL_PROMPT);
  }

  // a stale (or lost) initial prompt re-captures from the true head BEFORE
  // the re-seed — capture ONLY (the extraction fires once, below, on the
  // final record — the same flow a fresh capture uses)
  if ((stale || promptObs === null) && headId !== null) {
    captureInitialPromptIfAbsent(input.ctx, input.pi);
  }

  // the re-seed: the new nGoal wraps the FINAL initial-prompt record —
  // fresh or carried — with an EMPTY summary (the extraction below is the
  // seed's producer, exactly as at first capture). The re-seed ops run while
  // the records are still detached (nodes wiped, records kept) — the
  // structural asserts re-arm after the batches land every record
  const finalPrompt = graph.observations.get(O_INITIAL_PROMPT) ?? null;
  if (!graph.nodes.has(N_GOAL)) {
    persist(
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
    persist(store, applyAttachObservation(graph, { obsId: O_INITIAL_PROMPT, parentNode: N_GOAL }));
  }

  // the goal extraction fires ONCE on the final record — the same flow the
  // capture uses (fire-and-forget one-shot; don't-clobber protects anything
  // that lands first; a failure leaves the slot for the Builder backstop)
  if (finalPrompt !== null) {
    void runGoalExtract({
      ctx: input.ctx,
      settings: getSessionOwlSettings(),
      store: toStoreContext(input.pi, input.ctx),
      widget: input.widget,
      verbatimText: finalPrompt.summary,
    });
  }

  // The pending pool: every collected record except oInitialPrompt stays
  // DETACHED (they are outside the tree — the reset already voided their old
  // parents; there is no parking node). Batches attach them progressively;
  // graph.rebuildPending (armed by the reset) keeps the relaxed assert live.
  const pending = [...graph.observations.values()].filter((o) => o.id !== O_INITIAL_PROMPT).sort(captureOrder);
  return pending;
}

/** Resume path: the pending records are the DETACHED ones (the rebuild pool —
 *  outside the tree until their batch), plus any records still parked under a
 *  legacy `nPending` node from an older store (its records drain as ordinary
 *  pending; the emptied node dissolves automatically on the last mv). Returns
 *  null when nothing is pending (a completed rebuild re-runs as nothing-to-do). */
function resumePending(): Observation[] | null {
  const graph = getGraphStore().graph;
  const listed = new Set<string>();
  for (const node of graph.nodes.values()) {
    for (const id of node.observationIds) listed.add(id);
    if (node.id !== N_PENDING) continue;
  }
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
  graph.rebuildPending = true; // the relaxed assert stays live until completion
  return pending;
}

// --- the run ---------------------------------------------------------------

/**
 * Run the structure rebuild over the collected observation records. Never
 * throws — aborts/errors stop the run with the remainder parked (a re-run
 * continues). Progress shows as an observe-style stage with batch counters
 * (done/total); the Builder's own runs flip the stage display in between.
 */
export async function runReuseRebuild(input: ReuseRebuildInput): Promise<void> {
  if (input.signal.aborted) return;
  const store = toStoreContext(input.pi, input.ctx);

  // resume when a previous rebuild actually left records parked (the detached
  // pool, or a legacy parked nPending); the MARKER alone never decides — a
  // completed rebuild's marker stays (the fresh path appends it, completion
  // never clears it), so an empty pool under a stale marker must take the
  // fresh start (void structure, re-seed, re-fire the extraction) instead of
  // a silent 'nothing collected to rebuild' no-op
  const parked = latestMarkerIsReuse(input.ctx) ? resumePending() : null;
  const pending = parked !== null && parked.length !== NO_RECORDS ? parked : startFresh(input, store);
  if (pending === null || pending.length === NO_RECORDS) {
    log.info("reuse-rebuild: nothing collected to rebuild");
    return;
  }
  if (input.signal.aborted) return;
  // goal-first stage sequencing: the fresh start fires the goal extraction
  // (under this run's own compaction-class hold, un-locked) — settle it BEFORE
  // the batches and maybeBuild engage. Safe here: this run already holds the
  // lock, and awaiting while holding would be the deadlock the extraction's
  // un-locked branch avoids on purpose.
  await extractionSettled();
  if (input.signal.aborted) return;

  const batchSize = Math.max(1, input.settings.builderEveryNObservations);
  const totalBatches = Math.ceil(pending.length / batchSize);
  const maybeBuild = makeMaybeBuilder({
    ctx: input.ctx,
    settings: input.settings,
    signal: input.signal,
    // non-null scope: the compaction-style root-view safeguard fires the
    // Builder regardless of builderMode — the root view stays bounded through
    // a long rebuild (the Builder never faces thousands of roots at once)
    scope: { firstKeptEntryId: null },
    runBuilder: input.runBuilder,
  });

  let stageOpened = false;
  let done = FIRST_BATCH;
  try {
    input.widget.startStage(WRAP_STAGE, { batch: { done, total: totalBatches } });
    stageOpened = true;
    for (let offset = 0; offset < pending.length; offset += batchSize) {
      if (input.signal.aborted) return;
      // live master switch: a disable mid-rebuild parks the remainder (durable)
      if (!getSessionOwlSettings().enabled) {
        log.info(`reuse-rebuild: stopping: session-owl disabled (after ${done}/${totalBatches} batches)`);
        return;
      }
      const batch = pending.slice(offset, offset + batchSize);
      const g = getGraphStore().graph;
      // one wrapper per record — mirroring the Observer's capture pairing (the
      // Builder sees per-observation `new` roots exactly as it does live)
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
      appendGraphDeltaBatch(
        store,
        ops.map((d) => (d.type === "record_observation" ? { ...d, obs: { ...d.obs } } : d)),
      );

      done += 1;
      input.widget.setBatch(done, totalBatches);

      const built = await maybeBuild();
      if (input.signal.aborted) return;
      if (built) input.widget.startStage(WRAP_STAGE, { batch: { done, total: totalBatches } });
    }
    // full attachment re-arms: every collected record now lives in the tree —
    // read through the store: the fresh start swapped the graph object, so an
    // entry-captured reference would clear the STALE one and leave the live
    // flag armed (the relaxed assert never tightens again)
    const live = getGraphStore().graph;
    live.rebuildPending = false;
    assertGraphStructure(live, "reuse_rebuild_complete");
    log.info(`reuse-rebuild: complete (${pending.length} records in ${totalBatches} batches)`);
  } catch (cause) {
    // applied batches are durable; the remainder stays detached (pending) —
    // never throw; a re-run continues from the pool
    log.error("reuse-rebuild failed (remainder stays pending; re-run continues)", cause);
  } finally {
    if (stageOpened) input.widget.endStage();
  }
}
