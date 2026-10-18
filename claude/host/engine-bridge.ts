// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// Shared engine services home. The engine's scanner (2.1.291+) refuses `$`
// itself AND its nouns crossing a call boundary — every engine call must be
// spelled `$.noun.method(...)` lexically inside a handler body. The register
// wiring therefore ARMS this bridge at each handler entry with a capsule
// set: closures created in the handler whose bodies spell the literal calls.
// Deep host code (and the stage engine) uses the armed services instead of
// ever seeing `$`. A service call after its dispatch ended relies on the
// last-armed capsules.
//
// Also homes the process-global spawn registry (every agent this mod
// spawned — the delivery-drop and the capture skip consult its membership;
// the caller gate consults the live-run map instead) and the
// turn.complete{agentId} routing that resolves awaiting stage-run promises.

let services: Record<string, (...args: any[]) => any> | null = null;

/**
 * Arm with the handler's capsule set. `svcs` is a plain object of closures
 * (never `$`, never a noun of it — the scanner checks).
 */
export function arm(svcs: Record<string, (...args: any[]) => any>): void {
  services = svcs;
}

/** Test-only: drop the armed table (the module-load / pre-arm window). */
export function _disarmForTest(): void {
  services = null;
}

/** The armed services; throws the named error before the first arm. */
export function currentServices(): Record<string, (...args: any[]) => any> {
  if (services === null) {
    throw new Error("session-owl: engine call before any handler armed the bridge");
  }
  return services;
}

// ---- spawn registry (process-global) --------------------------------------

/** Every agent this mod spawned: agentId -> spawn record. */
export const spawnRegistry = new Map();

export function recordSpawn(agentId: string, record: Record<string, unknown>): void {
  spawnRegistry.set(agentId, { launchedAt: Date.now(), ...record });
}

export function forgetSpawn(agentId: string): void {
  spawnRegistry.delete(agentId);
}

// ---- turn.complete{agentId} routing ---------------------------------------

/** The usage a turn.complete carries (the API's four counts + model id). */
export interface CompletionUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  model: string;
}

/** A turn.complete's owl-relevant fields (the shim's StageUsage source). */
export interface CompletionEvent {
  answer: string;
  isAborted: boolean;
  agentId: string;
  usage?: CompletionUsage | null;
  /** Why the turn ended ('answer' | 'aborted' | 'refusal' | 'error'). */
  reason?: string;
}

const completions = new Map<string, Array<(e: CompletionEvent) => void>>(); // agentId -> [resolve]

/** Await a spawned agent's turn.complete. The stage engine's run seam. */
export function awaitAgentCompletion(agentId: string): Promise<CompletionEvent> {
  return new Promise((resolve) => {
    const list = completions.get(agentId) ?? [];
    list.push(resolve);
    completions.set(agentId, list);
  });
}

/** Called from the turn.complete hook: resolves everything awaiting this agent. */
export function routeAgentCompletion(e: CompletionEvent): boolean {
  const list = completions.get(e.agentId);
  if (!list) return false;
  completions.delete(e.agentId);
  for (const resolve of list) resolve(e);
  return true;
}

export function clearRouting(): void {
  completions.clear();
}

// ---- deliberate aborts (the handback-enforcer kill) -------------------------------

/** Abort marks WE initiate: the run layer forgives exactly these completions
 *  (an abort we initiated is a clean finish, records kept). */
const deliberateAborts = new Set<string>();

/** Mark an abort WE are initiating (call right before the abort). */
export function markDeliberateAbort(agentId: string): void {
  deliberateAborts.add(agentId);
}

/** Unmark (the abort call itself failed — nothing to forgive). */
export function clearDeliberateAbort(agentId: string): void {
  deliberateAborts.delete(agentId);
}

/** One-shot: was this agent's completion deliberately aborted by us? */
export function consumeDeliberateAbort(agentId: string): boolean {
  return deliberateAborts.delete(agentId);
}

/** session.end: clear the spawn registry, pending completions, services.
 *  A stage run still awaiting its completion resolves as aborted — the
 *  engine's agents end with the session, and an awaiting gate must not
 *  hang past it. */
export function clearAllForSessionEnd(): void {
  spawnRegistry.clear();
  deliberateAborts.clear();
  for (const list of completions.values()) {
    for (const resolve of list) resolve({ answer: "", isAborted: true, agentId: "", usage: null, reason: "aborted" });
  }
  completions.clear();
  services = null;
}
