// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// The goal-extract completer mapping: the injected one-shot adapter over an
// engine `$.model.complete` capsule (one shot, no tools, 512-token
// cap, per-call timeout, abortable; skip-and-log when no model resolves;
// never throws; usage ignored — the run layer owns the don't-clobber guard
// and the atomic write).
import { describe, expect, test } from "vitest";
import {
  goalModelSetting,
  type ModelCompleteCapsule,
  makeGoalCompleter,
} from "../../host/runs/goal-extract-complete.js";

function fixture(over: { complete?: ModelCompleteCapsule; getModel?: () => string | null } = {}) {
  const calls: Array<{ request: Record<string, unknown>; options: unknown }> = [];
  const complete: ModelCompleteCapsule =
    over.complete ??
    (async (request, options) => {
      calls.push({ request: request as Record<string, unknown>, options });
      return { isAnswered: true, text: "Distilled goal" };
    });
  const getModel = over.getModel ?? (() => "claude-haiku");
  const logs: string[] = [];
  const completer = makeGoalCompleter({
    complete,
    getModel,
    log: (message) => logs.push(message),
  });
  return { completer, calls, logs };
}

describe("makeGoalCompleter — the $.model.complete mapping (the one-shot profile)", () => {
  test("one shot: request carries model/prompt/maxTokens/timeoutMs; the signal rides options", async () => {
    const { completer, calls } = fixture();
    const controller = new AbortController();
    const reply = await completer({
      prompt: "GOAL\n\nthe ask",
      signal: controller.signal,
      maxTokens: 512,
      timeoutMs: 30_000,
    });
    expect(reply).toBe("Distilled goal");
    expect(calls.length).toBe(1); // ONE call — no retries, no tools
    expect(calls[0]?.request).toEqual({
      model: "claude-haiku",
      prompt: "GOAL\n\nthe ask",
      maxTokens: 512,
      timeoutMs: 30_000,
    });
    expect(calls[0]?.options).toEqual({ signal: controller.signal });
  });

  test("no model resolvable ⇒ skip-and-log, empty reply (the Builder backstop holds)", async () => {
    const { completer, calls, logs } = fixture({ getModel: () => null });
    const reply = await completer({
      prompt: "p",
      signal: new AbortController().signal,
      maxTokens: 512,
      timeoutMs: 1000,
    });
    expect(reply).toBe("");
    expect(calls).toEqual([]); // no call at all
    expect(logs.some((l) => l.includes("goal extract skipped"))).toBe(true);
  });

  test("an unanswered result (api-error/empty-reply) logs with status and error detail — returns empty, never throws", async () => {
    const { completer, logs } = fixture({
      complete: (async () => ({ isAnswered: false, reason: "api-error", status: 429, error: "rate_limited" })) as never,
    });
    const reply = await completer({
      prompt: "p",
      signal: new AbortController().signal,
      maxTokens: 512,
      timeoutMs: 1000,
    });
    expect(reply).toBe("");
    expect(
      logs.some(
        (l) => l.includes("goal extract model call") && l.includes("status=429") && l.includes("error=rate_limited"),
      ),
    ).toBe(true);
  });

  test("an aborted result returns empty silently (a shutdown is not an error)", async () => {
    const { completer, logs } = fixture({
      complete: (async () => ({ isAnswered: false, reason: "aborted" })) as never,
    });
    const reply = await completer({
      prompt: "p",
      signal: new AbortController().signal,
      maxTokens: 512,
      timeoutMs: 1000,
    });
    expect(reply).toBe("");
    expect(logs).toEqual([]);
  });

  test("a thrown capsule (belt over the never-rejecting API) is caught: empty reply, one log line", async () => {
    const { completer, logs } = fixture({
      complete: (async () => {
        throw new Error("bridge gone");
      }) as never,
    });
    const reply = await completer({
      prompt: "p",
      signal: new AbortController().signal,
      maxTokens: 512,
      timeoutMs: 1000,
    });
    expect(reply).toBe("");
    expect(logs.some((l) => l.includes("goal extract model call failed"))).toBe(true);
  });

  test("the model resolves the OBSERVER's way: observerModel → defaultModel → session", () => {
    expect(goalModelSetting("prov/observer-model", "prov/default-model", "session-concrete")).toBe(
      "prov/observer-model",
    );
    expect(goalModelSetting(null, "prov/default-model", "session-concrete")).toBe("prov/default-model");
    expect(goalModelSetting(null, null, "session-concrete")).toBe("session-concrete");
    // nothing concrete anywhere → null → the completer skips (Builder backstop)
    expect(goalModelSetting(null, null, null)).toBe(null);
  });
});
