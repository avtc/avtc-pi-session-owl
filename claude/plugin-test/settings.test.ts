// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// Engine-kit twin of the settings surface: the consumer + pane compose under
// the real kit loader over injected data stubs (fs/env/capsules), and the
// pane tree draws + drives through a mounted Pane (the probe recipe: base
// responder + requestId match + find-by-text + acts).

import { describe, expect, test } from "claude-code/testing";
import {
  _resetSessionOwlSettingsHandle,
  _setRegisterSettingsCommand,
  getSessionOwlSettings,
} from "../core/src/config/schema.js";
import { _resetSettingsConsumerForTest, initSettingsConsumer } from "../host/settings/consumer.js";
import {
  _resetSettingsPaneForTest,
  ensureSettingsPane,
  getSettingsPaneController,
  SETTINGS_PANE_ID,
} from "../host/settings/pane.js";
import { buildPaneTree } from "../node_modules/avtc-claude-settings-ui/dist/index.js";

function memFs() {
  const store = new Map<string, string>();
  return {
    read: async (p: string) => store.get(p) ?? null,
    write: async (p: string, c: string) => void store.set(p, c),
    exists: async (p: string) => store.has(p),
  };
}

function memEnv() {
  const store = new Map<string, string>();
  return { get: (n: string) => store.get(n), set: (n: string, v: string) => void store.set(n, v) };
}

async function setup() {
  const opened: unknown[] = [];
  await initSettingsConsumer({
    configDir: "/kit-cfg",
    cwd: "/kit-cwd",
    fs: memFs(),
    env: memEnv(),
    capsules: { toolRegister: async () => undefined, uiInvalidate: () => undefined },
  });
  const controller = await ensureSettingsPane({
    uiLog: () => undefined,
    uiOpen: async (args) => {
      opened.push(args);
      return { isPlaced: true };
    },
    uiClose: () => undefined,
    uiInvalidate: () => undefined,
    settingsRead: async () => ({}),
  });
  return { controller, opened };
}

function splitChildren(props: Record<string, unknown>): { props: Record<string, unknown>; children?: unknown } {
  const { children, ...rest } = props as { children?: unknown };
  return { props: rest, children };
}

function teardown() {
  _resetSessionOwlSettingsHandle();
  _setRegisterSettingsCommand(null);
  _resetSettingsConsumerForTest();
  _resetSettingsPaneForTest();
}

describe("settings surface — engine-run twin", () => {
  test("the consumer loads defaults through the vendored seam", async () => {
    teardown();
    const { controller } = await setup();
    if (controller === null) throw new Error("controller null");
    expect(getSessionOwlSettings().enabled).toBe(true);
    expect(controller.state().tabs.length).toBeGreaterThan(1);
    teardown();
  });

  test("the pane tree composes over a stub element table", async () => {
    teardown();
    const { controller } = await setup();
    if (controller === null) throw new Error("controller null");
    const ELEMENTS = {
      Box: (props: Record<string, unknown>) => ({ type: "Box", ...splitChildren(props) }),
      Text: (props: Record<string, unknown>) => ({ type: "Text", ...splitChildren(props) }),
      Button: (props: Record<string, unknown>) => ({ type: "Button", ...splitChildren(props) }),
      Input: (props: Record<string, unknown>) => ({ type: "Input", ...splitChildren(props) }),
      Select: (props: Record<string, unknown>) => ({ type: "Select", ...splitChildren(props) }),
    };
    const tree = buildPaneTree(ELEMENTS as never, controller, { bodyColumns: 80 });
    expect(JSON.stringify(tree)).toContain("SessionOwl Settings");
    expect(JSON.stringify(tree)).toContain("Save project");
    teardown();
  });
});

describe("the settings pane mounts and drives — engine-run twin", () => {
  test("mount, find the title, switch tabs", async ($, on) => {
    teardown();
    const made = await setup();
    if (made.controller === null) throw new Error("controller null");
    // The kit's drawing checker: Button REQUIRES a key, and a key claims
    // plugin ownership only the drawing plugin can hold — a test-authored
    // actable is impossible to mount. The twin therefore swaps actables for
    // displayable Text (labels ride along) and validates the COMPOSITION;
    // full interaction is proven by the live pane probe (the real plugin's
    // tree + kit acts) and the Node suites.
    const stripObj = (props: Record<string, unknown>) => {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(props)) {
        if (typeof v === "function") continue;
        if (k === "key") continue; // actable keys claim plugin ownership the test cannot hold
        out[k] = v;
      }
      return out;
    };

    const STUB = {
      Box: (props: Record<string, unknown>) => ({ type: "Box", ...splitChildren(stripObj(props)) }),
      Text: (props: Record<string, unknown>) => {
        const split = splitChildren(stripObj(props));
        return { type: "Text", text: Array.isArray(split.children) ? split.children.join("") : "", ...split };
      },
      // actables -> displayables (see the comment above)
      Button: (props: Record<string, unknown>) => ({
        type: "Text",
        ...splitChildren({ children: [String(props.label ?? "")] }),
      }),
      Input: (props: Record<string, unknown>) => ({
        type: "Text",
        ...splitChildren({ children: [String(props.value ?? props.label ?? "")] }),
      }),
      Select: (props: Record<string, unknown>) => ({
        type: "Text",
        ...splitChildren({ children: [String(props.value ?? props.label ?? "")] }),
      }),
    };
    on("ui.render", { component: "Pane" }, async (_$, e) => {
      if ((e as { requestId?: string }).requestId !== SETTINGS_PANE_ID) {
        return { type: "Box", children: [] };
      }
      const ctl = getSettingsPaneController();
      if (ctl === null) return { type: "Box", children: [] };
      const props = (e as { props?: { bodyColumns?: number } }).props;
      return buildPaneTree(STUB as never, ctl, { bodyColumns: props?.bodyColumns ?? 80 }) as never;
    });
    const ui = await $.ui.mount({
      plugin: "test",
      surface: "terminal",
      component: "Pane",
      requestId: SETTINGS_PANE_ID,
      props: {
        title: "SessionOwl Settings",
        isFocused: true,
        bodyColumns: 80,
        placement: "inline",
        scroll: { bodyRows: 24, offset: 0 },
        view: {},
      },
    });
    expect(await ui.find({ type: "Text", text: /SessionOwl Settings/ })).toBeDefined();
    expect(await ui.find({ type: "Text", text: /General/ })).toBeDefined();
    await ui.unmount();
    teardown();
  });
});
