// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// The stage launch broker: stage agents are spawned THROUGH the
// session-owl-subagent-support companion (the engine tags a plugin's own
// spawned agents so their tool calls re-entry-skip the plugin's hooks —
// routing the spawn through the companion roots the agents' origin there
// and our tool.call hooks dispatch for them). The broker owns the launch
// handshake: it fires the companion's launch tool from AMBIENT orchestration
// code and waits for the companion's ambient `stage_launched` callback with
// the spawn handle. Every failure degrades to the direct spawn — a
// stage run must never die on the launcher.

import { describe, expect, test } from "vitest";
import {
  createLaunchBroker,
  type LaunchHandle,
  STAGE_LAUNCHED_TOOL,
  stageLaunchedToolSpec,
} from "../../host/stage/launch.js";

function handle(agentId: string): LaunchHandle {
  return { model: "m", agentId };
}

describe("stage launch broker", () => {
  test("the tool spec is deferred and requires the handshake fields", () => {
    const spec = stageLaunchedToolSpec() as Record<string, any>;
    expect(spec.name).toBe("stage_launched");
    expect(spec.isDeferred).toBe(true);
    expect(String(STAGE_LAUNCHED_TOOL).endsWith("stage_launched")).toBe(true);
    expect(spec.inputSchema.required).toContain("launchId");
    // a failure report carries launchError INSTEAD of a handle — only the
    // launch id itself is unconditionally required
    expect(spec.inputSchema.required).not.toContain("spawnAgentId");
    expect(String(JSON.stringify(spec.inputSchema.properties))).toContain("launchError");
  });

  test("spawn resolves through the companion callback with the handle", async () => {
    const launched: Record<string, unknown>[] = [];
    const broker = createLaunchBroker();
    broker.arm({
      launchViaCompanion: async (spec) => {
        launched.push(spec);
        return { result: "launching" };
      },
      spawnDirect: async () => {
        throw new Error("fallback must not run");
      },
      warn: () => {},
    });
    const pending = broker.spawn({ subagentType: "session-owl:observe", prompt: "go" });
    await new Promise((r) => setTimeout(r, 5));
    expect(launched.length).toBe(1);
    expect(launched[0].subagentType).toBe("session-owl:observe");
    expect(typeof launched[0].launchId).toBe("string");
    expect(broker.pendingLaunchIds().length).toBe(1);
    expect(broker.pendingLaunchCount()).toBe(1);
    // the companion's ambient callback settles the launch
    const settleId = String(launched[0].launchId);
    expect(broker.settle({ launchId: settleId, spawnAgentId: "ag-7", spawnModel: "sonnet" })).toEqual({
      result: "launched",
    });
    await expect(pending).resolves.toEqual({ model: "sonnet", agentId: "ag-7" });
    expect(broker.pendingLaunchCount()).toBe(0);
  });

  test("settle denies unknown ids, missing handles, and duplicates", async () => {
    const broker = armedBroker({ launchViaCompanionImpl: async () => ({ result: "launching" }) });
    const pending = broker.spawn({ subagentType: "t", prompt: "p" });
    await new Promise((r) => setTimeout(r, 5));
    expect("deny" in broker.settle({ launchId: "no-such-id", spawnAgentId: "x" })).toBe(true);
    expect("deny" in broker.settle({ launchId: currentOnlyLaunchId(broker) })).toBe(true);
    const id = currentOnlyLaunchId(broker);
    expect(broker.settle({ launchId: id, spawnAgentId: "ag-1", spawnModel: "m" })).toEqual({
      result: "launched",
    });
    expect("deny" in broker.settle({ launchId: id, spawnAgentId: "ag-1", spawnModel: "m" })).toBe(true);
    await expect(pending).resolves.toEqual(handle("ag-1"));
  });

  test("a refused launch (companion absent) falls back to the direct spawn with a warning", async () => {
    const warnings: string[] = [];
    const broker = armedBroker({
      launchViaCompanionImpl: async () => {
        throw new Error("no tool has that name");
      },
      warn: (m) => warnings.push(m),
      spawnDirectImpl: async () => handle("direct-1"),
    });
    await expect(broker.spawn({ subagentType: "t", prompt: "p" })).resolves.toEqual(handle("direct-1"));
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toContain("session-owl-subagent-support");
    expect(broker.pendingLaunchCount()).toBe(0);
  });

  test("a callback that never arrives times out and falls back", async () => {
    const broker = armedBroker({
      launchViaCompanionImpl: async () => ({ result: "launching" }),
      spawnDirectImpl: async () => handle("late-1"),
      settleTimeoutMs: 15,
    });
    await expect(broker.spawn({ subagentType: "t", prompt: "p" })).resolves.toEqual(handle("late-1"));
    expect(broker.pendingLaunchCount()).toBe(0);
  });

  test("spawn before arm throws (services not yet armed)", async () => {
    const broker = createLaunchBroker();
    await expect(broker.spawn({ subagentType: "t", prompt: "p" })).rejects.toThrow(/armed/);
  });
});

// ---- test helpers ---------------------------------------------------------------

interface BrokerOpts {
  launchViaCompanionImpl?: (spec: Record<string, unknown>) => Promise<unknown>;
  spawnDirectImpl?: (input: Record<string, unknown>) => Promise<LaunchHandle>;
  warn?: (message: string) => void;
  settleTimeoutMs?: number;
}

function armedBroker(opts: BrokerOpts) {
  const broker = createLaunchBroker();
  broker.arm({
    launchViaCompanion: opts.launchViaCompanionImpl ?? (async () => ({ result: "launching" }) as unknown),
    spawnDirect: opts.spawnDirectImpl ?? (async () => handle("fallback")),
    warn: opts.warn ?? (() => {}),
    ...(opts.settleTimeoutMs !== undefined ? { settleTimeoutMs: opts.settleTimeoutMs } : {}),
  });
  return broker;
}

function currentOnlyLaunchId(broker: ReturnType<typeof createLaunchBroker>): string {
  const ids = broker.pendingLaunchIds();
  if (ids.length !== 1) throw new Error(`expected one launch in flight, saw ${ids.length}`);
  return ids[0];
}
