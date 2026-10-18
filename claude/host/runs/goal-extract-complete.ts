// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// The goal-extract completer mapping — the one-shot `$.model.complete`
// adapter (one shot, no tools, cap + timeout + abortable). The engine capsule is INJECTED (a handler-authored
// closure spelling `$.model.complete` literally — the scanner's rule); this
// module is the pure mapping: model resolution (the observer's chain —
// observerModel → defaultModel → the session's — via the injected getter),
// the request shape (prompt, the 512-token
// cap, the per-call timeout), the abort signal in the options, and the
// result fold (answered ⇒ text; aborted ⇒ "" silently; anything else ⇒
// skip-and-log). Never throws — the run layer's never-throws contract
// starts here.

/** The engine `$.model.complete` capsule's structural shape (the subset the
 *  mapping reads; the real capsule is authored in the register's handler). */
export type ModelCompleteCapsule = (
  request: { model: string; prompt: string; maxTokens?: number; effort?: string; timeoutMs?: number },
  options?: { signal?: AbortSignal },
) => Promise<{
  isAnswered: boolean;
  text?: string;
  reason?: string;
  /** Present on an `api-error`: the HTTP status and the engine's error kind. */
  status?: unknown;
  error?: unknown;
}>;

/** The one-shot's model choice — resolved the OBSERVER's way (the rule:
 *  the goal extractor's model resolves exactly as observerModel does — stage
 *  model → default model → the session's; the session slot only ever holds a
 *  concrete id, the engine's default-model label recording as null).
 *  null ⇒ the completer skips (the Builder backstop holds). */
export function goalModelSetting(
  observerModel: string | null,
  defaultModel: string | null,
  sessionModel: string | null,
): string | null {
  return observerModel ?? defaultModel ?? sessionModel;
}

export interface GoalCompleterInput {
  prompt: string;
  signal?: AbortSignal | null;
  maxTokens: number;
  /** The effort level (the observer thinking ladder); undefined = omit. */
  effort?: string;
  timeoutMs: number | null;
}

/** Build the completer over the injected capsule. `getModel` resolves the
 *  one-shot's model (null ⇒ skip-and-log — the Builder backstop holds). */
export function makeGoalCompleter(opts: {
  complete: ModelCompleteCapsule;
  getModel: () => string | null;
  log?: (message: string) => void;
}): (input: GoalCompleterInput) => Promise<string> {
  const log = opts.log ?? ((message: string) => console.error(message));
  return async (input) => {
    const model = opts.getModel();
    if (model === null) {
      log("goal extract skipped: no model resolvable (defaultModel unset, no session model)");
      return "";
    }
    try {
      const result = await opts.complete(
        {
          model,
          prompt: input.prompt,
          maxTokens: input.maxTokens,
          ...(input.effort === undefined ? {} : { effort: input.effort }),
          ...(input.timeoutMs === null ? {} : { timeoutMs: input.timeoutMs }),
        },
        input.signal === undefined || input.signal === null ? undefined : { signal: input.signal },
      );
      if (result.isAnswered) return result.text ?? "";
      if (result.reason === "aborted") return ""; // a shutdown is not an error
      const detail = result.status !== undefined ? ` status=${String(result.status)}` : "";
      const errKind = result.error !== undefined ? ` error=${String(result.error)}` : "";
      log(`goal extract model call unanswered (${String(result.reason ?? "unknown")}${detail}${errKind})`);
      return "";
    } catch (cause) {
      log(`goal extract model call failed: ${cause instanceof Error ? cause.message : String(cause)}`);
      return "";
    }
  };
}
