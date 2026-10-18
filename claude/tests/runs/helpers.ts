// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// Shared fixtures for the run-module suites: the memory-fs rig (mirror rows
// + prepared StoreContext + the conversation's core handle), the scripted
// fake stage runner (drives the REAL executor layer through the tools), the
// widget recorder, and the tool-call helper.
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { SessionOwlConfig } from "../../core/src/config/schema.js";
import { DEFAULT_CONFIG } from "../../core/src/config/schema.js";
import type { NodeId } from "../../core/src/types.js";
import { makeNode, N_GOAL, nowStoredTimestamp } from "../../core/src/types.js";
import { getCore } from "../../host/core-instances.js";
import type { StageWidget } from "../../host/runs/seams.js";
import { completeStageRun, createStageRun, type StageRunState } from "../../host/stage/runs.js";
import { handleStageToolCall } from "../../host/stage/tools.js";
import { createMemoryFs } from "../../host/storage/fs-adapter.js";
import { LedgerWriter } from "../../host/storage/ledger.js";
import { MirrorWriter } from "../../host/storage/mirror.js";
import { type PreparedContext, prepareStoreContext } from "../../host/storage/store-context.js";
import type { EngineStageRunInput, StageRunResultLike } from "../../shims/pi-agent-core/index.js";

export const SETTINGS: SessionOwlConfig = { ...DEFAULT_CONFIG, observerThresholdTokens: 60 };

export const PAD = "x".repeat(200);

/** Alternating user/assistant entries (a pair = one chunk group). */
export function entries(n: number, pad = PAD): SessionEntry[] {
  return Array.from({ length: n }, (_, i) =>
    msgEntry(`e${i + 1}`, `entry ${i + 1} ${pad}`, i % 2 === 0 ? "user" : "assistant"),
  );
}

export function msgEntry(id: string, text: string, role: "user" | "assistant" = "user"): SessionEntry {
  return { id, timestamp: `${id}-ts`, type: "message", message: { role, content: text } } as unknown as SessionEntry;
}

/** A widget recorder: the calls the run drives. */
export function recorderWidget(): StageWidget & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    startStage: (s, init) => calls.push(`start:${s}:${JSON.stringify(init ?? {})}`),
    setPass: (p) => calls.push(`pass:${p}`),
    setBatch: (d, t) => calls.push(`batch:${d}/${t}`),
    endStage: () => calls.push("end"),
    onEvent: () => calls.push("event"),
    invalidateRoots: () => calls.push("invalidate"),
    render: () => calls.push("render"),
  };
}

// ---- the fake stage runner --------------------------------------------------

export type Behavior = (
  input: EngineStageRunInput,
  agentId: string,
) => Promise<Partial<StageRunResultLike>> | Partial<StageRunResultLike>;

export interface FakeRunner {
  calls: EngineStageRunInput[];
  agents: StageRunState[];
  runner: (input: EngineStageRunInput) => Promise<StageRunResultLike>;
}

export function okResult(): StageRunResultLike {
  return {
    messages: [],
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1, elapsedMs: 5 },
    outputTokens: 1,
    aborted: false,
    timedOut: false,
    abortReason: null,
  };
}

export function makeRunner(script: Behavior[], endlessOk = true): FakeRunner {
  const calls: EngineStageRunInput[] = [];
  const agents: StageRunState[] = [];
  let n = 0;
  return {
    calls,
    agents,
    runner: async (input) => {
      calls.push(input);
      n += 1;
      const agentId = `ag-${n}`;
      agents.push(
        createStageRun(agentId, input.stage, {
          maxTokens: input.maxTokens,
          timeoutMs: input.timeoutMs,
          noProgressTurns: input.noProgressTurns,
        }),
      );
      input.onSpawn?.(agentId);
      const behave = script[(n - 1) % script.length];
      if (behave === undefined) {
        if (!endlessOk) throw new Error(`fake runner: no behavior scripted for call ${n}`);
        return okResult();
      }
      const over = await behave(input, agentId);
      completeStageRun(agentId);
      return { ...okResult(), ...over };
    },
  };
}

/** A memory DumpFs (the tests) — captures writes, ENOENT on missing. */
export function makeMemoryDumpFs() {
  const files = new Map<string, string>();
  return {
    files,
    fs: {
      readText: async (p: string) => {
        const t = files.get(p);
        if (t === undefined) throw new Error(`ENOENT: ${p}`);
        return t;
      },
      writeText: async (p: string, t: string) => {
        files.set(p, t);
      },
      listDir: async () => [] as string[],
      statMtime: async () => null as number | null,
    },
  };
}

/** Simulate the model calling a stage tool through the real executor layer. */
export async function useTool(agentId: string, short: string, args: Record<string, unknown>): Promise<unknown> {
  return handleStageToolCall(
    { tool: `mcp__session-owl__${short}`, agentId, ...args } as unknown as { tool: string; agentId?: string },
    (id) => id === agentId,
  );
}

// ---- the rig -----------------------------------------------------------------

export const mem = createMemoryFs();

export interface Rig {
  core: Awaited<ReturnType<typeof getCore>>;
  prepared: PreparedContext;
  store: PreparedContext["ctx"];
  mirror: MirrorWriter;
  ledger: LedgerWriter;
}

export async function rigUp(sessionId: string, rows: SessionEntry[] = [], seedGoal = true): Promise<Rig> {
  const dir = `/cfg/session-owl/sessions/${sessionId}`;
  const mirror = new MirrorWriter(mem.adapter, dir, `run-${sessionId}`);
  const ledger = new LedgerWriter(mem.adapter, dir, `run-${sessionId}`);
  let prev: string | null = null;
  for (const e of rows) {
    mirror.bufferRow({ uuid: e.id, parentUuid: prev, row: { type: "message", id: e.id } as never });
    prev = e.id;
  }
  if (prev !== null) await mirror.flush();
  const prepared = await prepareStoreContext(mem.adapter, dir, ledger, mirror);
  const core = await getCore(sessionId, { ctxFactory: () => prepared.ctx, resolverFactory: () => () => [] });
  if (seedGoal) {
    const g = core.store.getGraphStore().graph;
    if (!g.nodes.has(N_GOAL)) {
      g.nodes.set(
        N_GOAL,
        makeNode({
          id: N_GOAL,
          summary: "goal",
          importance: "crit",
          parentNode: null,
          state: "active",
          createdAt: nowStoredTimestamp(),
        }),
      );
    }
  }
  return { core, prepared, store: prepared.ctx, mirror, ledger };
}

/** Seed a node straight into the graph (test fixture). */
export function seedNode(
  rig: Rig,
  id: string,
  state: "active" | "new" | "archived" | "obsolete",
  summary = id,
  imp: "crit" | "high" | "med" | "low" = "med",
): void {
  rig.core.store.getGraphStore().graph.nodes.set(
    id as NodeId,
    makeNode({
      id: id as NodeId,
      summary,
      importance: imp,
      parentNode: null,
      state,
      createdAt: nowStoredTimestamp(),
    }),
  );
}

type Custom = Record<string, unknown>;

export function branchCustoms(rig: Rig, customType: string): Custom[] {
  const branch = rig.store.getBranch(rig.store.getLeafId());
  return branch
    .filter(
      (e) =>
        (e as { type?: string; customType?: string }).type === "custom" &&
        (e as { customType?: string }).customType === customType,
    )
    .map((e) => (e as { data?: unknown }).data as Custom);
}
