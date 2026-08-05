// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// End-to-end integration: drive the REAL `memkeeperExtension(pi)` activate +
// the four session hooks through a scripted multi-turn session, faking only
// cross-boundary I/O (the LLM `runStage`, the session branch, the UI). Asserts
// the deterministic acceptance seams hold and that every component is
// reachable from activate (no "built but never wired" stubs).

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type {
  ExtensionAPI,
  ExtensionContext,
  SessionBeforeCompactEvent,
  SessionEntry,
  SessionStartEvent,
} from "@earendil-works/pi-coding-agent";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Fake the LLM stage-runner: the real Observer/Builder/Selector orchestration
// runs; only the agentLoop step is scripted (per-scenario via
// `vi.mocked(runStage).mockImplementation`).
vi.mock("../src/runtime/agent-loop.js", () => ({
  runStage: vi.fn(),
  NO_REASONING: null,
  NO_TURN_LIMIT: null,
  NO_EVENT_SINK: null,
  NO_STAGE_END_HOOK: null,
  NO_LOOP_OVERRIDE: null,
  SEQUENTIAL: "sequential",
}));

import {
  _resetGetMemkeeperSettings,
  _resetMemkeeperSettingsHandle,
  _setGetMemkeeperSettings,
  DEFAULT_CONFIG,
} from "../src/config/schema.js";
import { validateGraph } from "../src/graph/invariants.js";
import memkeeperExtension from "../src/index.js";
import { runStage, type StageRunResult } from "../src/runtime/agent-loop.js";
import { _resetRunLock, inFlight as runLockInFlight } from "../src/runtime/run-lock.js";
import { getGraphStore, resetForNewSession } from "../src/store/graph-store.js";
import { N_GOAL, O_INITIAL_PROMPT } from "../src/types.js";

/** A no-op agent-loop result (no messages, zero usage). The default per-scenario
 *  runStage script; the module mock in this file delegates to a script set via
 *  `vi.mocked(runStage).mockImplementation`. */
const EMPTY_RESULT: StageRunResult = {
  messages: [],
  usage: { input: 0, output: 0, cacheRead: 0, cost: 0, turns: 1 },
  outputTokens: 0,
  aborted: false,
};

// --- fake session entries --------------------------------------------------

type FakeEntry = SessionEntry & {
  id: string;
  type: string;
  parentId: string | null;
  timestamp: string;
  message?: AgentMessage;
};

function userEntry(id: string, text: string): FakeEntry {
  return {
    id,
    type: "message",
    parentId: null,
    timestamp: "2026-07-28T14:30:00.000Z",
    message: { role: "user", content: text, timestamp: Date.now() },
  } as FakeEntry;
}

function assistantEntry(id: string, text: string): FakeEntry {
  return {
    id,
    type: "message",
    parentId: null,
    timestamp: "2026-07-28T14:31:00.000Z",
    message: {
      role: "assistant",
      content: [{ type: "text", text }],
      api: "anthropic",
      provider: "anthropic",
      model: "m",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: Date.now(),
    },
  } as FakeEntry;
}

// --- fake pi / ctx ---------------------------------------------------------

/** The fake pi exposes an `emit(event, ...args)` test dispatcher (mirrors Pi's
 *  per-extension handler dispatch: fires all handlers for an event in order) and
 *  a `_tool(name)` test accessor for registered tools. */
type FakePi = ExtensionAPI & {
  emit(event: string, ...args: unknown[]): Promise<unknown>;
  _tool(name: string): { execute: (...args: unknown[]) => Promise<unknown> };
};

interface FakePiState {
  branch: FakeEntry[];
  appendedEntries: unknown[];
}

function makeFakeCtx(state: FakePiState): ExtensionContext {
  const fakeModel = { provider: "test", id: "m" } as unknown as ExtensionContext["model"];
  return {
    sessionManager: {
      getLeafId: () => "leaf-1",
      getBranch: () => [...state.branch],
    },
    modelRegistry: {
      find: () => fakeModel,
      getApiKeyAndHeaders: async () => ({ ok: true as const, apiKey: "key" }),
    } as unknown as ExtensionContext["modelRegistry"],
    model: fakeModel,
    ui: { notify: () => {} },
    appendEntry: (entry: unknown) => {
      state.appendedEntries.push(entry);
    },
  } as unknown as ExtensionContext;
}

/** Throw with a clear message when a test asks for a tool that was never
 *  registered (avoids the non-null assertion lint). */
function throwMissingTool(name: string): never {
  throw new Error(`integration test: tool "${name}" was not registered`);
}

function makeFakePi(): ExtensionAPI {
  // A real event dispatcher: pi.on records handlers by event; emit(event,
  // ...args) fires all handlers for that event in registration order (mirrors
  // Pi's per-extension handler dispatch). This lets the integration test drive
  // the activate-registered hooks the same way Pi does.
  const handlers = new Map<string, Array<(...args: unknown[]) => unknown>>();
  const tools = new Map<string, { execute: (...args: unknown[]) => Promise<unknown> }>();
  const pi = {
    appendEntry: () => {},
    registerTool: (tool: { name: string; execute: (...args: unknown[]) => Promise<unknown> }) => {
      tools.set(tool.name, tool);
    },
    registerCommand: vi.fn(),
    on: (event: string, handler: (...args: unknown[]) => unknown) => {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
    events: { on: vi.fn(() => () => {}) },
    // test-only dispatcher: fires all handlers for an event in order, returns
    // the last non-undefined return (Pi uses the session_before_compact return).
    emit: async (event: string, ...args: unknown[]) => {
      let last: unknown;
      for (const h of handlers.get(event) ?? []) {
        const r = await h(...args);
        if (r !== undefined) last = r;
      }
      return last;
    },
    _tool: (name: string) => tools.get(name) ?? throwMissingTool(name),
  };
  return pi as unknown as ExtensionAPI;
}

// --- script the LLM runStage per scenario ---------------------------------

beforeEach(() => {
  vi.clearAllMocks();
  resetForNewSession();
  _resetGetMemkeeperSettings();
  _setGetMemkeeperSettings(() => ({ ...DEFAULT_CONFIG }));
  // default script: a no-op runStage (no observations, no mutations).
  vi.mocked(runStage).mockImplementation(async () => EMPTY_RESULT);
});

afterEach(() => {
  _resetGetMemkeeperSettings();
  // Defensive reset of the run-lock singleton between tests — the green path
  // always releases (background launches are awaited, compaction acquires+
  // releases), so this is not a current defect, but without a reset a future
  // test change or a real hang would cascade-lock the whole suite.
  _resetRunLock();
});

// activate sets the module `handle` via initMemkeeperSettings (the REAL
// registerSettingsCommand against the fake pi). Clear it so it does not leak to
// later test files under isolate:false (the exact leak class the worth-notes
// warned about — schema.test.ts does the same in its file-level afterAll).
afterAll(() => {
  _resetMemkeeperSettingsHandle();
});

/** Parse the `E=<id>` citation markers out of a chunk's text (the Observer's
 *  record_observations tool validates sourceEntryIds against exactly these). */
function parseChunkIds(text: string): string[] {
  const ids: string[] = [];
  const re = /E=(\S+?)>/g;
  let m: RegExpExecArray | null = re.exec(text);
  while (m !== null) {
    ids.push(m[1] as string);
    m = re.exec(text);
  }
  return ids;
}

/** Script the LLM runStage to record one observation per Observer chunk,
 *  citing the chunk's first valid id. Returns the count of recorded chunks. */
function scriptObserverRecordsOnePerChunk(): { recorded: number } {
  const state = { recorded: 0 };
  vi.mocked(runStage).mockImplementation(async (input) => {
    const tool = input.tools[0] as unknown as { execute: (id: string, args: unknown) => Promise<unknown> };
    const raw = input.messages[0] as { content?: unknown } | undefined;
    const text = typeof raw?.content === "string" ? raw.content : "";
    const ids = parseChunkIds(text);
    if (ids.length > 0 && typeof tool?.execute === "function") {
      await tool.execute("call-1", {
        observations: [{ summary: "observed fact", importance: "med", sourceEntryIds: [ids[0] as string] }],
      });
      state.recorded += 1;
    }
    return EMPTY_RESULT;
  });
  return state;
}

describe("memkeeperExtension end-to-end (default profile)", () => {
  it("session_start seeds an empty graph with nGoal (no oInitialPrompt yet)", async () => {
    const state: FakePiState = { branch: [], appendedEntries: [] };
    const pi = makeFakePi() as FakePi;
    memkeeperExtension(pi);

    await pi.emit("session_start", { type: "session_start", reason: "new" } as SessionStartEvent, makeFakeCtx(state));

    const graph = getGraphStore().graph;
    expect(graph.nodes.has(N_GOAL)).toBe(true);
    // oInitialPrompt absent before the first user message.
    expect(graph.observations.has(O_INITIAL_PROMPT)).toBe(false);
  });

  it("first user turn captures oInitialPrompt verbatim + seeds nGoal.summary", async () => {
    const state: FakePiState = {
      branch: [userEntry("u1", "Fix the login bug in auth.ts")],
      appendedEntries: [],
    };
    const pi = makeFakePi() as FakePi;
    memkeeperExtension(pi);
    const ctx = makeFakeCtx(state);
    await pi.emit("session_start", { type: "session_start", reason: "new" } as SessionStartEvent, ctx);
    // turn_end: the synchronous capture runs before the background trigger.
    await pi.emit("turn_end", {}, ctx);

    const graph = getGraphStore().graph;
    const obs = graph.observations.get(O_INITIAL_PROMPT);
    expect(obs).toBeDefined();
    expect(obs?.summary).toBe("Fix the login bug in auth.ts");
    expect(obs?.parentNode).toBe(N_GOAL);
    // nGoal.summary seeded from the first non-empty line.
    expect(graph.nodes.get(N_GOAL)?.summary).toBe("Fix the login bug in auth.ts");
  });

  it("Observer fires at turn_end (background) → wraps new nodes + advances frontier", async () => {
    // A branch with enough token mass past the first user message to clear a
    // low observer threshold. The unobserved gap = entries after oInitialPrompt.
    const branch: FakeEntry[] = [
      userEntry("u1", "Fix the login bug"),
      assistantEntry("a1", "x".repeat(600)),
      userEntry("u2", "now fix the logout"),
      assistantEntry("a2", "y".repeat(600)),
    ];
    const state: FakePiState = { branch, appendedEntries: [] };
    // low threshold so the Observer fires on this small gap.
    _setGetMemkeeperSettings(() => ({ ...DEFAULT_CONFIG, observerThresholdTokens: 50 }));
    const script = scriptObserverRecordsOnePerChunk();
    const pi = makeFakePi() as FakePi;
    memkeeperExtension(pi);
    const ctx = makeFakeCtx(state);
    await pi.emit("session_start", { type: "session_start", reason: "new" } as SessionStartEvent, ctx);
    await pi.emit("turn_end", {}, ctx); // captures oInitialPrompt + fires Observer

    // the background Observer run is fire-and-forget; await the run-lock release.
    await new Promise((r) => setTimeout(r, 20));
    expect(runLockInFlight()).toBe(false);

    const graph = getGraphStore().graph;
    // at least one observation beyond oInitialPrompt was captured + wrapped.
    const newObs = [...graph.observations.values()].filter((o) => o.id !== O_INITIAL_PROMPT);
    expect(newObs.length).toBeGreaterThan(0);
    // each captured obs is parented to a `new` wrapper node at the root.
    for (const o of newObs) {
      const node = graph.nodes.get(o.parentNode);
      expect(node).toBeDefined();
      expect(node?.state).toBe("new");
      expect(node?.parentNode).toBeNull();
    }
    // the frontier advanced past the observed entries.
    expect(getGraphStore().observerFrontier).not.toBeNull();
    expect(script.recorded).toBeGreaterThan(0);
  });

  it("session_before_compact: ensure-ready stages run + summary rendered + snapshot persisted", async () => {
    // Build a branch where the compacted block (before the cut) holds the
    // observed content; the cut keeps the tail.
    const branch: FakeEntry[] = [
      userEntry("u1", "Fix the login bug"),
      assistantEntry("a1", "x".repeat(600)),
      userEntry("u2", "keep working"),
      assistantEntry("a2", "z".repeat(600)),
    ];
    const state: FakePiState = { branch, appendedEntries: [] };
    _setGetMemkeeperSettings(() => ({
      ...DEFAULT_CONFIG,
      observerThresholdTokens: 50,
      // low Builder threshold → Builder RUNS (fast-path not taken) so its
      // stage-end flush_new converts the catch-up `new` nodes to active. The
      // first pass is a no-op (scripted runStage records nothing) → loop ends →
      // flushNew fires. Selector builds regardless (no cached tree → build).
      builderRootViewThreshold: 1,
      selectorRootViewThreshold: 100000,
    }));
    scriptObserverRecordsOnePerChunk();
    const pi = makeFakePi() as FakePi;
    memkeeperExtension(pi);
    const ctx = makeFakeCtx(state);
    await pi.emit("session_start", { type: "session_start", reason: "new" } as SessionStartEvent, ctx);
    await pi.emit("turn_end", {}, ctx); // observe the gap (background)
    await new Promise((r) => setTimeout(r, 20));

    // Now compact: cut keeps u2/a2 (the tail); u1/a1 are the compacted block.
    const compactEvt: SessionBeforeCompactEvent = {
      type: "session_before_compact",
      preparation: { firstKeptEntryId: "u2", tokensBefore: 50000 } as SessionBeforeCompactEvent["preparation"],
      branchEntries: branch as unknown as SessionEntry[],
      reason: "threshold",
      willRetry: false,
      signal: new AbortController().signal,
    } as unknown as SessionBeforeCompactEvent;
    const result = (await pi.emit("session_before_compact", compactEvt, ctx)) as unknown as {
      compaction?: { summary: string; details: unknown };
      cancel?: boolean;
    };

    // the LAST session_before_compact handler is memkeeper's (settings-ui does
    // not register one); its return is the compaction result.
    expect(result.compaction).toBeDefined();
    const summary = result.compaction?.summary ?? "";
    expect(summary).toContain("## Initial prompt");
    expect(summary).toContain("Fix the login bug");
    expect(summary).toContain("## Active set");
    expect(summary).toContain(N_GOAL);

    const graph = getGraphStore().graph;
    // Builder flush_new ran (even on fast-path skip) → no `new` nodes remain.
    const newNodes = [...graph.nodes.values()].filter((n) => n.state === "new");
    expect(newNodes.length).toBe(0);
    // the selected tree was built + persisted (selected-root default).
    expect(getGraphStore().selectedTree).not.toBeNull();
    // structural invariant: every observation under exactly one existing
    // node, containment tree acyclic + consistent, nGoal invariants hold.
    expect(() => validateGraph(getGraphStore().graph)).not.toThrow();
  });

  it("compaction flushes new nodes to active even when the Builder fast-path skips LLM passes (root view under threshold)", async () => {
    // In the default profile, when the root view stays under
    // builderRootViewThreshold at compaction, the Builder is fast-path-skipped
    // — but its flush_new must STILL run so new wrapper nodes (from Observer
    // catch-up) don't linger as state:'new' indefinitely.
    const branch: FakeEntry[] = [
      userEntry("u1", "Fix the login bug"),
      assistantEntry("a1", "x".repeat(600)),
      userEntry("u2", "keep working"),
      assistantEntry("a2", "z".repeat(600)),
    ];
    const state: FakePiState = { branch, appendedEntries: [] };
    _setGetMemkeeperSettings(() => ({
      ...DEFAULT_CONFIG,
      observerThresholdTokens: 50,
      // HIGH threshold → Builder fast-path skips (root view well under it); the
      // hook still calls runBuilder (no pre-gate) and runBuilder flushes new.
      builderRootViewThreshold: 1_000_000,
      selectorRootViewThreshold: 1_000_000,
    }));
    scriptObserverRecordsOnePerChunk();
    const pi = makeFakePi() as FakePi;
    memkeeperExtension(pi);
    const ctx = makeFakeCtx(state);
    await pi.emit("session_start", { type: "session_start", reason: "new" } as SessionStartEvent, ctx);
    await pi.emit("turn_end", {}, ctx); // observe → new wrapper nodes at root
    await new Promise((r) => setTimeout(r, 20));
    // sanity: there is at least one `new` node from the catch-up before compaction.
    const hadNew = [...getGraphStore().graph.nodes.values()].some((n) => n.state === "new");
    expect(hadNew).toBe(true);

    const compactEvt: SessionBeforeCompactEvent = {
      type: "session_before_compact",
      preparation: { firstKeptEntryId: "u2", tokensBefore: 50000 } as SessionBeforeCompactEvent["preparation"],
      branchEntries: branch as unknown as SessionEntry[],
      reason: "threshold",
      willRetry: false,
      signal: new AbortController().signal,
    } as unknown as SessionBeforeCompactEvent;
    await pi.emit("session_before_compact", compactEvt, ctx);
    await new Promise((r) => setTimeout(r, 20));

    // the Builder fast-path ran its flush_new even though it skipped LLM passes
    // (root view under threshold) → no node remains state:'new'.
    const stillNew = [...getGraphStore().graph.nodes.values()].filter((n) => n.state === "new");
    expect(stillNew).toHaveLength(0);
  });

  it("enabled=false off-path: turn_end no-ops + compaction returns undefined (Pi native)", async () => {
    _setGetMemkeeperSettings(() => ({ ...DEFAULT_CONFIG, enabled: false }));
    const state: FakePiState = {
      branch: [userEntry("u1", "Fix the login bug"), assistantEntry("a1", "x".repeat(600))],
      appendedEntries: [],
    };
    const pi = makeFakePi() as FakePi;
    memkeeperExtension(pi);
    const ctx = makeFakeCtx(state);
    await pi.emit("session_start", { type: "session_start", reason: "new" } as SessionStartEvent, ctx);
    await pi.emit("turn_end", {}, ctx);
    await new Promise((r) => setTimeout(r, 10));

    const graph = getGraphStore().graph;
    // disabled → no capture (oInitialPrompt absent), no Observer run, no lock.
    expect(graph.observations.has(O_INITIAL_PROMPT)).toBe(false);
    expect([...graph.observations.values()].length).toBe(0);
    expect(runLockInFlight()).toBe(false);

    // compaction returns undefined (Pi runs its native summary).
    const compactEvt: SessionBeforeCompactEvent = {
      type: "session_before_compact",
      preparation: { firstKeptEntryId: "a1", tokensBefore: 50000 } as SessionBeforeCompactEvent["preparation"],
      branchEntries: state.branch as unknown as SessionEntry[],
      reason: "threshold",
      willRetry: false,
      signal: new AbortController().signal,
    } as unknown as SessionBeforeCompactEvent;
    const result = await pi.emit("session_before_compact", compactEvt, ctx);
    expect(result).toBeUndefined();
  });

  it("compaction with an already-aborted signal → {cancel:true} (clean degrade, never half-built)", async () => {
    // An aborted compaction signal cancels cleanly (no stages run,
    // no partial summary). This is the deterministic cancel seam — the hook
    // never throws and never returns a half-built summary.
    const state: FakePiState = {
      branch: [userEntry("u1", "Fix the login bug"), assistantEntry("a1", "x".repeat(600))],
      appendedEntries: [],
    };
    _setGetMemkeeperSettings(() => ({
      ...DEFAULT_CONFIG,
      observerThresholdTokens: 50,
      builderRootViewThreshold: 1, // would force a Builder run if not aborted
    }));
    const abort = new AbortController();
    abort.abort(); // Pi already gave up before we start
    const pi = makeFakePi() as FakePi;
    memkeeperExtension(pi);
    const ctx = makeFakeCtx(state);
    await pi.emit("session_start", { type: "session_start", reason: "new" } as SessionStartEvent, ctx);

    const compactEvt: SessionBeforeCompactEvent = {
      type: "session_before_compact",
      preparation: { firstKeptEntryId: "a1", tokensBefore: 50000 } as SessionBeforeCompactEvent["preparation"],
      branchEntries: state.branch as unknown as SessionEntry[],
      reason: "threshold",
      willRetry: false,
      signal: abort.signal,
    } as unknown as SessionBeforeCompactEvent;
    const result = (await pi.emit("session_before_compact", compactEvt, ctx)) as {
      cancel?: boolean;
      compaction?: unknown;
    };
    expect(result.cancel).toBe(true);
    expect(result.compaction).toBeUndefined();
    // no stages ran → runStage never called.
    expect(vi.mocked(runStage)).not.toHaveBeenCalled();
  });

  it("/new (session_start reason=new) reseeds an empty graph with nGoal", async () => {
    const state: FakePiState = { branch: [], appendedEntries: [] };
    const pi = makeFakePi() as FakePi;
    memkeeperExtension(pi);
    const ctx = makeFakeCtx(state);
    // simulate a prior populated graph, then a /new resets it.
    await pi.emit("session_start", { type: "session_start", reason: "new" } as SessionStartEvent, ctx);
    await pi.emit("turn_end", {}, ctx); // would observe — but branch empty, nothing to observe

    // /new again: empty branch → fresh graph reseeded (nGoal present, no obs).
    await pi.emit("session_start", { type: "session_start", reason: "new" } as SessionStartEvent, ctx);
    const graph = getGraphStore().graph;
    expect(graph.nodes.has(N_GOAL)).toBe(true);
    expect(graph.observations.size).toBe(0);
  });

  it("/reload (session_start reason=reload) reconstructs the graph from session entries", async () => {
    // A session file that already carries an nGoal seed (graph_delta) + one
    // observation. On reload, load() replays them into the in-memory graph.
    const branch: FakeEntry[] = [
      userEntry("u1", "Fix the login bug"),
      {
        id: "g1",
        type: "custom",
        parentId: null,
        timestamp: "2026-07-28T14:30:00.000Z",
        customType: "memkeeper.graph_delta",
        data: {
          kind: "graph_delta",
          delta: {
            type: "create_node",
            id: N_GOAL,
            summary: "reloaded goal",
            importance: "crit",
            parentNode: null,
            state: "active",
          },
        },
      } as unknown as FakeEntry,
    ];
    const state: FakePiState = { branch, appendedEntries: [] };
    const pi = makeFakePi() as FakePi;
    memkeeperExtension(pi);
    const ctx = makeFakeCtx(state);

    await pi.emit("session_start", { type: "session_start", reason: "reload" } as SessionStartEvent, ctx);

    const graph = getGraphStore().graph;
    // the replayed graph_delta reconstructed nGoal with its stored summary.
    expect(graph.nodes.has(N_GOAL)).toBe(true);
    expect(graph.nodes.get(N_GOAL)?.summary).toBe("reloaded goal");
  });

  it("mk_recall reads the selected tree in selected-root mode (consistent ids)", async () => {
    // Run a full observe→compact cycle so the Selector builds + persists a
    // selected tree carrying observations, then mk_recall reads it.
    const branch: FakeEntry[] = [
      userEntry("u1", "Fix the login bug in auth.ts"),
      assistantEntry("a1", "x".repeat(600)),
      userEntry("u2", "keep working"),
      assistantEntry("a2", "z".repeat(600)),
    ];
    const state: FakePiState = { branch, appendedEntries: [] };
    _setGetMemkeeperSettings(() => ({
      ...DEFAULT_CONFIG,
      observerThresholdTokens: 50,
      builderRootViewThreshold: 1,
      selectorRootViewThreshold: 100000,
    }));
    scriptObserverRecordsOnePerChunk();
    const pi = makeFakePi() as FakePi;
    memkeeperExtension(pi);
    const ctx = makeFakeCtx(state);
    await pi.emit("session_start", { type: "session_start", reason: "new" } as SessionStartEvent, ctx);
    await pi.emit("turn_end", {}, ctx);
    await new Promise((r) => setTimeout(r, 20));
    const compactEvt: SessionBeforeCompactEvent = {
      type: "session_before_compact",
      preparation: { firstKeptEntryId: "u2", tokensBefore: 50000 } as SessionBeforeCompactEvent["preparation"],
      branchEntries: branch as unknown as SessionEntry[],
      reason: "threshold",
      willRetry: false,
      signal: new AbortController().signal,
    } as unknown as SessionBeforeCompactEvent;
    await pi.emit("session_before_compact", compactEvt, ctx);

    // mk_recall (registered read-only tool) reads the selected tree.
    const mkRecall = pi._tool("mk_recall");
    expect(mkRecall).toBeDefined();
    const result = (await mkRecall.execute(
      "call-1",
      { query: "login" },
      new AbortController().signal,
      undefined,
      undefined,
    )) as { content: { type: string; text?: string }[] };
    // selected-root mode: the render references the graph content (the
    // oInitialPrompt-seeded nGoal summary 'Fix the login bug' is in the tree).
    const text = result.content.map((c) => c.text ?? "").join("\n");
    expect(text.length).toBeGreaterThan(0);
    expect(text).toContain("login");
  });
});
