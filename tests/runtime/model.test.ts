// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import type { Model } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { resolveStageModel, resolveStageModelOrNotify } from "../../src/runtime/model.js";

// A minimal Model stand-in (only provider/id matter for resolution).
function fakeModel(provider: string, id: string): Model<never> {
  return { provider, id } as unknown as Model<never>;
}

/** Build a fake ExtensionContext with a scripted modelRegistry + current model. */
function ctxWith({
  findResult,
  apiKey,
  sessionModel,
}: {
  findResult?: Model<never> | undefined;
  apiKey?: string | undefined;
  sessionModel?: Model<never> | undefined;
}): ExtensionContext {
  return {
    modelRegistry: {
      find: () => findResult,
      getApiKeyAndHeaders: async () => ({ ok: true as const, apiKey }),
    },
    model: sessionModel,
  } as unknown as ExtensionContext;
}

describe("resolveStageModel", () => {
  it("uses the component model when set and found, resolving its api key", async () => {
    const m = fakeModel("openai", "gpt-4o");
    const res = await resolveStageModel(ctxWith({ findResult: m, apiKey: "sk-x" }), "openai/gpt-4o");
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.model).toBe(m);
      expect(res.apiKey).toBe("sk-x");
    }
  });

  it("falls through to defaultModel-equivalent when component model is null", async () => {
    // caller passes null as component model; a non-null defaultModel is itself a
    // provider/id passed in the same slot, so this tests the null→session path.
    const session = fakeModel("anthropic", "claude-3");
    const res = await resolveStageModel(ctxWith({ sessionModel: session }), null);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.model).toBe(session);
  });

  it("errors when a component model is set but not found in the registry", async () => {
    const res = await resolveStageModel(ctxWith({ findResult: undefined }), "openai/missing");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/openai\/missing/);
  });

  it("errors on a malformed component model with no '/' separator", async () => {
    const res = await resolveStageModel(ctxWith({ findResult: undefined }), "gpt-4o");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/not a provider\/id reference/);
  });

  it("errors when the provider side is empty", async () => {
    const res = await resolveStageModel(ctxWith({ findResult: undefined }), "/gpt-4o");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/not a provider\/id reference/);
  });

  it("errors when the model-id side is empty", async () => {
    const res = await resolveStageModel(ctxWith({ findResult: undefined }), "openai/");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/not a provider\/id reference/);
  });

  it("errors when no component model and no session model available", async () => {
    const res = await resolveStageModel(ctxWith({ sessionModel: undefined }), null);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.length).toBeGreaterThan(0);
  });

  it("errors when the model is found but api-key resolution fails", async () => {
    const m = fakeModel("openai", "gpt-4o");
    const ctx = {
      modelRegistry: {
        find: () => m,
        getApiKeyAndHeaders: async () => ({ ok: false as const, error: "no api key configured" }),
      },
      model: undefined,
    } as unknown as ExtensionContext;
    const res = await resolveStageModel(ctx, "openai/gpt-4o");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/no api key configured/);
  });
});

describe("resolveStageModelOrNotify", () => {
  /** Fake ctx with a notify spy capturing ui.notify calls. */
  function ctxWithNotify({
    findResult,
    sessionModel,
  }: {
    findResult?: Model<never> | undefined;
    sessionModel?: Model<never> | undefined;
  }): { ctx: ExtensionContext; notify: (msg: string, level: string) => void; calls: string[] } {
    const calls: string[] = [];
    const notify = (msg: string, _level: string): void => {
      calls.push(msg);
    };
    const ctx = {
      modelRegistry: {
        find: () => findResult,
        getApiKeyAndHeaders: async () => ({ ok: true as const, apiKey: "sk-x" }),
      },
      model: sessionModel,
      ui: { notify },
    } as unknown as ExtensionContext;
    return { ctx, notify, calls };
  }

  it("resolves silently (no notify) on success", async () => {
    const m = fakeModel("openai", "gpt-4o");
    const { ctx, calls } = ctxWithNotify({ findResult: m });
    const res = await resolveStageModelOrNotify(ctx, "Builder", "openai/gpt-4o");
    expect(res.ok).toBe(true);
    expect(calls).toEqual([]);
  });

  it("notifies a stage-skipped warning naming the stage on resolution failure", async () => {
    const { ctx, calls } = ctxWithNotify({ findResult: undefined });
    const res = await resolveStageModelOrNotify(ctx, "Selector", "openai/missing");
    expect(res.ok).toBe(false);
    expect(calls.length).toBe(1);
    expect(calls[0]).toMatch(/Selector skipped a run: /);
    expect(calls[0]).toMatch(/openai\/missing/);
  });
});
