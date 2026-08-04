// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { makeObserverRun, makeSelectorRun } from "../../src/runtime/stages.js";
import type { SelectorRunInput } from "../../src/selector/run.js";
import { onTurnEnd, setStageRuns } from "../../src/triggers.js";
import { NO_OP_WIDGET } from "../../src/widget/tracker.js";

describe("makeObserverRun (Observer stage wiring)", () => {
  it("adapts the Observer run into the RunFn contract and is invoked by onTurnEnd", async () => {
    let calledWithUnobserved: unknown = "never";
    const pi = {} as unknown as ExtensionAPI;
    // inject a fake runObserver via the seam
    const runFn = makeObserverRun(pi, NO_OP_WIDGET, async (args) => {
      calledWithUnobserved = args.unobserved.map((e) => e.id);
    });
    setStageRuns({
      runObserver: runFn,
      runBuilder: async () => {},
      runSelector: async () => {},
    });

    // drive onTurnEnd with a branch that has an unobserved user+assistant pair
    const entries = [
      {
        id: "u1",
        type: "message",
        parentId: null,
        timestamp: "t",
        message: { role: "user", content: `hi ${"x".repeat(50)}` },
      },
      {
        id: "a1",
        type: "message",
        parentId: null,
        timestamp: "t",
        message: { role: "assistant", content: [{ type: "text", text: `reply ${"y".repeat(5000)}` }] },
      },
    ];
    const ctx = {
      sessionManager: { getLeafId: () => "a1", getBranch: () => entries },
      modelRegistry: { find: () => undefined, getApiKeyAndHeaders: async () => ({ ok: false, error: "x" }) },
      getContextUsage: () => ({ tokens: 0, contextWindow: 200000, percent: 0 }),
      model: undefined,
      ui: { notify: () => {} },
    } as unknown as ExtensionContext;

    onTurnEnd({
      ctx,
      settings: {
        enabled: true,
        defaultModel: null,
        observerModel: null,
        observerMode: "on-threshold",
        observerThresholdTokens: 1,
        observerIncludeThinking: false,
        observerToolBlockCapTokens: null,
        builderModel: null,
        builderMode: "on-compaction",
        builderEveryNObservations: 40,
        builderSessionContextThresholdTokens: 200000,
        builderRootViewThreshold: 8000,
        maxBuilderPasses: 5,
        selectorModel: null,
        selectorMode: "on-compaction",
        selectorSessionContextThresholdTokens: 200000,
        selectorRootViewThreshold: 4000,
        maxSelectorPasses: 5,
        renderMode: "selected-root",
        commandResultCap: 50,
        findTimeoutMs: 5000,
        toolResultTokenBudget: 6000,
      },
    });

    // the fire-and-forget run resolves asynchronously; wait a tick
    await new Promise((r) => setTimeout(r, 20));
    expect(calledWithUnobserved).toEqual(["a1"]);

    // restore no-op stage runs so other tests aren't affected
    setStageRuns({ runObserver: async () => {}, runBuilder: async () => {}, runSelector: async () => {} });
  });
});

describe("makeSelectorRun (Selector stage wiring)", () => {
  it("forwards ctx/pi/settings/signal/scope/widget into SelectorRunInput + reads todo live", async () => {
    const captured: SelectorRunInput[] = [];
    const fakeRunSelector = async (input: SelectorRunInput) => {
      captured.push(input);
    };
    const pi = { marker: "pi-instance" } as unknown as ExtensionAPI;
    const widget = { marker: "widget-instance" } as unknown as typeof NO_OP_WIDGET;
    // a mutable todo wiring — simulates avtc-pi-todo appearing mid-session.
    let todoContext: unknown = null;
    let todoBridge: unknown = null;
    const todo = {
      getContext: () => todoContext as SelectorRunInput["todo"],
      getBridge: () => todoBridge as SelectorRunInput["todoBridge"],
    };

    const runFn = makeSelectorRun(pi, widget, fakeRunSelector, todo);

    const ctx = { marker: "ctx" } as unknown as ExtensionContext;
    const signal = new AbortController().signal;
    const settings = { marker: "settings" } as unknown as Parameters<typeof runFn>[0]["settings"];

    // before avtc-pi-todo appears: todo context + bridge are null.
    await runFn({ ctx, settings, signal, scope: null, unobserved: null });

    // now avtc-pi-todo fires pi-todo:ready — the live read picks it up.
    todoContext = { marker: "todo-context" } as unknown;
    todoBridge = { marker: "todo-bridge" } as unknown;
    await runFn({ ctx, settings, signal, scope: { firstKeptEntryId: "cut-1" }, unobserved: null });

    expect(captured.length).toBe(2);
    // first call: ctx/settings/signal forwarded by identity, background scope
    // (null), no todo.
    expect(captured[0]?.ctx).toBe(ctx);
    expect(captured[0]?.settings).toBe(settings);
    expect(captured[0]?.signal).toBe(signal);
    expect(captured[0]?.scope).toBeNull();
    expect(captured[0]?.todo).toBeNull();
    expect(captured[0]?.todoBridge).toBeNull();
    expect(captured[0]?.widget).toBe(widget);
    const firstPi = captured[0]?.pi as { marker?: string } | undefined;
    expect(firstPi?.marker).toBe("pi-instance");
    // second call: compaction scope + live todo (picked up mid-session).
    expect(captured[1]?.scope).toEqual({ firstKeptEntryId: "cut-1" });
    const secondTodo = captured[1]?.todo as { marker?: string } | null;
    const secondBridge = captured[1]?.todoBridge as { marker?: string } | null;
    expect(secondTodo?.marker).toBe("todo-context");
    expect(secondBridge?.marker).toBe("todo-bridge");
  });
});
