// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { makeObserverRun } from "../../src/runtime/stages.js";
import { onTurnEnd, setStageRuns } from "../../src/triggers.js";

describe("makeObserverRun (Observer stage wiring)", () => {
  it("adapts the Observer run into the RunFn contract and is invoked by onTurnEnd", async () => {
    let calledWithUnobserved: unknown = "never";
    const pi = {} as unknown as ExtensionAPI;
    // inject a fake runObserver via the seam
    const runFn = makeObserverRun(pi, async (args) => {
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
      },
    });

    // the fire-and-forget run resolves asynchronously; wait a tick
    await new Promise((r) => setTimeout(r, 20));
    expect(calledWithUnobserved).toEqual(["a1"]);

    // restore no-op stage runs so other tests aren't affected
    setStageRuns({ runObserver: async () => {}, runBuilder: async () => {}, runSelector: async () => {} });
  });
});
