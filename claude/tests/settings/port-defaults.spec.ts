// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// The port's background-model default: the shared Default-model knob ships
// pre-set to `haiku` through the port schema composite (the vendored schema
// stays byte-identical — its default stays null), the pre-init settings
// fallback derives from the same composite, and an explicit "Session
// default" (null) persists as a value so the revert to the session model
// survives reloads. Red first — withPortDefaults / PORT_DEFAULTS_CONFIG do
// not exist yet.

import { describe, expect, test } from "vitest";
import { createSettingsExtension } from "../../../node_modules/avtc-claude-settings-ui/dist/index.js";
import { SESSION_OWL_SCHEMA, type SessionOwlConfig } from "../../core/src/config/schema.js";
import { OWL_CLAUDE_SCHEMA, PORT_DEFAULTS_CONFIG } from "../../host/settings/consumer.js";
import {
  PORT_DEFAULT_MODEL,
  PORT_DEFAULT_THINKING_LEVEL,
  PORT_OBSERVER_INCLUDE_THINKING,
  withPortDefaults,
  withPortFields,
} from "../../host/settings/port-fields.js";
import { stageModelFromSettings } from "../../host/stage/agents.js";

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

describe("the port's default-model override", () => {
  test("the port composite ships defaultModel as haiku; the vendored schema stays null", () => {
    const portRow = OWL_CLAUDE_SCHEMA.settings.find((s) => s.id === "defaultModel");
    const vendoredRow = SESSION_OWL_SCHEMA.settings.find((s) => s.id === "defaultModel");
    expect(portRow?.defaultValue).toBe("haiku");
    expect(vendoredRow?.defaultValue).toBeNull();
  });

  test("withPortDefaults overrides exactly the three port-defaulted rows — every other row is untouched", () => {
    const base = withPortFields(SESSION_OWL_SCHEMA);
    const overridden = withPortDefaults(base);
    expect(overridden.settings.length).toBe(base.settings.length);
    for (const [i, row] of base.settings.entries()) {
      const after = overridden.settings[i];
      if (row.id === "defaultModel") {
        expect(after.defaultValue).toBe(PORT_DEFAULT_MODEL);
        expect(after.defaultValue).toBe("haiku");
      } else if (row.id === "defaultThinkingLevel") {
        expect(after.defaultValue).toBe(PORT_DEFAULT_THINKING_LEVEL);
        expect(after.defaultValue).toBe("high");
      } else if (row.id === "observerIncludeThinking") {
        expect(after.defaultValue).toBe(PORT_OBSERVER_INCLUDE_THINKING);
        expect(after.defaultValue).toBe(false);
      } else {
        expect(after).toBe(row); // same reference — no accidental rebuild
      }
    }
  });

  test("PORT_DEFAULTS_CONFIG mirrors every composite row's default (the derivation rule)", () => {
    expect(Object.keys(PORT_DEFAULTS_CONFIG).length).toBe(OWL_CLAUDE_SCHEMA.settings.length);
    for (const row of OWL_CLAUDE_SCHEMA.settings) {
      expect(PORT_DEFAULTS_CONFIG).toHaveProperty(row.id, row.defaultValue);
    }
    // spot values: the port's own defaults, not the vendored ones
    expect(PORT_DEFAULTS_CONFIG.defaultModel).toBe("haiku");
    expect(PORT_DEFAULTS_CONFIG.defaultThinkingLevel).toBe("high");
    expect(PORT_DEFAULTS_CONFIG.observerIncludeThinking).toBe(false);
    expect((PORT_DEFAULTS_CONFIG as { keepRecentTokens?: unknown }).keepRecentTokens).toBe(20_000);
    expect(PORT_DEFAULTS_CONFIG.enabled).toBe(true);
  });
});

describe("the port's thinking-knob defaults", () => {
  test("the port composite ships defaultThinkingLevel high and observerIncludeThinking false; the vendored schema stays null/true", () => {
    const thinkingRow = OWL_CLAUDE_SCHEMA.settings.find((s) => s.id === "defaultThinkingLevel");
    const vendoredThinkingRow = SESSION_OWL_SCHEMA.settings.find((s) => s.id === "defaultThinkingLevel");
    const includeRow = OWL_CLAUDE_SCHEMA.settings.find((s) => s.id === "observerIncludeThinking");
    const vendoredIncludeRow = SESSION_OWL_SCHEMA.settings.find((s) => s.id === "observerIncludeThinking");
    expect(thinkingRow?.defaultValue).toBe("high");
    expect(vendoredThinkingRow?.defaultValue).toBeNull();
    expect(includeRow?.defaultValue).toBe(false);
    expect(vendoredIncludeRow?.defaultValue).toBe(true);
  });

  test("a fresh load with no files resolves both thinking knobs to the port defaults", async () => {
    const lib = createSettingsExtension<Record<string, unknown>>(OWL_CLAUDE_SCHEMA as never, {
      fs: memFs() as never,
      env: memEnv() as never,
      envVar: "TEST_OWL_SETTINGS",
    });
    await lib.load("/proj", "/home/.claude");
    expect(lib.getSettings().defaultThinkingLevel).toBe("high");
    expect(lib.getSettings().observerIncludeThinking).toBe(false);
  });

  test("re-enabling prev-turn thinking persists as a value and survives a reload", async () => {
    const fs = memFs();
    const lib = createSettingsExtension<Record<string, unknown>>(OWL_CLAUDE_SCHEMA as never, {
      fs: fs as never,
      env: memEnv() as never,
      envVar: "TEST_OWL_SETTINGS",
    });
    await lib.load("/proj", "/home/.claude");
    lib.updateSetting("observerIncludeThinking", true, { level: "session" });
    expect(lib.getSettings().observerIncludeThinking).toBe(true);

    // a second handle over the same files: the explicit true rides the
    // env-var ladder back in, not the default
    const envDump = memEnv({ TEST_OWL_SETTINGS: JSON.stringify(lib.getSettings()) });
    const second = createSettingsExtension<Record<string, unknown>>(OWL_CLAUDE_SCHEMA as never, {
      fs,
      env: envDump as never,
      envVar: "TEST_OWL_SETTINGS",
    });
    await second.load("/proj", "/home/.claude");
    expect(second.getSettings().observerIncludeThinking).toBe(true);
  });
});

describe("the haiku default through the real settings library", () => {
  test("a fresh load with no files resolves defaultModel to haiku", async () => {
    const lib = createSettingsExtension<Record<string, unknown>>(OWL_CLAUDE_SCHEMA as never, {
      fs: memFs() as never,
      env: memEnv() as never,
      envVar: "TEST_OWL_SETTINGS",
    });
    await lib.load("/proj", "/home/.claude");
    expect(lib.getSettings().defaultModel).toBe("haiku");
  });

  test("picking Session default (null) persists as a value and survives a reload", async () => {
    const fs = memFs();
    const lib = createSettingsExtension<Record<string, unknown>>(OWL_CLAUDE_SCHEMA as never, {
      fs: fs as never,
      env: memEnv() as never,
      envVar: "TEST_OWL_SETTINGS",
    });
    await lib.load("/proj", "/home/.claude");
    lib.updateSetting("defaultModel", null, { level: "session" });
    expect(lib.getSettings().defaultModel).toBeNull();

    // a second handle over the same (empty) files: the explicit null rides
    // the env-var ladder back in, not the default
    const envDump = memEnv({ TEST_OWL_SETTINGS: JSON.stringify(lib.getSettings()) });
    const second = createSettingsExtension<Record<string, unknown>>(OWL_CLAUDE_SCHEMA as never, {
      fs,
      env: envDump as never,
      envVar: "TEST_OWL_SETTINGS",
    });
    await second.load("/proj", "/home/.claude");
    expect(second.getSettings().defaultModel).toBeNull();
  });

  test("an explicit null default falls the stages back to the session model; haiku routes them", () => {
    const reverted: Parameters<typeof stageModelFromSettings>[0] = {
      observerModel: null,
      builderModel: null,
      selectorModel: null,
      defaultModel: null,
      defaultThinkingLevel: null,
      observerThinkingLevel: null,
      builderThinkingLevel: null,
      selectorThinkingLevel: null,
    };
    expect(stageModelFromSettings(reverted, "observer")).toBeUndefined();
    expect(stageModelFromSettings(reverted, "builder")).toBeUndefined();
    expect(stageModelFromSettings(reverted, "selector")).toBeUndefined();

    const defaults = PORT_DEFAULTS_CONFIG as SessionOwlConfig;
    expect(
      stageModelFromSettings(
        {
          observerModel: defaults.observerModel,
          builderModel: defaults.builderModel,
          selectorModel: defaults.selectorModel,
          defaultModel: defaults.defaultModel,
          defaultThinkingLevel: null,
          observerThinkingLevel: null,
          builderThinkingLevel: null,
          selectorThinkingLevel: null,
        },
        "observer",
      ),
    ).toBe("haiku");
  });
});
