// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// The `/owl:rescan --reuse-observations` rebuild: re-build the graph STRUCTURE
// from the already-collected observation records, in their original capture
// order, WITHOUT re-running the Observer LLM over the session. The collected
// records are parked under a dedicated `nPending` root, then re-wrapped into
// fresh `new` roots in batches; after each batch the Builder runs per the
// configured cadence (plus the compaction-style root-view safeguard — the root
// view stays bounded so the Builder never faces thousands of roots at once).
//
// Durability + resumability: every step persists at call time (marker, re-seed,
// parking attaches, per-batch create+mv). A crash mid-rebuild reloads to the
// parking state (structure ≤ the marker replays from the log); re-running the
// command CONTINUES (the parking node is non-empty) instead of restarting.
// When the last batch empties the parking node it auto-dissolves; the run
// stops there — the tail (`new` nodes below the cadence) is picked up by the
// normal triggers (threshold / compaction), per the command's contract.

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { SessionOwlConfig } from "../config/schema.js";
import { getSessionOwlSettings } from "../config/schema.js";
import {
  applyAttachObservation,
  applyCreateNode,
  applyMv,
  applySetMeta,
  assertGraphStructure,
  type GraphDelta,
  MUTATE_SOURCE,
  parseSeq,
} from "../graph/mutations.js";
import { toStoreContext } from "../lifecycle.js";
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
import {
  type Importance,
  type SessionOwlGraph,
  N_GOAL,
  N_PENDING,
  O_INITIAL_PROMPT,
  type Observation,
} from "../types.js";
import type { WidgetController } from "../widget/tracker.js";

// --- named constants (no bare literals at call sites) ----------------------

const WRAP_STAGE = "observe" as const;
const PARKING_SUMMARY = "pending re-wrap (rescan --reuse-observations)";
const PARKING_IMPORTANCE: Importance = "low";
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

/** Fresh-start preamble: void the old structure (reuse marker), re-seed nGoal +
 *  oInitialPrompt (+ the distilled goal summary), and park every collected
 *  record (except oInitialPrompt) under `nPending` in capture order. Returns
 *  the parked records, or an empty list when there is nothing to rebuild. */
function startFresh(_input: ReuseRebuildInput, store: StoreContext): Observation[] {
  const before = getGraphStore().graph;
  const goalSummary = before.nodes.get(N_GOAL)?.summary ?? "";
  const promptObs = before.observations.get(O_INITIAL_PROMPT) ?? null;

  resetGraphForReuse(store);

  const graph = getGraphStore().graph;
  // the re-seed ops run while the records are still detached (nodes wiped,
  // records kept) — the structural asserts re-arm after the parking batch
  // lands every record under nGoal/nPending (asserted at the end of startFresh)
  persist(
    store,
    applyCreateNode(graph, {
      id: N_GOAL,
      summary: goalSummary,
      importance: "crit",
      parentNode: null,
      state: "active",
      skipStructural: true,
    }),
  );
  if (promptObs !== null) {
    persist(store, applyAttachObservation(graph, { obsId: O_INITIAL_PROMPT, parentNode: N_GOAL }));
  }
  if (goalSummary !== "") {
    persist(
      store,
      applySetMeta(
        graph,
        { nodeId: N_GOAL, importance: null, archived: null, obsolete: null, summary: goalSummary },
        MUTATE_SOURCE,
        { skipStructural: true },
      ),
    );
  }

  // park every collected record except oInitialPrompt, in capture order
  const pending = [...graph.observations.values()].filter((o) => o.id !== O_INITIAL_PROMPT).sort(captureOrder);
  if (pending.length === NO_RECORDS) return pending;
  persist(
    store,
    applyCreateNode(graph, {
      id: N_PENDING,
      summary: PARKING_SUMMARY,
      importance: PARKING_IMPORTANCE,
      parentNode: null,
      state: "active",
      skipStructural: true,
    }),
  );
  const parkOps: GraphDelta[] = [];
  for (const obs of pending) {
    parkOps.push(applyAttachObservation(graph, { obsId: obs.id, parentNode: N_PENDING }));
  }
  appendGraphDeltaBatch(
    store,
    parkOps.map((d) => (d.type === "record_observation" ? { ...d, obs: { ...d.obs } } : d)),
  );
  // every record is now listed (nGoal ∘ nPending) — the invariant re-arms
  assertGraphStructure(graph, "reuse_rebuild_park");
  return pending;
}

/** Resume path: the pending records are those still parked under `nPending`
 *  (in listing order), plus any collected-but-unparked strays (a crash between
 *  the marker and the parking batch — re-park them now). */
function resumeParked(store: StoreContext): Observation[] | null {
  const graph = getGraphStore().graph;
  const parking = graph.nodes.get(N_PENDING);
  if (parking === undefined) return null;
  const parked = parking.observationIds
    .map((id) => graph.observations.get(id))
    .filter((o): o is Observation => o !== undefined);
  // strays: collected records listed under NO node (post-reload reconcile may
  // have re-wrapped them as fresh roots — those count as already re-wrapped,
  // not strays; only truly unlisted records re-park here)
  const listed = new Set<string>();
  for (const node of graph.nodes.values()) for (const id of node.observationIds) listed.add(id);
  const strays = [...graph.observations.values()].filter((o) => o.id !== O_INITIAL_PROMPT && !listed.has(o.id));
  if (strays.length > NO_RECORDS) {
    for (const obs of strays) {
      persist(store, applyAttachObservation(graph, { obsId: obs.id, parentNode: N_PENDING }));
    }
    return [...parked, ...strays];
  }
  return parked;
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
  const graph: SessionOwlGraph = getGraphStore().graph;

  // resume when a previous rebuild parked records and never finished; otherwise
  // a fresh start (void structure, re-seed, park)
  const resumable = latestMarkerIsReuse(input.ctx) && graph.nodes.get(N_PENDING) !== undefined;
  const pending = resumable ? resumeParked(store) : startFresh(input, store);
  if (pending === null || pending.length === NO_RECORDS) {
    log.info("reuse-rebuild: nothing collected to rebuild");
    return;
  }
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
    log.info(`reuse-rebuild: complete (${pending.length} records in ${totalBatches} batches)`);
  } catch (cause) {
    // applied batches are durable; the remainder stays parked — never throw
    log.error("reuse-rebuild failed (remainder stays parked; re-run continues)", cause);
  } finally {
    if (stageOpened) input.widget.endStage();
  }
}
