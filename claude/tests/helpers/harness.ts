// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// Local test harness for the plugin's host binding — the Node-env twin of
// the engine's own testing kit (claude plugin test). Loads the real
// register(on) wiring against an in-memory `$` (fs/env/agent/tool/command
// nouns as recorders), dispatches events, and exposes the host modules'
// state for assertions. No engine required: this is the fast surface; the
// kit spec in claude/plugin-test/ runs the same assertions for real.
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

type HookFn = ($: any, e: any, next: (e2?: any) => any) => any;
type Spec = Record<string, unknown>;

const REGISTER_PATH = require.resolve("../../hooks/register.ts");

export function createHarness() {
  // ---- in-memory $ table -------------------------------------------------
  const files = new Map<string, string>();
  const env = new Map<string, string>();
  const registered: { tools: Spec[]; commands: Spec[]; agents: Spec[] } = { tools: [], commands: [], agents: [] };
  let dispatchDepth = 0;

  const fsNoun = {
    write: async (path: string, text: string) => {
      files.set(path, text);
    },
    read: async (path: string) => {
      // cap-refusal simulation: a refused path throws the platform's
      // over-4-MiB message (the rewind helper tier's trigger)
      if (fsRefusals.has(path)) throw new Error("a text is over the 4194304-byte limit");
      if (!files.has(path)) throw new Error(`ENOENT: ${path}`);
      return files.get(path);
    },
    // FsEntry-shaped (the d.ts FsEntry: name has no directory part; kind
    // dir|file; size/mtimeMs/isLink for entries the fake fs knows).
    list: async (dir: string) => {
      const seen = new Map<
        string,
        { name: string; kind: "dir" | "file"; size: number; mtimeMs: number; isLink: boolean }
      >();
      for (const k of files.keys()) {
        if (!k.startsWith(`${dir}/`)) continue;
        const rest = k.slice(dir.length + 1).split("/");
        const name = rest[0];
        if (rest.length > 1) {
          seen.set(name, { name, kind: "dir", size: 0, mtimeMs: 0, isLink: false });
        } else if (!seen.has(name) || seen.get(name)?.kind === "dir") {
          seen.set(name, { name, kind: "file", size: files.get(k)?.length ?? 0, mtimeMs: 0, isLink: false });
        }
      }
      return [...seen.values()];
    },
    exists: async (path: string) => files.has(path),
    stat: async (path: string) => {
      if (!files.has(path)) throw new Error(`ENOENT: ${path}`);
      return {
        size: (files.get(path) ?? "").length,
      };
    },
  };

  const turnAborts: Array<{ turnId: string }> = [];
  const spawned: Spec[] = [];
  // The engine roster `$.agent.list()` answers — tests shape it per scenario
  // (entry shape: { id, spawnedBy?, ... }).
  let agentRoster: Spec[] = [];
  const toolCalls: Spec[] = [];
  // Registration-refusal knob: simulates the engine's mode refusal
  // ($.tool.register unbound at the startup classic start) — the queue
  // opens again via clearToolRegisterRefusals().
  let toolRegisterRefusals = 0;
  // the session noun: an api/rows view the test controls (the rewind
  // checkpoint reads it; undefined noun => the checkpoint degrades to the
  // tripwire tier, exactly like a platform without messages())
  let sessionApiMessages: unknown[] | null = null;
  // the session noun's model getter: what `$.session.model()` answers in
  // this test (value), or that the read fails (error)
  let sessionModelValue: string | null = "probed-session-model";
  let sessionModelError: Error | null = null;
  // the session noun's usage getter: the window `$.session.usage()` answers
  // in this test (the widget's denominator seed at start)
  let sessionUsageWindow: number | null = 128_000;
  let sessionUsageError: Error | null = null;
  const processRuns: string[][] = [];
  let sessionRows: Array<{ uuid?: string }> | null = null;
  // per-agent views: a scoped read (agentId) must never see the main one
  const agentApiViews = new Map<string, unknown[]>();
  // paths whose reads throw the over-cap refusal (the helper tier's probe)
  const fsRefusals = new Set<string>();
  // the settings read result the test controls (defaults when never set)
  let settingsValue: Record<string, unknown> = {};
  const $ = {
    fs: fsNoun,
    env: {
      get: async (name: string) => env.get(name),
      set: async (name: string, value: string) => env.set(name, value),
    },
    tool: {
      register: async (spec: Spec) => {
        if (toolRegisterRefusals > 0) {
          toolRegisterRefusals -= 1;
          throw new Error("$.tool.register is not available in this mode: no session is bound in this process");
        }
        registered.tools.push(spec);
        return { ok: true };
      },
      // the companion simulation: the subagent-support plugin's ambient
      // behavior — spawn on a timer (frame closed), then report the handle
      // back through the plugin's stage_launched callback (a nested
      // tool.call dispatch)
      call: async (input: Spec) => {
        toolCalls.push(input);
        const name =
          typeof (input as { tool?: unknown }).tool === "string"
            ? String((input as { tool: string }).tool)
            : typeof input === "string"
              ? input
              : "";
        if (name === "mcp__session-owl-subagent-support__launch") {
          const launchId = String((input as { launchId?: unknown }).launchId ?? "");
          setTimeout(() => {
            $.agent
              .spawn({
                subagentType: (input as { subagentType?: unknown }).subagentType,
                prompt: (input as { prompt?: unknown }).prompt,
              })
              .then((handle: { model: string; agentId: string }) => {
                void dispatch("tool.call", {
                  tool: "mcp__session-owl__stage_launched",
                  launchId,
                  spawnAgentId: handle.agentId,
                  spawnModel: handle.model,
                });
              })
              .catch(() => {});
          }, 0);
          return { result: "launching" };
        }
        throw new Error(`no tool has that name: ${name || "(unnamed)"}`);
      },
    },
    command: {
      register: async (spec: Spec) => {
        registered.commands.push(spec);
        return { ok: true };
      },
    },
    agent: {
      list: async () => agentRoster.slice(),
      register: async (spec: Spec) => {
        registered.agents.push(spec);
        return { ok: true };
      },
      spawn: async (input: Spec) => {
        spawned.push(input);
        const agentId = `agent-${spawned.length}`;
        // The stage-run protocol waits at awaitAgentCompletion until a
        // turn.complete{agentId} routes here. The harness completes every
        // spawn on a timer AFTER the run registers its waiter (macrotask
        // after the spawn microtask drain) — full chains settle with no
        // live model: the answer is empty, usage null, never aborted.
        setTimeout(() => {
          if (bridge !== null) {
            bridge.routeAgentCompletion({ answer: "", isAborted: false, agentId, usage: null });
          }
        }, 0);
        return { model: "fake-model", agentId };
      },
    },
    turn: {
      abort: async (input: unknown) => {
        turnAborts.push(input as { turnId: string });
      },
    },
    clock: {
      now: async () => Date.now(),
      after: (ms: number, fn: () => void) => {
        const t = setTimeout(fn, ms);
        return { cancel: () => clearTimeout(t) };
      },
      every: (ms: number, fn: () => void) => {
        const t = setInterval(fn, ms);
        return () => clearInterval(t);
      },
    },
    settings: {
      read: async () => settingsValue,
    },
    plugin: {
      name: "session-owl",
      root: "/owl",
    },
    process: {
      run: async (argv: unknown[]) => {
        processRuns.push(argv as string[]);
        return { stdout: '{"pruned":0}', exitCode: 0 };
      },
    },
    session: {
      messages: async (opts?: { as?: string; agentId?: string }) => {
        // null = the test armed no view: the call fails, the checkpoint
        // degrades to the tripwire tier (an armed EMPTY view is a rewind)
        if (typeof opts?.agentId === "string") {
          const agentView = agentApiViews.get(opts.agentId);
          if (agentView === undefined) throw new Error(`no api view armed for agent ${opts.agentId}`);
          return [...agentView];
        }
        if (sessionApiMessages === null) throw new Error("no api view armed in this test");
        if (opts?.as === "api") return [...sessionApiMessages];
        return [...(sessionRows ?? [])];
      },
      model: async () => {
        if (sessionModelError !== null) throw sessionModelError;
        if (sessionModelValue === null) throw new Error("no session model in this test");
        return sessionModelValue;
      },
      usage: async () => {
        if (sessionUsageError !== null) throw sessionUsageError;
        if (sessionUsageWindow === null) throw new Error("no session usage in this test");
        return { startedAt: 0, context: { window: sessionUsageWindow }, rateLimits: [] };
      },
    },
    // the ui noun: resolve hands a Box/Text table for render-hook tests;
    // log/status record (the widget fallback + notify adapter assertions)
    ui: {
      resolve: () => ({
        Box: (props: { children?: unknown[] }) => ({ type: "Box", ...props }),
        Text: (props: { children?: unknown[] }) => ({ type: "Text", ...props }),
      }),
      log: (text: string, opts?: { to?: string }) => {
        uiLog.push(opts?.to === "debug" ? `[debug] ${text}` : text);
      },
      status: (text: string | undefined) => {
        uiStatus.push(text);
      },
      ask: async (question: string, options?: readonly string[]) => {
        uiAskQuestions.push({ question, options: options ?? null });
        return uiAskAnswers.length > 0 ? (uiAskAnswers.shift() as string) : "No";
      },
      open: (args: unknown) => {
        uiOpenCalls.push(args);
        return Promise.resolve({});
      },
      focus: (args: unknown) => {
        uiFocusCalls.push(
          typeof args === "object" && args !== null && "key" in args ? (args as { key: string }).key : String(args),
        );
        return Promise.resolve({});
      },
      close: (args: unknown) => {
        uiCloseCalls.push(args);
      },
      invalidate: (what: unknown) => {
        uiInvalidateCalls.push(what);
      },
    },
  };
  const uiLog: string[] = [];
  const uiStatus: Array<string | undefined> = [];
  // the ask recorder: tests queue answers ("Yes"/"No"/labels); an empty
  // queue answers "No" (confirms decline — the safe default)
  const uiAskAnswers: string[] = [];
  const uiAskQuestions: Array<{ question: string; options: readonly string[] | null }> = [];
  const uiOpenCalls: unknown[] = [];
  const uiFocusCalls: string[] = [];
  const uiCloseCalls: unknown[] = [];
  const uiInvalidateCalls: unknown[] = [];

  // ---- plugin load + event dispatch --------------------------------------
  const hooks = new Map<string, HookFn[]>(); // name -> [fn]
  const failureHooks = new Map<string, HookFn>(); // name -> .catch handler
  // the engine's two registration forms: on(name, hook) and on(name, matcher, hook);
  // each registration takes ONE .catch, recorded here so tests can drive a
  // throw/timeout/re-entry failure through the guard
  const on = (name: string, matcherOrFn: any, maybeFn?: HookFn) => {
    const fn: HookFn = maybeFn ?? matcherOrFn;
    if (!hooks.has(name)) hooks.set(name, []);
    hooks.get(name)?.push(fn);
    return {
      catch: (handler: HookFn) => {
        failureHooks.set(name, handler);
      },
    };
  };

  let state: any = null;
  let bridge: any = null;

  async function load() {
    // one module graph shared by register.ts and the host modules; state
    // carries an explicit reset (like the pi suite's setup.ts singletons) so
    // each harness starts clean without splitting module identity.
    const mod = await import(REGISTER_PATH);
    state = await import(require.resolve("../../host/state.ts"));
    bridge = await import(require.resolve("../../host/engine-bridge.ts"));
    state._resetForTest();
    // fresh registration per load: a second load on the same hooks map
    // would double-register every handler and double-dispatch events
    hooks.clear();
    failureHooks.clear();
    mod.register(on, {});
    return [...hooks.keys()];
  }

  /** Ask a registration's .catch in the hook's place (the engine's failure
   *  dispatch): the handler answers for the event, `next` carrying the
   *  failure and `called: false`. Returns the handler's answer. */
  async function dispatchFailure(name: string, e: any, failure: Record<string, unknown>): Promise<any> {
    if (!state) throw new Error("harness not loaded");
    const handler = failureHooks.get(name);
    if (handler === undefined) throw new Error(`no failure handler registered for ${name}`);
    const next: any = (e2?: any) => e2 ?? e;
    next.error = failure;
    next.called = false;
    const answered = await handler($, e, next);
    return answered === undefined ? e : answered;
  }

  async function dispatch(name: string, e: any): Promise<any> {
    if (!state) throw new Error("harness not loaded");
    dispatchDepth += 1;
    try {
      let result: any = e;
      for (const fn of hooks.get(name) ?? []) {
        // generator-shaped hooks (turn.step) consume `yield* next(e)`: give
        // them an async-generator next; plain hooks get the value-returning one
        const isGen = fn.constructor.name === "AsyncGeneratorFunction";
        const plainNext = (e2?: any) => e2 ?? result;
        const genNext = async function* genNextInner(e2?: any) {
          yield;
          return e2 ?? result;
        };
        const next = isGen ? genNext : plainNext;
        const r = fn($, result, next);
        if (r && typeof r[Symbol.asyncIterator] === "function") {
          // async-generator hook (turn.step): drain chunks, keep the return
          const it = r[Symbol.asyncIterator]();
          let step = await it.next();
          while (!step.done) {
            step = await it.next();
          }
          if (step.value !== undefined) result = step.value;
        } else {
          const ar = await r;
          if (ar !== undefined) result = ar;
        }
      }
      return result;
    } finally {
      dispatchDepth -= 1;
    }
  }

  // the harness's OWN teardown list (session.end runs it after the handler —
  // test suites register per-dispatch expectations here)
  const harnessTeardown: Array<() => void> = [];
  async function dispatchWithTeardown(name: string, e: any): Promise<any> {
    const result = await dispatch(name, e);
    if (name === "session.end") {
      for (const fn of harnessTeardown.splice(0)) {
        fn();
      }
    }
    return result;
  }

  return {
    uiLog,
    uiStatus,
    uiAskAnswers,
    uiAskQuestions,
    uiOpenCalls,
    uiFocusCalls,
    uiCloseCalls,
    uiInvalidateCalls,
    load,
    dispatch: dispatchWithTeardown,
    dispatchFailure,
    // in-flight dispatch depth (0 = outside any handler dynamic extent)
    get inDispatch() {
      return dispatchDepth;
    },
    env: {
      set: (k: string, v: string) => env.set(k, v),
      get: (k: string) => env.get(k),
    },
    refuseToolRegisters: (n: number) => {
      toolRegisterRefusals = n;
    },
    clearToolRegisterRefusals: () => {
      toolRegisterRefusals = 0;
    },
    settings: {
      read: async () => settingsValue,
    },
    plugin: {
      name: "session-owl",
      root: "/owl",
    },
    fsRead: async (p: string) => files.get(p),
    processRuns,
    sessionApi: {
      set(messages: unknown[], rows?: Array<{ uuid?: string }>) {
        sessionApiMessages = messages;
        sessionRows = rows ?? [];
      },
    },
    sessionModelApi: {
      set(value: string | null, error?: Error) {
        sessionModelValue = value;
        sessionModelError = error ?? null;
      },
    },
    sessionUsageApi: {
      set(window: number | null, error?: Error) {
        sessionUsageWindow = window;
        sessionUsageError = error ?? null;
      },
    },
    settingsApi: {
      set(value: Record<string, unknown>) {
        settingsValue = value;
      },
    },
    fsRefuse: (path: string | null) => {
      if (path === null) fsRefusals.clear();
      else fsRefusals.add(path);
    },
    sessionApiArmed: () => sessionApiMessages !== null,
    sessionAgentApi: {
      set(agentId: string, messages: unknown[]) {
        agentApiViews.set(agentId, messages);
      },
    },
    fsPaths: () => [...files.keys()],
    fsWrite: async (p: string, t: string) => files.set(p, t),
    tools: {
      get registered() {
        return registered.tools;
      },
    },
    commands: {
      get registered() {
        return registered.commands;
      },
    },
    agents: {
      get registered() {
        return registered.agents;
      },
    },
    spawned: {
      get calls() {
        return spawned;
      },
    },
    toolCalls: {
      get calls() {
        return toolCalls;
      },
    },
    turnAborts: {
      get calls() {
        return turnAborts;
      },
    },
    registryKeys: () => [...(state.registry.keys() as Iterable<string>)],
    setAgentRoster: (entries: Spec[]) => {
      agentRoster = entries;
    },
    onTeardown: (fn: () => void) => {
      harnessTeardown.push(fn);
    },
    bridge: () => bridge,
    async engineCreate() {
      const out = await dispatch("engine.create", {});
      return out ?? {};
    },
  };
}
