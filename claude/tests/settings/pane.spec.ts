// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// Settings pane tests: the pane module composes the library controller over
// the consumer's installed handle (title, storage levels, after-change
// wiring through the wrapped updateSetting), and the degrade path covers
// surfaces without field elements. Red first — the module does not exist.

import { afterEach, describe, expect, test } from "vitest";
import { buildPaneTree, captureCtx } from "../../../node_modules/avtc-claude-settings-ui/dist/index.js";
import { _resetSessionOwlSettingsHandle, _setRegisterSettingsCommand } from "../../core/src/config/schema.js";
import { _resetRecallRegistration } from "../../host/recall/register.js";
import {
  _resetSettingsConsumerForTest,
  getInstalledSettingsHandle,
  initSettingsConsumer,
} from "../../host/settings/consumer.js";
import { _resetSettingsPaneForTest, ensureSettingsPane, SETTINGS_PANE_ID } from "../../host/settings/pane.js";
import { setOwlEnabled } from "../../host/state.js";

function memFs(files: Record<string, string> = {}) {
  const store = new Map(Object.entries(files));
  return {
    read: async (p: string) => store.get(p) ?? null,
    write: async (p: string, c: string) => void store.set(p, c),
    exists: async (p: string) => store.has(p),
  };
}

const memEnv = (vars: Record<string, string> = {}) => {
  const store = new Map(Object.entries(vars));
  return { get: (n: string) => store.get(n), set: (n: string, v: string) => void store.set(n, v) };
};

type SettingsReadStub = () => Promise<unknown>;

async function makePaneWith(settingsRead: SettingsReadStub) {
  const notified: string[] = [];
  const opened: unknown[] = [];
  await initSettingsConsumer({
    configDir: "/cfg",
    cwd: "/work/proj",
    fs: memFs(),
    env: memEnv(),
    capsules: {
      toolRegister: async () => undefined,
      uiInvalidate: () => undefined,
    },
  });
  const controller = await ensureSettingsPane({
    uiLog: (text: string) => void notified.push(text),
    uiOpen: async (args: unknown) => {
      opened.push(args);
      return { isPlaced: true };
    },
    uiClose: () => undefined,
    uiInvalidate: () => undefined,
    settingsRead,
  });
  return { controller, notified, opened };
}

async function makePane() {
  return makePaneWith(async () => ({}));
}

afterEach(() => {
  _resetSessionOwlSettingsHandle();
  _setRegisterSettingsCommand(null);
  _resetSettingsConsumerForTest();
  _resetSettingsPaneForTest();
  _resetRecallRegistration();
  setOwlEnabled(true);
});

describe("the settings pane", () => {
  test("composes over the installed handle with owl's title + storage levels", async () => {
    const made = await makePane();
    const controller = made.controller;
    if (controller === null) throw new Error("pane controller unexpectedly null");
    expect(controller.state().title).toBe("SessionOwl Settings");
    expect(controller.state().storageLevels).toEqual(["session", "project", "global"]);
    expect(controller.state().tabs.length).toBeGreaterThan(1);
    expect(controller.state().tabs[0]?.settings.length).toBeGreaterThan(0);
  });

  test("opens the pane with the pinned id (focus, escape close)", async () => {
    const { opened } = await makePane();
    expect(opened).toHaveLength(1);
    const args = opened[0] as { id: string; title: string; focus: boolean; closeOnEscape: boolean };
    expect(args.id).toBe(SETTINGS_PANE_ID);
    expect(args.focus).toBe(true);
    expect(args.closeOnEscape).toBe(true);
  });

  test("a value change flows through the wrapped handle (the owl after-change)", async () => {
    const made = await makePane();
    const controller = made.controller;
    if (controller === null) throw new Error("pane controller unexpectedly null");
    const before = getInstalledSettingsHandle()?.getSettings().enabled;
    const row = findRow(controller, "enabled");
    expect(row).toBeTruthy();
    const display = row?.presets?.find((p) => p.label !== String(before));
    controller.selectValue("enabled", display?.displayValue ?? "false");
    expect(getInstalledSettingsHandle()?.getSettings().enabled).toBe(!before);
  });

  test("the tree builds over a stub element table", async () => {
    const made = await makePane();
    const controller = made.controller;
    if (controller === null) throw new Error("pane controller unexpectedly null");
    const ELEMENTS = {
      Box: (props: Record<string, unknown>) => ({ type: "Box", ...props }),
      Text: (props: Record<string, unknown>) => ({ type: "Text", ...props }),
      Button: (props: Record<string, unknown>) => ({ type: "Button", ...props }),
      Input: (props: Record<string, unknown>) => ({ type: "Input", ...props }),
      Select: (props: Record<string, unknown>) => ({ type: "Select", ...props }),
    };
    const tree = buildPaneTree(ELEMENTS as never, controller, { bodyColumns: 80 });
    const json = JSON.stringify(tree);
    expect(json).toContain("SessionOwl Settings");
    expect(json).toContain("Save project");
    expect(json).toContain("Save global");
  });

  test("prepare captures the models context — the documented engine aliases as static pairs", async () => {
    captureCtx({});
    const made = await makePane();
    const controller = made.controller;
    if (controller === null) throw new Error("pane controller unexpectedly null");
    await controller.prepare();
    const modelRow = findRow(controller, "defaultModel");
    expect(modelRow?.presets).toEqual([
      { label: "Default", displayValue: "Default", rawValue: null },
      { label: "haiku", displayValue: "haiku", rawValue: "haiku" },
      { label: "sonnet", displayValue: "sonnet", rawValue: "sonnet" },
      { label: "opus", displayValue: "opus", rawValue: "opus" },
      { label: "fable", displayValue: "fable", rawValue: "fable" },
    ]);
  });
});

describe("the settings pane's model-row enrichment (user availableModels)", () => {
  const CORE_PRESETS = [
    { label: "Default", displayValue: "Default", rawValue: null },
    { label: "haiku", displayValue: "haiku", rawValue: "haiku" },
    { label: "sonnet", displayValue: "sonnet", rawValue: "sonnet" },
    { label: "opus", displayValue: "opus", rawValue: "opus" },
    { label: "fable", displayValue: "fable", rawValue: "fable" },
  ];

  test("appends the user's availableModels rows after the aliases, labeled from modelPicker", async () => {
    const made = await makePaneWith(async () => ({
      availableModels: ["glm-5.3", "sonnet", "claude-fable-5", "claude-fable-5", 7],
      modelPicker: { options: [{ model: "glm-5.3", label: "Z.ai GLM" }] },
    }));
    const controller = made.controller;
    if (controller === null) throw new Error("pane controller unexpectedly null");
    await controller.prepare();
    // the alias set ("sonnet") is never duplicated; a labeled row keeps its
    // label but carries the raw id as its value (what the stage spawn accepts);
    // repeats and non-strings drop.
    expect(findRow(controller, "defaultModel")?.presets).toEqual([
      ...CORE_PRESETS,
      { label: "Z.ai GLM", displayValue: "glm-5.3", rawValue: "glm-5.3" },
      { label: "claude-fable-5", displayValue: "claude-fable-5", rawValue: "claude-fable-5" },
    ]);
  });

  test("a settings read that fails degrades to the core alias presets — SAYING the failure (never silent)", async () => {
    const made = await makePaneWith(async () => {
      throw new Error("read unavailable");
    });
    const controller = made.controller;
    if (controller === null) throw new Error("pane controller unexpectedly null");
    await controller.prepare();
    expect(findRow(controller, "defaultModel")?.presets).toEqual(CORE_PRESETS);
    // never a silent catch: the degrade is still
    // logged — exactly one said line, carrying the reason
    expect(made.notified.length).toBe(1);
    expect(String(made.notified[0])).toContain("settings pane model enrichment failed");
    expect(String(made.notified[0])).toContain("read unavailable");
  });

  test("malformed settings leave the core presets unchanged", async () => {
    const made = await makePaneWith(async () => ({
      availableModels: "sonnet",
      modelPicker: { options: [{ label: 3 }] },
    }));
    const controller = made.controller;
    if (controller === null) throw new Error("pane controller unexpectedly null");
    await controller.prepare();
    expect(findRow(controller, "defaultModel")?.presets).toEqual(CORE_PRESETS);
  });

  test("reserved alias keywords are never enrichment rows", async () => {
    const made = await makePaneWith(async () => ({
      availableModels: ["default", "best", "opusplan", "sonnet[1m]", "haiku", "glm-5.3"],
    }));
    const controller = made.controller;
    if (controller === null) throw new Error("pane controller unexpectedly null");
    await controller.prepare();
    expect(findRow(controller, "defaultModel")?.presets).toEqual([
      ...CORE_PRESETS,
      { label: "glm-5.3", displayValue: "glm-5.3", rawValue: "glm-5.3" },
    ]);
  });
});

function findRow(
  controller: {
    state: () => {
      tabs: Array<{
        settings: ReadonlyArray<{
          id: string;
          presets?: ReadonlyArray<{ label: string; displayValue: string; rawValue: unknown }>;
        }>;
      }>;
    };
  },
  id: string,
) {
  for (const tab of controller.state().tabs) {
    const row = tab.settings.find((s) => s.id === id);
    if (row) return row;
  }
  return undefined;
}
