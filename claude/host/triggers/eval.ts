// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// The boundary evaluator — the ported trigger matrix at the Claude
// boundaries. The vendored evaluation functions are reused verbatim (the
// decisions are pi's); this module owns the BOUNDARY mapping and the chain:
//
//   turn.step      the mid-turn cheap matrix over the pending rows (the
//                  primary evaluation point) — launches only through
//                  the cheap gate (a truncation tripwire fired since
//                  the last clean check ⇒ defer to the turn boundary)
//   turn.complete  the wrap-up evaluation + launch (pi's onTurnEnd chain:
//                  observe → build → select under ONE keyed run-lock
//                  acquire, Builder/Selector re-evaluated AFTER the
//                  Observer completes so its fresh `new` nodes are
//                  visible; a colliding run on the conversation SKIPS —
//                  the settle-rearm re-enters the gap on release)
//   session.measure the context snapshot (context.ts) feeding the
//                  on-session-context-threshold arms; loop keys read
//                  unknown ⇒ those arms skip
//
// The runs are INJECTED closures (the wiring layer binds the conversation's
// core/storage/widget into the host run modules). The evaluator never
// touches the engine — the register-side handlers call these entry points.

import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { SessionOwlConfig } from "../../core/src/config/schema.js";
import {
  computeUnobserved,
  evaluateBuilderTrigger,
  evaluateObserverTrigger,
  evaluateSelectorTrigger,
  makeMaybeBuilder,
  type TriggerInput,
} from "../../core/src/triggers.js";
import { ownCompactionFloorIndex, ownSummaryFloorIndex } from "../compaction/floor.js";
import { runsLog } from "../runs/seams.js";
import { contextTokensFor, makeTriggerCtx } from "./context.js";
import { acquireOrSkip, armRearmOnRelease, type RunHandle, type StageName } from "./run-locks.js";

/** The stage runs the evaluator launches (the wiring binds the
 *  conversation's core/storage/widget into the host run modules; the
 *  evaluator passes only the per-launch fields). */
export interface TriggerRuns {
  runObserver: (args: {
    signal: AbortSignal;
    unobserved: SessionEntry[] | null;
    /** pi's makeObserverRun wrap: the Observer's per-chunk mid-run Builder
     *  seam (absent ⇒ the chain re-evaluates only after the Observer). */
    maybeBuild?: () => Promise<boolean>;
  }) => Promise<void>;
  runBuilder: (args: { signal: AbortSignal }) => Promise<void>;
  runSelector: (args: { signal: AbortSignal }) => Promise<void>;
}

/** The evaluator's inputs — the named contract: pending rows (the
 *  conversation's entries view), the settings snapshot, context usage (via
 *  the measure snapshots), the live master switch, the cheap-gate
 *  predicate, the core-pinning boundary, and the launch closures. */
export interface TriggerHostDeps {
  /** The conversation key (sessionId, agentId-scope) — the run-lock's key. */
  key: string;
  settings: SessionOwlConfig;
  /** The conversation's entries view (the capture grouper over the row
   *  cache — the pending-rows source for the cheap matrix). */
  getLeafId: () => string | null;
  getBranch: (leafId: string | null) => SessionEntry[];
  /** The reasoning level for the runs (settings-derived). */
  thinkingLevel: string | null;
  /** The live master switch (default: the settings snapshot's enabled). */
  isEnabled: () => boolean;
  /** The settle-rearm's re-entry gate: the launch site's pause/bootstrap/
   *  conflict gates re-read LIVE when the deferred evaluation runs (the
   *  boundary's own call-site gate already held at skip time; the release
   *  may be 20 minutes later). Absent = entry relies on the switch above. */
  launchGuard?: () => boolean;
  /** The cheap gate: clean ⇒ a mid-turn launch may proceed; dirty ⇒
   *  defer to the turn boundary. (The tripwire state itself is the layered
   *  check's; default clean.)  */
  cheapGateClean: () => boolean;
  /** The conversation's observer frontier (resolved through its core handle
   *  by the wiring — the stateful store singleton stays untouched here). */
  getObserverFrontier: () => string | null;
  /** The conversation's recorded own-summary texts (the observation floor's
   *  identity source, resolved through the core handle like the frontier). */
  getOwnSummaries: () => ReadonlySet<string>;
  /** Pins the conversation's core as the ACTIVE singleton for the next
   *  synchronous stretch: resolves once the core is swapped in AND no
   *  other conversation's swap is in flight. Every vendored decision call
   *  below follows an `await pinCore()` with no intervening awaits, so it
   *  reads the right conversation's store with the vendored in-flight
   *  guard free (a bare decision, exactly pi's mid-chain spelling).
   *
   *  Binding requirement: the implementation must go through the core
   *  multiplexer's SERIALIZED swap (getCore(key)) and resolve only after
   *  the swap queue is drained — a fast-path that merely checks "is the
   *  active singleton already mine" is UNSOUND mid-swap (another
   *  conversation's swap can be between its singleton reset and its key
   *  flip) and would silently reintroduce wrong-conversation reads. */
  pinCore: () => Promise<void>;
  runs: TriggerRuns;
}

/** The pi-shaped TriggerInput over the host's narrow inputs. */
function triggerInput(deps: TriggerHostDeps, prefetchedContextTokens?: number | null): TriggerInput {
  const ctx = makeTriggerCtx({
    key: deps.key,
    getLeafId: deps.getLeafId,
    getBranch: (leafId) => deps.getBranch(leafId),
    thinkingLevel: deps.thinkingLevel,
  });
  const base = { ctx: ctx as unknown as TriggerInput["ctx"], settings: deps.settings };
  return prefetchedContextTokens === undefined ? base : { ...base, prefetchedContextTokens };
}

/** One arm's verdict for the decision line: fire/skip + the evaluator's
 *  own reason. */
function verdict(arm: { shouldFire: boolean; reason: string }): string {
  return `${arm.shouldFire ? "fire" : "skip"} (reason=${arm.reason})`;
}

/** Agent-scoped conversation keys are `sessionId|agentId` (state.ts's
 *  conversationKey); the main conversation's key carries no separator. */
function isSubagentKey(key: string): boolean {
  return key.includes("|");
}

/** Evaluate the matrix and run the firing stages as one chained background
 *  run (pi's onTurnEnd body). Resolves when the chain settles — the
 *  boundary handlers fire-and-forget this; tests may await it directly. */
/** `fullScope` bypasses the on-file summary floor — the plain-rescan
 *  relaunch re-observes the whole live path by design (the maintenance
 *  promise); every ordinary boundary keeps the floor. */
export async function evaluateAndLaunch(deps: TriggerHostDeps, fullScope: boolean): Promise<void> {
  // The subagent gate: with subagentMode "disabled", agent-scoped loops
  // skip stage work entirely (observation + graph building — the LLM cost);
  // the capture + compaction seams decline the loop outright (nothing is
  // collected — no mirror, no takeover). "on-compaction" defers the loop's
  // observer to its compaction catch-up via the binding's effective-settings
  // override (settings arriving here already carry it); "inherited" runs
  // the full matrix. The main conversation is never gated here.
  if (isSubagentKey(deps.key) && deps.settings.subagentMode === "disabled") {
    runsLog("trigger: skipped — session-owl disabled for subagents");
    return;
  }
  if (!deps.isEnabled()) return;

  // Pin BEFORE the evaluation stretch: the vendored decisions read the
  // graph-store singleton (countNewNodes / computeRootViewTokens) — the pin
  // makes that singleton THIS conversation's, with no other swap in flight
  await deps.pinCore();

  // the unobserved slice on the conversation's entries view (the vendored
  // frontier rule: strictly after the frontier id, anchored past the first
  // user message)
  const branch = deps.getBranch(deps.getLeafId());
  // the observation floor (own summaries bound the scope — same rule as the
  // compaction catch-up gap): the store's recorded texts and the branch's
  // own compaction entries are two witnesses of the same fact, the newest
  // position winning; the rescan relaunch is the explicit whole-path
  // override
  const recordedFloor = ownSummaryFloorIndex(branch, deps.getOwnSummaries());
  const fileFloor = fullScope ? -1 : ownCompactionFloorIndex(branch);
  const floor = Math.max(recordedFloor, fileFloor);
  const scoped = floor === -1 ? branch : branch.slice(floor + 1);
  const unobserved = computeUnobserved(scoped, deps.getObserverFrontier());

  // read the context fill ONCE, only when a context arm is on (pi's
  // needsContextTokens rule — the default profile never reads it)
  const needsContextTokens =
    deps.settings.builderMode === "on-session-context-threshold" ||
    deps.settings.selectorMode === "on-session-context-threshold";
  const withCtx = needsContextTokens ? triggerInput(deps, contextTokensFor(deps.key)) : triggerInput(deps);

  // pre-evaluate all three decisions. The vendored functions' in-flight
  // guard reads the vendored singleton lock — the pin above has drained any
  // swap holding it, so on the host these behave as the bare decisions;
  // THIS host's keyed lock is checked below
  const observer = evaluateObserverTrigger({ ...withCtx, unobserved } as Parameters<typeof evaluateObserverTrigger>[0]);
  const builder = evaluateBuilderTrigger(withCtx);
  const selector = evaluateSelectorTrigger(withCtx);

  // One decision line per boundary: every arm's fire/skip + reason, so a
  // stage that never fires (or a starved chain) reads straight out of the
  // production file log instead of only engine --debug.
  runsLog(`trigger [${deps.key}]: observe=${verdict(observer)} build=${verdict(builder)} select=${verdict(selector)}`);

  // The empty-skip forensic: an unresolvable frontier (an id the branch
  // no longer carries — the resume/fork shape) silences the observer with
  // the same "no unobserved entries" reason as a genuinely-observed tail;
  // the branch/frontier numbers separate the two at a glance in the log.
  if (!observer.shouldFire && observer.reason.includes("no unobserved entries")) {
    const branch = deps.getBranch(deps.getLeafId());
    const frontier = deps.getObserverFrontier();
    const frontierIndex = frontier === null ? -2 : branch.findIndex((e) => e.id === frontier);
    runsLog(
      `observe-empty forensics: branch=${branch.length} frontier=${frontier === null ? "null" : frontier.slice(0, 8)} ` +
        `frontierIndex=${frontierIndex} leaf=${deps.getLeafId() === null ? "null" : (deps.getLeafId() as string).slice(0, 8)}`,
    );
  }

  if (!observer.shouldFire && !builder.shouldFire && !selector.shouldFire) return;
  const firstStage: StageName = observer.shouldFire ? "observe" : builder.shouldFire ? "build" : "select";
  const handle = acquireOrSkip(deps.key, firstStage);
  if (handle === null) {
    // settle-rearm (a deliberate divergence from pi's drop-if-busy): the
    // skipped evaluation keeps its work — one coalesced re-entry, guarded,
    // fired by the holder's successful release
    runsLog("trigger: run already in flight — SKIP (settle-rearm armed)");
    armRearmOnRelease(deps.key, () => {
      if (deps.launchGuard !== undefined && !deps.launchGuard()) {
        runsLog("trigger: settle-rearm held — the launch guard declined the deferred evaluation");
        return;
      }
      void evaluateAndLaunch(deps, false).catch((cause) => runsLog("trigger: settle-rearm evaluation failed", cause));
    });
    return;
  }

  await runChained(deps, handle, withCtx, observer.shouldFire, unobserved);
}

/** The chained background run: observe → build → select under the single
 *  acquire, Builder/Selector re-evaluated after the Observer (pi's chain,
 *  verbatim semantics over the keyed lock). */
async function runChained(
  deps: TriggerHostDeps,
  handle: RunHandle,
  withCtx: TriggerInput,
  observerFires: boolean,
  unobserved: SessionEntry[],
): Promise<void> {
  const signal = handle.abortController.signal;
  try {
    if (observerFires) {
      handle.setStage("observe");
      // pi's makeObserverRun wrap: the mid-run Builder seam, turn_end scope
      // (scope null ⇒ mode-aware cadence), re-pinned in front — the Observer's
      // long awaits let other conversations' swaps re-point the singletons
      // (the reobserve/compaction idiom).
      const bareMaybeBuild = makeMaybeBuilder({
        ctx: withCtx.ctx as unknown as Parameters<typeof makeMaybeBuilder>[0]["ctx"],
        settings: withCtx.settings,
        signal,
        scope: null,
        runBuilder: () => deps.runs.runBuilder({ signal }),
      });
      const maybeBuild = async (): Promise<boolean> => {
        await deps.pinCore();
        return bareMaybeBuild();
      };
      await deps.runs.runObserver({ signal, unobserved, maybeBuild });
    }
    if (signal.aborted) return;
    // live master switch: a disable mid-run stops the remaining phases
    if (!deps.isEnabled()) return;
    // re-evaluate AFTER the Observer (its fresh `new` nodes are visible) —
    // re-pinned first: the Observer's awaits let other conversations' swaps
    // re-point the singleton in between
    await deps.pinCore();
    const chainedBuilder = evaluateBuilderTrigger(withCtx);
    runsLog(`trigger [${deps.key}]: chained build ${verdict(chainedBuilder)}`);
    if (chainedBuilder.shouldFire) {
      handle.setStage("build");
      await deps.runs.runBuilder({ signal });
    }
    if (signal.aborted) return;
    if (!deps.isEnabled()) return;
    await deps.pinCore();
    const chainedSelector = evaluateSelectorTrigger(withCtx);
    runsLog(`trigger [${deps.key}]: chained select ${verdict(chainedSelector)}`);
    if (chainedSelector.shouldFire) {
      handle.setStage("select");
      await deps.runs.runSelector({ signal });
    }
  } catch (cause) {
    runsLog("trigger: chained background run failed", cause);
  } finally {
    handle.release();
  }
}

/** The turn.step boundary: the cheap synchronous matrix over the pending
 *  rows. A mid-turn launch proceeds only through the cheap gate — a fired
 *  tripwire defers the launch to the turn boundary (reconciling the
 *  mid-turn matrix with the layered check's cost). Both boundary entry
 *  points contain the launch: a throw anywhere inside (the gate check
 *  itself, the storage reads before the acquire, the chain) is logged,
 *  never an unhandled rejection. */
export function onStepBoundary(deps: TriggerHostDeps, _e: { agentId?: string }): void {
  try {
    if (!deps.cheapGateClean()) return; // defer to the boundary — no launch, no evaluation
  } catch (cause) {
    runsLog("trigger: cheap-gate check failed — deferring to the boundary", cause);
    return;
  }
  void evaluateAndLaunch(deps, false).catch((cause) => runsLog("trigger: evaluation failed", cause));
}

/** The turn.complete boundary: the wrap-up evaluation + launch
 *  (fire-and-forget; the full layered check precedes this at its wiring).
 *  The loop's view is SNAPSHOTTED SYNCHRONOUSLY here: the wiring releases
 *  the conversation's capture right after this call (an agent loop is
 *  terminal at its completion), and the evaluation's first await yields
 *  before it reads the branch — a live read would always see the RELEASED
 *  (empty) view and skip every agent loop's wrap-up. */
export function onTurnCompleteBoundary(deps: TriggerHostDeps, _e: { agentId?: string }): void {
  let launchDeps = deps;
  try {
    const leafId = deps.getLeafId();
    const branch = deps.getBranch(leafId);
    launchDeps = {
      ...deps,
      getLeafId: () => leafId,
      getBranch: () => branch,
    };
  } catch (cause) {
    runsLog("trigger: boundary snapshot failed — launching with live deps", cause);
  }
  void evaluateAndLaunch(launchDeps, false).catch((cause) => runsLog("trigger: evaluation failed", cause));
}
