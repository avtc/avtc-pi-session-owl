// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// The stage launch broker: stage agents are spawned THROUGH the
// session-owl-subagent-support companion (the engine tags a plugin's own
// spawned agents so their tool calls re-entry-skip the plugin's hooks —
// routing the spawn through the companion roots the agents' origin there
// and this plugin's tool.call hooks dispatch for them). The handshake:
//
//   1. spawn(input) fires the companion's `launch` tool from AMBIENT
//      orchestration code (raised by this plugin, so the companion's hook
//      dispatches it) and parks a pending launch under a fresh launchId;
//   2. the companion's hook returns at once and spawns the agent from its
//      own ambient code (its frame closed — the agents' origin roots at
//      the companion, never here);
//   3. the companion's ambient code calls back into `stage_launched` with
//      the spawn handle (raised by the companion, so THIS plugin's hook
//      dispatches it) and settle() resolves the parked spawn.
//
// Every failure degrades to the direct spawn (better a racing stage run
// than none): a refused launch (the
// companion absent), or a callback that never arrives before the timeout.
// The capsules arrive via arm() (the register wiring authors them against
// its dollar — data and capsules only, never the dollar itself).

/** The spawn handle runStage needs (the shape $.agent.spawn resolves). */
export interface LaunchHandle {
  model: string;
  agentId: string;
}

/** The companion's launch tool spec input (what spawn forwards). */
export interface LaunchInput {
  subagentType: string;
  prompt: string;
  model?: string;
}

/** The full name of the callback tool this module serves. */
export const STAGE_LAUNCHED_TOOL = "mcp__session-owl__stage_launched";

/** The callback tool's registration spec (deferred — it stays off the main
 *  prompt; only the companion's ambient code ever calls it, by full name). */
export function stageLaunchedToolSpec(): Record<string, unknown> {
  return {
    name: "stage_launched",
    isDeferred: true,
    description:
      "Internal launch callback: the subagent companion reports a spawned agent's handle here. Not for the model.",
    inputSchema: {
      type: "object",
      required: ["launchId"],
      properties: {
        launchId: {
          type: "string",
          description: "The launch id the spawning side parked.",
        },
        spawnAgentId: {
          type: "string",
          description: "The spawned agent's id.",
        },
        spawnModel: {
          type: "string",
          description: "The model the agent runs on.",
        },
        launchError: {
          type: "string",
          description: "The spawn's failure reason (reported instead of a handle).",
        },
      },
    },
  };
}

/** The armed capsules (register wiring re-arms them per surface arm). */
interface LaunchDeps {
  launchViaCompanion: (spec: Record<string, unknown>) => Promise<unknown>;
  spawnDirect: (input: Record<string, unknown>) => Promise<LaunchHandle>;
  warn: (message: string) => void;
  settleTimeoutMs?: number;
}

interface PendingLaunch {
  resolve: (handle: LaunchHandle) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  input: Record<string, unknown>;
}

const DEFAULT_SETTLE_TIMEOUT_MS = 20_000;

export interface LaunchBroker {
  arm(deps: LaunchDeps): void;
  spawn(input: Record<string, unknown>): Promise<LaunchHandle>;
  settle(e: Record<string, unknown>): { result: string } | { deny: string };
  pendingLaunchCount(): number;
  pendingLaunchIds(): string[];
  reset(): void;
}

export function createLaunchBroker(): LaunchBroker {
  const pending = new Map<string, PendingLaunch>();
  let deps: LaunchDeps | null = null;

  function fallback(id: string, entry: PendingLaunch, reason: string): void {
    if (!pending.delete(id)) return; // already settled
    clearTimeout(entry.timer);
    deps?.warn(reason);
    deps?.spawnDirect(entry.input).then(
      (h) => entry.resolve(h),
      (err) => entry.reject(err instanceof Error ? err : new Error(String(err))),
    );
  }

  return {
    arm(next: LaunchDeps) {
      deps = next;
    },

    async spawn(input: Record<string, unknown>): Promise<LaunchHandle> {
      if (deps === null) {
        throw new Error("stage launch broker not armed (agentSpawn/log missing)");
      }
      const armed = deps;
      const parkedAt = Date.now();
      const id = `launch-${parkedAt.toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
      const parked = new Promise<LaunchHandle>((resolve, reject) => {
        const timer = setTimeout(() => {
          fallback(
            id,
            { resolve, reject, timer, input },
            "stage launch callback timed out — spawning directly (the subagent companion did not report the handle)",
          );
        }, armed.settleTimeoutMs ?? DEFAULT_SETTLE_TIMEOUT_MS);
        pending.set(id, { resolve, reject, timer, input });
      });
      try {
        await armed.launchViaCompanion({ launchId: id, ...input });
      } catch {
        // the companion is absent or refused the launch — degrade to the
        // direct spawn path (one warning per failure)
        const entry = pending.get(id);
        if (entry !== undefined) {
          fallback(
            id,
            entry,
            "session-owl-subagent-support launch refused — spawning directly (install the companion plugin for reliable stage agents)",
          );
        }
      }
      const handle = await parked;
      return handle;
    },

    settle(e: Record<string, unknown>): { result: string } | { deny: string } {
      const id = typeof e.launchId === "string" ? e.launchId : null;
      const agentId = typeof e.spawnAgentId === "string" && e.spawnAgentId.length > 0 ? e.spawnAgentId : null;
      if (id === null) return { deny: "stage_launched: launchId missing" };
      const entry = pending.get(id);
      if (entry === undefined) return { deny: `stage_launched: no launch in flight for ${id}` };
      // the companion's own failure report: reject the parked launch WITH
      // the reason (its stack when the companion had one) — the stage run
      // fails loudly and retries; never a silent timeout
      const launchError = typeof e.launchError === "string" && e.launchError.length > 0 ? e.launchError : null;
      if (launchError !== null) {
        pending.delete(id);
        clearTimeout(entry.timer);
        entry.reject(new Error(`stage agent spawn failed at the companion: ${launchError}`));
        return { result: "launched" };
      }
      if (agentId === null) return { deny: "stage_launched: spawnAgentId missing" };
      pending.delete(id);
      clearTimeout(entry.timer);
      entry.resolve({
        model: typeof e.spawnModel === "string" ? e.spawnModel : "",
        agentId,
      });
      return { result: "launched" };
    },

    pendingLaunchCount(): number {
      return pending.size;
    },

    pendingLaunchIds(): string[] {
      return [...pending.keys()];
    },

    reset() {
      // teardown rejects whatever never settled (session ended): a parked
      // spawn must never hang its run-lock past the session
      for (const entry of pending.values()) {
        clearTimeout(entry.timer);
        entry.reject(new Error("session ended before the launch settled"));
      }
      pending.clear();
      deps = null;
    },
  };
}
