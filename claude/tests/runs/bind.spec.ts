// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import { readFileSync } from "node:fs";
import path from "node:path";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
// The conversation binding — the runtime assembly the register wiring hands
// to the trigger boundaries, the compaction gate, and the commands: the
// conversation's storage assembly + core multiplexer pin + capture entry
// view + live settings + the widget bridge + the real stage runs. Every
// external surface rides the bridge capsules (armed per test); state is
// reset per file (the suite convention).
import { beforeEach, describe, expect, test } from "vitest";
import { DEFAULT_CONFIG } from "../../core/src/config/schema.js";
import { captureAppend, releaseCapture } from "../../host/capture/append-handler.js";
import * as bridge from "../../host/engine-bridge.js";
import { checkpointService } from "../../host/rewind/checkpoint-service.js";
import { _resetBindings, getBinding, raceLoadBudget, releaseBinding, StoreLoadingError } from "../../host/runs/bind.js";
import {
  _resetSettingsConsumerForTest,
  getInstalledSettingsHandle,
  initSettingsConsumer,
  PORT_DEFAULTS_CONFIG,
} from "../../host/settings/consumer.js";
import { loadStoreState } from "../../host/start/backfill.js";
import * as state from "../../host/state.js";
import { flushSessionStorage, getSessionStorage, releaseSessionStorage } from "../../host/storage/session-storage.js";
import { _resetWidgetLine, widgetLine } from "../../host/widget/line-store.js";

function claudeRow(uuid: string, parentUuid: string | null, text: string): Record<string, unknown> {
  return {
    uuid,
    parentUuid,
    door: "prompt",
    origin: { kind: "composer" },
    message: { type: "user", content: [{ type: "text", text }] },
  };
}

describe("conversation binding — the runtime assembly", () => {
  let modelCalls: Record<string, unknown>[];
  let invalidations: number[];
  let widgetLogs: string[];
  let files: Map<string, string>;

  beforeEach(async () => {
    state._resetForTest();
    _resetSettingsConsumerForTest();
    _resetBindings();
    _resetWidgetLine();
    state.resolveConfigDir("/cfg", null);
    modelCalls = [];
    invalidations = [];
    widgetLogs = [];
    files = new Map<string, string>();
    bridge.arm({
      envGetConfigDir: async () => "/cfg",
      envGetSessionOwlSettings: async () => null,
      envSetSessionOwlSettings: async () => {},
      fsRead: async (p: string) => {
        if (!files.has(p)) throw new Error(`ENOENT: ${p}`);
        return files.get(p);
      },
      fsWrite: async (p: string, t: string) => {
        files.set(p, t);
      },
      fsList: async (p: string) =>
        [...files.keys()].filter((k) => k.startsWith(`${p}/`)).map((k) => k.slice(p.length + 1)),
      fsStat: async () => null,
      uiLog: () => {},
      uiInvalidate: () => {
        invalidations.push(1);
      },
      uiStatus: () => {},
      widgetLog: (m: string) => widgetLogs.push(m),
      sessionSurfaces: async () => ["terminal"],
      modelComplete: async (req: Record<string, unknown>) => {
        modelCalls.push(req);
        return { isAnswered: true, text: "extracted goal" };
      },
      avtcTodoGetItems: async () => {
        throw new TypeError("no noun");
      },
      toolCall: async () => {
        throw new Error("no tool");
      },
      agentSpawn: async () => ({ model: "fake", agentId: "ag-1" }),
    } as unknown as Record<string, (...args: unknown[]) => unknown>);
  });

  test("memoized per conversation; release drops the instance", () => {
    const a = getBinding("sess-b", "sess-b", null);
    const b = getBinding("sess-b", "sess-b", null);
    expect(a).toBe(b);
    releaseBinding("sess-b");
    expect(getBinding("sess-b", "sess-b", null)).not.toBe(a);
  });

  test("settings read live through the installed handle; the port's schema defaults before init", () => {
    const binding = getBinding("sess-b", "sess-b", null);
    expect(binding.settings()).toEqual(PORT_DEFAULTS_CONFIG);
    // the port default diverges from the vendored schema in exactly this knob
    expect(binding.settings().defaultModel).toBe("haiku");
  });

  test("an agent-scoped binding with subagentMode on-compaction (the default) defers its observer — the effective-settings override", async () => {
    await initSettingsConsumer({
      configDir: "/cfg",
      cwd: "/w",
      fs: { read: async () => null, write: async () => {}, exists: async () => false },
      env: { get: async () => null, set: async () => {} },
      capsules: { toolRegister: async () => {}, uiInvalidate: () => {}, appendTimeline: () => {} },
    } as never);
    const binding = getBinding("sess-b|agent-1", "sess-b", "agent-1");
    // the schema default keeps observerMode on-threshold; the binding's override
    // defers the subagent conversation's observer to its compaction catch-up
    expect(getInstalledSettingsHandle()?.getSettings().observerMode).toBe("on-threshold");
    expect(binding.settings().observerMode).toBe("on-compaction");
    // the override is the ONLY difference — the rest reads through untouched
    expect(binding.settings().subagentMode).toBe("on-compaction");
    expect(binding.settings().defaultModel).toBe("haiku");
  });

  test("subagentMode inherited leaves the observer cadence alone; disabled never rewrites settings (gates enforce it)", async () => {
    await initSettingsConsumer({
      configDir: "/cfg",
      cwd: "/w",
      fs: { read: async () => null, write: async () => {}, exists: async () => false },
      env: { get: async () => null, set: async () => {} },
      capsules: { toolRegister: async () => {}, uiInvalidate: () => {}, appendTimeline: () => {} },
    } as never);
    const handle = getInstalledSettingsHandle();
    handle?.updateSetting("subagentMode", "inherited");
    const inherited = getBinding("sess-b|agent-2", "sess-b", "agent-2");
    expect(inherited.settings().observerMode).toBe("on-threshold");
    handle?.updateSetting("subagentMode", "disabled");
    const off = getBinding("sess-b|agent-3", "sess-b", "agent-3");
    expect(off.settings().observerMode).toBe("on-threshold");
    expect(off.settings().subagentMode).toBe("disabled");
    // the MAIN conversation is never overridden — the default mode defers
    // subagents only, the main observer cadence is the user's own
    const main = getBinding("sess-b", "sess-b", null);
    expect(main.settings().observerMode).toBe("on-threshold");
  });

  test("isEnabled folds the live master switch", () => {
    const binding = getBinding("sess-b", "sess-b", null);
    expect(binding.isEnabled()).toBe(true);
    state.setOwlEnabled(false);
    expect(binding.isEnabled()).toBe(false);
  });

  test("commandDeps.isEnabled is ENABLED-ONLY — a conflict pause never reads as disabled", async () => {
    const { setConflictHits } = await import("../../host/conflicts/pause.js");
    const binding = getBinding("sess-b", "sess-b", null);
    const deps = binding.commandDeps({
      confirm: async () => false,
      checkThenServe: async () => {},
    });
    state.setOwlEnabled(true);
    setConflictHits([{ channel: "B", name: "other-mod@x", evidence: "session.compact" }]);
    try {
      expect(deps.isEnabled()).toBe(true); // paused ≠ disabled (the pause surfaces live in the bodies)
    } finally {
      setConflictHits(null);
    }
    state.setOwlEnabled(false);
    expect(deps.isEnabled()).toBe(false);
  });

  test("commandDeps.getBranch carries the observation coverage customs (the reobserve scan reads them)", async () => {
    // A messages-only view makes computeUncoveredRanges read every entry
    // behind the frontier as one giant zero-observation hole; the command
    // needs pi's mixed shape — grouped messages PLUS the observation
    // coverage customs off the store branch.
    const binding = getBinding("sess-cmd", "sess-cmd", null);
    await binding.pinCore();
    const conv = state.ensureConversation("sess-cmd", null);
    captureAppend(
      conv.key,
      claudeRow("u1", null, "hello") as never,
      (key, row) => getSessionStorage(key, "sess-cmd", row?.agentId ?? null).mirror,
    );
    captureAppend(
      conv.key,
      claudeRow("a1", "u1", "hi") as never,
      (key, row) => getSessionStorage(key, "sess-cmd", row?.agentId ?? null).mirror,
    );
    // a record-bearing observation covering both seeded rows lands on the
    // store as a ledger record (the fold surfaces it as a branch custom)
    const storage = getSessionStorage(conv.key, "sess-cmd", null);
    storage.ledger.append(
      "observation",
      {
        coversFromId: "u1",
        coversUpToId: "a1",
        records: [{ sourceEntryIds: ["u1", "a1"], text: "seen" }],
      } as never,
      "a1",
    );
    await flushSessionStorage(conv.key);
    const deps = binding.commandDeps({
      confirm: async () => false,
      checkThenServe: async () => {},
    });
    const branch = deps.getBranch(null);
    const customs = branch.filter((e) => (e as { customType?: string }).customType === "session-owl.observation");
    expect(customs.length).toBe(1);
    expect(branch.some((e) => e.type === "message")).toBe(true);
  });

  test("commandDeps.relaunchMaintenance RETURNS the launch promise (the rescan failure path binds)", async () => {
    const binding = getBinding("sess-b", "sess-b", null);
    const deps = binding.commandDeps({
      confirm: async () => false,
      checkThenServe: async () => {},
    });
    state.setOwlEnabled(false); // the chain no-ops — but the promise itself must be handed back
    const p = deps.relaunchMaintenance();
    expect(typeof (p as unknown as { then?: unknown }).then).toBe("function");
    await (p as Promise<void>);
  });

  test("a re-created AGENT binding hydrates its durable mirror batches (release-at-turn-end must not stump the branch)", async () => {
    // An agent loop's storage is RELEASED at each of its turn ends; the
    // re-created MirrorWriter starts empty and the flushed rows live only
    // in the session dir's batch files. Without adoption, the binding's
    // branch — the compaction gate's catch-up input — reads only the
    // post-release rows (a subagent's compact reads one entry while its
    // mirror held a dozen rows on disk).
    const key = "sess-b|agent-rel";
    const conv = state.ensureConversation("sess-b", "agent-rel");
    expect(conv.key).toBe(key);
    const mirrorFor = (k: string, row?: { agentId?: string }) =>
      getSessionStorage(k, "sess-b", row?.agentId ?? "agent-rel").mirror;
    captureAppend(key, claudeRow("r1", null, "round one") as never, mirrorFor as never);
    captureAppend(key, claudeRow("r2", "r1", "round one reply") as never, mirrorFor as never);
    await flushSessionStorage(key);
    // the turn ends: everything released (register.ts does exactly this —
    // the capture cache AND the storage AND the binding)
    releaseCapture(key);
    releaseSessionStorage(key);
    releaseBinding(key);
    // the next round's rows arrive under a FRESH capture
    captureAppend(key, claudeRow("r3", "r2", "round two") as never, mirrorFor as never);
    const binding = getBinding(key, "sess-b", "agent-rel");
    await binding.pinCore();
    const branch = binding.branch();
    expect(branch.length).toBe(3); // durable r1+r2 adopted back + live r3
  });

  test("a binding pins against the transcript's truth: rows the mirror lacks are re-mirrored before serving", async () => {
    // The conversation binding is the SECOND entry into the same load: it
    // must do the FULL work — read the transcript, re-mirror the rows the
    // mirror lacks, and only then serve. A shortened path that only sweeps
    // the mirror serves an amputated branch whenever it wins the load
    // (a fast pin before the boot backfill, a failed boot read).
    const dir = "/cfg/session-owl/sessions/sess-gap";
    const trow = (uuid: string, parentUuid: string | null, ts: string, text: string) =>
      JSON.stringify({
        uuid,
        parentUuid,
        type: "user",
        timestamp: ts,
        message: { role: "user", content: [{ type: "text", text }] },
      });
    files.set(
      "/cfg/t-gap.jsonl",
      `${trow("g1", null, "2026-11-01T10:00:00.000Z", "one")}${"\n"}${trow(
        "g2",
        "g1",
        "2026-11-01T10:01:00.000Z",
        "two",
      )}${"\n"}${trow("g3", "g2", "2026-11-01T10:02:00.000Z", "three")}${"\n"}`,
    );
    files.set(`${dir}/.session.json`, JSON.stringify({ sessionId: "sess-gap", transcriptPath: "/cfg/t-gap.jsonl" }));
    state.setCurrentTranscriptPath("/cfg/t-gap.jsonl");
    const binding = getBinding("sess-gap", "sess-gap", null);
    await binding.pinCore();
    const branch = binding.branch();
    expect(branch.map((e) => e.id)).toEqual(["g1", "g2", "g3"]);
  });

  test("a load that outruns the budget rejects with StoreLoadingError and never cancels the load", async () => {
    let resolveLoad: () => void = () => {};
    const load = new Promise<string>((resolve) => {
      resolveLoad = () => resolve("loaded");
    });
    const pin = raceLoadBudget(load);
    await expect(pin).rejects.toBeInstanceOf(StoreLoadingError);
    resolveLoad();
    await expect(load).resolves.toBe("loaded"); // the load ran to completion
  });

  test("a boot-stamped prepared state is the binding's fast exit (no second derivation)", async () => {
    const trow = (uuid: string, parentUuid: string | null, ts: string, text: string) =>
      JSON.stringify({
        uuid,
        parentUuid,
        type: "user",
        timestamp: ts,
        message: { role: "user", content: [{ type: "text", text }] },
      });
    files.set("/cfg/t-stamp.jsonl", `${trow("s1", null, "2026-11-01T10:00:00.000Z", "one")}${"\n"}`);
    state.setCurrentTranscriptPath("/cfg/t-stamp.jsonl");
    const storage = getSessionStorage("sess-stamp", "sess-stamp", null);
    // the boot lane's derivation (as register.ts parks it after runBackfill)
    const bootLoaded = await loadStoreState(storage.mirror, storage.ledger, {
      sessionId: "sess-stamp",
      fs: storage.fs,
      transcriptPath: "/cfg/t-stamp.jsonl",
    });
    storage.sharedPrepared = { context: bootLoaded.prepared, sessionId: "sess-stamp" };
    const binding = getBinding("sess-stamp", "sess-stamp", null);
    await binding.pinCore();
    expect(binding.branch().map((e) => e.id)).toEqual(["s1"]);
    // the fast exit returned the BOOT's context object — no re-derivation
    expect(storage.sharedPrepared?.context).toBe(bootLoaded.prepared);
    // and a session mismatch invalidates: a different id must re-derive, not reuse
    storage.sharedPrepared = { context: bootLoaded.prepared, sessionId: "other-session" };
    binding.reprepareStore();
    await binding.pinCore();
    expect(binding.branch().map((e) => e.id)).toEqual(["s1"]);
  });

  test("a resumed binding serves the conversation order, not the file order (multi-producer batches)", async () => {
    // Two writers' batches on disk: the OLD lineage (seq 9) holds the
    // conversation's first rows, a LATER writer's seq-2 batch holds newer
    // rows. File order (seq) serves the newer rows first, the adopted tip
    // becomes an old row, and the chain walk stumps the branch. The
    // binding must re-sequence by the conversation order (timestamp)
    // before serving — the same order the boot backfill applies.
    const dir = "/cfg/session-owl/sessions/sess-order";
    const row = (uuid: string, parentUuid: string | null, ts: string, text: string) =>
      JSON.stringify({
        uuid,
        parentUuid,
        row: {
          uuid,
          parentUuid,
          door: "prompt",
          origin: { kind: "composer" },
          message: { type: "user", content: [{ type: "text", text }] },
          timestamp: ts,
        },
      });
    files.set(
      `${dir}/m9-aaaaaaaa.jsonl`,
      `${row("o1", null, "2026-11-01T10:00:00.000Z", "first")}\n${row("o2", "o1", "2026-11-01T10:01:00.000Z", "second")}\n`,
    );
    files.set(`${dir}/m2-bbbbbbbb.jsonl`, `${row("n1", "o2", "2026-11-02T09:00:00.000Z", "newest")}\n`);
    const binding = getBinding("sess-order", "sess-order", null);
    await binding.pinCore();
    const branch = binding.branch();
    expect(branch.map((e) => e.id)).toEqual(["o1", "o2", "n1"]);
  });

  test("pinCore resolves the conversation's handle; branch/leafId read the capture cache", async () => {
    const binding = getBinding("sess-b", "sess-b", null);
    const handle = await binding.pinCore();
    expect(handle.key).toBe("sess-b");
    // an empty capture view: null leaf, empty branch
    expect(binding.leafId()).toBeNull();
    expect(binding.branch()).toEqual([]);
    const conv = state.ensureConversation("sess-b", null);
    captureAppend(
      conv.key,
      claudeRow("u1", null, "hello") as never,
      (key, row) => getSessionStorage(key, "sess-b", row?.agentId ?? null).mirror,
    );
    const branch = binding.branch();
    expect(branch.length).toBe(1);
    expect(binding.leafId()).toBe((branch[branch.length - 1] as SessionEntry).id);
  });

  test("the served branch excludes rewind-dead rows (rewind-aware rescan/compaction scope)", async () => {
    const binding = getBinding("sess-b", "sess-b", null);
    await binding.pinCore();
    const conv = state.ensureConversation("sess-b", null);
    captureAppend(
      conv.key,
      claudeRow("u1", null, "live one") as never,
      (key, row) => getSessionStorage(key, "sess-b", row?.agentId ?? null).mirror,
    );
    captureAppend(
      conv.key,
      claudeRow("u2", "u1", "dead after rewind") as never,
      (key, row) => getSessionStorage(key, "sess-b", row?.agentId ?? null).mirror,
    );
    captureAppend(
      conv.key,
      claudeRow("u3", "u2", "live two") as never,
      (key, row) => getSessionStorage(key, "sess-b", row?.agentId ?? null).mirror,
    );
    expect(binding.branch()).toHaveLength(3);
    // the reconciliation marks u2 dead — the served branch drops it; the
    // mirror keeps the row (arrival order intact), only the served view filters
    checkpointService().noteDivergenceDead(conv.key, ["u2"]);
    const branch = binding.branch();
    expect(branch).toHaveLength(2);
    expect(JSON.stringify(branch)).not.toContain("dead after rewind");
  });

  test("triggerDeps carry the wiring contract (key, runs, gates)", async () => {
    const binding = getBinding("sess-b", "sess-b", null);
    const deps = binding.triggerDeps();
    expect(deps.key).toBe("sess-b");
    expect(typeof deps.runs.runObserver).toBe("function");
    expect(typeof deps.runs.runBuilder).toBe("function");
    expect(typeof deps.runs.runSelector).toBe("function");
    expect(deps.cheapGateClean()).toBe(true);
    // the launch runs the REAL observer module: an empty unobserved slice
    // completes without spawning anything
    await deps.runs.runObserver({ signal: new AbortController().signal, unobserved: [] });
    expect(modelCalls.length).toBe(0);
  });

  test("the widget bridge publishes the stage line on a band surface", () => {
    const binding = getBinding("sess-b", "sess-b", null);
    binding.widget.startStage("observe", { pass: 1 });
    binding.widget.render(); // the transition render (the runs' own cadence)
    expect(widgetLine()).not.toBeNull();
    binding.widget.endStage(); // endStage re-renders on its own
    expect(widgetLine()).toBeNull();
  });

  test("goal-extract launch maps onto the model capsule with the settings model", async () => {
    // a real settings handle with a defaultModel (the production read path)
    await initSettingsConsumer({
      configDir: "/cfg",
      cwd: "/w",
      fs: {
        read: async () => null,
        write: async () => {},
        exists: async () => false,
      },
      env: {
        get: async () => null,
        set: async () => {},
      },
      capsules: { toolRegister: async () => {}, uiInvalidate: () => {}, appendTimeline: () => {} },
    } as never);
    const handle = getInstalledSettingsHandle();
    expect(handle).not.toBeNull();
    handle?.updateSetting("defaultModel", "fake-goal-model");
    const binding = getBinding("sess-b", "sess-b", null);
    await binding.launchGoalExtract("Redesign the auth flow");
    expect(modelCalls.length).toBe(1);
    const req = modelCalls[0] as { model?: unknown; prompt?: unknown; maxTokens?: unknown };
    expect(req.model).toBe("fake-goal-model");
    expect(req.maxTokens).toBe(DEFAULT_CONFIG.observerMaxTokens); // the observer tokens knob (owner ruling)
    expect(String(req.prompt)).toContain("Redesign the auth flow");
  });

  test("goal-extract with Session default and no session model skips the call (Builder backstop), never throws", async () => {
    // a real handle with defaultModel explicitly cleared (the Session default
    // pick) and no session model in the bridge: the model chain resolves to
    // nothing, so the completer must skip
    await initSettingsConsumer({
      configDir: "/cfg",
      cwd: "/w",
      fs: {
        read: async () => null,
        write: async () => {},
        exists: async () => false,
      },
      env: {
        get: async () => null,
        set: async () => {},
      },
      capsules: { toolRegister: async () => {}, uiInvalidate: () => {}, appendTimeline: () => {} },
    } as never);
    getInstalledSettingsHandle()?.updateSetting("defaultModel", null, { level: "session" });
    const binding = getBinding("sess-b", "sess-b", null);
    await binding.launchGoalExtract("verbatim");
    expect(modelCalls.length).toBe(0);
  });
  test("a stage transition lands the band line in the store and invalidates ui.render", async () => {
    const binding = getBinding("sess-w", "sess-w", null);
    binding.widget.startStage("observe", { pass: 1 });
    binding.widget.onEvent({
      type: "message_end",
      message: {
        usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        model: "m",
      },
    } as never);
    // leading render is immediate; the async surface dispatch needs a tick
    await new Promise((resolve) => setTimeout(resolve, 30));
    const line = widgetLine();
    expect(line).not.toBeNull();
    expect(line).toContain("🦉");
    expect(invalidations.length).toBeGreaterThan(0);
    expect(widgetLogs.some((m) => m.includes("band publish"))).toBe(true);
    // endStage hides the line again (the re-publish on drop)
    binding.widget.endStage();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(widgetLine()).toBeNull();
  });
});

describe("bind — every built stage-run input wires the unit-commit flush seam", () => {
  test("every await runBuilder({/runSelector({ input literal in bind.ts carries flushLedger", () => {
    const file = path.resolve(__dirname, "../../host/runs/bind.ts");
    const text = readFileSync(file, "utf8");
    const suspects: string[] = [];
    let scans = 0;
    for (const m of text.matchAll(/await (runBuilder|runSelector)\(\{/g)) {
      scans += 1;
      const name = m[1] ?? "?";
      const open = (m.index ?? 0) + m[0].length - 1; // index of '{'
      let depth = 0;
      let end = -1;
      for (let i = open; i < text.length; i += 1) {
        const ch = text[i];
        if (ch === "{") depth += 1;
        else if (ch === "}") {
          depth -= 1;
          if (depth === 0) {
            end = i;
            break;
          }
        }
      }
      const body = end === -1 ? "" : text.slice(open, end + 1);
      if (end === -1 || !body.includes("flushLedger")) suspects.push(`${name} at offset ${String(m.index)}`);
    }
    // the scan must actually have subjects (the trigger + compaction builders)
    expect(scans).toBeGreaterThanOrEqual(4);
    // a constructor without its drain = a stage run whose buffer only reaches
    // the disk at some unrelated boundary — the unit-commit contract forbids it
    expect(suspects).toEqual([]);
  });
});
