// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// Settings consumer tests: the vendored core's settings seam
// (_setRegisterSettingsCommand + initSessionOwlSettings) drives the Claude
// library handle — consumer name, env var, precedence ladder, live gate
// flip through onAfterChange, and the reload alias. Red first — the module
// does not exist.

import { afterEach, describe, expect, test, vi } from "vitest";
import {
  _resetSessionOwlSettingsHandle,
  _setRegisterSettingsCommand,
  getSessionOwlSettings,
  reloadSessionOwlConfig,
} from "../../core/src/config/schema.js";
import { log } from "../../core/src/log.js";
import { _resetConflictStateForTest, setConflictHits } from "../../host/conflicts/pause.js";
import { _resetRecallRegistration } from "../../host/recall/register.js";
import { _resetSettingsConsumerForTest, initSettingsConsumer } from "../../host/settings/consumer.js";
import { isOwlIgnoreConflicts, _resetForTest as resetState, setOwlEnabled } from "../../host/state.js";

function memFs(files: Record<string, string> = {}) {
  const store = new Map(Object.entries(files));
  return {
    read: async (p: string) => store.get(p) ?? null,
    write: async (p: string, c: string) => void store.set(p, c),
    exists: async (p: string) => store.has(p),
    dump: () => Object.fromEntries(store),
  };
}

function memEnv(vars: Record<string, string> = {}) {
  const store = new Map(Object.entries(vars));
  return {
    get: (n: string) => store.get(n),
    set: (n: string, v: string) => void store.set(n, v),
    dump: () => Object.fromEntries(store),
  };
}

const CONFIG_DIR = "/cfg";
const CWD = "/work/proj";
const GLOBAL_PATH = "/cfg/avtc-session-owl-settings.json";
const PROJECT_PATH = "/work/proj/.claude/avtc-session-owl-settings.json";
const ENV_VAR = "CLAUDE_SETTINGS_SESSION_OWL";

function makeCapsules() {
  const registered: unknown[] = [];
  const invalidates: number[] = [];
  const timeline: string[] = [];
  return {
    registered,
    invalidates,
    timeline,
    toolRegister: async (spec: unknown) => void registered.push(spec),
    uiInvalidate: () => void invalidates.push(1),
    fsStat: async () => null,
    appendTimeline: (t: string) => void timeline.push(t),
  };
}

async function makeConsumer(overrides?: {
  files?: Record<string, string>;
  env?: Record<string, string>;
  capsules?: Partial<ReturnType<typeof makeCapsules>>;
}) {
  // fresh adapters per call (the suite's own convention — production re-init
  // is idempotent and KEEPS its handles; the tests exercise fresh libraries)
  _resetSettingsConsumerForTest();
  const fs = memFs(overrides?.files);
  const env = memEnv(overrides?.env);
  const capsules = { ...makeCapsules(), ...(overrides?.capsules ?? {}) };
  const handle = await initSettingsConsumer({
    configDir: CONFIG_DIR,
    cwd: CWD,
    fs,
    env,
    capsules,
  });
  return { fs, env, capsules, handle };
}

test("load diagnostics: the effective knobs and the layered cwd are logged — an empty-cwd reload shows the project file dropping out", async () => {
  const spy = vi.spyOn(log, "info").mockImplementation(() => {});
  const make = await makeConsumer();
  const firstLines = spy.mock.calls.map((c) => String(c[0] ?? ""));
  const firstLine = firstLines.find((l) => l.startsWith("settings: "));
  expect(firstLine).toBeDefined();
  expect(firstLine).toContain("observerThresholdTokens=");
  expect(firstLine).toContain("builderEveryNObservations=");
  expect(firstLine).toContain("enabled=");
  expect(firstLine ?? "").toMatch(/cwd=".+"/); // the normal start layers a real cwd
  // a start event WITHOUT cwd (the /branch shape): reload with
  // "" and the line must show it — the project layer then cannot resolve
  expect(firstLine ?? "").not.toContain('cwd=""');
  await initSettingsConsumer({
    configDir: "/cfg",
    cwd: "",
    fs: make.fs,
    env: make.env,
    capsules: make.capsules,
  });
  const reloadLines = spy.mock.calls.map((c) => String(c[0] ?? ""));
  expect(reloadLines.some((l) => /^settings: reload cwd=""/.test(l))).toBe(true);
  spy.mockRestore();
});

afterEach(() => {
  _resetSessionOwlSettingsHandle();
  _setRegisterSettingsCommand(null);
  _resetSettingsConsumerForTest();
  _resetRecallRegistration();
  _resetConflictStateForTest(); // own the conflict premise — hits/ignore leaks from other suites never mask the timeline assertions
  setOwlEnabled(true);
});

describe("the settings consumer — paths + ladder", () => {
  test("default config with no files; env var serialized", async () => {
    const { env } = await makeConsumer();
    expect(getSessionOwlSettings().enabled).toBe(true);
    const serialized = env.dump()[ENV_VAR];
    expect(serialized).toBeDefined();
    expect(JSON.parse(serialized as string).enabled).toBe(true);
  });

  test("global then project layering under the avtc-session-owl name", async () => {
    const { handle: _h } = await makeConsumer({
      files: {
        [GLOBAL_PATH]: JSON.stringify({ enabled: false }),
        [PROJECT_PATH]: JSON.stringify({ enabled: true }),
      },
    });
    void _h;
    expect(getSessionOwlSettings().enabled).toBe(true); // project wins
    const { handle: _h2 } = await makeConsumer({
      files: { [GLOBAL_PATH]: JSON.stringify({ enabled: false }) },
    });
    void _h2;
    expect(getSessionOwlSettings().enabled).toBe(false); // global over default
  });

  test("session env var bootstraps over files (subagent propagation)", async () => {
    await makeConsumer({ env: { [ENV_VAR]: JSON.stringify({ enabled: false }) } });
    expect(getSessionOwlSettings().enabled).toBe(false);
  });
});

describe("the settings consumer — gate flips", () => {
  test("disabled at start syncs the live predicate", async () => {
    await makeConsumer({ files: { [GLOBAL_PATH]: JSON.stringify({ enabled: false }) } });
    expect(getSessionOwlSettings().enabled).toBe(false);
  });

  test("ignoreConflicts at start syncs the live co-run predicate", async () => {
    await makeConsumer({ files: { [GLOBAL_PATH]: JSON.stringify({ ignoreConflicts: true }) } });
    expect(isOwlIgnoreConflicts()).toBe(true);
  });

  test("an enable flip through the wrapped handle registers owl_recall once + invalidates", async () => {
    resetState(); // own the premise: no start-gate registration leaked from other suites
    const first = await makeConsumer({ files: { [GLOBAL_PATH]: JSON.stringify({ enabled: false }) } });
    expect(getSessionOwlSettings().enabled).toBe(false);
    first.handle.updateSetting("enabled", true);
    expect(getSessionOwlSettings().enabled).toBe(true); // the live read flipped
    expect(first.capsules.registered).toHaveLength(1); // owl_recall registered
    expect(first.capsules.invalidates.length).toBeGreaterThan(0); // band invalidated
    // a second flip fires no second registration (once per process; settle
    // the async flag write first)
    await new Promise((r) => setTimeout(r, 10));
    first.handle.updateSetting("enabled", false);
    first.handle.updateSetting("enabled", true);
    await new Promise((r) => setTimeout(r, 10));
    expect(first.capsules.registered).toHaveLength(1);
  });

  test("a failing toolRegister never becomes an unhandled rejection (logged degrade)", async () => {
    resetState(); // fresh-process semantics (the beforeEach already cleared the recall once-flag)
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const c = await makeConsumer({
        files: { [GLOBAL_PATH]: JSON.stringify({ enabled: false }) },
        capsules: {
          toolRegister: async () => {
            throw new Error("engine register rejected");
          },
        },
      });
      c.handle.updateSetting("enabled", true);
      await new Promise((r) => setTimeout(r, 10));
      expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("owl_recall registration failed"));
    } finally {
      errSpy.mockRestore();
    }
  });

  test("an ignoreConflicts flip syncs the live co-run predicate (the pause recompute input)", async () => {
    const c = await makeConsumer();
    expect(getSessionOwlSettings().ignoreConflicts).toBe(false);
    c.handle.updateSetting("ignoreConflicts", true);
    expect(getSessionOwlSettings().ignoreConflicts).toBe(true); // the live read flipped
    expect(isOwlIgnoreConflicts()).toBe(true); // the closure-side live predicate
    c.handle.updateSetting("ignoreConflicts", false);
    expect(isOwlIgnoreConflicts()).toBe(false);
  });

  test("a disable flip syncs the live predicate without unregistering", async () => {
    const c = await makeConsumer();
    c.handle.updateSetting("enabled", false);
    expect(getSessionOwlSettings().enabled).toBe(false);
    expect(c.capsules.registered).toHaveLength(0);
  });
});

describe("the settings consumer — reload", () => {
  test("reloadSessionOwlConfig picks up an env-var change", async () => {
    const first = await makeConsumer();
    void first;
    expect(getSessionOwlSettings().enabled).toBe(true);
    first.env.set(ENV_VAR, JSON.stringify({ ...getSessionOwlSettings(), enabled: false }));
    reloadSessionOwlConfig();
    await new Promise((r) => setTimeout(r, 20));
    expect(getSessionOwlSettings().enabled).toBe(false);
  });
});

describe("the settings consumer — conflict-timeline transitions", () => {
  test("an enable flip appends enable; a disable flip appends disable only", async () => {
    const { capsules, handle } = await makeConsumer();
    handle.updateSetting("enabled", true);
    expect(capsules.timeline).toEqual(["enable"]);
    handle.updateSetting("enabled", false);
    expect(capsules.timeline).toEqual(["enable", "disable"]);
  });

  test("an enable while conflict-paused also mirrors pause (the window never opens)", async () => {
    setConflictHits([{ channel: "B", name: "other-mod@x", evidence: "session.compact" }]);
    try {
      const { capsules, handle } = await makeConsumer();
      handle.updateSetting("enabled", true);
      expect(capsules.timeline).toEqual(["enable", "pause"]);
    } finally {
      _resetConflictStateForTest();
    }
  });

  test("ignoreConflicts flips mirror pause/resume (hits armed)", async () => {
    setConflictHits([{ channel: "B", name: "other-mod@x", evidence: "session.compact" }]);
    try {
      const { capsules, handle } = await makeConsumer();
      handle.updateSetting("ignoreConflicts", true); // resume: the user overrides the pause
      expect(capsules.timeline[capsules.timeline.length - 1]).toBe("resume");
      handle.updateSetting("ignoreConflicts", false); // pause again
      expect(capsules.timeline[capsules.timeline.length - 1]).toBe("pause");
    } finally {
      _resetConflictStateForTest();
    }
  });

  test("ignoreConflicts flips with NO hits append nothing (never paused)", async () => {
    const { capsules, handle } = await makeConsumer();
    handle.updateSetting("ignoreConflicts", true);
    expect(capsules.timeline).toEqual([]);
  });
});

describe("the settings consumer — port-only fields", () => {
  test("the handle's schema carries the port overlay: keepRecentTokens + mirrorRetentionDays in the General tab", async () => {
    const { handle } = await makeConsumer();
    const ids = handle.schema.settings.map((s) => s.id);
    expect(ids).toContain("keepRecentTokens");
    expect(ids).toContain("keptTailAggregatedThinking");
    expect(ids).toContain("mirrorRetentionDays");
    const general = handle.schema.tabs.find((t) => t.label === "General");
    expect(general?.settingIds).toContain("keepRecentTokens");
    expect(general?.settingIds).toContain("mirrorRetentionDays");
  });

  test("the port fields ride persistence (normalize keeps the port-only keys)", async () => {
    const { handle, fs } = await makeConsumer();
    handle.updateSetting("keepRecentTokens", 32000);
    handle.updateSetting("mirrorRetentionDays", 30);
    await handle.persistToGlobal();
    const saved = JSON.parse(fs.dump()[GLOBAL_PATH] as string);
    expect(saved.keepRecentTokens).toBe(32000);
    expect(saved.mirrorRetentionDays).toBe(30);
  });

  test("keepRecentTokens accepts small budgets — 0 (summary-only) and 1 stick", async () => {
    const { handle } = await makeConsumer();
    const read = () => (handle.getSettings() as unknown as Record<string, unknown>).keepRecentTokens;
    handle.updateSetting("keepRecentTokens", 0);
    expect(read()).toBe(0);
    handle.updateSetting("keepRecentTokens", 1);
    expect(read()).toBe(1);
  });
});
