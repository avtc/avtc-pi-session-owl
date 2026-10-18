// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

/**
 * The settings pane — the /owl-settings surface.
 *
 * Composes the Claude library's pane stack (controller + tree builder) over
 * the settings consumer's installed handle: the controller drives the wrapped
 * updateSetting (owl's after-change wiring rides inside it), the tree
 * builder runs against the element table the render hook resolves, and the
 * capsules (open/close/invalidate/log) arrive from the wiring — this module
 * never touches a UI API itself.
 *
 * Degrade paths: a surface without field elements (mobile draws no Input or
 * Select) gets a text-only notice naming the manual-JSON locations instead
 * of a broken tree; a missing settings handle (pane requested before the
 * consumer init) refuses to compose and says so through the log capsule.
 */

import {
  captureCtx,
  createPaneController,
  type PaneController,
  type PresetPair,
} from "../../node_modules/avtc-claude-settings-ui/dist/index.js";
import { errDetail } from "../log/err-detail.js";
import { getInstalledSettingsHandle } from "./consumer.js";

/** The pane's pinned id — the render hook filters on it (e.requestId). */
export const SETTINGS_PANE_ID = "owl-settings";

/** The pane's title (pi's modal frame title, carried over). */
export const SETTINGS_PANE_TITLE = "SessionOwl Settings";

/** The manual-JSON degrade notice (surfaces without field elements). */
export const SETTINGS_PANE_MANUAL_JSON =
  "session-owl settings need a terminal surface — edit ~/.claude/avtc-session-owl-settings.json (global) or <project>/.claude/avtc-session-owl-settings.json instead.";

/** The not-initialized degrade notice. */
export const SETTINGS_PANE_NOT_READY = "session-owl settings are not loaded yet — try again in a moment.";

/** The capsules the pane needs (authored in register.ts handlers, data here). */
export interface PaneCapsules {
  uiLog: (text: string) => void;
  uiOpen: (args: {
    id: string;
    title: string;
    focus: boolean;
    closeOnEscape: boolean;
    rows: number;
  }) => Promise<unknown>;
  uiClose: () => void;
  uiInvalidate: () => void;
  /** Places the pane's focus ring on an element (the picker return). */
  uiFocus?: (key: string) => Promise<unknown>;
  /** The engine's settings snapshot ($.settings.read) — the model-row
   *  enrichment reads the user's availableModels from it at pane open. */
  settingsRead: () => Promise<unknown>;
}

/** The model presets every open offers (beside Default): the alias values a
 *  stage spawn accepts verbatim — the enrichment rows append after them. */
const CORE_MODEL_PAIRS: PresetPair[] = [
  ["haiku", "haiku"],
  ["sonnet", "sonnet"],
  ["opus", "opus"],
  ["fable", "fable"],
];

/** Model values the engine reserves that are NOT stage-spawnable ids — an
 *  availableModels entry only ever becomes a picker row when it names
 *  something a spawn could actually run (aliases are already core rows). */
const RESERVED_MODEL_VALUES = new Set([
  "haiku",
  "sonnet",
  "opus",
  "fable",
  "sonnet[1m]",
  "opus[1m]",
  "default",
  "best",
  "opusplan",
]);

/** Rows for the user's own models: each availableModels entry appended as a
 *  `[label, value]` pair — the value verbatim (an id the spawn accepts; the
 *  `provider/<id>` serialization the model-preset path would produce is NOT a
 *  spawnable form here), labeled from modelPicker when the user named the row.
 *  Never throws: anything malformed (non-array, non-string, bad options)
 *  collapses to zero rows, so an odd settings shape degrades to the core
 *  aliases. */
function enrichmentModelPairs(settings: unknown): PresetPair[] {
  if (settings === null || typeof settings !== "object") return [];
  const root = settings as Record<string, unknown>;
  const raw = root.availableModels;
  if (!Array.isArray(raw)) return [];
  const labels = new Map<string, string>();
  const picker = root.modelPicker;
  if (picker !== null && typeof picker === "object") {
    const options = (picker as Record<string, unknown>).options;
    if (Array.isArray(options)) {
      for (const option of options) {
        if (option === null || typeof option !== "object") continue;
        const model = (option as Record<string, unknown>).model;
        const label = (option as Record<string, unknown>).label;
        if (typeof model === "string" && typeof label === "string" && label.length > 0) {
          labels.set(model, label);
        }
      }
    }
  }
  const pairs: PresetPair[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    if (typeof entry !== "string") continue;
    const value = entry.trim();
    if (value.length === 0 || seen.has(value)) continue;
    if (RESERVED_MODEL_VALUES.has(value.toLowerCase())) continue;
    seen.add(value);
    pairs.push([labels.get(value) ?? value, value]);
  }
  return pairs;
}

let paneController: PaneController | null = null;

/** Build (once) and open the settings pane. Returns the controller the render
 *  hook reads, or null when the consumer has not initialized (logged). */
export async function ensureSettingsPane(capsules: PaneCapsules): Promise<PaneController | null> {
  const handle = getInstalledSettingsHandle();
  if (handle === null) {
    capsules.uiLog(SETTINGS_PANE_NOT_READY);
    return null;
  }
  if (paneController === null) {
    paneController = createPaneController(handle as never, {
      title: SETTINGS_PANE_TITLE,
      notify: { message: (text) => capsules.uiLog(text), warn: (text) => capsules.uiLog(text) },
      storageLevels: handle.storageLevels,
      cwd: currentCwd,
      onClose: () => capsules.uiClose(),
      onInvalidate: () => capsules.uiInvalidate(),
      onPickerClosed: (rowId) => {
        // pi returns to the item it was changing: re-take the keyboard (Esc
        // handed it back) and put the ring back. In the input-anchored
        // model the ring returns to the FILTER field — its DRAWN key (the
        // current epoch; a stale epoch is never drawn again and the focus
        // wait dies, dropping the keyboard out of the pane); the
        // controller's selection already sits on the edited row.
        const anchored = paneController !== null && paneController.anchorFocusAttempt !== undefined;
        const target = anchored
          ? ((paneController as unknown as { anchorSeatKey?: () => string }).anchorSeatKey?.() ?? "settings-filter:0")
          : rowId;
        void capsules
          .uiOpen({
            id: SETTINGS_PANE_ID,
            title: SETTINGS_PANE_TITLE,
            focus: true,
            closeOnEscape: true,
            rows: 28,
          })
          .then(() => capsules.uiFocus?.(target))
          .catch((err: unknown) => {
            // the pane did not open — say why (the user clicked and sees
            // nothing otherwise)
            capsules.uiLog(`session-owl: settings pane failed to open: ${errDetail(err)}`);
          });
      },
    });
    // The models context for the model-type presets: the platform exposes
    // no model-list API, so the picker offers the engine's DOCUMENTED
    // aliases (the $.model.complete docs' own examples plus fable — the
    // spawn validator's accepted set) as static pairs — plus, appended after
    // them, the user's own availableModels entries (label from modelPicker
    // when the user named one; the read's failure path adds nothing). Full
    // ids and gateway models therefore become real rows, the value staying
    // round-trippable through the files.
    let enrichment: PresetPair[] = [];
    try {
      enrichment = enrichmentModelPairs(await capsules.settingsRead());
    } catch (err) {
      // an unreadable settings snapshot never blocks the pane — but the
      // read failure is still said
      capsules.uiLog(`session-owl: settings pane model enrichment failed: ${errDetail(err)}`);
    }
    captureCtx({
      models: [],
      enabledModelPatterns: null,
      staticModelPairs: [...CORE_MODEL_PAIRS, ...enrichment],
      cwd: currentCwd,
    });
    await paneController.prepare();
  }
  await capsules.uiOpen({
    id: SETTINGS_PANE_ID,
    title: SETTINGS_PANE_TITLE,
    focus: true,
    closeOnEscape: true,
    rows: 28,
  });
  return paneController;
}

/** The cwd the pane's project saves target (set by the consumer init). */
let currentCwd = "";

/** Record the session cwd (called by the settings consumer init). */
export function setPaneCwd(cwd: string): void {
  currentCwd = cwd;
}

/** The controller for the render hook (null before the first open). */
export function getSettingsPaneController(): PaneController | null {
  return paneController;
}

/** The text-only tree for surfaces without field elements (mobile). */
export function manualJsonNoticeTree(els: { Text: (props: Record<string, unknown>) => unknown }): unknown {
  return els.Text({ key: "owl-settings-degrade", children: SETTINGS_PANE_MANUAL_JSON });
}

/** Test seam: full reset. */
export function _resetSettingsPaneForTest(): void {
  paneController = null;
  currentCwd = "";
}
