// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// The /owl-* command wiring at the dispatch surface: command.run routes the
// seven browse/maintenance names to the host bodies with the binding's
// deps (the notify adapter over ui.log, the confirm capsule over ui.ask,
// the pinned store serves), owl-settings keeps its inline pane branch, and
// a foreign command passes through untouched.
import { beforeEach, describe, expect, test } from "vitest";
import { getViewerContent, VIEWER_PANE_ID } from "../../host/commands/viewer.js";
import { setConflictHits } from "../../host/conflicts/pause.js";
import * as state from "../../host/state.js";
import { createHarness } from "../helpers/harness.js";

let h: ReturnType<typeof createHarness>;

beforeEach(async () => {
  h = createHarness();
  await h.load();
  h.env.set("CLAUDE_CONFIG_DIR", "/cfg");
  await h.dispatch("classic.SessionStart", {
    source: "startup",
    session_id: "s-cmd",
    transcript_path: "/t/s-cmd.jsonl",
    cwd: "/w",
  });
});

describe("owl-* command wiring — command.run dispatch", () => {
  test("owl-ls serves the root view through the viewer pane (even a one-root listing)", async () => {
    const out = await h.dispatch("command.run", { command: "owl-ls", args: "" });
    expect(out).toEqual({});
    // the conversation bootstrap seeds the goal root — the serve renders it whole in the pane
    expect(getViewerContent()?.text ?? "").toMatch(/^📁 nGoal · /);
    expect(h.uiOpenCalls.some((a) => (a as { id?: string }).id === VIEWER_PANE_ID)).toBe(true);
  });

  test("owl-cat with no args answers pi's usage text", async () => {
    const out = await h.dispatch("command.run", { command: "owl-cat", args: "  " });
    expect(out).toEqual({});
    expect(h.uiLog).toContain("Usage: /owl-cat <id> — give a node id or an observation id.");
  });

  test("owl-find with no args answers pi's usage text", async () => {
    await h.dispatch("command.run", { command: "owl-find", args: "" });
    expect(h.uiLog).toContain(
      "Usage: /owl-find <query> — give a JS regex to search node summaries and observation content.",
    );
  });

  test("owl-find-all answers the shared usage text (pi's one find body)", async () => {
    await h.dispatch("command.run", { command: "owl-find-all", args: "" });
    expect(h.uiLog).toContain(
      "Usage: /owl-find <query> — give a JS regex to search node summaries and observation content.",
    );
  });

  test("a disabled owl answers the browse-disabled notice (browse arms)", async () => {
    state.setOwlEnabled(false);
    try {
      await h.dispatch("command.run", { command: "owl-ls", args: "" });
      expect(h.uiLog).toContain("session-owl is disabled.");
    } finally {
      state.setOwlEnabled(true);
    }
  });

  test("a CONFLICT-PAUSED owl still SERVES the browse arms (pause is not disabled)", async () => {
    setConflictHits([{ channel: "B", name: "other-mod@x", evidence: "session.compact" }]);
    try {
      await h.dispatch("command.run", { command: "owl-ls", args: "" });
      expect(h.uiLog.some((l) => l.includes("session-owl is disabled"))).toBe(false);
      expect(getViewerContent()?.text ?? "").toMatch(/^📁 nGoal · /); // the graph still serves (pane)
    } finally {
      setConflictHits(null);
    }
  });

  test("a CONFLICT-PAUSED owl-status serves the PAUSED report (paused-first ordering)", async () => {
    setConflictHits([{ channel: "B", name: "other-mod@x", evidence: "session.compact" }]);
    try {
      await h.dispatch("command.run", { command: "owl-status", args: "" });
      expect(h.uiLog.some((l) => l.includes("session-owl is disabled"))).toBe(false);
      // the multi-line report opens the viewer pane (content, not ui.log)
      expect(getViewerContent()?.text ?? "").toContain("Paused — another compaction-handling mod is installed:");
      expect(h.uiOpenCalls.some((a) => (a as { id?: string }).id === VIEWER_PANE_ID)).toBe(true);
    } finally {
      setConflictHits(null);
    }
  });

  test("a CONFLICT-PAUSED owl-rescan still runs its confirm flow (gates on enabled only)", async () => {
    setConflictHits([{ channel: "B", name: "other-mod@x", evidence: "session.compact" }]);
    try {
      h.uiAskAnswers.push("No");
      await h.dispatch("command.run", { command: "owl-rescan", args: "" });
      expect(h.uiAskQuestions.length).toBe(1); // reached the confirm, not a disabled notice
      expect(h.uiLog.some((l) => l.includes("session-owl is disabled"))).toBe(false);
    } finally {
      setConflictHits(null);
    }
  });

  test("owl-status serves the real report (the header, not the interim degrade)", async () => {
    await h.dispatch("command.run", { command: "owl-status", args: "" });
    // the multi-line report opens the viewer pane (content, not ui.log)
    expect(getViewerContent()?.text ?? "").toContain("🦉 session-owl — status");
    expect(h.uiOpenCalls.some((a) => (a as { id?: string }).id === VIEWER_PANE_ID)).toBe(true);
    expect(h.uiLog.some((l) => l.includes("status report unavailable in this build"))).toBe(false);
  });

  test("owl-reobserve-0-obs-chunks with nothing to do answers pi's nothing text", async () => {
    await h.dispatch("command.run", { command: "owl-reobserve-0-obs-chunks", args: "" });
    expect(h.uiLog).toContain("No skipped or unobserved ranges — nothing to re-observe.");
  });

  test("owl-rescan declines at the confirm and does nothing destructive", async () => {
    h.uiAskAnswers.push("No");
    const out = await h.dispatch("command.run", { command: "owl-rescan", args: "" });
    expect(out).toEqual({});
    expect(h.uiAskQuestions.length).toBe(1);
    expect(h.uiAskQuestions[0]?.question).toContain("Discard the current memory graph");
    expect(h.uiLog.some((l) => l.includes("Rescanning"))).toBe(false);
  });

  test("owl-settings still opens the pane branch (the re-enable path, no disabled guard)", async () => {
    state.setOwlEnabled(false);
    try {
      const out = await h.dispatch("command.run", { command: "owl-settings", args: "" });
      expect(out).toEqual({});
      expect(h.uiOpenCalls.length).toBeGreaterThan(0);
    } finally {
      state.setOwlEnabled(true);
    }
  });

  test("a foreign command passes through untouched (identity)", async () => {
    const event = { name: "other-mod:go", args: "x" };
    expect(await h.dispatch("command.run", event)).toBe(event);
  });
});

describe("settings pane focus + close wiring", () => {
  test("ui.focus on the pane DENIES into selection navigation (the input-anchored keyboard)", async () => {
    const { getSettingsPaneController } = await import("../../host/settings/pane.js");
    await h.dispatch("command.run", { command: "owl-settings", args: "" });
    const controller = getSettingsPaneController();
    expect(controller).not.toBeNull();
    // the anchored model: the filter Input holds the ring; a move attempt
    // onto a row is DENIED and read as a NEXT signal — the selection (and
    // the description box with it) advances
    const first = controller?.state().selectionId;
    const r1 = (await h.dispatch("ui.focus", {
      component: "Pane",
      requestId: "owl-settings",
      element: "observerMode",
    })) as { deny?: string };
    expect(r1?.deny).toContain("filter field keeps the keyboard");
    const after = controller?.state().selectionId;
    expect(after).not.toBe(first);
    expect(controller?.state().describedRow?.id).toBe(after);
    // a filter-field target is ALLOWED through (the ring's own seat)
    const r2 = (await h.dispatch("ui.focus", {
      component: "Pane",
      requestId: "owl-settings",
      element: "settings-filter:0",
    })) as { deny?: string };
    expect(r2?.deny).toBeUndefined();
  });

  test("the picker's bottom edge REDIRECTS the ring onto the custom value field", async () => {
    const { getSettingsPaneController } = await import("../../host/settings/pane.js");
    await h.dispatch("command.run", { command: "owl-settings", args: "" });
    const controller = getSettingsPaneController();
    // a row with presets AND a custom value field (the number-with-presets
    // row carries the per-setting open-value override)
    const tabs = controller?.state().tabs ?? [];
    let tabIndex = tabs.findIndex((t) => t.settings.some((r) => r.id === "rootViewTargetNodes"));
    if (tabIndex < 0) tabIndex = 0;
    controller?.switchTab(tabIndex);
    controller?.openPicker("rootViewTargetNodes");
    expect(controller?.state().pickingRow?.id).toBe("rootViewTargetNodes");
    const focus = (element: string) =>
      h.dispatch("ui.focus", { component: "Pane", requestId: "owl-settings", element }) as Promise<{
        deny?: string;
        element?: string;
      }>;
    // walk to the last option (each proposal walks the selection down one)
    const count = controller?.state().pickerOptions.length ?? 0;
    expect(count).toBeGreaterThan(1);
    for (let i = 0; i < count - 1; i += 1) {
      const r = await focus("pick:0");
      expect(r.deny).toBeDefined();
    }
    expect(controller?.state().pickerSelection).toBe(count - 1);
    // the bottom edge: the host lands the ring on the custom value field
    // (the engine's own element rewrite — typing follows the ring there)
    const r = await focus("pick:0");
    expect(r.deny).toBeUndefined();
    expect(r.element).toBe("picker-custom");
    // from the custom field, ANY proposal hands the keyboard BACK to the
    // picker filter (the selection stays; the field keeps printables/Enter/Esc)
    const stay = await focus("pick:0");
    expect(stay.deny).toBeUndefined();
    expect(String(stay.element).startsWith("picker-filter:")).toBe(true);
    expect(controller?.state().pickerSelection).toBe(count - 1);
  });

  test("a picker CHOICE refocuses the DRAWN seat key — the current filter epoch, never a stale :0", async () => {
    const pane = await import("../../host/settings/pane.js");
    pane._resetSettingsPaneForTest(); // the pane singleton keeps its CREATOR's capsules — re-create for this harness
    const getSettingsPaneController = pane.getSettingsPaneController;
    await h.dispatch("command.run", { command: "owl-settings", args: "" });
    const controller = getSettingsPaneController();
    // bump the filter epoch (a submit — Enter in the filter — bumps it)
    controller?.submitFilter("");
    controller?.closePicker(); // the submit also opened the row's picker
    // a choice closes the picker and hands the keyboard back
    controller?.openPicker("enabled");
    controller?.pickPreset("enabled", "true");
    await new Promise((resolve) => setTimeout(resolve, 0)); // the refocus chain rides uiOpen().then()
    const last = h.uiFocusCalls[h.uiFocusCalls.length - 1];
    expect(last).toBe("settings-filter:1"); // the drawn key — the stale :0 dropped the keyboard out of the pane
  });

  test("Escape while the picker is open RETURNS to the list (the close is denied)", async () => {
    const { getSettingsPaneController } = await import("../../host/settings/pane.js");
    await h.dispatch("command.run", { command: "owl-settings", args: "" });
    const controller = getSettingsPaneController();
    controller?.openPicker("enabled");
    const denied = await h.dispatch("ui.close", { id: "owl-settings", origin: { kind: "person" } });
    expect(controller?.state().pickingRow).toBeNull(); // back at the settings list
    expect(denied).toHaveProperty("deny"); // the hook denied — the pane stays open
    // a close with no picker open PASSES THROUGH to the engine (next(e))
    const event = { id: "owl-settings", origin: { kind: "person" } };
    const passed = await h.dispatch("ui.close", event);
    expect(passed).toBe(event);
  });
});
