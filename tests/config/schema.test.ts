// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import { afterEach, describe, expect, it, vi } from "vitest";

// Hoisted mock: registerSettingsCommand returns a fake handle whose getSettings() yields a
// distinct live value so the "after init" test can prove getMemkeeperSettings reads the handle.
const LIVE_AFTER_INIT = vi.hoisted(() => {
  // A sentinel config distinct from DEFAULT_CONFIG (enabled flipped) — reassigned per test below.
  return { enabled: false, commandResultCap: 25 };
});

vi.mock("avtc-pi-settings-ui", () => ({
  registerSettingsCommand: vi.fn(() => ({
    getSettings: () => LIVE_AFTER_INIT,
    updateSetting: () => {},
    storageLevels: ["session", "project", "global"],
  })),
  settingsFilePaths: (name: string) => ({
    globalPath: (globalDir?: string) => `${globalDir ?? "~/.pi"}/agent/${name}-settings.json`,
    projectPath: (cwd: string) => `${cwd}/.pi/${name}-settings.json`,
  }),
}));

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as settingsUi from "avtc-pi-settings-ui";
import type { MemkeeperConfig } from "../../src/config/schema.js";
// settingsFilePaths + registerSettingsCommand are type-only imports in schema.ts; the mock above
// supplies runtime values. Import the schema AFTER the mock is registered.
import {
  _resetGetMemkeeperSettings,
  _setGetMemkeeperSettings,
  DEFAULT_CONFIG,
  getMemkeeperSettings,
  initMemkeeperSettings,
  MEMKEEPER_SCHEMA,
} from "../../src/config/schema.js";

const EXPECTED_IDS = [
  // General
  "enabled",
  "defaultModel",
  "renderMode",
  "observerMode",
  "builderMode",
  "selectorMode",
  "commandResultCap",
  // Observer
  "observerModel",
  "observerThresholdTokens",
  "observerIncludeThinking",
  "observerToolBlockCapTokens",
  // Builder
  "builderModel",
  "builderEveryNObservations",
  "builderSessionContextThresholdTokens",
  "builderRootViewThreshold",
  "maxBuilderPasses",
  // Selector
  "selectorModel",
  "selectorSessionContextThresholdTokens",
  "selectorRootViewThreshold",
  "maxSelectorPasses",
] as const;

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

  it("allows null on commandResultCap and observerToolBlockCapTokens (the 'no limit' presets)", () => {
    // Presets may mix bare values and [label, value] pairs; a null element (bare or in a pair)
    // is the "no limit" / "no truncation" option.
    const hasNull = (presets: unknown): boolean =>
      Array.isArray(presets) &&
      presets.some((el) => el === null || (Array.isArray(el) && el.length === 2 && el[1] === null));

    const cap = MEMKEEPER_SCHEMA.settings.find((s) => s.id === "commandResultCap");
    expect(cap?.type).toBe("number");
    expect(hasNull(cap?.presets), "commandResultCap needs a null preset").toBe(true);

    const toolCap = MEMKEEPER_SCHEMA.settings.find((s) => s.id === "observerToolBlockCapTokens");
    expect(hasNull(toolCap?.presets), "observerToolBlockCapTokens needs a null preset").toBe(true);
  });

  it("declares the correct `type` for every setting", () => {
    const expectedType: Record<string, string> = {
      enabled: "boolean",
      defaultModel: "model",
      renderMode: "string",
      observerMode: "string",
      builderMode: "string",
      selectorMode: "string",
      commandResultCap: "number",
      observerModel: "model",
      observerThresholdTokens: "number",
      observerIncludeThinking: "boolean",
      observerToolBlockCapTokens: "number",
      builderModel: "model",
      builderEveryNObservations: "number",
      builderSessionContextThresholdTokens: "number",
      builderRootViewThreshold: "number",
      maxBuilderPasses: "number",
      selectorModel: "model",
      selectorSessionContextThresholdTokens: "number",
      selectorRootViewThreshold: "number",
      maxSelectorPasses: "number",
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
    expect(DEFAULT_CONFIG.builderMode).toBe("on-compaction");
    expect(DEFAULT_CONFIG.selectorMode).toBe("on-compaction");
    expect(DEFAULT_CONFIG.renderMode).toBe("selected-root");
  });
});

describe("getMemkeeperSettings", () => {
  afterEach(() => _resetGetMemkeeperSettings());

  it("returns DEFAULT_CONFIG before init (no crash for early callers)", () => {
    // Must run before any init call; module-level handle is still null here.
    const cfg = getMemkeeperSettings();
    expect(cfg).toStrictEqual(DEFAULT_CONFIG);
  });

  it("initMemkeeperSettings registers the /mk:settings command with the documented options", () => {
    const fakePi = {} as ExtensionAPI;
    initMemkeeperSettings(fakePi);
    const spy = vi.mocked(settingsUi.registerSettingsCommand);
    expect(spy).toHaveBeenCalledTimes(1);
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
    // initMemkeeperSettings ran in the test above (module-level handle now set).
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
    // Falls through to the handle (set by the init test above) -> LIVE_AFTER_INIT.
    expect(getMemkeeperSettings().enabled).toBe(false);
    expect(getMemkeeperSettings().commandResultCap).toBe(25);
  });
});
