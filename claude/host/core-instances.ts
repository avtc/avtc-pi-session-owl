// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// The per-conversation core multiplexer.
//
// The vendored core is module-singleton (`graph-store.ts` `let store`,
// `details.ts` `detailsCache`, `run-lock.ts` `let active`,
// `session-affinity.ts` `let sessionBase`) and byte-identity forbids
// restructuring it; pi never needed more because pi runs one process per
// session. On the engine, one process serves MANY conversations, and the
// kickoff probes answered the registry upgrade INFEASIBLE — dynamic import()
// is banned in hooks modules and loader registration cannot run there — so
// SERIALIZED SWAP is the only multiplexing mechanism.
//
// A switch = pi's own onSessionTree sequence PLUS the reset pi never needed
// (pi never switches conversations in-process; the store must not keep the
// previous conversation's graph, and resetForNewSession exists exactly for
// the fresh-session case):
//
//   [lock] -> resetForNewSession -> setEntryResolver -> clearDetailsCache ->
//   setSessionOwlSessionBase -> load(ctx) -> [unlock]
//
// Switch policy: reader-class switches DEFER behind the current
// conversation's run-lock (wait for the in-flight run — it belongs to ITS
// conversation); compaction/rewind-class switches (mode "takeover") take
// precedence and abort-and-await the in-flight run first (pi's
// acquireForCompaction precedence). Every switch holds the run-lock ACROSS
// the swap so no stage run can start mid-swap and land in the wrong graph.
//
// HANDLE-USE CONTRACT: the returned handle is a view of module singletons —
// it stays valid only while no other key switches in. Use it without an
// intervening `await`, or hold the run-lock across the whole use (a switch
// cannot interleave a lock-holding op: defer waits for it, takeover aborts
// it). `currentCoreKey()` revalidates after any suspect await.
//
// Failure semantics: a swap rejects its caller and clears the live-key
// pointer (no later getCore fast-paths into the half-reset store — every
// subsequent call performs a full swap) when its load() throws OR when a
// conversation teardown raced it (a stale teardown epoch — even a request
// that only sat queued when the teardown ran). The pump survives for the
// next request.
//
// Concurrency: switch requests are serialized in call order (one pump); a
// same-key request that finds itself current is a fast path (no reload) —
// one QUEUED behind a cross-key switch still swaps back. Shared services
// (spawn registry, logger, settings handle) stay process-global — matching
// pi's per-process shell + per-session core split.
//
// STATIC-IMPORT RULE (lint-enforced by the suite in
// claude/tests/core-instances.spec.ts): host code may statically import only
// STATELESS core modules; the STATEFUL set — store/graph-store,
// format/details, runtime/run-lock, runtime/session-affinity — is consumed
// exclusively through getCore(key). This file is the single legal importer.

import type { EntryResolver } from "../core/src/format/details.js";
import * as details from "../core/src/format/details.js";
import { log } from "../core/src/log.js";
import * as runLock from "../core/src/runtime/run-lock.js";
import * as sessionAffinity from "../core/src/runtime/session-affinity.js";
import type { StoreContext } from "../core/src/store/graph-store.js";
import * as graphStore from "../core/src/store/graph-store.js";
import { errDetail } from "./log/err-detail.js";
import { ensureConversation } from "./state.js";

export type { StoreContext };
/** The entry-resolver seam type (from the details module). */
export type Resolver = EntryResolver;

/** The stateful core surface one conversation is served through. */
export interface CoreHandle {
  readonly key: string;
  readonly conversation: import("./state.js").ConversationState;
  readonly store: typeof graphStore;
  readonly details: typeof details;
  readonly runLock: typeof runLock;
  readonly sessionAffinity: typeof sessionAffinity;
}

/** Options: per-conversation factories (sticky once registered) + switch mode. */
export interface CoreOptions {
  /** Factory for this conversation's StoreContext (the storage adapter's). */
  ctxFactory?: () => StoreContext;
  /** Factory for this conversation's entry resolver (refreshed per switch). */
  resolverFactory?: () => Resolver;
  /** defer (default): wait for the in-flight run. takeover: abort it first. */
  mode?: "defer" | "takeover";
}

interface ConversationFactories {
  ctxFactory?: () => StoreContext;
  resolverFactory?: () => Resolver;
  /** Per-conversation affinity base (random per first sight, then stable). */
  affinityBase: string;
}

// ---- module state -------------------------------------------------------------

let currentKey: string | null = null;
/** Monotonic graph-object tag for the cross-key contamination trace. */
let traceSeq = 0;
const factories = new Map<string, ConversationFactories>();
/** Serializes switches in call order; never holds a rejection (pump survives). */
let pump: Promise<unknown> = Promise.resolve();
/** Bumped by every conversation dispose; a swap whose epoch goes stale
 *  (session.end raced it) must not resurrect the dead key as live. */
let teardownEpoch = 0;

function randomBase(): string {
  // Non-content-derived per-conversation base (pi uses randomUUID per session
  // instance; node:crypto is banned in the hooks closure, so Math.random).
  return `owl-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function parseKey(key: string): { sessionId: string; agentId: string | null } {
  const bar = key.indexOf("|");
  if (bar === -1) return { sessionId: key, agentId: null };
  return { sessionId: key.slice(0, bar), agentId: key.slice(bar + 1) };
}

/** Wire this key's teardown into its registry entry (session.end runs these). */
function registerDispose(key: string): void {
  const conversation = ensureConversation(parseKey(key).sessionId, parseKey(key).agentId);
  if (conversation.dispose.some((d) => (d as { key?: string }).key === `core:${key}`)) return;
  const dispose = () => {
    teardownEpoch += 1;
    factories.delete(key);
    graphStore.evictConversation(key); // session.end drops the resident state
    if (currentKey === key) currentKey = null;
  };
  (dispose as { key?: string }).key = `core:${key}`;
  conversation.dispose.push(dispose);
}

function handleFor(key: string): CoreHandle {
  return {
    key,
    conversation: ensureConversation(parseKey(key).sessionId, parseKey(key).agentId),
    store: graphStore,
    details,
    runLock,
    sessionAffinity,
  };
}

/** The conversation the core currently serves (null before the first switch,
 *  after teardown, or after a failed swap). */
export function currentCoreKey(): string | null {
  return currentKey;
}

/** Re-pin a run's OWN conversation key after awaits: the process-global core
 *  serves whichever key the last dispatch swapped in, and a parallel
 *  conversation's event can steal it mid-run (pi gets this isolation from one
 *  process per session; the port must re-assert it). A run that reads or mints
 *  graph state without re-pinning silently operates on a FOREIGN conversation:
 *  wrapper ids minted from the foreign counter, applies landing in the wrong
 *  graph. Fast path: no-op when the key already owns the live state. */
export async function reassertCore(key: string): Promise<void> {
  if (currentKey === key) return;
  await getCore(key);
}

/** Drop a conversation's resident state (the subagent-handoff eviction — the
 *  hook awaits the key's run-lock first so a still-draining stage run keeps
 *  its store; session.end's dispose owns its own key). Log the outcome beside
 *  the activation trace so a handoff is greppable like a swap. */
export function evictResidentConversation(key: string): void {
  graphStore.evictConversation(key);
  log.info(`handoff: evicted resident state key=${key}`);
}

// ---- the swap -----------------------------------------------------------------

/** The seams that re-apply on EVERY activation — they are per-process values
 *  the resident state object does not own: the session-entry resolver, the
 *  affinity base, and the process-wide details cache (cleared per flip so
 *  renders never cross a conversation boundary). */
function applyConversationSeams(key: string): void {
  const f = factories.get(key);
  if (f?.resolverFactory) {
    graphStore.setEntryResolver(f.resolverFactory());
  } else {
    // Never inherit the previous conversation's resolver (pi clears it on
    // shutdown for the same reason: entry ids are per-conversation).
    graphStore.clearEntryResolver();
  }
  // Explicit belt (resetForNewSession already clears — idempotent).
  details.clearDetailsCache();
  sessionAffinity.setSessionOwlSessionBase(f?.affinityBase ?? randomBase());
}

/** The switch sequence proper. Caller holds the run-lock across this.
 *  `forceLoad` re-folds from disk even when the key is resident (the rewind
 *  refold swapped the branch truth under the in-memory state). */
async function swapTo(key: string, forceLoad = false): Promise<void> {
  const swapStart = Date.now();
  // Resident flip: the key's state never left memory — pointer only, no
  // reset, no ctx refresh, no load.
  if (graphStore.activateConversation(key).resident && !forceLoad) {
    applyConversationSeams(key);
    traceSeq += 1;
    const residentGraph = graphStore.getGraphStore().graph as {
      nodes: Map<string, unknown>;
      observations: Map<string, unknown>;
    };
    (residentGraph as unknown as { owlTrace?: number }).owlTrace = traceSeq;
    log.info(
      `activate: key=${key} resident=yes (load 0ms) nodes=${residentGraph.nodes.size} obs=${residentGraph.observations.size} trace#${traceSeq}`,
    );
    currentKey = key;
    return;
  }
  const f = factories.get(key);
  // Cold (or forced) load: activate already pointed the singleton at `key`;
  // drop any stale/partial state for THIS key before installing its view —
  // the previous conversation's resident state stays in its map entry.
  graphStore.resetForNewSession();
  applyConversationSeams(key);
  const startedWithFactory = Boolean(f?.ctxFactory);
  if (f?.ctxFactory) {
    const ctx = f.ctxFactory();
    // pi's ctxFactory pattern: refresh (re-fold + re-resolve) at EVERY
    // load — a context prepared earlier holds the fold from its own
    // construction; records flushed since (capture batches, observer
    // persists) would stay invisible to the fold and the graph would come
    // up empty every cross-conversation switch
    await (ctx as { refresh?: () => Promise<void> }).refresh?.();
    await graphStore.load(ctx);
  }
  const g = graphStore.getGraphStore().graph as { nodes: Map<string, unknown>; observations: Map<string, unknown> };
  traceSeq += 1;
  (g as unknown as { owlTrace?: number }).owlTrace = traceSeq; // cross-module identity: which swap installed this graph object
  log.info(
    `activate: key=${key} resident=no (load ${Date.now() - swapStart}ms) ctxFactory=${startedWithFactory} nodes=${g.nodes.size} obs=${g.observations.size} trace#${traceSeq}`,
  );
  currentKey = key;
}

async function acquireAcrossSwap(mode: "defer" | "takeover"): Promise<runLock.RunHandle> {
  if (mode === "takeover") {
    // Compaction/rewind precedence: abort-and-await the in-flight run, then
    // hold the lock across the swap (acquireForCompaction does both).
    return runLock.acquireForCompaction();
  }
  // Reader-class defer: WAIT for the in-flight run (no abort — it belongs to
  // its own conversation), then hold the lock across the swap. Polling
  // acquireOrSkip doubles as the wait: it returns null while a run is active.
  // (byte-identity keeps the core's private waitForIdle unreachable from
  // host code; the poll is the exported-API equivalent — the engine-side
  // exercise of this path rides on the storage-adapter's kit twin.)
  for (;;) {
    const handle = runLock.acquireOrSkip("observe");
    if (handle !== null) return handle;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

/**
 * The single seam for the STATEFUL core set. Ensures the conversation is
 * registered (lazy bootstrap — the registry entry is created at the first
 * event carrying the key, the session DIRECTORY only at first write, which
 * is the storage adapter's concern), switches the core to this conversation
 * when needed (serialized; policy per `mode`), and returns the stateful
 * module surface.
 *
 * Factories are sticky: options that PROVIDE a factory update that field for
 * the key (last-provided wins, per field); a provided factory applies at the
 * NEXT swap of that key — a re-registration while the key is live does not
 * retro-fit the already-loaded conversation.
 */
export function getCore(key: string, options: CoreOptions = {}): Promise<CoreHandle> {
  const existing = factories.get(key);
  if (options.ctxFactory || options.resolverFactory) {
    const next: ConversationFactories = {
      ...existing,
      ...(options.ctxFactory ? { ctxFactory: options.ctxFactory } : {}),
      ...(options.resolverFactory ? { resolverFactory: options.resolverFactory } : {}),
      affinityBase: existing?.affinityBase ?? randomBase(),
    };
    factories.set(key, next);
  } else if (!existing) {
    factories.set(key, { affinityBase: randomBase() });
  }
  registerDispose(key);
  const mode = options.mode ?? "defer";
  // Capture at CALL time, not slot time: a teardown completing while this
  // request sits queued behind another swap must stale it too.
  const epochAtCall = teardownEpoch;
  const run = pump.then(async (): Promise<CoreHandle> => {
    if (key === currentKey) return handleFor(key);
    const lock = await acquireAcrossSwap(mode);
    try {
      await swapTo(key);
      if (teardownEpoch !== epochAtCall) {
        // session.end teardown raced this switch (the swap was parked behind
        // a run): the key is dead — never resurrect it as the live one.
        currentKey = null;
        throw new Error(`session-owl: conversation ${key} ended during the switch`);
      }
    } catch (err) {
      // Failed swap: no live key — later calls must FULL-swap, never
      // fast-path into the half-reset store. The half-loaded state is
      // dropped, and the previously-live key evicts too (a failed switch
      // was never fully applied: memory must not be trusted for either).
      const previousKey = currentKey;
      graphStore.evictConversation(key);
      if (previousKey !== null && previousKey !== key) graphStore.evictConversation(previousKey);
      currentKey = null;
      throw err;
    } finally {
      lock.release();
    }
    return handleFor(key);
  });
  // the chain's tail must never reject (the NEXT queued call would inherit
  // the rejection) — but the FAILURE ITSELF is still said, with its stack:
  // a run whose own caller never awaited must not vanish silently
  pump = run.catch((err: unknown) => {
    log.warn(`core-instances: queued run failed: ${errDetail(err)}`);
  });
  return run;
}

/** Force a reload of the LIVE conversation's graph after an in-place fold
 *  change — the rewind reconciliation's refold. `getCore` fast-paths a
 *  same-key call (no reload), but the refold swapped the branch truth under
 *  the live store: the observer frontier may now name a row the branch no
 *  longer carries (a forked-off dead tail), and `computeUnobserved` answers
 *  [] for an unresolvable frontier — the observer would stay silent for the
 *  rest of the session. This reruns the swap sequence (reset + refreshed
 *  ctxFactory fold + load) for the SAME key, re-deriving the frontier (and
 *  the quarantined records) from the refolded branch. A no-op for a key that
 *  is not live — its next swap loads the refolded truth anyway. Returns
 *  whether a reload ran. */
export function reloadCoreFor(key: string): Promise<boolean> {
  const run = pump.then(async (): Promise<boolean> => {
    if (key !== currentKey) return false;
    // The refold already aborted and awaited any in-flight run before it
    // touched the fold; a reader-class acquire is enough here.
    const lock = await acquireAcrossSwap("defer");
    try {
      await swapTo(key, true); // forced re-fold — the refold changed the branch truth
      return true;
    } finally {
      lock.release();
    }
  });
  // the chain's tail must never reject (the NEXT queued call would inherit
  // the rejection) — but the FAILURE ITSELF is still said, with its stack:
  // a run whose own caller never awaited must not vanish silently
  pump = run.catch((err: unknown) => {
    log.warn(`core-instances: queued run failed: ${errDetail(err)}`);
  });
  return run;
}

/** Test-only: drop all multiplexer state (the core singletons reset via their
 *  own _reset* functions). */
export function _resetCoreInstances(): void {
  graphStore.resetConversationStates(); // every resident graph state is test-scoped
  currentKey = null;
  factories.clear();
  pump = Promise.resolve();
  teardownEpoch = 0;
}
