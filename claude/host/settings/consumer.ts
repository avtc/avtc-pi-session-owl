// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

/**
 * The settings consumer — the wiring that feeds the vendored core's settings
 * seam from the Claude library.
 *
 * The vendored core keeps its own settings entry points (getSessionOwlSettings
 * / reloadSessionOwlConfig / initSessionOwlSettings) byte-identical to the pi
 * source; they run against whatever `registerSettingsCommand` the host
 * installs through the module's own seam (_setRegisterSettingsCommand). This
 * module installs THAT: a Claude-shaped factory that ignores the pi host
 * argument, builds the library handle over injected fs/env surfaces, loads
 * it, and returns it wrapped so every value change also fires owl's
 * after-change wiring (the live enable gate + the recall registration + the
 * band repaint) — pi's modal onChange, hosted.
 *
 * Consumer identity (the naming decision): name `avtc-session-owl`, env var
 * `CLAUDE_SETTINGS_SESSION_OWL`, global `<configDir>/avtc-session-owl-settings.json`,
 * project `<cwd>/.claude/avtc-session-owl-settings.json`.
 */

import {
  _setRegisterSettingsCommand,
  getSessionOwlSettings,
  initSessionOwlSettings,
  SESSION_OWL_SCHEMA,
  type SessionOwlConfig,
} from "../../core/src/config/schema.js";
import { log } from "../../core/src/log.js";
import type { FsAdapter, StorageLevel } from "../../node_modules/avtc-claude-settings-ui/dist/index.js";
import {
  createSettingsExtension,
  type EnvStore,
  settingsFilePaths,
} from "../../node_modules/avtc-claude-settings-ui/dist/index.js";
import { getConflictHits, isConflictPaused } from "../conflicts/pause.js";
import { errDetail, guarded, sayError } from "../log/err-detail.js";
import { registerOwlRecallIfNewlyEnabled } from "../recall/register.js";
import { setOwlEnabled, setOwlIgnoreConflicts, setOwlSubagentMode } from "../state.js";
import { setPaneCwd } from "./pane.js";
import { withPortDefaults, withPortFields } from "./port-fields.js";

/** The consumer identity (the naming decision: runtime name, session env var). */
export const OWL_CONSUMER_NAME = "avtc-session-owl";
export const OWL_SETTINGS_ENV_VAR = "CLAUDE_SETTINGS_SESSION_OWL";

/** The owl schema under the Claude path conventions (the pi-named paths of the
 *  vendored SESSION_OWL_SCHEMA belong to its dead-on-this-platform modal
 *  registration; every live read/write goes through this schema). Two
 *  shared knobs ship with port defaults (withPortDefaults): the Default-model
 *  knob `haiku` and the Default-thinking-level knob `high`. */
export const OWL_CLAUDE_SCHEMA = withPortDefaults(
  withPortFields({
    ...SESSION_OWL_SCHEMA,
    ...settingsFilePaths(OWL_CONSUMER_NAME),
  }),
);

/** The port's effective defaults — every composite row's defaultValue. This
 * is the pre-init settings fallback (bind.ts): the window before the consumer
 * installs resolves through the SAME defaults the installed handle
 * normalizes absent keys to (haiku background model and the port field
 * defaults included), so there is no second place for them to drift. */
export const PORT_DEFAULTS_CONFIG: SessionOwlConfig = Object.fromEntries(
  OWL_CLAUDE_SCHEMA.settings.map((s) => [s.id, s.defaultValue]),
) as unknown as SessionOwlConfig;

/** The capsules the consumer needs from the wiring (scanner-safe: authored in
 *  the register.ts handlers, passed here as data). `appendTimeline` (optional)
 *  receives the conflict-timeline transitions the settings flips imply. */
export interface SettingsCapsules {
  toolRegister: (spec: unknown) => Promise<unknown>;
  uiInvalidate: () => void;
  /** Clears a pinned status line (the fallback surfaces' widget) — the
   *  disable transition must withdraw it, not just the band. */
  uiStatus?: (text: string | undefined) => void;
  appendTimeline?: (t: "enable" | "disable" | "pause" | "resume") => void;
}

/** What initSettingsConsumer takes. */
export interface SettingsConsumerInit {
  configDir: string;
  cwd: string;
  fs: FsAdapter;
  env: EnvStore;
  capsules: SettingsCapsules;
}

/** The wrapped handle the consumer returns (the pane consumes it too). */
export interface OwlSettingsHandle {
  getSettings(): SessionOwlConfig;
  updateSetting(key: string, value: unknown, opts?: { level?: StorageLevel }): void;
  storageLevels: StorageLevel[];
  persistToProject(cwd?: string): Promise<void>;
  persistToGlobal(): Promise<void>;
  /** The schema the pane's tab groups build from (OWL_CLAUDE_SCHEMA). */
  schema: typeof OWL_CLAUDE_SCHEMA;
}

/** pi's after-change wiring, hosted: live gate sync, recall registration on
 *  enable flips, band repaint. Fired by every wrapped updateSetting. */
function fireAfterChange(id: string, value: unknown, capsules: SettingsCapsules): void {
  if (id === "enabled" && typeof value === "boolean") {
    setOwlEnabled(value);
    if (!value) {
      // the widget withdraws on disable: the band passes through and a
      // pinned status line (the fallback surfaces) is cleared
      capsules.uiStatus?.(undefined);
    }
    if (value) {
      void registerOwlRecallIfNewlyEnabled(async (spec) => capsules.toolRegister(spec)).catch((err: unknown) => {
        // the once-flag stays unset on failure (retryable); the rejection
        // itself must never become unhandled — said through the one error
        // transport (file log + user-visible ui.log, console last)
        sayError(`session-owl: mid-session owl_recall registration failed: ${errDetail(err)}`);
      });
    }
    // the timeline anchor: enable/disable transitions feed Channel C's
    // owl-active windows (idempotent appends — a redundant same-direction
    // transition is interval-neutral)
    capsules.appendTimeline?.(value ? "enable" : "disable");
    if (value) mirrorPauseIntoTimeline(capsules);
  }
  // The conflict pause reads this live: a mid-session flip recomputes the
  // pause at the next hook call and repaints the band.
  if (id === "ignoreConflicts" && typeof value === "boolean") {
    setOwlIgnoreConflicts(value);
    mirrorPauseIntoTimeline(capsules);
  }
  // The subagent gates (capture + compaction) read this live: a mid-session
  // flip re-routes the next subagent loop without a restart.
  if (id === "subagentMode" && (value === "inherited" || value === "disabled" || value === "on-compaction")) {
    setOwlSubagentMode(value);
  }
  capsules.uiInvalidate();
}

/** Mirror the effective pause predicate into the timeline after a settings
 *  flip: pause while paused, resume when a pause lifts (with no hits the
 *  predicate was never paused — nothing to record). */
function mirrorPauseIntoTimeline(capsules: SettingsCapsules): void {
  if (capsules.appendTimeline === undefined) return;
  const hits = getConflictHits();
  if (hits === null || hits.length === 0) return; // never paused — no transition
  const paused = isConflictPaused(() => ({
    enabled: getSessionOwlSettings().enabled,
    ignoreConflicts: getSessionOwlSettings().ignoreConflicts,
  }));
  capsules.appendTimeline(paused ? "pause" : "resume");
}

let installedHandle: OwlSettingsHandle | null = null;

/** The Claude-shaped registerSettingsCommand installed into the vendored seam.
 *  The pi host argument is opaque here (never touched); the schema argument is
 *  the vendored SESSION_OWL_SCHEMA — the handle builds from OWL_CLAUDE_SCHEMA
 *  (same settings, Claude paths). */
function claudeRegisterSettingsCommand(
  _pi: unknown,
  _schema: unknown,
  options: { onAfterChange?: (id: string, newValue: unknown) => void } | undefined,
): OwlSettingsHandle {
  const init = consumerInit;
  if (init === null) throw new Error("settings consumer: initSettingsConsumer must run before registration");
  const lib = createSettingsExtension<Record<string, unknown>>(OWL_CLAUDE_SCHEMA, {
    fs: init.fs,
    env: init.env,
    envVar: OWL_SETTINGS_ENV_VAR,
  });
  const afterChange = options?.onAfterChange;
  const wrapped: OwlSettingsHandle = {
    getSettings: () => lib.getSettings() as unknown as SessionOwlConfig,
    updateSetting(key, value, opts) {
      lib.updateSetting(key, value, opts);
      fireAfterChange(key, lib.getSettings()[key], init.capsules);
      afterChange?.(key, value);
    },
    storageLevels: lib.storageLevels,
    persistToProject: (cwd?: string) => lib.persistToProject(cwd ?? init.cwd),
    persistToGlobal: () => lib.persistToGlobal(),
    schema: OWL_CLAUDE_SCHEMA as unknown as typeof OWL_CLAUDE_SCHEMA,
  };
  // The reload alias the vendored reloadSessionOwlConfig calls (sync-shaped on
  // pi; here the async load fires and lands best-effort — readers re-query
  // getSessionOwlSettings and see the fresh values once it settles).
  (wrapped as OwlSettingsHandle & { loadSettingsIntoMemory?: () => void }).loadSettingsIntoMemory = () => {
    guarded(lib.load(consumerInit?.cwd, consumerInit?.configDir), "settings reload");
  };
  libHandle = lib;
  return wrapped;
}

/** The raw library handle (the pane's controller consumes it). */
let libHandle: ReturnType<typeof createSettingsExtension<Record<string, unknown>>> | null = null;

/** The pending init (set by initSettingsConsumer; read by the registerFn). */
let consumerInit: SettingsConsumerInit | null = null;

/** Wire the settings system: install the registerFn, run the vendored
 *  registration (which loads the ladder), and sync the live enable gate. */
/** Resolved-knob diagnostics: which cwd layered the files and what the
 *  effective gates are — the live evidence when a start pulse arrives
 *  WITHOUT its cwd (the project layer then cannot resolve and defaults win).
 *  Never throws (a hook-top throw would kill the whole handler). */
function logSettingsLoad(kind: "first-load" | "reload", cwd: string): void {
  try {
    const s = getSessionOwlSettings();
    log.info(
      `settings: ${kind} cwd=${JSON.stringify(cwd)} enabled=${String(s.enabled)} observerThresholdTokens=${String(
        s.observerThresholdTokens,
      )} builderEveryNObservations=${String(s.builderEveryNObservations)}`,
    );
  } catch (err) {
    // diagnostics never throw — but the logger itself failing is still
    // said: sayError retries both transports, console only when both refuse
    try {
      sayError(`session-owl: settings-load diagnostics failed: ${errDetail(err)}`);
    } catch {
      // nothing exists to say it with
    }
  }
}

export async function initSettingsConsumer(init: SettingsConsumerInit): Promise<OwlSettingsHandle> {
  if (installedHandle !== null && libHandle !== null) {
    // Already initialized (a resume/clear re-start): reload the files into
    // the EXISTING handles — a rebuilt handle would orphan the settings
    // pane's controller (built once over the first handle) and split the
    // in-memory buffer reads.
    consumerInit = init;
    await libHandle.load(init.cwd, init.configDir);
    setOwlEnabled(getSessionOwlSettings().enabled);
    setOwlIgnoreConflicts(getSessionOwlSettings().ignoreConflicts);
    setOwlSubagentMode(getSessionOwlSettings().subagentMode);
    setPaneCwd(init.cwd);
    logSettingsLoad("reload", init.cwd);
    return installedHandle;
  }
  consumerInit = init;
  _setRegisterSettingsCommand(claudeRegisterSettingsCommand as never);
  const handle = initSessionOwlSettings(null as never, null);
  installedHandle = handle as unknown as OwlSettingsHandle;
  // The vendored registration is sync-shaped; the library load is async — run
  // it to completion here so the first getSessionOwlSettings reads real data.
  if (libHandle !== null) await libHandle.load(init.cwd, init.configDir);
  setOwlEnabled(getSessionOwlSettings().enabled);
  setOwlIgnoreConflicts(getSessionOwlSettings().ignoreConflicts);
  setOwlSubagentMode(getSessionOwlSettings().subagentMode);
  setPaneCwd(init.cwd);
  logSettingsLoad("first-load", init.cwd);
  return installedHandle;
}

/** The installed wrapped handle (the pane + tests; null before init). */
export function getInstalledSettingsHandle(): OwlSettingsHandle | null {
  return installedHandle;
}

/** The library handle (the pane controller's data source; null before init). */
export function getLibSettingsHandle(): ReturnType<typeof createSettingsExtension<Record<string, unknown>>> | null {
  return libHandle;
}

/** Test seam: full reset (the vendored seams reset separately by the suite). */
export function _resetSettingsConsumerForTest(): void {
  consumerInit = null;
  installedHandle = null;
  libHandle = null;
}
