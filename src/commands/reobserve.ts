// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// `/mk:reobserve-0-obs-chunks` — re-run the Observer over the zero-observation
// HOLES: chunks the frontier jumped over (a 0-record chunk followed by a
// record-bearing one) and empty-verdict chunks (a completed chunk persisted with
// records: []). The repair tool for sessions where a degraded model left holes.
// The OPEN tail after the frontier is deliberately excluded — the normal observe
// triggers (turn_end threshold / compaction catch-up) own it. Each hole is
// observed with the normal per-chunk pipeline, and captured observations land in
// fresh `new` ROOT wrapper nodes exactly like a normal Observer run, with the
// mid-run Builder folding pipelined (catch-up semantics: mode-aware cadence +
// the root-view safeguard — a large repair never balloons the root view before
// a folding pass).
//
// The run-lock is taken with acquireOrSkip (a colliding maintenance run means
// "try again", not "wait"); the frontier itself never regresses —
// appendObservation is forward-only, so re-observing an older range appends its
// observations without moving the pointer back.

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { getMemkeeperSettings } from "../config/schema.js";
import { log } from "../log.js";
import { notify } from "../notify.js";
import type { ObserverRunInput } from "../observer/run.js";
import { acquireOrSkip } from "../runtime/run-lock.js";
import { getGraphStore } from "../store/graph-store.js";
import { computeUncoveredRanges, makeMaybeBuilder, type RunFn } from "../triggers.js";
import type { WidgetController } from "../widget/tracker.js";

/** The registered command name. */
export const MK_REOBSERVE_COMMAND = "mk:reobserve-0-obs-chunks";

/** Deps for the re-observe command: the append surface (pi), the widget the
 *  Observer run drives, the Observer run itself, and the Builder stage run the
 *  mid-repair folding drives (seams for tests). */
export interface ReobserveDeps {
  pi: ExtensionAPI;
  widget: WidgetController;
  runObserver: (input: ObserverRunInput) => Promise<void>;
  /** The Builder stage run the mid-repair fold drives (the same contract the
   *  turn_end chained run hands to makeMaybeBuilder). */
  runBuilderStage: RunFn;
  /** Test seam: receives the background launch promise (production omits). */
  onLaunched?: (promise: Promise<void>) => void;
}

/**
 * `/mk:reobserve-0-obs-chunks` — compute the zero-observation ranges on the
 * active branch and re-observe each oldest-first under one run-lock acquire.
 * Additive only: nothing is discarded; recovered observations persist per-chunk
 * as usual. Notifies the start, the recovered summary, or the failure.
 */
export async function runMkReobserve(_args: string, ctx: ExtensionCommandContext, deps: ReobserveDeps): Promise<void> {
  const settings = getMemkeeperSettings();
  if (!settings.enabled) {
    notify(ctx, "memkeeper is disabled (enable it first).", "warning");
    return;
  }
  const branch = ctx.sessionManager.getBranch(ctx.sessionManager.getLeafId() ?? undefined);
  const ranges = computeUncoveredRanges(branch, getGraphStore().observerFrontier);
  if (ranges.length === 0) {
    notify(ctx, "No skipped or unobserved ranges — nothing to re-observe.", "info");
    return;
  }
  const handle = acquireOrSkip("observe");
  if (handle === null) {
    notify(ctx, "A maintenance run is in flight — try again once it finishes.", "warning");
    return;
  }
  const entryCount = ranges.reduce((sum, range) => sum + range.entries.length, 0);
  notify(ctx, `Re-observing ${ranges.length} skipped range(s) (${entryCount} entries)…`, "info");

  const signal = handle.abortController.signal;
  // Mid-repair Builder folding, catch-up semantics: a large repair (hundreds of
  // recovered roots) must not balloon the root view before a single folding
  // pass — the non-null scope enables the compaction-style root-view safeguard
  // on top of the mode-aware cadence (each-N / on-root-view / on-context fire
  // per settings; on-compaction folds via the safeguard here, fully at the next
  // compaction).
  const maybeBuild = makeMaybeBuilder({
    ctx,
    settings,
    signal,
    scope: { firstKeptEntryId: null },
    runBuilder: () =>
      deps.runBuilderStage({ ctx, settings: getMemkeeperSettings(), signal, scope: null, unobserved: null }),
  });
  const launch = (async () => {
    let recovered = 0;
    try {
      for (const range of ranges) {
        if (signal.aborted) break;
        const before = getGraphStore().graph.observations.size;
        await deps.runObserver({
          ctx,
          pi: deps.pi,
          settings: getMemkeeperSettings(),
          unobserved: range.entries,
          signal,
          widget: deps.widget,
          maybeBuild,
        });
        recovered += getGraphStore().graph.observations.size - before;
      }
      notify(ctx, `Re-observe done — ${recovered} observation(s) recovered into new roots.`, "info");
    } catch (cause) {
      log.error("reobserve: run failed", cause);
      notify(ctx, "Re-observe failed — see the memkeeper log for the error.", "error");
    } finally {
      handle.release();
    }
  })();
  deps.onLaunched?.(launch);
}
