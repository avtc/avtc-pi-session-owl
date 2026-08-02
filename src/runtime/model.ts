// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// Model resolution shared by every agentLoop stage (Observer / Builder /
// Selector). Each stage calls this with its resolved `modelSetting` — the
// component-specific model string (e.g. `settings.observerModel`) falling back to
// `settings.defaultModel` — and the session context. Resolution chain:
//   1. a non-null `modelSetting` (provider/id) → look it up in the registry;
//   2. otherwise the current session model (`ctx.model`).
// Then the api key is resolved for the chosen model. A failed resolution (unknown
// model, no key, no model at all) is reported so the stage can skip + notify.

import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { notify } from "../notify.js";

export type ResolvedStageModel =
  | { ok: true; model: Model<Api>; apiKey: string | undefined }
  | { ok: false; error: string };

/**
 * Resolve a stage model + api key.
 *
 * @param modelSetting — `provider/id` string, or `null` to fall through to the
 *   session model (the caller has already collapsed `component ?? default`).
 */
export async function resolveStageModel(
  ctx: ExtensionContext,
  modelSetting: string | null,
): Promise<ResolvedStageModel> {
  let model: Model<Api> | undefined;
  if (modelSetting !== null) {
    const slashIndex = modelSetting.indexOf("/");
    if (slashIndex === -1) {
      return { ok: false, error: `model "${modelSetting}" is not a provider/id reference` };
    }
    const provider = modelSetting.slice(0, slashIndex).trim();
    const modelId = modelSetting.slice(slashIndex + 1).trim();
    if (provider.length === 0 || modelId.length === 0) {
      return { ok: false, error: `model "${modelSetting}" is not a provider/id reference` };
    }
    model = ctx.modelRegistry.find(provider, modelId);
    if (model === undefined) {
      return { ok: false, error: `model "${modelSetting}" is not available` };
    }
  } else {
    model = ctx.model;
    if (model === undefined) {
      return { ok: false, error: "no model configured (set a component/default model or select a session model)" };
    }
  }

  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
  if (!auth.ok) {
    return { ok: false, error: auth.error };
  }
  return { ok: true, model, apiKey: auth.apiKey };
}

/** Resolve a stage model + api key, notifying + returning `{ ok: false }` on
 *  failure so the caller can `return` (the stage is skipped). The `stageLabel`
 *  ("Observer"/"Builder"/"Selector") names the run in the warning. */
export async function resolveStageModelOrNotify(
  ctx: ExtensionContext,
  stageLabel: "Observer" | "Builder" | "Selector",
  modelSetting: string | null,
): Promise<ResolvedStageModel> {
  const resolved = await resolveStageModel(ctx, modelSetting);
  if (!resolved.ok) {
    notify(ctx, `${stageLabel} skipped a run: ${resolved.error}`, "warning");
  }
  return resolved;
}
