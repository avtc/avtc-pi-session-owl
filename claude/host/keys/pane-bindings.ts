// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import { errDetail } from "../log/err-detail.js";

/** The shipped pane keybindings: the settings pane's pi-parity keys.
 *
 * The engine gives mods no key events — a pane's keyboard is the focus
 * walk (Tab/arrows as next/previous proposals) plus one-digit hotkeys,
 * and pi's settings model needs Tab/Shift+Tab to switch pages and
 * Ctrl+S / Ctrl+Shift+S to save. The route is the engine's own
 * keybinding actions: a `Pane`/`PaneField`-context entry binds the key
 * to a registered action, and the pane draws the Button that receives
 * it (the legend row's ‹ › glyphs for tabs:next/tabs:previous; the save
 * buttons for the save chords).
 *
 * The merge is ONLY-IF-ABSENT: a key the person already bound (in the
 * file, in the Pane or PaneField context) is never touched — their
 * binding wins and ours is simply not installed. The file is written
 * only when something was added; a second session over an installed
 * file writes nothing. A malformed file is left alone and logged.
 */

/** The keys the pane installs, per context (both are active while a
 *  mod's pane holds the keyboard; PaneField is the more specific one
 *  that applies while one of the pane's fields has focus). */
/** The chord → action tokens. An action dispatch reaches a pane's button
 *  only when NO engine handler for that action is mounted: Chat-context
 *  operation qualifies while a pane holds the keyboard (its handler
 *  lives at the composer): chat:stash qualifies; app-level toggles
 *  (modelPicker, fastMode, thinkingToggle) and tabs:* were consumed by
 *  always-mounted engine handlers and never arrived. The keys are bound
 *  in Pane/PaneField contexts only, so the tokens never fire at the
 *  prompt and their real meanings are never triggered. */
const CHORDS = {
  "ctrl+left": "chat:undo",
  "ctrl+right": "chat:newline",
  "ctrl+s": "chat:stash",
  "ctrl+g": "chat:clearInput",
};

/** Tokens earlier builds shipped, per key — an entry holding one is OUR
 *  stale install and is upgraded to the current token. Any other value
 *  is the person's own binding and always wins. */
const OBSOLETE_TOKENS: Record<string, readonly string[]> = {
  "ctrl+s": [],
  "ctrl+g": [],
  "ctrl+left": ["app:diffFileListUp"],
  "ctrl+right": ["app:diffFileListDown"],
};

/** Keys earlier builds shipped and no longer install — an entry holding
 *  one of OUR tokens is removed: ctrl+shift+s is indistinguishable
 *  without the Kitty keyboard protocol (the chord never matched); the
 *  bare Tab/Shift+Tab never dispatch to an action button (no dispatch
 *  fires at all while the walk is suppressed). Any other
 *  value is the person's own and stays. */
const RETIRED_KEYS: Record<string, readonly string[]> = {
  "ctrl+shift+s": ["app:toggleReplTab", "chat:thinkingToggle", "chat:clearInput", "chat:newline"],
  tab: ["tabs:next", "chat:modelPicker", "chat:newline"],
  "shift+tab": ["tabs:previous", "chat:fastMode", "chat:undo"],
};

export const PANE_KEYBINDING_CONTEXTS: Record<string, Record<string, string>> = {
  Pane: CHORDS,
  PaneField: CHORDS,
};

/** The file-IO capsules the merge runs on (data only — never `$`). */
export interface KeybindingsIo {
  readTextFile: (path: string) => Promise<string>;
  writeTextFile: (path: string, text: string) => Promise<void>;
  log: (message: string) => void;
}

/** Merge the pane's shipped keys into `<configDir>/keybindings.json`.
 *  Never throws — a failure logs and the session continues without the
 *  chords (the pane's arrow navigation never depended on them). */
export async function mergePaneKeybindings(io: KeybindingsIo, configDir: string): Promise<void> {
  const path = `${configDir}/keybindings.json`;
  let raw: string;
  try {
    raw = await io.readTextFile(path);
  } catch (err) {
    // absent file = the fresh case (a new one is written below); any other
    // read failure is still said
    io.log(`keybindings.json read failed (shipping fresh defaults): ${errDetail(err)}`);
    raw = "";
  }
  let cfg: unknown;
  if (raw.trim() !== "") {
    try {
      cfg = JSON.parse(raw);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      io.log(`keybindings.json is not valid JSON — the pane's shipped keys were not installed: ${message}`);
      return;
    }
  }
  if (cfg === undefined || cfg === null || typeof cfg !== "object" || Array.isArray(cfg)) {
    cfg = {};
  }
  const root = cfg as { bindings?: unknown };
  if (!Array.isArray(root.bindings)) root.bindings = [];
  const blocks = root.bindings as Record<string, unknown>[];

  const trace: string[] = [];
  let changed = false;
  for (const block of blocks) {
    const map = (block.bindings ?? {}) as Record<string, unknown>;
    for (const [key, ours] of Object.entries(RETIRED_KEYS)) {
      if (map[key] !== undefined && ours.includes(String(map[key]))) {
        delete map[key]; // our retired install — restore the key's default
        trace.push(`retired ${String(block.context)}:${key} (${String(map[key])})`);
        changed = true;
      }
    }
  }
  for (const [context, keys] of Object.entries(PANE_KEYBINDING_CONTEXTS)) {
    let block = blocks.find((b) => b !== null && typeof b === "object" && b.context === context);
    if (block === undefined) {
      block = { context, bindings: {} };
      blocks.push(block);
    }
    const map = (block.bindings ?? {}) as Record<string, unknown>;
    if (block.bindings === undefined) block.bindings = map;
    for (const [key, action] of Object.entries(keys)) {
      const existing = map[key];
      if (existing === undefined) {
        map[key] = action; // only-if-absent — the person's own binding wins
        trace.push(`added ${context}:${key} -> ${action}`);
        changed = true;
      } else if ((OBSOLETE_TOKENS[key] ?? []).includes(String(existing))) {
        map[key] = action; // our own stale token — upgrade in place
        trace.push(`upgraded ${context}:${key} ${String(existing)} -> ${action}`);
        changed = true;
      } else if (existing !== action) {
        trace.push(`kept ${context}:${key} (the person's own: ${String(existing)})`);
      }
    }
  }

  if (changed) {
    await io.writeTextFile(path, `${JSON.stringify(root, null, 2)}\n`);
    io.log(`keybindings ${path}: ${trace.join("; ")}`);
  } else {
    io.log(`keybindings ${path}: current (no changes)`);
  }
}
