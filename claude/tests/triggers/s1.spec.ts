// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
// S1, mechanically checked: NO per-turn memory injection. (1) A static scan
// of the register wiring — no prompt-mutating hook registrations exist
// (prompt.compose / prompt.context absent; prompt.submit may only DROP
// internal stage handbacks, never rewrite the user's prompt). (2) A full
// turn cycle over the mounted register with a recording fake `$` — the
// prompt.compose / prompt.context stubs count ZERO calls across
// session-start → append → turn.step → turn.complete → session.measure.
import { afterAll, beforeEach, describe, expect, test } from "vitest";
import { clearDetailsCache } from "../../core/src/format/details.js";
import { resetForNewSession } from "../../core/src/store/graph-store.js";
import { register } from "../../hooks/register.js";
import { _resetCapture } from "../../host/capture/append-handler.js";
import { _resetCoreInstances } from "../../host/core-instances.js";
import { clearAllStageRuns } from "../../host/stage/runs.js";
import * as state from "../../host/state.js";
import { _resetMeasureSnapshots } from "../../host/triggers/context.js";
import { _resetRunLocks } from "../../host/triggers/run-locks.js";
import { resetClaudeHostSingletons } from "../helpers/host-teardown.js";

const REGISTER_PATH = fileURLToPath(new URL("../../hooks/register.ts", import.meta.url));

type Handler = (arg0: unknown, e: Record<string, unknown>, next: (e: unknown) => Promise<unknown>) => Promise<unknown>;

describe("S1 static scan — no prompt-mutating hooks in the wiring", () => {
  test("the register registers NO prompt.compose / prompt.context hook (memory enters only as the compaction message)", async () => {
    const source = await readFile(REGISTER_PATH, "utf8");
    expect(source).not.toMatch(/on\(\s*["']prompt\.compose["']/);
    expect(source).not.toMatch(/on\(\s*["']prompt\.context["']/);
    // the only prompt.* registration allowed: prompt.submit, and only as the
    // delivery drop (its handler must return next(e) or { drop } — never a
    // rewritten prompt)
    expect(source).not.toMatch(/on\(\s*["']prompt\.(?!submit)["']/);
    const submitIdx = source.indexOf('on("prompt.submit"');
    expect(submitIdx).toBeGreaterThan(-1); // the delivery drop stays wired
  });
});

describe("S1 turn cycle — zero prompt.compose / prompt.context calls", () => {
  beforeEach(() => {
    _resetCapture();
    _resetCoreInstances();
    resetForNewSession();
    clearDetailsCache();
    clearAllStageRuns();
    _resetRunLocks();
    _resetMeasureSnapshots();
    state._resetForTest();
  });
  // this file dispatches the register handlers with a recording fake `$`
  // (env without `set`) — the file must not leave that fake armed in the
  // bridge for the next file's service calls
  afterAll(async () => {
    await resetClaudeHostSingletons();
  });

  test("a full turn cycle never touches the prompt surfaces", async () => {
    const promptCalls: string[] = [];
    const fsFiles = new Map<string, string>();
    const fake$: Record<string, unknown> = {
      env: {
        get: async (name: string) =>
          name === "CLAUDE_CONFIG_DIR" ? "/cfg/owl-s1" : name === "HOME" ? "/home/u" : undefined,
      },
      fs: {
        write: async (p: string, t: string) => {
          fsFiles.set(p, t);
        },
        read: async (p: string) => fsFiles.get(p) ?? "",
        list: async () => [],
        stat: async () => null,
      },
      tool: { register: async () => {} },
      command: { register: async () => {} },
      agent: { register: async () => {}, spawn: async () => ({ agentId: "never" }) },
      clock: { after: () => ({ cancel: () => {} }), every: () => () => {} },
      ui: { log: () => {} },
      session: { usage: async () => null },
      // the S1 sentinels: any call FAILS the count assertion below
      prompt: {
        compose: async () => {
          promptCalls.push("prompt.compose");
          return { sections: [] };
        },
        context: async () => {
          promptCalls.push("prompt.context");
          return { blocks: [] };
        },
      },
    };

    const handlers = new Map<string, Handler>();
    const on = (name: string, handler: Handler) => {
      handlers.set(name, handler);
      return { catch: () => {} }; // the registration's guard — not driven here
    };
    register(on as never, {} as never); // (on, options)
    const next = async (e: unknown) => e;
    const run = (name: string, e: Record<string, unknown>) => {
      const h = handlers.get(name);
      if (h === undefined) throw new Error(`no handler for ${name}`);
      return h(fake$, e, next as never);
    };

    // classic.SessionStart: the session marker + state bootstrap
    await run("classic.SessionStart", {
      session_id: "sess-s1",
      transcript_path: "/cfg/sess-s1.jsonl",
      source: "startup",
      cwd: "/w",
    });
    // one appended row (a user message)
    await run("session.append", {
      uuid: "u1",
      parentUuid: null,
      type: "user",
      message: { role: "user", content: "hello" },
      timestamp: "2026-01-01T00:00:00Z",
    });
    // the turn: steps then completion (the relay passes a non-stage step
    // through; turn.step's next is a STREAM — an async generator)
    const step = handlers.get("turn.step") as unknown as (
      $: unknown,
      e: unknown,
      stream: () => AsyncGenerator<unknown, unknown>,
    ) => AsyncGenerator<unknown, unknown>;
    async function* stepStream(): AsyncGenerator<unknown, unknown> {
      yield { kind: "text", text: "thinking out loud" };
      return { stop: "end_turn" };
    }
    const gen = step(fake$, { turnId: "t1", index: 0, model: "m", messageCount: 2 }, stepStream);
    await gen.next();
    await gen.next();
    await run("turn.complete", {
      answer: "hi back",
      durationMs: 10,
      isAborted: false,
      turnId: "t1",
      reason: "answer",
      usage: null,
    });
    await run("session.measure", { context: { tokens: 1000, window: 200_000 }, rateLimits: [], changed: ["context"] });

    expect(promptCalls).toEqual([]); // S1: zero per-turn prompt mutation
  });
});
