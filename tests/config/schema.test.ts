// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { MemkeeperConfig } from "../../src/config/schema.js";
import {
  _resetGetMemkeeperSettings,
  _resetMemkeeperSettingsHandle,
  _setGetMemkeeperSettings,
  _setRegisterSettingsCommand,
  DEFAULT_CONFIG,
  getMemkeeperSettings,
  initMemkeeperSettings,
  MEMKEEPER_SCHEMA,
  reloadMemkeeperConfig,
} from "../../src/config/schema.js";
import { ImportanceSchema, NodeStateSchema } from "../../src/schema.js";
import { IMPORTANCE_VALUES, NODE_STATE_VALUES } from "../../src/types.js";

// Inject a fake registerSettingsCommand via the schema.ts seam (NOT vi.mock of
// avtc-pi-settings-ui — under isolate:false a module mock of that dep races
// against the many test files that import schema.ts loading the REAL module,
// causing flaky clobbering). The fake handle returns a sentinel config (enabled
// flipped) so the "after init" test proves getMemkeeperSettings reads the handle.
const LIVE_AFTER_INIT = { enabled: false, commandResultCap: 25 } as const;
// A vi.fn typed as the real registerSettingsCommand signature; the body returns
// a fake handle. Used via _setRegisterSettingsCommand (cast at the call site).
const registerSpy = vi.fn((_pi: ExtensionAPI, _schema: unknown, opts: unknown) => ({
  getSettings: () => LIVE_AFTER_INIT,
  updateSetting: () => {},
  storageLevels: (opts as { storageLevels?: string[] })?.storageLevels ?? ["session", "project", "global"],
})) as unknown as typeof import("avtc-pi-settings-ui").registerSettingsCommand & {
  mock: ReturnType<typeof vi.fn>["mock"];
};

beforeAll(() => _setRegisterSettingsCommand(registerSpy));
afterAll(() => _setRegisterSettingsCommand(null));

const EXPECTED_IDS = [
  // General
  "enabled",
  "defaultModel",
  "defaultThinkingLevel",
  "renderMode",
  "observerMode",
  "builderMode",
  "selectorMode",
  "rootViewTargetNodes",
  "rootViewStrategy",
  "commandResultCap",
  "findTimeoutMs",
  "llmCallTimeoutMs",
  "toolResultTokenBudget",
  "debugLog",
  // Observer
  "observerModel",
  "observerThresholdTokens",
  "observerIncludeThinking",
  "observerToolBlockCapTokens",
  "observerMaxTokens",
  "observerThinkingLevel",
  // Builder
  "builderModel",
  "builderEveryNObservations",
  "builderSessionContextThresholdTokens",
  "builderRootViewThreshold",
  "builderSkipWithinBudget",
  "maxBuilderPasses",
  "builderMaxTokens",
  "builderThinkingLevel",
  // Selector
  "selectorModel",
  "selectorSessionContextThresholdTokens",
  "selectorRootViewThreshold",
  "maxSelectorPasses",
  "selectorMaxTokens",
  "selectorThinkingLevel",
] as const;

// File-level teardown: clear the module handle (set by initMemkeeperSettings in the
// initialized describe) so it does NOT leak into other test files under isolate:false
// (getMemkeeperSettings would otherwise return the mock handle, not DEFAULT_CONFIG).
afterAll(() => _resetMemkeeperSettingsHandle());

describe("MEMKEEPER_SCHEMA", () => {
  it("declares every expected setting id", () => {
    const ids = MEMKEEPER_SCHEMA.settings.map((s) => s.id);
    for (const id of EXPECTED_IDS) {
      expect(ids, `missing setting id: ${id}`).toContain(id);
    }
    expect(new Set(ids).size, "no duplicate ids").toBe(ids.length);
    expect(ids.length, "no unexpected ids").toBe(EXPECTED_IDS.length);
  });

  it("every setting has a label and a defaultValue", () => {
    for (const s of MEMKEEPER_SCHEMA.settings) {
      expect(s.label, `${s.id} needs a label`).toBeTruthy();
      expect(s, `${s.id} needs a defaultValue`).toHaveProperty("defaultValue");
    }
  });

  it("every tab references only existing setting ids", () => {
    const ids = new Set(MEMKEEPER_SCHEMA.settings.map((s) => s.id));
    for (const tab of MEMKEEPER_SCHEMA.tabs) {
      expect(tab.label, "tab needs a label").toBeTruthy();
      expect(tab.settingIds.length, `tab '${tab.label}' is empty`).toBeGreaterThan(0);
      for (const id of tab.settingIds) {
        expect(ids.has(id), `tab '${tab.label}' references unknown id '${id}'`).toBe(true);
      }
    }
  });

  it("every setting id is covered by exactly one tab", () => {
    const tabbed: Record<string, number> = {};
    for (const tab of MEMKEEPER_SCHEMA.tabs) {
      for (const id of tab.settingIds) {
        tabbed[id] = (tabbed[id] ?? 0) + 1;
      }
    }
    for (const id of MEMKEEPER_SCHEMA.settings.map((s) => s.id)) {
      expect(tabbed[id] ?? 0, `${id} must appear in exactly one tab`).toBe(1);
    }
  });

  it("declares four tabs General/Observer/Builder/Selector", () => {
    const labels = MEMKEEPER_SCHEMA.tabs.map((t) => t.label);
    expect(labels).toEqual(["General", "Observer", "Builder", "Selector"]);
  });

  // A null preset element (bare or in a [label, value] pair) is the "no limit" /
  // "no target" option — several number knobs carry one.
  const hasNullPreset = (presets: unknown): boolean =>
    Array.isArray(presets) &&
    presets.some((el) => el === null || (Array.isArray(el) && el.length === 2 && el[1] === null));

  it("allows null on commandResultCap and observerToolBlockCapTokens (the 'no limit' presets)", () => {
    // Presets may mix bare values and [label, value] pairs; a null element (bare or in a pair)
    // is the "no limit" / "no truncation" option.
    const cap = MEMKEEPER_SCHEMA.settings.find((s) => s.id === "commandResultCap");
    expect(cap?.type).toBe("number");
    expect(hasNullPreset(cap?.presets), "commandResultCap needs a null preset").toBe(true);

    const toolCap = MEMKEEPER_SCHEMA.settings.find((s) => s.id === "observerToolBlockCapTokens");
    expect(hasNullPreset(toolCap?.presets), "observerToolBlockCapTokens needs a null preset").toBe(true);
  });

  it("declares the root-view shape knobs' presets (null pair, custom values, six strategies)", () => {
    const target = MEMKEEPER_SCHEMA.settings.find((s) => s.id === "rootViewTargetNodes");
    expect(target?.type).toBe("number");
    expect(target?.min).toBe(1);
    expect((target as { supportsCustomValues?: boolean } | undefined)?.supportsCustomValues).toBe(true);
    expect(hasNullPreset(target?.presets), "rootViewTargetNodes needs a null preset").toBe(true);

    const strategy = MEMKEEPER_SCHEMA.settings.find((s) => s.id === "rootViewStrategy");
    expect(strategy?.type).toBe("string");
    const values = ((strategy?.presets ?? []) as readonly (readonly [string, string])[]).map((p) => p[1]);
    expect(values).toEqual(["balanced", "by-task", "by-category", "by-recency", "by-importance", "by-topic"]);
  });

  it("declares the correct `type` for every setting", () => {
    const expectedType: Record<string, string> = {
      enabled: "boolean",
      defaultModel: "model",
      defaultThinkingLevel: "thinking-level",
      renderMode: "string",
      observerMode: "string",
      builderMode: "string",
      selectorMode: "string",
      rootViewTargetNodes: "number",
      rootViewStrategy: "string",
      commandResultCap: "number",
      findTimeoutMs: "duration",
      llmCallTimeoutMs: "duration",
      toolResultTokenBudget: "number",
      debugLog: "boolean",
      observerModel: "model",
      observerThresholdTokens: "number",
      observerIncludeThinking: "boolean",
      observerToolBlockCapTokens: "number",
      observerMaxTokens: "number",
      observerThinkingLevel: "thinking-level",
      builderModel: "model",
      builderEveryNObservations: "number",
      builderSessionContextThresholdTokens: "number",
      builderRootViewThreshold: "number",
      builderSkipWithinBudget: "boolean",
      maxBuilderPasses: "number",
      builderMaxTokens: "number",
      builderThinkingLevel: "thinking-level",
      selectorModel: "model",
      selectorSessionContextThresholdTokens: "number",
      selectorRootViewThreshold: "number",
      maxSelectorPasses: "number",
      selectorMaxTokens: "number",
      selectorThinkingLevel: "thinking-level",
    };
    for (const s of MEMKEEPER_SCHEMA.settings) {
      expect(s.type, `${s.id} type`).toBe(expectedType[s.id]);
    }
  });

  it("declares `min` on the numeric knobs that need a floor", () => {
    // Every numeric setting has min >= 1 (counts/thresholds are positive). commandResultCap and
    // observerToolBlockCapTokens allow 0 via min:0 (capped at 0 = effectively no work, still valid).
    const numeric = MEMKEEPER_SCHEMA.settings.filter((s) => s.type === "number");
    expect(numeric.length, "sanity: numeric settings exist").toBeGreaterThan(0);
    for (const s of numeric) {
      expect(typeof s.min, `${s.id} needs a numeric min`).toBe("number");
    }
    // commandResultCap and observerToolBlockCapTokens floor at 0; the rest floor at 1.
    const cap = MEMKEEPER_SCHEMA.settings.find((s) => s.id === "commandResultCap");
    expect(cap?.min).toBe(0);
    const toolCap = MEMKEEPER_SCHEMA.settings.find((s) => s.id === "observerToolBlockCapTokens");
    expect(toolCap?.min).toBe(0);
  });
});

describe("DEFAULT_CONFIG parity with schema defaults", () => {
  it("matches every schema defaultValue exactly", () => {
    for (const s of MEMKEEPER_SCHEMA.settings) {
      const key = s.id as keyof MemkeeperConfig;
      expect(DEFAULT_CONFIG[key], `DEFAULT_CONFIG.${s.id}`).toStrictEqual(s.defaultValue);
    }
  });

  it("covers every MemkeeperConfig key", () => {
    const schemaKeys = new Set(MEMKEEPER_SCHEMA.settings.map((s) => s.id));
    for (const key of Object.keys(DEFAULT_CONFIG)) {
      expect(schemaKeys.has(key), `DEFAULT_CONFIG has key not in schema: ${key}`).toBe(true);
    }
  });

  it("is frozen (callers can't mutate the shared default)", () => {
    expect(Object.isFrozen(DEFAULT_CONFIG)).toBe(true);
  });

  it("has the documented default profile", () => {
    expect(DEFAULT_CONFIG.enabled).toBe(true);
    expect(DEFAULT_CONFIG.observerMode).toBe("on-threshold");
    expect(DEFAULT_CONFIG.builderMode).toBe("each-N-observations");
    expect(DEFAULT_CONFIG.selectorMode).toBe("on-compaction");
    expect(DEFAULT_CONFIG.renderMode).toBe("observations-root");
    expect(DEFAULT_CONFIG.rootViewTargetNodes).toBeNull();
    expect(DEFAULT_CONFIG.rootViewStrategy).toBe("balanced");
    expect(DEFAULT_CONFIG.observerIncludeThinking).toBe(true);
    expect(DEFAULT_CONFIG.observerToolBlockCapTokens).toBeNull();
    expect(DEFAULT_CONFIG.builderSkipWithinBudget).toBe(true);
    expect(DEFAULT_CONFIG.observerMaxTokens).toBe(16384);
    expect(DEFAULT_CONFIG.builderMaxTokens).toBe(32768);
    expect(DEFAULT_CONFIG.selectorMaxTokens).toBe(65536);
    expect(DEFAULT_CONFIG.llmCallTimeoutMs).toBe(1_200_000);
  });

  it("offers 10m/20m/30m/Infinite LLM call timeout presets (no 3m)", () => {
    const s = MEMKEEPER_SCHEMA.settings.find((x) => x.id === "llmCallTimeoutMs");
    const labels = ((s?.presets ?? []) as readonly (readonly [string, number | null])[]).map((p) => p[0]);
    expect(labels).toEqual(["10m", "20m", "30m", "Infinite"]);
  });
});

describe("getMemkeeperSettings — before init", () => {
  // Ensure the handle is undefined when this runs, even if another test file set
  // it earlier (isolate:false shares module state).
  beforeAll(() => _resetMemkeeperSettingsHandle());
  it("returns DEFAULT_CONFIG before init (no crash for early callers)", () => {
    // Runs first (this describe precedes the initialized one); module-level handle is undefined.
    expect(getMemkeeperSettings()).toStrictEqual(DEFAULT_CONFIG);
  });
});

describe("getMemkeeperSettings — initialized", () => {
  const fakePi = {} as ExtensionAPI;
  // Each test initializes its own handle read (init is idempotent via the spy; at(-1) is current).
  beforeEach(() => initMemkeeperSettings(fakePi));
  afterEach(() => _resetGetMemkeeperSettings());

  it("initMemkeeperSettings registers the /mk:settings command with the documented options", () => {
    const spy = registerSpy;
    expect(spy).toHaveBeenCalled();
    const [piArg, schemaArg, optsArg] = spy.mock.calls.at(-1) ?? [];
    expect(piArg).toBe(fakePi);
    expect(schemaArg).toBe(MEMKEEPER_SCHEMA);
    expect(optsArg).toMatchObject({
      commandName: "mk:settings",
      title: "Memkeeper Settings",
      titleRight: "avtc-pi-memkeeper",
      storageLevels: ["session", "project", "global"],
      envVar: "PI_SETTINGS_MEMKEEPER",
    });
  });

  it("returns the handle's live getSettings() after init", () => {
    const cfg = getMemkeeperSettings();
    // The mock handle yields LIVE_AFTER_INIT (enabled:false, distinct from default true).
    expect(cfg.enabled).toBe(false);
    expect(cfg.commandResultCap).toBe(25);
  });

  it("_setGetMemkeeperSettings overrides the read (the repo DI/mock pattern)", () => {
    const injected: MemkeeperConfig = { ...DEFAULT_CONFIG, enabled: false, maxBuilderPasses: 1 };
    _setGetMemkeeperSettings(() => injected);
    expect(getMemkeeperSettings()).toBe(injected);
  });

  it("_resetGetMemkeeperSettings restores the real-handle read", () => {
    const injected: MemkeeperConfig = { ...DEFAULT_CONFIG, enabled: false };
    _setGetMemkeeperSettings(() => injected);
    _resetGetMemkeeperSettings();
    // Override cleared -> falls through to the handle (set by beforeEach) -> LIVE_AFTER_INIT.
    expect(getMemkeeperSettings().enabled).toBe(false);
    expect(getMemkeeperSettings().commandResultCap).toBe(25);
  });
});

describe("tool schemas derive from canonical types (no drift)", () => {
  it("ImportanceSchema enum equals IMPORTANCE_VALUES", () => {
    expect([...(ImportanceSchema as { enum: string[] }).enum]).toEqual([...IMPORTANCE_VALUES]);
  });

  it("NodeStateSchema enum equals NODE_STATE_VALUES", () => {
    expect([...(NodeStateSchema as { enum: string[] }).enum]).toEqual([...NODE_STATE_VALUES]);
  });
});

describe("reloadMemkeeperConfig", () => {
  // Dedicated fake handle tracking loadSettingsIntoMemory (the settings-ui refresh call).
  const loadSettingsIntoMemory = vi.fn();
  const reloadRegisterSpy = vi.fn((_pi: ExtensionAPI, _schema: unknown, _opts: unknown) => ({
    getSettings: () => DEFAULT_CONFIG,
    updateSetting: () => {},
    loadSettingsIntoMemory,
    storageLevels: ["session", "project", "global"],
  })) as unknown as typeof import("avtc-pi-settings-ui").registerSettingsCommand & {
    mock: ReturnType<typeof vi.fn>["mock"];
  };

  beforeAll(() => _setRegisterSettingsCommand(reloadRegisterSpy));
  afterAll(() => {
    _setRegisterSettingsCommand(null);
    _resetMemkeeperSettingsHandle();
  });

  beforeEach(() => {
    loadSettingsIntoMemory.mockReset();
    _resetMemkeeperSettingsHandle();
  });

  it("is a no-op before initMemkeeperSettings (handle undefined — no throw)", () => {
    // handle is undefined here (cleared in beforeEach)
    expect(() => reloadMemkeeperConfig()).not.toThrow();
    expect(loadSettingsIntoMemory).not.toHaveBeenCalled();
  });

  it("calls the handle's loadSettingsIntoMemory(undefined, undefined) after init", () => {
    initMemkeeperSettings({} as ExtensionAPI);
    reloadMemkeeperConfig();
    expect(loadSettingsIntoMemory).toHaveBeenCalledTimes(1);
    expect(loadSettingsIntoMemory).toHaveBeenCalledWith(undefined, undefined);
  });
});
