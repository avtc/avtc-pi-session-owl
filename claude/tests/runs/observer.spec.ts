// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import type { SessionEntry } from "@earendil-works/pi-coding-agent";
// The Observer run host port: per-chunk persistence cadence (an aborted
// chunk persists zero records), empty-verdict hole records, the
// mid-catch-up Builder fold, the live enabled gate, timeout classification,
// engine-failure propagation, and the usage ledger per chunk.
import { beforeEach, describe, expect, test, vi } from "vitest";
import { DEFAULT_CONFIG, type SessionOwlConfig } from "../../core/src/config/schema.js";
import { buildChunks } from "../../core/src/format/chunk.js";
import { clearDetailsCache } from "../../core/src/format/details.js";
import { resetForNewSession } from "../../core/src/store/graph-store.js";
import { _resetCoreInstances } from "../../host/core-instances.js";
import { runObserver } from "../../host/runs/observer.js";
import { NO_OP_WIDGET, type StageWidget } from "../../host/runs/seams.js";
import { StageModelError } from "../../host/runs/stage-errors.js";
import { clearAllStageRuns, markContextBudgetHit, type StageRunState } from "../../host/stage/runs.js";
import { handleStageToolCall } from "../../host/stage/tools.js";
import type { EngineStageRunInput } from "../../shims/pi-agent-core/index.js";
import {
  type Behavior,
  branchCustoms,
  entries,
  makeMemoryDumpFs,
  makeRunner,
  mem,
  msgEntry,
  PAD,
  type Rig,
  recorderWidget,
  rigUp,
} from "./helpers.js";

// Simulate the model calling record_observations through the real tool layer.
async function recordViaTool(agentId: string, observations: unknown[]): Promise<unknown> {
  return handleStageToolCall(
    { tool: "mcp__session-owl__record_observations", agentId, observations } as unknown as {
      tool: string;
      agentId?: string;
    },
    (id) => id === agentId,
  );
}

// ---- fixtures (shared rig from ./helpers.js; the Observer-specific
// SETTINGS + chunk-first-id + recordsId helpers stay local) --------------

const SETTINGS: SessionOwlConfig = {
  ...DEFAULT_CONFIG,
  observerThresholdTokens: 60, // every user+assistant group (~110 tok) flushes → one chunk per pair
  observerMaxTokens: 2000,
  llmCallTimeoutMs: 30_000,
};

/** Records `ids` (allowed entry ids) as one observation per id via the tool. */
const recordsIds =
  (ids: string[]): Behavior =>
  async (_input, agentId) => {
    await recordViaTool(
      agentId,
      ids.map((id) => ({ summary: `obs of ${id}`, importance: "med", sourceEntryIds: [id] })),
    );
    return {};
  };

/** The chunking the run itself computes (identical options → identical chunks),
 *  so scripted behaviors can cite ids their own chunk allows. */
function chunkFirstIds(unobserved: SessionEntry[]): string[][] {
  const chunks = buildChunks(unobserved, {
    tokenThreshold: SETTINGS.observerThresholdTokens,
    toolBlockCapTokens: SETTINGS.observerToolBlockCapTokens,
    includeThinking: SETTINGS.observerIncludeThinking,
    includeEntryId: true,
  });
  return chunks.map((c) => [...c.allowedIds]);
}

beforeEach(() => {
  mem.files.clear();
  _resetCoreInstances();
  resetForNewSession();
  clearDetailsCache();
  clearAllStageRuns();
});
// ---- the suite -------------------------------------------------------------

describe("runObserver — the stage dump", () => {
  test("owl's own synthetic rows are never observed (the compaction summary + the attributed-reasoning row)", async () => {
    // Both rows' content is BY CONSTRUCTION already-observed material: the
    // summary is the graph's own render; the attributed row copies pre-cut
    // thinking that was observed before the compaction. The observer must
    // skip them (their lead-ins are the discriminator — owl authored both).
    const unobserved = [
      msgEntry("s1", "# Memory\nYour session memory — the top level…", "user"),
      msgEntry("e1", `entry 1 ${PAD}`, "user"),
      msgEntry("a1", "Reasoning from earlier turns (attributed):\n\nsome pre-cut thinking", "assistant"),
      msgEntry("e2", `entry 2 ${PAD}`, "assistant"),
    ];
    const r = await rigUp("obs-own-rows", unobserved, true);
    const fx = makeRunner([recordsIds(["e1"]), recordsIds(["e2"])]);
    await runObserver({
      core: r.core,
      store: r.store,
      settings: SETTINGS,
      unobserved,
      signal: new AbortController().signal,
      widget: NO_OP_WIDGET,
      runStageFn: fx.runner,
    });
    // the spawned runs carry ONLY the real rows — neither lead-in leaks
    const allPrompts = JSON.stringify(fx.calls.map((c) => c.messages));
    expect(allPrompts).not.toContain("# Memory");
    expect(allPrompts).not.toContain("Reasoning from earlier turns");
    expect(allPrompts).toContain("entry 1");
  });

  test("a batchWindow reports cumulative repair progress against the grand total", async () => {
    // the repair (re-observe) pre-computes one grand chunk total and places
    // each run after the chunks its predecessor ranges completed — the widget
    // then carries a single done/total across the whole repair
    const unobserved = [
      msgEntry("w1", `one ${PAD}`, "user"),
      msgEntry("w2", `two ${PAD}`, "assistant"),
      msgEntry("w3", `three ${PAD}`, "user"),
      msgEntry("w4", `four ${PAD}`, "assistant"),
    ];
    const r = await rigUp("obs-window", unobserved, true);
    const fx = makeRunner([recordsIds(["w1"]), recordsIds(["w3"])]);
    const widget = recorderWidget();
    await runObserver({
      core: r.core,
      store: r.store,
      settings: { ...SETTINGS, observerThresholdTokens: 1 },
      unobserved,
      signal: new AbortController().signal,
      widget,
      runStageFn: fx.runner,
      batchWindow: { offset: 3, total: 7 },
    });
    const lines = widget.calls.filter((c) => c.startsWith("start:observe:") || c.startsWith("batch:"));
    expect(lines[0]).toBe('start:observe:{"batch":{"done":3,"total":7}}');
    expect(lines.slice(1)).toEqual(["batch:4/7", "batch:5/7"]);
  });

  test("short-id mode: the chunk cites sequential shorts; a short citation persists the stored id", async () => {
    const U1 = "583da234-4f1d-4d21-854d-aaaaaaaaaaaa";
    const U2 = "583da234-4f1d-4d21-854d-bbbbbbbbbbbb";
    const unobserved = [msgEntry(U1, `one ${PAD}`, "user"), msgEntry(U2, `two ${PAD}`, "assistant")];
    const r = await rigUp("obs-short-id", unobserved, true);
    const fx = makeRunner([
      async (_i, agentId) => {
        await recordViaTool(agentId, [
          { summary: "obs via the short cite", importance: "med", sourceEntryIds: ["e1"] },
        ]);
        return {};
      },
    ]);
    await runObserver({
      core: r.core,
      store: r.store,
      settings: SETTINGS,
      unobserved,
      signal: new AbortController().signal,
      widget: NO_OP_WIDGET,
      runStageFn: fx.runner,
    });
    // the chunk prompt cites the chunk-scoped short, never the uuid
    const allPrompts = JSON.stringify(fx.calls.map((c) => c.messages));
    expect(allPrompts).toContain("entryId=e1");
    expect(allPrompts).not.toContain(U1);
    // the persisted record carries the STORED id
    const obs = branchCustoms(r, "session-owl.observation");
    expect(obs).toHaveLength(1);
    const record = (obs[0] as { records: { sourceEntryIds: string[] }[] }).records[0];
    expect(record.sourceEntryIds).toEqual([U1]);
  });

  test("debugDumpLimit > 0 flushes the archived chunks as ONE ring-slot dump", async () => {
    const unobserved = entries(4);
    const r = await rigUp("obs-dump-1", unobserved, true);
    const dump = makeMemoryDumpFs();
    const perChunk = chunkFirstIds(unobserved);
    const fx = makeRunner([recordsIds([perChunk[0][0]])]);
    await runObserver({
      core: r.core,
      store: r.store,
      settings: { ...SETTINGS, debugDumpLimit: 1 },
      unobserved,
      signal: new AbortController().signal,
      widget: NO_OP_WIDGET,
      runStageFn: fx.runner,
      dumps: { fs: dump.fs, baseDir: "/owl-data", cwd: "E:\\obs" },
    });
    const text = dump.files.get("/owl-data/dumps/E-obs/observer-0.txt") ?? "";
    expect(text).toContain('<dump stage="observer" started="');
    expect(text).toContain("<chunk i=");
    // the header carries the REAL record tool contract (not a stub)
    expect(text).toContain("Record the observations worth keeping from this chunk.");
    expect(text.endsWith("</dump>\n")).toBe(true);
    // the cost seam rides the stage input: known family resolves, unknown nulls
    const rates = fx.calls[0]?.modelRates;
    expect(rates?.("claude-sonnet-4-6")).toEqual({ inputPerM: 3, outputPerM: 15 });
    expect(rates?.("mimo-v2.6-flash")).toBeNull();
  });
});

describe("runObserver — the machinery context-limit chunk boundary", () => {
  test("a chunk whose agent hit its context budget ends THAT pass; the run continues and the chunk's records persist", async () => {
    const unobserved = entries(9);
    const r = await rigUp("s-ctx-1", unobserved, true);
    const perChunk = chunkFirstIds(unobserved);
    expect(perChunk.length).toBeGreaterThanOrEqual(3);
    const fx2 = makeRunner([
      recordsIds([perChunk[0][0]]),
      async (_input, agentId: string) => {
        await recordViaTool(agentId, [
          { summary: `obs of ${perChunk[1][0]}`, importance: "med", sourceEntryIds: [perChunk[1][0]] },
        ]);
        return { aborted: true, abortReason: "context-limit" } as never;
      },
      recordsIds([perChunk[2][0]]),
    ]);
    await runObserver({
      core: r.core,
      store: r.store,
      settings: SETTINGS,
      unobserved,
      signal: new AbortController().signal,
      widget: NO_OP_WIDGET,
      runStageFn: fx2.runner,
    });
    // the run did NOT stop at the budget: all three chunks ran
    expect(fx2.calls.length).toBeGreaterThanOrEqual(3);
    const graph = r.core.store.getGraphStore().graph;
    // chunk 2's records persisted (the boundary keeps collected work)
    const records = [...graph.nodes.values()].filter((n) =>
      String((n as { summary?: unknown }).summary ?? "").includes(`obs of ${perChunk[1][0]}`),
    );
    expect(records.length).toBeGreaterThan(0);
  });

  test("a chunk whose run THROWS after the context-budget marker is a boundary, not a run failure (the engine encodes the vetoed request as stopReason error)", async () => {
    const unobserved = entries(9);
    const r = await rigUp("s-ctx-2", unobserved, true);
    const perChunk = chunkFirstIds(unobserved);
    expect(perChunk.length).toBeGreaterThanOrEqual(3);
    const fx3 = makeRunner([
      recordsIds([perChunk[0][0]]),
      async (_input, agentId: string) => {
        await recordViaTool(agentId, [
          { summary: `obs of ${perChunk[1][0]}`, importance: "med", sourceEntryIds: [perChunk[1][0]] },
        ]);
        markContextBudgetHit(agentId);
        throw new StageModelError("stage engine failure (error):");
      },
      recordsIds([perChunk[2][0]]),
    ]);
    await runObserver({
      core: r.core,
      store: r.store,
      settings: SETTINGS,
      unobserved,
      signal: new AbortController().signal,
      widget: NO_OP_WIDGET,
      runStageFn: fx3.runner,
    });
    expect(fx3.calls.length).toBeGreaterThanOrEqual(3);
    const graph = r.core.store.getGraphStore().graph;
    const records = [...graph.nodes.values()].filter((n) =>
      String((n as { summary?: unknown }).summary ?? "").includes(`obs of ${perChunk[1][0]}`),
    );
    expect(records.length).toBeGreaterThan(0);
  });
});

describe("runObserver — per-chunk persistence (Defect-A)", () => {
  test("a 3-chunk run persists after chunks 1 and 2; chunk 3 aborts with ZERO records (no verdict for it)", async () => {
    const unobserved = entries(9);
    const r = await rigUp("s-a", unobserved, true);
    const controller = new AbortController();
    const perChunk = chunkFirstIds(unobserved);
    expect(perChunk.length).toBeGreaterThanOrEqual(3); // the abort lands on a LATER chunk
    const fx2 = makeRunner([
      recordsIds([perChunk[0][0]]),
      recordsIds([perChunk[1][0]]),
      async () => {
        controller.abort(); // the abort lands mid-chunk-3 (before its persist)
        return { aborted: true, abortReason: "signal" };
      },
    ]);
    await runObserver({
      core: r.core,
      store: r.store,
      settings: SETTINGS,
      unobserved,
      signal: controller.signal,
      widget: NO_OP_WIDGET,
      runStageFn: fx2.runner,
      // the production seam shape: flush writes the batch, refresh re-folds
      // the live ctx so the just-durable records stay in the in-memory view
      flushLedger: async () => {
        await r.ledger.flush();
        await r.prepared.refresh();
      },
    });
    expect(fx2.calls.length).toBeGreaterThanOrEqual(3);
    const graph = r.core.store.getGraphStore().graph;
    // chunks 1-2 left real wrappers
    expect(graph.nodes.size).toBe(3); // nGoal + 2 wrappers
    // the branch carries exactly two observation records (chunk 3 wrote NONE)
    const obs = branchCustoms(r, "session-owl.observation");
    expect(obs).toHaveLength(2);
    expect(obs[0]).toMatchObject({ coversFromId: "e1", records: [expect.objectContaining({ summary: "obs of e1" })] });
    // the frontier advanced only through the last PERSISTED chunk
    expect(r.core.store.getGraphStore().observerFrontier).toBe(obs[1].coversUpToId);
    // per-chunk DURABILITY: the persisted records are on disk (ledger
    // flushed at each chunk), not sitting in the buffer
    expect(r.ledger.bufferedRecords()).toHaveLength(0);
    const persisted = (await mem.adapter.listDir("/cfg/session-owl/sessions/s-a")).filter((n) =>
      n.startsWith("ledger-"),
    );
    expect(persisted.length).toBeGreaterThanOrEqual(1);
  });

  test("flush cadence: N=5 chunk checkpoints + the run end = ceil(k/5) flushes, never one per record", async () => {
    // the unit-commit contract: a kill mid-run loses at most N=5 chunks of
    // LLM work (N counts observer CHUNKS, not extracted observations), a
    // trivial run pays exactly one flush at its final chunk
    const N = 5;
    // fixture math: groups are user/assistant PAIRS (~58 tokens each) and the
    // threshold flushes every 2 groups ⇒ k = size/4: 8→2, 24→6, 48→12
    // (ceil(k/5) = 1 / 2 / 3 — the middle and last sizes cross the N=5
    // checkpoint boundary)
    for (const size of [8, 24, 48]) {
      const unobserved = entries(size);
      const k = chunkFirstIds(unobserved).length;
      expect(k).toBeGreaterThanOrEqual(2); // probes must beat the ceil(k/5)=1 triviality
      const r = await rigUp(`cad-${size}`, unobserved);
      const fx = makeRunner([], true);
      let flushes = 0;
      await runObserver({
        core: r.core,
        store: r.store,
        settings: SETTINGS,
        unobserved,
        signal: new AbortController().signal,
        widget: NO_OP_WIDGET,
        runStageFn: fx.runner,
        flushLedger: async () => {
          flushes += 1;
        },
      });
      expect(flushes).toBe(Math.ceil(k / N));
    }
  });

  test("a record-bearing chunk that aborts still persists its records (genuine verdicts)", async () => {
    const unobserved = entries(2);
    const r = await rigUp("s-b", unobserved, true);
    const controller = new AbortController();
    const fx = makeRunner([
      async (_i, agentId) => {
        await recordViaTool(agentId, [{ summary: "obs of e1", importance: "med", sourceEntryIds: ["e1"] }]);
        controller.abort();
        return { aborted: true, abortReason: "signal" };
      },
    ]);
    await runObserver({
      core: r.core,
      store: r.store,
      settings: SETTINGS,
      unobserved: entries(2),
      signal: controller.signal,
      widget: NO_OP_WIDGET,
      runStageFn: fx.runner,
    });
    const graph = r.core.store.getGraphStore().graph;
    expect(graph.nodes.size).toBe(2); // nGoal + the wrapper
    expect(branchCustoms(r, "session-owl.observation")).toHaveLength(1);
  });

  test("a 0-record chunk persists an EMPTY-VERDICT hole record (never re-observed automatically)", async () => {
    const unobserved = entries(3);
    const r = await rigUp("s-c", unobserved, true);
    const fx = makeRunner([async () => ({})]); // the model records nothing
    await runObserver({
      core: r.core,
      store: r.store,
      settings: SETTINGS,
      unobserved: entries(3),
      signal: new AbortController().signal,
      widget: NO_OP_WIDGET,
      notify: () => {},
      runStageFn: fx.runner,
    });
    const obs = branchCustoms(r, "session-owl.observation");
    expect(obs.length).toBeGreaterThanOrEqual(1);
    expect(obs[0]).toMatchObject({ records: [], tokenCount: 0 });
    // the frontier advanced past the hole — a re-run covers nothing
    expect(r.core.store.getGraphStore().observerFrontier).not.toBeNull();
  });

  test("a relay no-progress abort is a CHUNK VERDICT: accumulated records persist, no empty hole", async () => {
    const unobserved = entries(2);
    const r = await rigUp("s-np", unobserved, true);
    const fx = makeRunner([
      async (_i, agentId) => {
        await recordViaTool(agentId, [{ summary: "obs of e1", importance: "med", sourceEntryIds: ["e1"] }]);
        return { aborted: true, abortReason: "no-progress" };
      },
    ]);
    await runObserver({
      core: r.core,
      store: r.store,
      settings: SETTINGS,
      unobserved: entries(2),
      signal: new AbortController().signal,
      widget: NO_OP_WIDGET,
      runStageFn: fx.runner,
    });
    const obs = branchCustoms(r, "session-owl.observation");
    expect(obs).toHaveLength(1);
    expect(obs[0].records).toHaveLength(1); // the degenerate stop kept its verdict
  });
});

describe("runObserver — validation + notify", () => {
  test("foreign source ids reject per-record; an all-bad chunk warns via notify", async () => {
    const unobserved = entries(2);
    const r = await rigUp("s-d", unobserved, true);
    const notes: string[] = [];
    const fx = makeRunner([
      async (_i, agentId) => {
        const out = (await recordViaTool(agentId, [
          { summary: "bad id one", importance: "med", sourceEntryIds: ["e998"] },
          { summary: "bad id two", importance: "med", sourceEntryIds: ["e999"] },
        ])) as { deny: string };
        // an ALL-rejected batch answers as a DENY — the engine delivers
        // deny text to the model as an ERROR result, never a success-shaped
        // ack
        expect(out.deny).toContain("rejected:");
        expect(out.deny).not.toContain("accepted:");
        return {};
      },
    ]);
    await runObserver({
      core: r.core,
      store: r.store,
      settings: SETTINGS,
      unobserved: entries(2),
      signal: new AbortController().signal,
      widget: NO_OP_WIDGET,
      notify: (m) => notes.push(m),
      runStageFn: fx.runner,
    });
    expect(notes).toContain("Observer skipped a chunk: all observations cited invalid source ids");
  });

  test("schema-invalid importance and malformed source ids reject per-record (nothing accepted)", async () => {
    const unobserved = entries(2);
    const r = await rigUp("s-schema", unobserved, true);
    const consoleErrors: string[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      consoleErrors.push(args.map(String).join(" "));
    });
    try {
      const fx = makeRunner([
        async (_i, agentId) => {
          const out = (await recordViaTool(agentId, [
            { summary: "bogus importance", importance: "urgent", sourceEntryIds: ["e1"] },
            { summary: "string ids", importance: "med", sourceEntryIds: "e1" },
            { summary: "empty ids", importance: "med", sourceEntryIds: [] },
          ])) as { deny: string };
          expect(out.deny).toContain("rejected:");
          expect(out.deny).not.toContain("accepted: all");
          return {};
        },
      ]);
      await runObserver({
        core: r.core,
        store: r.store,
        settings: SETTINGS,
        unobserved,
        signal: new AbortController().signal,
        widget: NO_OP_WIDGET,
        notify: () => {},
        runStageFn: fx.runner,
      });
      // zero records landed from the malformed chunk
      const wrappers = [...r.core.store.getGraphStore().graph.nodes.values()].filter((n) => n.state === "new");
      expect(wrappers.length).toBe(0);
      // the all-rejected batch answers as a DENY (no result field): the
      // record-execute diagnostics line must not trip over it
      expect(consoleErrors.some((line) => line.includes("diagnostics failed"))).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });

  test("each chunk's dump section closes (balanced forensics: <chunk> … </chunk>)", async () => {
    const unobserved = entries(9); // ≥3 chunks at threshold 60
    const r = await rigUp("s-close", unobserved, true);
    const fx = makeRunner([async () => ({}), async () => ({})]);
    await runObserver({
      core: r.core,
      store: r.store,
      settings: SETTINGS,
      unobserved,
      signal: new AbortController().signal,
      widget: NO_OP_WIDGET,
      notify: () => {},
      runStageFn: fx.runner,
    });
    expect(fx.agents.length).toBeGreaterThanOrEqual(2);
    for (const ag of fx.agents) {
      const sections = ag.dump.sections;
      const openers = sections.filter((x: string) => x.startsWith("<chunk ")).length;
      const closers = sections.filter((x: string) => x === "</chunk>\n").length;
      expect(openers).toBe(1);
      expect(closers).toBe(1);
    }
  });

  test("non-substantive summaries reject (punctuation-only is not an observation)", async () => {
    const unobserved = entries(2);
    const r = await rigUp("s-e", unobserved, true);
    const fx = makeRunner([
      async (_i, agentId) => {
        const out = (await recordViaTool(agentId, [
          { summary: "!!! ???", importance: "med", sourceEntryIds: ["e1"] },
        ])) as { deny: string };
        expect(out.deny).toContain("rejected:");
        return {};
      },
    ]);
    await runObserver({
      core: r.core,
      store: r.store,
      settings: SETTINGS,
      unobserved: entries(2),
      signal: new AbortController().signal,
      widget: NO_OP_WIDGET,
      notify: () => {},
      runStageFn: fx.runner,
    });
    expect(branchCustoms(r, "session-owl.observation")[0].records).toHaveLength(0);
  });

  test("a zero-total run warns 'Observer returned no observations'", async () => {
    const unobserved = entries(2);
    const r = await rigUp("s-f", unobserved, true);
    const notes: string[] = [];
    const fx = makeRunner([async () => ({})]);
    await runObserver({
      core: r.core,
      store: r.store,
      settings: SETTINGS,
      unobserved: entries(2),
      signal: new AbortController().signal,
      widget: NO_OP_WIDGET,
      notify: (m) => notes.push(m),
      runStageFn: fx.runner,
    });
    expect(notes).toContain("Observer returned no observations");
  });
});

describe("runObserver — gates, folding, failures", () => {
  test("disabled mid-run stops at the next chunk boundary (completed chunks durable)", async () => {
    const unobserved = entries(9);
    const r = await rigUp("s-g", unobserved, true);
    let enabled = true;
    const fx = makeRunner([recordsIds(["e1"]), recordsIds(["e3"])]);
    await runObserver({
      core: r.core,
      store: r.store,
      settings: SETTINGS,
      unobserved: entries(9),
      signal: new AbortController().signal,
      widget: NO_OP_WIDGET,
      isEnabled: () => enabled,
      runStageFn: async (input) => {
        const out = await fx.runner(input);
        enabled = false; // the master switch flips after chunk 1 completes
        return out;
      },
    });
    expect(fx.calls).toHaveLength(1); // chunk 2 never ran
    expect(branchCustoms(r, "session-owl.observation")).toHaveLength(1);
  });

  test("the mid-catch-up Builder folds after a record-bearing chunk and the stage re-asserts", async () => {
    const unobserved = entries(6);
    const r = await rigUp("s-h", unobserved, true);
    const widget = recorderWidget();
    const builtAt: number[] = [];
    const fx = makeRunner([recordsIds(["e1"]), recordsIds(["e3"])]);
    await runObserver({
      core: r.core,
      store: r.store,
      settings: SETTINGS,
      unobserved: entries(6),
      signal: new AbortController().signal,
      widget,
      maybeBuild: async () => {
        builtAt.push(fx.calls.length);
        return true;
      },
      runStageFn: fx.runner,
    });
    expect(builtAt.length).toBeGreaterThanOrEqual(1);
    // after a built fold the observe stage re-asserts (start:observe appears twice)
    expect(widget.calls.filter((c) => c.startsWith("start:observe")).length).toBeGreaterThanOrEqual(2);
  });

  test("a relay timeout-class abort throws StageTimeoutError (skip-and-notify surface)", async () => {
    const unobserved = entries(2);
    const r = await rigUp("s-i", unobserved, true);
    const fx = makeRunner([async () => ({ timedOut: true })]);
    await expect(
      runObserver({
        core: r.core,
        store: r.store,
        settings: SETTINGS,
        unobserved: entries(2),
        signal: new AbortController().signal,
        widget: NO_OP_WIDGET,
        runStageFn: fx.runner,
      }),
    ).rejects.toThrow("Observer stopped: an LLM call exceeded the 30s time limit");
  });

  test("an engine failure (refused spawn) propagates unless the caller aborted", async () => {
    const unobserved = entries(2);
    const r = await rigUp("s-j", unobserved, true);
    const boom = new Error("stage engine failure (refusal): nope");
    const fx = makeRunner([
      async () => {
        throw boom;
      },
    ]);
    await expect(
      runObserver({
        core: r.core,
        store: r.store,
        settings: SETTINGS,
        unobserved: entries(2),
        signal: new AbortController().signal,
        widget: NO_OP_WIDGET,
        runStageFn: fx.runner,
      }),
    ).rejects.toThrow("stage engine failure (refusal)");
    // the same throw during a caller abort returns cleanly (no error)
    const controller = new AbortController();
    await expect(
      runObserver({
        core: r.core,
        store: r.store,
        settings: SETTINGS,
        unobserved: entries(2),
        signal: controller.signal,
        widget: NO_OP_WIDGET,
        runStageFn: async (_input) => {
          controller.abort();
          throw boom;
        },
      }),
    ).resolves.toBeUndefined();
  });

  test("per-chunk usage ledger persists (an interrupted run keeps the tally)", async () => {
    const unobserved = entries(6);
    const r = await rigUp("s-k", unobserved, true);
    const fx = makeRunner([recordsIds(["e1"]), recordsIds(["e3"])]);
    await runObserver({
      core: r.core,
      store: r.store,
      settings: SETTINGS,
      unobserved: entries(6),
      signal: new AbortController().signal,
      widget: NO_OP_WIDGET,
      runStageFn: async (input) => {
        input.onStageEnd?.({ input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: 0.001, turns: 2, elapsedMs: 10 });
        return fx.runner(input);
      },
    });
    const usages = branchCustoms(r, "session-owl.usage");
    expect(usages.length).toBeGreaterThanOrEqual(1); // folded + persisted per chunk
    expect(r.core.store.getGraphStore().usageLedger.observe.turns).toBeGreaterThanOrEqual(1);
  });

  test("an empty gap returns without spawning (no chunks, no stage)", async () => {
    const unobserved = entries(0);
    const r = await rigUp("s-l", unobserved, true);
    const widget = recorderWidget();
    const fx = makeRunner([recordsIds(["e1"])]);
    await runObserver({
      core: r.core,
      store: r.store,
      settings: SETTINGS,
      unobserved: [],
      signal: new AbortController().signal,
      widget,
      runStageFn: fx.runner,
    });
    expect(fx.calls).toHaveLength(0);
    expect(widget.calls).toEqual([]);
  });
});

describe("runObserver — the widget event wire", () => {
  test("the stage input's onEvent forwards the run's model-call events into the widget", async () => {
    const unobserved = entries(2);
    const r = await rigUp("obs-wire-1", unobserved, true);
    const seen: string[] = [];
    const widget: StageWidget = {
      ...NO_OP_WIDGET,
      onEvent: (e) => seen.push(String(e.type)),
    };
    const fx = makeRunner([recordsIds([chunkFirstIds(unobserved)[0][0]])]);
    const orig = fx.runner;
    const runner = async (input: EngineStageRunInput) => {
      // the real engine's stage run emits model-call events through the
      // input's onEvent sink — exercise the wire exactly as it does
      input.onEvent?.({ type: "message_start" } as never);
      input.onEvent?.({
        type: "message_end",
        message: {
          usage: { input_tokens: 1, output_tokens: 2, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
          model: "m",
        },
      } as never);
      return orig(input);
    };
    await runObserver({
      core: r.core,
      store: r.store,
      settings: SETTINGS,
      unobserved,
      signal: new AbortController().signal,
      widget,
      runStageFn: runner,
      dumps: null,
    });
    expect(seen).toEqual(["message_start", "message_end"]);
  });
});

// ---- duplicate re-send protection (pi's seenAttempts ledger) ---------------

describe("runObserver — duplicate re-send protection", () => {
  /** One canonical record: cites the chunk's first allowed entry. */
  const REC = { summary: "Chose vitest for the run.", importance: "high", sourceEntryIds: ["e1"] };

  const wrappers = (r: Rig): number =>
    [...r.core.store.getGraphStore().graph.nodes.values()].filter((n) => n.state === "new").length;

  /** Run the chunks of `entryCount` entries (the rendered user entries are
   *  the allowed cites — two per chunk at threshold 60: the smallest pair of
   *  entries yields ONE chunk with a single allowed cite, four entries one
   *  chunk with two) whose first behavior makes one record_observations call
   *  per given batch; returns the tool acks (text + denied flag), the live
   *  run states, and the run's own rig for graph assertions. */
  async function runOneChunk(
    sessionId: string,
    calls: Record<string, unknown>[][],
    notes?: string[],
    entryCount = 2,
  ): Promise<{ acks: { text: string; denied: boolean }[]; agents: StageRunState[]; rig: Rig }> {
    const unobserved = entries(entryCount);
    const rig = await rigUp(sessionId, unobserved, true);
    const acks: { text: string; denied: boolean }[] = [];
    const fx = makeRunner([
      async (_i, agentId) => {
        for (const call of calls) {
          const out = (await recordViaTool(agentId, call)) as { result?: string; deny?: string };
          acks.push({ text: out.result ?? out.deny ?? "", denied: out.deny !== undefined });
        }
        return {};
      },
    ]);
    await runObserver({
      core: rig.core,
      store: rig.store,
      settings: SETTINGS,
      unobserved,
      signal: new AbortController().signal,
      widget: NO_OP_WIDGET,
      notify: (m) => notes?.push(m),
      runStageFn: fx.runner,
    });
    return { acks, agents: fx.agents, rig };
  }

  test("rejects a re-send of an accepted record with an explanatory line; the record stays single", async () => {
    const { acks, agents, rig } = await runOneChunk("dup-warn", [[REC], [REC]]);
    expect(acks[0]).toEqual({ text: "accepted: all", denied: false });
    expect(acks[1]).toEqual({
      text: "rejected:\n#1: duplicate — this observation (same summary and source ids) was already recorded this pass",
      denied: true, // the only record of the batch was rejected
    });
    // the rejected re-send did not feed the relay's accepted counter
    expect(agents[0].acceptedRecords).toBe(1);
    // the chunk still completed normally: one wrapper + one single-record
    // observation entry, frontier advanced
    expect(wrappers(rig)).toBe(1); // the goal node is not "new"
    const obs = branchCustoms(rig, "session-owl.observation");
    expect(obs).toHaveLength(1);
    expect(obs[0].records).toHaveLength(1);
    expect(rig.core.store.getGraphStore().observerFrontier).toBe(obs[0].coversUpToId);
  });

  test("normalizes whitespace and id order: a reflowed re-send with reordered ids is still a duplicate", async () => {
    const { acks, rig } = await runOneChunk(
      "dup-norm",
      [
        [{ summary: "Chose vitest for  the run.", importance: "high", sourceEntryIds: ["e3", "e1"] }],
        [{ summary: "Chose vitest for the  run.", importance: "high", sourceEntryIds: ["e1", "e3"] }],
      ],
      undefined,
      4, // one chunk with two allowed cites
    );
    expect(acks[1].text).toContain("duplicate");
    expect(acks[1].denied).toBe(true);
    expect(wrappers(rig)).toBe(1);
  });

  test("importance is not part of the duplicate key: a same-summary re-send with another importance is still a duplicate", async () => {
    const { acks, rig } = await runOneChunk("dup-imp", [
      [REC],
      [{ summary: REC.summary, importance: "low", sourceEntryIds: [...REC.sourceEntryIds] }],
    ]);
    expect(acks[1].text).toContain("duplicate");
    expect(wrappers(rig)).toBe(1);
  });

  test("different source ids are not duplicates: both records land", async () => {
    const { acks, rig } = await runOneChunk(
      "dup-ids",
      [[REC], [{ ...REC, sourceEntryIds: ["e3"] }]],
      undefined,
      4, // one chunk with two allowed cites
    );
    expect(acks[1]).toEqual({ text: "accepted: all", denied: false });
    expect(wrappers(rig)).toBe(2);
  });

  test("a duplicate inside ONE batch: the second copy is rejected, the first lands (no abort)", async () => {
    const { acks, rig } = await runOneChunk("dup-batch", [[REC, REC]]);
    expect(acks[0]).toEqual({
      text: "accepted: #1\nrejected:\n#2: duplicate — this observation (same summary and source ids) was already recorded this pass",
      denied: false,
    });
    expect(wrappers(rig)).toBe(1);
  });

  test("a re-send AFTER the duplicate rejection aborts the chunk: deny ack, relay abort, nothing persisted, frontier unchanged, notify warning", async () => {
    const notes: string[] = [];
    const { acks, agents, rig } = await runOneChunk("dup-fatal", [[REC], [REC], [REC]], notes);
    // the fatal call answers as a deny carrying the abort line
    expect(acks[2]).toEqual({
      text: "rejected:\n#1: duplicate re-sent after rejection — aborting this chunk",
      denied: true,
    });
    // the relay wiring (pi's stopAfterTurn counterpart): the pass ends at the
    // next step boundary with the duplicate reason
    expect(agents[0].abortFlag).toBe(true);
    expect(agents[0].abortReason).toBe("duplicate");
    // nothing landed anywhere: no observation entry (no empty verdict either —
    // the range stays unobserved), no wrappers, frontier did not move
    expect(branchCustoms(rig, "session-owl.observation")).toHaveLength(0);
    expect(wrappers(rig)).toBe(0);
    expect(rig.core.store.getGraphStore().observerFrontier).toBeNull();
    expect(notes).toContain(
      "Observer aborted a chunk: the model re-sent an already-rejected duplicate. The chunk stays unobserved and will be retried",
    );
  });

  test("the fatal call denies even when the same batch also carried a fresh record (it gets discarded)", async () => {
    const { acks, agents, rig } = await runOneChunk("dup-fresh", [
      [REC],
      [REC],
      [REC, { summary: "Fresh fact.", importance: "med", sourceEntryIds: ["e1"] }],
    ]);
    expect(acks[2].denied).toBe(true);
    expect(acks[2].text).not.toContain("accepted:"); // the fresh record is discarded with the pass
    // the discarded fresh accept must not feed the relay's accepted counter
    // (a fed counter would reset the no-progress streak)
    expect(agents[0].acceptedRecords).toBe(1);
    expect(wrappers(rig)).toBe(0);
  });

  test("an aborted chunk stops the run: later chunks stay unobserved (the frontier cannot jump past the hole)", async () => {
    const unobserved = entries(9); // three chunks at threshold 60
    const perChunk = chunkFirstIds(unobserved);
    expect(perChunk.length).toBe(3);
    const rig = await rigUp("dup-stop", unobserved, true);
    const notes: string[] = [];
    const fx = makeRunner([
      async (_i, agentId) => {
        const rec = { summary: REC.summary, importance: REC.importance, sourceEntryIds: [perChunk[0][0]] };
        await recordViaTool(agentId, [rec]);
        await recordViaTool(agentId, [rec]);
        await recordViaTool(agentId, [rec]);
        return { aborted: true, abortReason: "duplicate" };
      },
      recordsIds([perChunk[1][0]]), // chunk 2 — must never run
    ]);
    await runObserver({
      core: rig.core,
      store: rig.store,
      settings: SETTINGS,
      unobserved,
      signal: new AbortController().signal,
      widget: NO_OP_WIDGET,
      notify: (m) => notes.push(m),
      runStageFn: fx.runner,
    });
    expect(fx.calls.length).toBe(1); // the run stopped at the aborted chunk
    expect(branchCustoms(rig, "session-owl.observation")).toHaveLength(0);
    expect(rig.core.store.getGraphStore().observerFrontier).toBeNull();
    expect(notes).toContain(
      "Observer aborted a chunk: the model re-sent an already-rejected duplicate. The chunk stays unobserved and will be retried",
    );
  });

  test("the aborted chunk's forensics still drain into the dump (the void persists nothing, the dump keeps the pass)", async () => {
    const unobserved = entries(2); // one chunk, one allowed cite
    const rig = await rigUp("dup-dump", unobserved, true);
    const dump = makeMemoryDumpFs();
    const fx = makeRunner([
      async (_i, agentId) => {
        await recordViaTool(agentId, [REC]);
        await recordViaTool(agentId, [REC]);
        await recordViaTool(agentId, [REC]);
        return { aborted: true, abortReason: "duplicate" };
      },
    ]);
    await runObserver({
      core: rig.core,
      store: rig.store,
      settings: { ...SETTINGS, debugDumpLimit: 1 },
      unobserved,
      signal: new AbortController().signal,
      widget: NO_OP_WIDGET,
      notify: () => {},
      runStageFn: fx.runner,
      dumps: { fs: dump.fs, baseDir: "/owl-data", cwd: "E:\\obs" },
    });
    // the per-chunk drain ran BEFORE the void return: the aborted chunk's
    // input + wrapper landed, the closer rode the run-end flush — the
    // wrappers stay balanced exactly as for a completed chunk
    const text = dump.files.get("/owl-data/dumps/E-obs/observer-0.txt") ?? "";
    expect(text).toContain('<dump stage="observer" started="');
    expect(text).toContain("<input>");
    expect(text).toContain('<chunk i="1/1">');
    expect(text).toContain("</chunk>");
    expect(text.endsWith("</dump>\n")).toBe(true);
    // ...while NOTHING persisted from the voided pass
    expect(branchCustoms(rig, "session-owl.observation")).toHaveLength(0);
    expect(rig.core.store.getGraphStore().observerFrontier).toBeNull();
  });
});
