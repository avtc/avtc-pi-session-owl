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

import type { Api, Model, ThinkingLevel } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { log } from "../log.js";
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
  log.info(`resolving ${stageLabel} model (${modelDescription(modelSetting)})`);
  const resolved = await resolveStageModel(ctx, modelSetting);
  if (!resolved.ok) {
    log.warn(`${stageLabel} model resolve failed: ${resolved.error}`);
    notify(ctx, `${stageLabel} skipped a run: ${resolved.error}`, "warning");
  } else {
    log.info(`${stageLabel} model resolved`);
  }
  return resolved;
}

/** Render the model setting for a log line (null → "session default"). */
function modelDescription(modelSetting: string | null): string {
  return modelSetting ?? "session default";
}

/** A thinking-level config value: null = inherit the next tier; otherwise one of
 *  the settings-ui thinking-level presets ("off" | "minimal" | "low" | "medium" |
 *  "high" | "xhigh"). */
export type ThinkingSetting = string | null;

/** Resolve a stage's reasoning level into the agentLoop `reasoning` value
 *  (ThinkingLevel, or null to OMIT it so agentLoop uses its default).
 *
 *  Chain: stageLevel → defaultLevel → session thinking level (ctx.thinkingLevel).
 *  - any non-null stage level wins ("off" disables; a level sets it);
 *  - else any non-null default level;
 *  - else the session's thinking level (undefined ⇒ null = omit, i.e. off when
 *    the session reports no thinking level).
 *  Mirrors how `defaultModel`/`observerModel` resolve (null = inherit) and how
 *  avtc-pi-user-decisions maps a level to `reasoning` ("off" → omit). */
export function resolveStageReasoning(
  stageLevel: ThinkingSetting,
  defaultLevel: ThinkingSetting,
  // ctx.thinkingLevel is "off" | a level | undefined (the session runtime reports
  // "off" explicitly rather than omitting).
  sessionLevel: "off" | ThinkingLevel | undefined,
): ThinkingLevel | null {
  const level = stageLevel ?? defaultLevel;
  if (level === null) {
    // inherit the session: "off"/undefined → omit reasoning; else the session level
    if (sessionLevel === undefined || sessionLevel === "off") return null;
    return sessionLevel;
  }
  if (level === "off") return null;
  return level as ThinkingLevel;
}
