// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import { describe, expect, test } from "vitest";
import { type KeybindingsIo, mergePaneKeybindings, PANE_KEYBINDING_CONTEXTS } from "../../host/keys/pane-bindings.js";

function makeIo(existing = "") {
  const writes: string[] = [];
  const logs: string[] = [];
  const io: KeybindingsIo = {
    readTextFile: async () => existing,
    writeTextFile: async (_path, text) => {
      writes.push(text);
    },
    log: (message) => logs.push(message),
  };
  return { io, writes, logs, setExisting: (text: string) => (existing = text) };
}

describe("the shipped pane keybindings merge", () => {
  test("creates the file with both context blocks when absent", async () => {
    const h = makeIo("");
    await mergePaneKeybindings(h.io, "/cfg");
    expect(h.writes.length).toBe(1);
    const parsed = JSON.parse(h.writes[0] ?? "");
    const contexts = (parsed.bindings as Array<{ context: string }>).map((b) => b.context).sort();
    expect(contexts).toEqual(["Pane", "PaneField"]);
    const pane = (parsed.bindings as Array<{ context: string; bindings: Record<string, string> }>).find(
      (b) => b.context === "Pane",
    );
    expect(pane?.bindings).toEqual(PANE_KEYBINDING_CONTEXTS.Pane);
  });

  test("merges only-if-absent: the person's own tab binding wins, the rest install", async () => {
    const existing = JSON.stringify({
      bindings: [{ context: "Pane", bindings: { tab: "app:exit" } }],
    });
    const h = makeIo(existing);
    await mergePaneKeybindings(h.io, "/cfg");
    expect(h.writes.length).toBe(1);
    const parsed = JSON.parse(h.writes[0] ?? "");
    const pane = (parsed.bindings as Array<{ context: string; bindings: Record<string, string> }>).find(
      (b) => b.context === "Pane",
    );
    expect(pane?.bindings.tab).toBe("app:exit"); // theirs, untouched
    expect(pane?.bindings["shift+tab"]).toBeUndefined(); // not installed
    expect(pane?.bindings["ctrl+s"]).toBe("chat:stash");
  });

  test("retires our dead keys, upgrades our stale tokens; a foreign binding still wins", async () => {
    const stale = JSON.stringify({
      bindings: [
        {
          context: "Pane",
          bindings: {
            tab: "chat:newline", // our retired key — deleted
            "shift+tab": "tabs:previous", // our retired key — deleted
            "ctrl+s": "chat:stash", // current — kept
            "ctrl+left": "app:diffFileListUp", // our stale token — upgraded
          },
        },
        { context: "PaneField", bindings: { "ctrl+shift+s": "chat:clearInput" } },
      ],
    });
    const h = makeIo(stale);
    await mergePaneKeybindings(h.io, "/cfg");
    expect(h.writes.length).toBe(1);
    const parsed = JSON.parse(h.writes[0] ?? "");
    const pane = (parsed.bindings as Array<{ context: string; bindings: Record<string, string> }>).find(
      (b) => b.context === "Pane",
    );
    expect(pane?.bindings.tab).toBeUndefined(); // retired: bare keys never dispatch
    expect(pane?.bindings["shift+tab"]).toBeUndefined();
    expect(pane?.bindings["ctrl+s"]).toBe("chat:stash");
    expect(pane?.bindings["ctrl+left"]).toBe("chat:undo"); // stale token upgraded
    expect(pane?.bindings["ctrl+right"]).toBe("chat:newline");
    const field = (parsed.bindings as Array<{ context: string; bindings: Record<string, string> }>).find(
      (b) => b.context === "PaneField",
    );
    expect(field?.bindings["ctrl+shift+s"]).toBeUndefined(); // retired here too
    // the trace names what happened
    expect(h.logs.some((l) => l.includes("retired Pane:tab"))).toBe(true);
    expect(h.logs.some((l) => l.includes("upgraded Pane:ctrl+left"))).toBe(true);
  });

  test("writes nothing when everything is already installed", async () => {
    const installed = JSON.stringify({
      bindings: [
        { context: "Pane", bindings: { ...PANE_KEYBINDING_CONTEXTS.Pane } },
        { context: "PaneField", bindings: { ...PANE_KEYBINDING_CONTEXTS.PaneField } },
      ],
    });
    const h = makeIo(installed);
    await mergePaneKeybindings(h.io, "/cfg");
    expect(h.writes.length).toBe(0);
    expect(h.logs.some((l) => l.includes("current (no changes)"))).toBe(true);
  });

  test("a malformed file is left alone and logged", async () => {
    const h = makeIo("{ not json");
    await mergePaneKeybindings(h.io, "/cfg");
    expect(h.writes.length).toBe(0);
    expect(h.logs.some((l) => l.includes("not valid JSON"))).toBe(true);
  });

  test("other blocks and keys survive the merge", async () => {
    const existing = JSON.stringify({
      $schema: "https://example.com/x",
      bindings: [{ context: "Chat", bindings: { "ctrl+e": "chat:externalEditor" } }],
    });
    const h = makeIo(existing);
    await mergePaneKeybindings(h.io, "/cfg");
    const parsed = JSON.parse(h.writes[0] ?? "");
    expect(parsed.$schema).toBe("https://example.com/x");
    const chat = (parsed.bindings as Array<{ context: string; bindings: Record<string, string> }>).find(
      (b) => b.context === "Chat",
    );
    expect(chat?.bindings["ctrl+e"]).toBe("chat:externalEditor");
  });
});
