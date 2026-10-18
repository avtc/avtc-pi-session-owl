// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { SessionMessage } from "claude-code";
// The compaction takeover — the session.compact gate. Gate order: live
// pause predicate → enabled → cut at gate entry →
// acquireForCompaction → ensure-ready phases (Observer catch-up frontier→cut
// with mid-catch-up Builder folding, Builder fast-path intact, Selector when
// selected-root, enabled re-checked between phases) → render → snapshot
// persist BEFORE the answer → answer. Failure anywhere ⇒ {skip} + notify.
import { beforeEach, describe, expect, test } from "vitest";
import { DEFAULT_CONFIG, type SessionOwlConfig } from "../../core/src/config/schema.js";
import { clearDetailsCache } from "../../core/src/format/details.js";
import { cloneLedger, EMPTY_LEDGER } from "../../core/src/store/codecs.js";
import { resetForNewSession } from "../../core/src/store/graph-store.js";
import { makeNode, nowStoredTimestamp } from "../../core/src/types.js";
import { type CompactionHookDeps, compactionTakeover } from "../../host/compaction/hook.js";
import { _resetCoreInstances } from "../../host/core-instances.js";
import { ModelUnavailableError } from "../../host/runs/seams.js";
import { _resetMeasureSnapshots, recordMeasure } from "../../host/triggers/context.js";
import { _resetRunLocks, inFlight } from "../../host/triggers/run-locks.js";

// --- fixtures ----------------------------------------------------------------

const PAD = "x".repeat(600);

function entry(id: string): SessionEntry {
  return {
    id,
    timestamp: `${id}-ts`,
    type: "message",
    message: { role: "user", content: `entry ${id} ${PAD}` },
  } as unknown as SessionEntry;
}

/** An assistant branch entry whose content holds a thinking block. */
function thinkingEntry(id: string, thinking: string): SessionEntry {
  return {
    id,
    timestamp: `${id}-ts`,
    type: "message",
    message: { role: "assistant", content: [{ type: "thinking", thinking }] },
  } as unknown as SessionEntry;
}

function message(text: string, over: Record<string, unknown> = {}): SessionMessage {
  return { role: "user", text, toolUses: [], ...over } as SessionMessage;
}

/** A valid store: one root node with its observation. */
function fakeStore() {
  const obs = {
    id: "o-1",
    parentNode: "n-1",
    summary: "the initial prompt observation",
    sourceEntryIds: ["e1"],
    importance: "med",
    createdAt: nowStoredTimestamp(),
    state: "active",
  };
  const node = makeNode({
    id: "n-1" as never,
    summary: "root",
    importance: "med",
    parentNode: null,
    state: "active",
    createdAt: nowStoredTimestamp(),
  });
  node.observationIds = ["o-1"];
  return {
    graph: { nodes: new Map([[node.id as string, node]]), observations: new Map([["o-1", obs]]) },
    selectedTree: null,
    usageLedger: cloneLedger(EMPTY_LEDGER),
    lastCompactionLedger: null,
    observerFrontier: null as string | null,
    resolveEntries: null,
  };
}

interface Harness {
  order: string[];
  deps: CompactionHookDeps;
  notifications: Array<{ message: string; level: string }>;
  logs: string[];
  branch: SessionEntry[];
  store: ReturnType<typeof fakeStore>;
  setSettings: (s: Partial<SessionOwlConfig>) => void;
}

function makeHarness(over: Partial<CompactionHookDeps> = {}): Harness {
  const order: string[] = [];
  const notifications: Array<{ message: string; level: string }> = [];
  const logs: string[] = [];
  const branch = [entry("e1"), entry("e2"), entry("e3"), entry("e4")];
  const store = fakeStore();
  const settings = { ...DEFAULT_CONFIG, observerThresholdTokens: 60 } as SessionOwlConfig;
  const deps: CompactionHookDeps = {
    key: "sess-c",
    settings,
    getSettings: () => settings,
    isPaused: () => false,
    keepRecentTokens: 6, // drops the first two messages (each ~5 tokens) -> cut at the third, catch-up gap [second]
    keptTailAggregatedThinking: true,
    injectedSummaryRow: false,
    getBranch: () => branch,
    getLeafId: () => branch[branch.length - 1]?.id ?? null,
    getObserverFrontier: () => store.observerFrontier,
    pinCore: async () => {
      order.push("pin");
    },
    getGraphStore: () => store as never,
    runs: {
      runObserver: async (input) => {
        order.push(`observer:${input.unobserved.length}`);
        expect(inFlight("sess-c")).toBe(true); // the compaction lock is held through the phases
      },
      runBuilder: async (input) => {
        order.push(`builder:${input.scope?.firstKeptEntryId ?? "null"}`);
      },
      runSelector: async (input) => {
        order.push(`selector:${input.scope?.firstKeptEntryId ?? "null"}`);
      },
    },
    persistSnapshot: async (details, compactionId) => {
      order.push(`persist:${compactionId}`);
      expect(details).toHaveProperty("nodes"); // the encoded details object
    },
    notify: (message2, level) => notifications.push({ message: message2, level }),
    log: (m) => logs.push(m),
    newCompactionId: () => "c-1",
    ...over,
  };
  return {
    order,
    deps,
    notifications,
    logs,
    branch,
    store,
    setSettings: (s) => {
      Object.assign(settings, s); // deps.settings + getSettings share this object
    },
  };
}

function compactableMessages(): SessionMessage[] {
  return [
    message("old one — pad 1234"),
    message("old two — pad 1234"),
    message("recent three — pad"),
    message("recent four — pad"),
  ];
}
const EVENT = {
  trigger: "manual" as const,
  messages: compactableMessages(),
};

beforeEach(() => {
  _resetRunLocks();
  _resetMeasureSnapshots();
  _resetCoreInstances();
  resetForNewSession();
  clearDetailsCache();
});

// --- the gate ----------------------------------------------------------------

describe("compaction takeover — success path", () => {
  test("kept-tail thinking folds INTO the '# Memory' summary row (the only model-visible channel); the display echo shows the summary WITHOUT the section", async () => {
    recordMeasure("sess-c", { tokens: 50_000, window: 200_000 });
    const h = makeHarness();
    const branch = [...h.branch, thinkingEntry("e-t1", "the reasoning that must survive")];
    const deps = { ...h.deps, getBranch: () => branch };
    const outcome = await compactionTakeover(EVENT, deps);
    expect(outcome.kind).toBe("answer");
    if (outcome.kind !== "answer") return;
    const messages = outcome.result.messages;
    // messages[0] = the summary user row: it carries the reasoning section
    const first = messages[0];
    expect(first?.role).toBe("user");
    expect(first?.text).toContain("## Reasoning from turns kept in conversation history");
    expect(first?.text).toContain("the reasoning that must survive");
    // NO trailing assistant row by default (the synthetic row is dead —
    // the engine never serves it)
    const last = messages[messages.length - 1];
    expect(last?.text.startsWith("Reasoning from")).toBe(false);

    // the display knob: the trailing row echoes the SUMMARY alone — the
    // reasoning section is agent-only (it rides the model-visible row)
    const echo = await compactionTakeover(EVENT, { ...deps, injectedSummaryRow: true });
    if (echo.kind !== "answer") return;
    const echoMessages = echo.result.messages;
    const echoLast = echoMessages[echoMessages.length - 1];
    expect(echoLast?.role).toBe("assistant");
    expect(echoLast?.text.startsWith("# Memory")).toBe(true);
    expect(echoLast?.text).not.toContain("Reasoning from turns kept in conversation history");
  });

  test("the knob off (or no thinking in the tail) appends nothing", async () => {
    recordMeasure("sess-c", { tokens: 50_000, window: 200_000 });
    const h = makeHarness();
    const branch = [...h.branch, thinkingEntry("e-t1", "the reasoning that must survive")];
    const off = await compactionTakeover(EVENT, {
      ...h.deps,
      getBranch: () => branch,
      keptTailAggregatedThinking: false,
    });
    expect(off.kind).toBe("answer");
    if (off.kind !== "answer") return;
    expect(off.result.messages[off.result.messages.length - 1]?.text.startsWith("Reasoning from earlier turns")).toBe(
      false,
    );
    // and with the knob on but no thinking entries in the branch: also nothing
    const plain = await compactionTakeover(EVENT, h.deps);
    expect(plain.kind).toBe("answer");
    if (plain.kind !== "answer") return;
    expect(
      plain.result.messages[plain.result.messages.length - 1]?.text.startsWith("Reasoning from earlier turns"),
    ).toBe(false);
  });

  test("takeover shape: summary message first (owl header verbatim), kept tail as received, snapshot persisted BEFORE the answer", async () => {
    recordMeasure("sess-c", { tokens: 50_000, window: 200_000 });
    const h = makeHarness();
    const outcome = await compactionTakeover(EVENT, h.deps);
    expect(outcome.kind).toBe("answer");
    if (outcome.kind !== "answer") return;
    const result = outcome.result;
    expect(result.messages[0]?.text.startsWith("# Memory")).toBe(true); // owl's own header — renderSummary verbatim
    expect(result.messages[0]?.handle).toBeUndefined();
    expect(result.messages[0]?.role).toBe("user");
    expect((result.messages.length ?? 0) > 1).toBe(true); // the kept tail rode along
    expect(result.tokensBefore).toBe(50_000); // the measure bracket
    expect(typeof result.tokensAfter).toBe("number");
    expect("usage" in result && result.usage !== undefined).toBe(false); // the engine's usage field stays absent
    // the full gate ran: pin → observer catch-up → builder → (selector only in selected-root) → persist
    expect(h.order.filter((e) => e.startsWith("observer")).length).toBe(1);
    expect(h.order.filter((e) => e.startsWith("builder:")).length).toBe(1);
    expect(h.order.filter((e) => e.startsWith("selector")).length).toBe(0); // observations-root default
    const builderEntry = h.order.find((e) => e.startsWith("builder:"));
    expect(builderEntry).toBeDefined();
    expect(h.order.indexOf("persist:c-1")).toBeGreaterThan(h.order.indexOf(builderEntry as string)); // snapshot precedes the answer
    // no transcript notice row is written: the engine itself persists the
    // answer's summary message as a plain user row (resume reads that), and
    // the plugin-appended row rendered nowhere — dropped
    expect(h.order.includes("summary-row")).toBe(false);
    expect(h.notifications).toEqual([]);
    expect(inFlight("sess-c")).toBe(false); // released in finally
  });

  test("the answer outcome carries the cut anchor — the kept tail's first row id (the alignment exemption boundary)", async () => {
    recordMeasure("sess-c", { tokens: 50_000, window: 200_000 });
    const h = makeHarness();
    const outcome = await compactionTakeover(EVENT, h.deps);
    expect(outcome.kind).toBe("answer");
    if (outcome.kind !== "answer") return;
    // keepRecentTokens 6 drops the first two branch entries -> first kept =
    expect(outcome.cut).toBe("e3");
    // the diagnostic names the collection region + the branch size (the
    // empty-branch failure must be visible in the log)
    expect(h.logs.some((l) => l.includes("kept-tail thinking:") && l.includes("cut e3"))).toBe(true);
  });

  test("a skipped takeover never writes the summary row", async () => {
    const h = makeHarness();
    h.setSettings({ enabled: false });
    const outcome = await compactionTakeover(
      { trigger: "manual", messages: compactableMessages() },
      h.deps as unknown as CompactionHookDeps,
    );
    expect(outcome.kind).toBe("pass"); // disabled → the engine's own compaction
    expect(h.order.includes("summary-row")).toBe(false);
  });

  test("the cut rides the answer: the kept tail is the budget suffix (tool pairs whole)", async () => {
    const h = makeHarness();
    const call = {
      role: "assistant",
      text: "the call",
      toolUses: [{ tool_use_id: "t1", tool: "owl_recall", input: { query: "q" } }],
    } as unknown as SessionMessage;
    const resultMsg = {
      role: "user",
      text: "the result",
      toolUses: [],
      toolResults: [{ tool_use_id: "t1", text: "ok", isError: false }],
    } as unknown as SessionMessage;
    const messages = [message("ancient one"), message("ancient two"), call, resultMsg, message("newest")];
    const outcome = await compactionTakeover({ trigger: "auto", messages }, { ...h.deps, keepRecentTokens: 5 });
    expect(outcome.kind).toBe("answer");
    if (outcome.kind !== "answer") return;
    const texts = outcome.result.messages.map((m) => m.text);
    expect(texts).toContain("the call"); // the pair stayed whole
    expect(texts).toContain("the result");
    expect(texts).not.toContain("ancient one"); // the oldest dropped below the budget
  });
});

describe("compaction takeover — transparent paths", () => {
  test("paused (conflict self-restraint) ⇒ pass through — the live predicate gates at entry", async () => {
    const h = makeHarness({ isPaused: () => true });
    const outcome = await compactionTakeover(EVENT, h.deps);
    expect(outcome).toEqual({ kind: "pass" });
    expect(h.order).toEqual([]); // nothing ran
  });

  test("disabled at entry ⇒ pass through (native compaction proceeds)", async () => {
    const h = makeHarness();
    h.setSettings({ enabled: false });
    const outcome = await compactionTakeover(EVENT, h.deps);
    expect(outcome).toEqual({ kind: "pass" });
    expect(h.order).toEqual([]);
  });
});

describe("compaction takeover — failure paths", () => {
  test("a stage failure ⇒ {skip} + notify, conversation untouched, lock released", async () => {
    const h = makeHarness();
    h.deps.runs.runObserver = async () => {
      throw new Error("observer exploded");
    };
    const outcome = await compactionTakeover(EVENT, h.deps);
    expect(outcome.kind).toBe("skip");
    if (outcome.kind !== "skip") return;
    expect(outcome.result.skip).toContain("observer exploded");
    expect(h.notifications.length).toBe(1); // the user sees why
    expect(inFlight("sess-c")).toBe(false); // released — the next trigger retries
  });

  test("a conversation that fits the keep window is declined — {skip} 'nothing to compact', no stages run", async () => {
    const h = makeHarness();
    h.deps.keepRecentTokens = 1_000_000; // everything fits — the swallowed prefix is empty
    const outcome = await compactionTakeover(EVENT, h.deps);
    expect(outcome.kind).toBe("skip");
    if (outcome.kind !== "skip") return;
    expect(outcome.result.skip).toBe("session-owl: nothing to compact (session too small)");
    expect(h.order).toEqual([]); // declined at gate entry — no lock, no stages
    expect(inFlight("sess-c")).toBe(false);
  });

  test("a prior owl summary row never rides the kept tail (exactly one '# Memory' row in the answer)", async () => {
    const h = makeHarness();
    const messages = [
      message("seed row — swallowed by the cut"),
      message("# Memory\n\nYour session memory — the top level of a tree; each id opens deeper detail via owl_recall."),
      message("kept question — pad"),
      message("kept answer — pad"),
    ];
    h.deps.keepRecentTokens = 12; // the tail keeps the prior summary row position — the filter must drop it
    const outcome = await compactionTakeover({ trigger: "manual", messages }, h.deps);
    expect(outcome.kind).toBe("answer");
    if (outcome.kind !== "answer") return;
    const texts = outcome.result.messages.map((m) => m.text ?? "");
    expect(texts.filter((t) => t.startsWith("# Memory\n")).length).toBe(1); // the fresh summary only
    expect(texts.some((t) => t.includes("seed row"))).toBe(false); // swallowed
    expect(texts.some((t) => t.includes("kept question"))).toBe(true); // the tail rides
    expect(texts.some((t) => t.includes("kept answer"))).toBe(true);
  });

  test("a model-unavailable stage failure ⇒ {skip} with the fix-and-retry notice (no native fallback)", async () => {
    const h = makeHarness();
    h.deps.runs.runObserver = async () => {
      throw new ModelUnavailableError("api_error status 503");
    };
    const outcome = await compactionTakeover(EVENT, h.deps);
    expect(outcome.kind).toBe("skip");
    if (outcome.kind !== "skip") return;
    expect(outcome.result.skip).toContain("model unavailable");
    expect(outcome.result.skip).toContain("api_error status 503");
    expect(outcome.result.skip).toContain("/compact again");
    expect(inFlight("sess-c")).toBe(false); // released — the next trigger retries
  });

  test("an invalid graph ⇒ {skip} + notify BEFORE persisting (the last-good snapshot stays authoritative)", async () => {
    const h = makeHarness();
    // detach the observation: assertGraphStructure throws at the encode gate
    h.store.graph.nodes.delete("n-1");
    const persisted: string[] = [];
    h.deps.persistSnapshot = async (_d, id) => {
      persisted.push(id);
    };
    const outcome = await compactionTakeover(EVENT, h.deps);
    expect(outcome.kind).toBe("skip");
    expect(persisted).toEqual([]); // nothing poisoned the ledger
    expect(h.notifications.length).toBe(1);
  });

  test("a persist failure between render and answer ⇒ {skip} (crash window keeps the previous snapshot authoritative)", async () => {
    const h = makeHarness();
    h.deps.persistSnapshot = async () => {
      throw new Error("disk full");
    };
    const outcome = await compactionTakeover(EVENT, h.deps);
    expect(outcome.kind).toBe("skip");
    expect(h.notifications.length).toBe(1);
    expect(inFlight("sess-c")).toBe(false);
  });
});

describe("compaction takeover — the budget-free wait seam (viaToolCall)", () => {
  test("with viaToolCall the ensure-ready phases run INSIDE the wrapper and the answer still builds", async () => {
    recordMeasure("sess-c", { tokens: 50_000, window: 200_000 });
    const h = makeHarness();
    const order: string[] = [];
    const deps = {
      ...h.deps,
      viaToolCall: async <T>(work: () => Promise<T>): Promise<T> => {
        order.push("wrap-open");
        const out = await work();
        order.push("wrap-close");
        return out;
      },
    };
    const outcome = await compactionTakeover(EVENT, deps);
    expect(outcome.kind).toBe("answer");
    // the phases (observer catch-up + builder) ran between the wrapper's
    // open and close — i.e. inside the $ call the wiring rides
    const open = order.indexOf("wrap-open");
    const close = order.indexOf("wrap-close");
    expect(open).toBeGreaterThanOrEqual(0);
    expect(close).toBeGreaterThan(open);
  });

  test("a wrapper resolving WITHOUT settling NEVER renders — skip with the notice (pi's degrade)", async () => {
    recordMeasure("sess-c", { tokens: 50_000, window: 200_000 });
    const h = makeHarness();
    const deps = {
      ...h.deps,
      // the guarded failure shape: the engine cut the dispatch, the wrapper returned
      // undefined, the gate fell through to render a summary from a graph
      // whose stages were still running
      viaToolCall: async <T>(_work: () => Promise<T>): Promise<T> => undefined as unknown as T,
    };
    const outcome = await compactionTakeover(EVENT, deps);
    expect(outcome.kind).toBe("skip");
    if (outcome.kind === "skip") {
      expect(JSON.stringify(outcome.result)).toContain("session-owl");
    }
  });

  test("a mid-phase disable inside the wrapper still PASSES through (native compaction)", async () => {
    recordMeasure("sess-c", { tokens: 50_000, window: 200_000 });
    const h = makeHarness();
    let enabled = true;
    const deps = {
      ...h.deps,
      getSettings: () => ({ ...h.deps.getSettings(), enabled }),
      viaToolCall: async <T>(work: () => Promise<T>): Promise<T> => {
        enabled = false; // disabled while the $ call is in flight
        return work();
      },
    };
    const outcome = await compactionTakeover(EVENT, deps);
    expect(outcome).toEqual({ kind: "pass" });
  });
});

describe("compaction takeover — the entry-space cut alignment", () => {
  test("counts disagree (branch behind the transcript) ⇒ null cut ⇒ the WHOLE branch is the catch-up block", async () => {
    const h = makeHarness();
    h.branch.pop(); // 3 entries vs 4 messages — a shifted position must not be trusted
    const outcome = await compactionTakeover(EVENT, h.deps);
    expect(outcome.kind).toBe("answer");
    const builderEntry = h.order.find((e) => e.startsWith("builder:"));
    expect(builderEntry).toBe("builder:null"); // the null cut rides the scope
    const observerEntry = h.order.find((e) => e.startsWith("observer:"));
    // the whole branch was the gap block — the vendored frontier rule anchors
    // past the FIRST user message, so one entry of the 3-entry branch is the anchor
    expect(observerEntry).toBe(`observer:${h.branch.length - 1}`);
  });

  test("counts agree ⇒ the aligned entry id rides the scope", async () => {
    const h = makeHarness();
    await compactionTakeover(EVENT, h.deps);
    const builderEntry = h.order.find((e) => e.startsWith("builder:"));
    expect(builderEntry).toBe("builder:e3"); // firstKeptIndex 2 -> the third message-bearing entry
  });

  test("steady state (a prior compaction rode the branch): the tail still aligns past the boundary", async () => {
    const h = makeHarness();
    // the branch: two originals, the compaction boundary, two new rows —
    // head extras (the originals the engine compacted away) must not shift
    // the tail correspondence
    h.branch.length = 0;
    h.branch.push(
      entry("e1"),
      entry("e2"),
      { id: "b1", type: "compaction", summary: "# Memory — summary row" } as never,
      entry("e3"),
      entry("e4"),
    );
    // the transcript: [summary, kept(two), new(two)] — the cut keeps the newest 3 (a non-summary tail)
    const messages = [
      message("# Memory — summary row"),
      message("kept one"),
      message("kept two"),
      message("new one"),
      message("new two"),
    ];
    h.deps.keepRecentTokens = 8; // the four 2-token rows sum to 8 — the summary (6) crosses and drops
    const outcome = await compactionTakeover({ trigger: "auto", messages }, h.deps);
    expect(outcome.kind).toBe("answer");
    const builderEntry = h.order.find((e) => e.startsWith("builder:"));
    // kept1/kept2 are the pre-boundary originals (kept by the prior
    // compaction, still on the branch as the first two entries), new1/new2
    // are the last two — the tail correspondence maps the 4-message tail to
    // the 4 message-bearing entries exactly; nothing was dropped before
    // them, so the cut aligns at the FIRST branch entry
    expect(builderEntry).toBe("builder:e1");
  });

  test("countCompactions rule: non-empty-summary entries count, textless markers never", async () => {
    // pins the CURRENT mapping mechanism (the live-shape decision rides the
    // recorded probe — see the hook's isCompactionSummaryEntry note)
    const h = makeHarness();
    h.branch.length = 0;
    h.branch.push(
      entry("e1"),
      { id: "b0", type: "compaction", summary: "" } as never,
      { id: "b1", type: "compaction", summary: "# Memory — one" } as never,
      entry("e2"),
      { id: "b2", type: "compaction", summary: "# Memory — two" } as never,
      entry("e3"),
    );
    h.deps.keepRecentTokens = 2; // the first message stays swallowed — the render path runs countCompactions
    const outcome = await compactionTakeover(
      { trigger: "auto", messages: [message("swallowed seed — pad"), message("only row")] },
      { ...h.deps, getBranch: () => h.branch },
    );
    expect(outcome.kind).toBe("answer");
    if (outcome.kind !== "answer") return;
    // the footer's maturity signal counted the TWO summary rows — the
    // textless marker never counts under the current rule
    expect(outcome.result.messages[0]?.text).toContain("2 compactions");
  });

  test("the live two-row shape (boundary marker + summary) aligns exactly like the one-row model", async () => {
    const h = makeHarness();
    h.branch.length = 0;
    h.branch.push(
      entry("e1"),
      entry("e2"),
      { id: "b0", type: "compaction", summary: "" } as never, // the boundary marker — no text, never a summary
      { id: "b1", type: "compaction", summary: "# Memory — summary row" } as never,
      entry("e3"),
      entry("e4"),
    );
    const messages = [
      message("# Memory — summary row"),
      message("kept one"),
      message("kept two"),
      message("new one"),
      message("new two"),
    ];
    h.deps.keepRecentTokens = 8; // the four 2-token rows — the summary drops
    const outcome = await compactionTakeover({ trigger: "auto", messages }, h.deps);
    expect(outcome.kind).toBe("answer");
    const builderEntry = h.order.find((e) => e.startsWith("builder:"));
    expect(builderEntry).toBe("builder:e1"); // the same alignment as the one-row model
  });

  test("a tail that includes the summary itself ⇒ null (no misaligned position)", async () => {
    const h = makeHarness();
    h.branch.length = 0;
    h.branch.push(
      entry("e1"),
      { id: "b1", type: "compaction", summary: "# Memory — one" } as never,
      { id: "b2", type: "compaction", summary: "# Memory — two" } as never,
      entry("e2"),
      entry("e3"),
    );
    const messages = [
      message("swallowed seed — pad"),
      message("# Memory — summary row"),
      message("kept one"),
      message("new one"),
    ];
    h.deps.keepRecentTokens = 10; // the tail keeps the summary row — two branch summaries make the position untrustworthy
    const outcome = await compactionTakeover({ trigger: "auto", messages }, h.deps);
    expect(outcome.kind).toBe("answer");
    const builderEntry = h.order.find((e) => e.startsWith("builder:"));
    expect(builderEntry).toBe("builder:null"); // the summary-in-tail case distrusts
  });
});

describe("compaction takeover — mid-gate disable", () => {
  test("enabled re-checked between phases: disabled after the Observer ⇒ pass (native summary)", async () => {
    const h = makeHarness();
    let flip = false;
    h.deps.getSettings = () => {
      if (flip) return { ...(h.deps.settings as SessionOwlConfig), enabled: false };
      return h.deps.settings;
    };
    h.deps.runs.runObserver = async () => {
      flip = true; // the disable lands during the Observer
    };
    const outcome = await compactionTakeover(EVENT, h.deps);
    expect(outcome).toEqual({ kind: "pass" });
    expect(h.order.filter((e) => e.startsWith("builder")).length).toBe(0); // the remaining phases were skipped
  });
});

describe("compaction takeover — precompute (the ready-render branch)", () => {
  test("ready state (no backlog) ⇒ a pure render answer, ZERO stage runs, no persist", async () => {
    const h = makeHarness();
    h.store.observerFrontier = "e4"; // frontier at the tip ⇒ no unobserved backlog
    const outcome = await compactionTakeover({ trigger: "precompute", messages: EVENT.messages }, h.deps);
    expect(outcome.kind).toBe("answer");
    expect(
      h.order.filter((e) => e.startsWith("observer") || e.startsWith("builder") || e.startsWith("selector")),
    ).toEqual([]);
    expect(h.order.filter((e) => e.startsWith("persist"))).toEqual([]); // held results install at the real compaction
    if (outcome.kind !== "answer") return;
    expect(outcome.result.messages[0]?.text.startsWith("# Memory")).toBe(true);
  });

  test("no backlog but the root view over threshold ⇒ {skip} (not render-ready)", async () => {
    const h = makeHarness();
    h.store.observerFrontier = "e4"; // frontier at the tip ⇒ no backlog
    h.setSettings({ builderRootViewThreshold: 0 }); // any root view is over a zero threshold
    const outcome = await compactionTakeover({ trigger: "precompute", messages: EVENT.messages }, h.deps);
    expect(outcome.kind).toBe("skip");
  });

  test("backlog present ⇒ {skip} — the real compaction runs the full gate", async () => {
    const h = makeHarness(); // frontier null ⇒ the whole branch is unobserved
    const outcome = await compactionTakeover({ trigger: "precompute", messages: EVENT.messages }, h.deps);
    expect(outcome.kind).toBe("skip");
  });
});

describe("compaction takeover — scoping + instructions", () => {
  test("a subagent loop's key scopes the lock (the main conversation's lock stays free)", async () => {
    const h = makeHarness({ key: "sess-c|ag-7" });
    h.deps.runs.runObserver = async () => {
      expect(inFlight("sess-c|ag-7")).toBe(true);
      expect(inFlight("sess-c")).toBe(false); // the main conversation is NOT blocked
    };
    const outcome = await compactionTakeover({ trigger: "auto", agentId: "ag-7", messages: EVENT.messages }, h.deps);
    expect(outcome.kind).toBe("answer");
  });

  test("typed /compact instructions are ignored and logged (the summary is built from the graph)", async () => {
    const h = makeHarness();
    const outcome = await compactionTakeover(
      { trigger: "manual", instructions: "focus on the parser work", messages: EVENT.messages },
      h.deps,
    );
    expect(outcome.kind).toBe("answer");
    expect(h.logs.some((l) => l.includes("focus on the parser work"))).toBe(true);
  });
});
