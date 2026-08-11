// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type {
  PresetElement,
  RegisterSettingsOptions,
  SettingSchema,
  SettingsHandle,
  SettingsSchema,
  SettingsTabSchema,
} from "avtc-pi-settings-ui";
import { registerSettingsCommand, settingsFilePaths } from "avtc-pi-settings-ui";

/** Indirection over registerSettingsCommand so tests can inject a fake WITHOUT
 *  vi.mock(avtc-pi-settings-ui) — under isolate:false a module mock of this dep
 *  races against the many test files that import schema.ts (loading the REAL
 *  module), causing flaky clobbering. The seam keeps the mock local + deterministic. */
let registerFn: typeof registerSettingsCommand = registerSettingsCommand;

/** Test-only: inject a fake registerSettingsCommand (or restore the real one with null). */
export function _setRegisterSettingsCommand(fn: typeof registerSettingsCommand | null): void {
  registerFn = fn ?? registerSettingsCommand;
}

// ---------------------------------------------------------------------------
// MemkeeperConfig — the typed shape returned by getMemkeeperSettings()
// ---------------------------------------------------------------------------

/** The `model` settings resolve to a `provider/id` string, or `null` = fall through to
 *  defaultModel (then the session model). `commandResultCap` / `observerToolBlockCapTokens`
 *  allow `null` = no limit / no truncation (the "No limit" presets). */
export interface MemkeeperConfig {
  // General
  enabled: boolean;
  defaultModel: string | null;
  /** Thinking level for all stages when a stage doesn't override. null = reuse
   *  the session's thinking level (ctx.thinkingLevel). "off" = no thinking. */
  defaultThinkingLevel: string | null;
  renderMode: "selected-root" | "observations-root";
  observerMode: "on-threshold" | "on-compaction";
  builderMode: "on-compaction" | "each-N-observations" | "on-session-context-threshold" | "on-root-view-threshold";
  selectorMode: "on-compaction" | "on-session-context-threshold";
  commandResultCap: number | null;
  /** Find/mk_recall search execution timeout. Runs in a worker thread; a
   *  pattern still running past this is stopped. */
  findTimeoutMs: number;
  /** Per-LLM-call timeout for the Observer/Builder/Selector stages. A single
   *  response (one agentLoop turn) that runs longer is aborted. null = no
   *  limit. Bounds runaway/stalled generation so it can't pin a background run. */
  llmCallTimeoutMs: number | null;
  /** Max estimated tokens (chars/4) in any one cat/find/ls/mk_recall result
   *  text. Overflow pages with afterId (terse list) or stops expansion
   *  (fullDetails/grep); a single-observation target is unbudgeted in any mode.*/
  toolResultTokenBudget: number;
  /** Write debug-level trace logs (trigger decisions, per-stage stream start/end)
   *  to the log file. Off by default — enable to diagnose a stall. */
  debugLog: boolean;
  // Observer
  observerModel: string | null;
  observerThresholdTokens: number;
  observerIncludeThinking: boolean;
  observerToolBlockCapTokens: number | null;
  /** Maximum output tokens per Observer LLM call (per turn). */
  observerMaxTokens: number;
  /** Thinking level for the Observer. null = inherit defaultThinkingLevel. */
  observerThinkingLevel: string | null;
  // Builder
  builderModel: string | null;
  builderEveryNObservations: number;
  builderSessionContextThresholdTokens: number;
  builderRootViewThreshold: number;
  /** Skip the Builder's compaction fast-path: when the root view is already
   *  under builderRootViewThreshold, skip the Builder run entirely. Default
   *  false — the Builder always runs at least one pass. */
  builderSkipWithinBudget: boolean;
  maxBuilderPasses: number;
  /** Maximum output tokens per Builder LLM call (per turn). */
  builderMaxTokens: number;
  /** Thinking level for the Builder. null = inherit defaultThinkingLevel. */
  builderThinkingLevel: string | null;
  // Selector
  selectorModel: string | null;
  selectorSessionContextThresholdTokens: number;
  selectorRootViewThreshold: number;
  maxSelectorPasses: number;
  /** Maximum output tokens per Selector LLM call (per turn). */
  selectorMaxTokens: number;
  /** Thinking level for the Selector. null = inherit defaultThinkingLevel. */
  selectorThinkingLevel: string | null;
}

// ---------------------------------------------------------------------------
// DEFAULT_CONFIG — the canonical defaults. Single source of truth: the schema's
// `defaultValue` fields read FROM this object, so the two can never drift.
// Frozen so the `enabled=false` off-path and tests share one immutable copy.
// ---------------------------------------------------------------------------

const DEFAULT_RENDER_MODE = "selected-root";
const DEFAULT_OBSERVER_MODE = "on-threshold";
const DEFAULT_BUILDER_MODE = "on-compaction";
const DEFAULT_SELECTOR_MODE = "on-compaction";
const NO_MODEL: string | null = null;
const NO_LIMIT: number | null = null;
/** loadSettingsIntoMemory args: `undefined` makes avtc-pi-settings-ui fall back to its
 *  defaults (cwd → process.cwd(); globalDir unchanged) — same convention as the settings-ui
 *  factory's NO_GLOBAL_DIR. */
const RELOAD_USE_DEFAULT_CWD: string | undefined = undefined;
const RELOAD_KEEP_GLOBAL_DIR: string | undefined = undefined;
const DEFAULT_FIND_TIMEOUT_MS = 30_000;
const DEFAULT_LLM_CALL_TIMEOUT_MS = 600_000;
const MIN_LLM_CALL_TIMEOUT_MS = 1000;
const DEFAULT_MAX_TOKENS = 8192;
const MIN_MAX_TOKENS = 1;
const DEFAULT_TOOL_RESULT_TOKEN_BUDGET = 6000;
const MIN_TOOL_RESULT_TOKEN_BUDGET = 512;
const DEFAULT_FAST_PATH = false;
const DEBUG_LOG_DEFAULT = false;

export const DEFAULT_CONFIG: Readonly<MemkeeperConfig> = Object.freeze({
  // General
  enabled: true,
  defaultModel: NO_MODEL,
  defaultThinkingLevel: NO_MODEL,
  renderMode: DEFAULT_RENDER_MODE,
  observerMode: DEFAULT_OBSERVER_MODE,
  builderMode: DEFAULT_BUILDER_MODE,
  selectorMode: DEFAULT_SELECTOR_MODE,
  commandResultCap: 50,
  findTimeoutMs: DEFAULT_FIND_TIMEOUT_MS,
  llmCallTimeoutMs: DEFAULT_LLM_CALL_TIMEOUT_MS,
  toolResultTokenBudget: DEFAULT_TOOL_RESULT_TOKEN_BUDGET,
  debugLog: DEBUG_LOG_DEFAULT,
  // Observer
  observerModel: NO_MODEL,
  observerThresholdTokens: 4000,
  observerIncludeThinking: false,
  observerToolBlockCapTokens: 400,
  observerMaxTokens: DEFAULT_MAX_TOKENS,
  observerThinkingLevel: NO_MODEL,
  // Builder
  builderModel: NO_MODEL,
  builderEveryNObservations: 40,
  builderSessionContextThresholdTokens: 200000,
  builderRootViewThreshold: 40000,
  builderSkipWithinBudget: DEFAULT_FAST_PATH,
  maxBuilderPasses: 3,
  builderMaxTokens: DEFAULT_MAX_TOKENS,
  builderThinkingLevel: NO_MODEL,
  // Selector
  selectorModel: NO_MODEL,
  selectorSessionContextThresholdTokens: 200000,
  selectorRootViewThreshold: 20000,
  maxSelectorPasses: 3,
  selectorMaxTokens: DEFAULT_MAX_TOKENS,
  selectorThinkingLevel: NO_MODEL,
} satisfies MemkeeperConfig);

// ---------------------------------------------------------------------------
// Presets — shared label/value pairs for the enum + ranged knobs.
// ---------------------------------------------------------------------------

const RENDER_MODE_PRESETS: readonly PresetElement[] = [
  ["Selected root", "selected-root"],
  ["Observations root", "observations-root"],
];
const OBSERVER_MODE_PRESETS: readonly PresetElement[] = [
  ["On threshold", "on-threshold"],
  ["On compaction", "on-compaction"],
];
const BUILDER_MODE_PRESETS: readonly PresetElement[] = [
  ["On compaction", "on-compaction"],
  ["Every N observations", "each-N-observations"],
  ["On session context threshold", "on-session-context-threshold"],
  ["On root view threshold", "on-root-view-threshold"],
];
const SELECTOR_MODE_PRESETS: readonly PresetElement[] = [
  ["On compaction", "on-compaction"],
  ["On session context threshold", "on-session-context-threshold"],
];
const COMMAND_RESULT_CAP_PRESETS: readonly PresetElement[] = [10, 25, 50, 100, ["No limit", NO_LIMIT]];
const FIND_TIMEOUT_PRESETS: readonly PresetElement[] = [
  ["10s", 10_000],
  ["30s", 30_000],
  ["1m", 60_000],
  ["2m", 120_000],
  ["5m", 300_000],
];
const LLM_CALL_TIMEOUT_PRESETS: readonly PresetElement[] = [
  ["3m", 180_000],
  ["10m", 600_000],
  ["30m", 1_800_000],
  ["Infinite", NO_LIMIT],
];
const MAX_TOKENS_PRESETS: readonly PresetElement[] = [2048, 4096, 8192, 16384];
const TOOL_RESULT_TOKEN_BUDGET_PRESETS: readonly PresetElement[] = [2000, 4000, 6000, 8000, 12000];
const OBSERVER_THRESHOLD_PRESETS: readonly PresetElement[] = [
  ["1K", 1000],
  ["2K", 2000],
  ["4K", 4000],
  ["8K", 8000],
  ["16K", 16000],
];
const OBSERVER_TOOL_CAP_PRESETS: readonly PresetElement[] = [100, 200, 400, 800, 1600, ["No limit", NO_LIMIT]];
const BUILDER_EVERY_N_PRESETS: readonly PresetElement[] = [10, 20, 40, 80, 160];
const CONTEXT_THRESHOLD_PRESETS: readonly PresetElement[] = [["200K", 200000]];
const ROOT_VIEW_PRESETS: readonly PresetElement[] = [
  ["10K", 10000],
  ["20K", 20000],
  ["40K", 40000],
  ["80K", 80000],
  ["160K", 160000],
];
const MAX_PASSES_PRESETS: readonly PresetElement[] = [1, 3, 5];
// Thinking-level presets. settings-ui's thinking-level type defaults to the six
// levels; these override to prepend a null "inherit" option (null = fall through
// to the next tier, mirroring how a null model setting means "use default"). Each
// entry is a full [label, value] pair — the thinking-level type's parse rejects
// bare-string presets (it does not degrade to identity under an empty-presets ctx
// the way the plain string type does), so pairs (which skip parse validation) are
// required.
const THINKING_LEVEL_SESSION_PRESETS: readonly PresetElement[] = [
  ["Session default", NO_MODEL],
  ["off", "off"],
  ["minimal", "minimal"],
  ["low", "low"],
  ["medium", "medium"],
  ["high", "high"],
  ["xhigh", "xhigh"],
];
const THINKING_LEVEL_INHERIT_PRESETS: readonly PresetElement[] = [
  ["Inherit default", NO_MODEL],
  ["off", "off"],
  ["minimal", "minimal"],
  ["low", "low"],
  ["medium", "medium"],
  ["high", "high"],
  ["xhigh", "xhigh"],
];

// ---------------------------------------------------------------------------
// MEMKEEPER_SCHEMA — the full settings-ui schema (4 tabs).
// settings-ui owns all validation/clamp/normalize; memkeeper does none.
// ---------------------------------------------------------------------------

function setting(id: keyof MemkeeperConfig, over: Omit<SettingSchema, "id">): SettingSchema {
  return { id, ...over };
}

const SETTINGS: readonly SettingSchema[] = [
  // ── General ────────────────────────────────────────────────────────────────
  setting("enabled", {
    label: "Enabled",
    description:
      "Master switch for memkeeper. Off = memkeeper stops capturing memory and stops adding its compaction summary (pi's compaction and other extensions are unaffected).",
    type: "boolean",
    defaultValue: DEFAULT_CONFIG.enabled,
  }),
  setting("defaultModel", {
    label: "Default model",
    description: "One model for all components. Empty = use the current session model.",
    type: "model",
    defaultValue: DEFAULT_CONFIG.defaultModel,
  }),
  setting("defaultThinkingLevel", {
    label: "Default thinking level",
    description:
      "Thinking level for all components. Session default = use the session's thinking level; off = no thinking.",
    type: "thinking-level",
    defaultValue: DEFAULT_CONFIG.defaultThinkingLevel,
    presets: THINKING_LEVEL_SESSION_PRESETS,
  }),
  setting("renderMode", {
    label: "Render mode",
    description:
      "What memkeeper injects after compaction (and what /mk:* recall reads). " +
      "Selected root = a focused, task-relevant view the Selector builds; " +
      "Observations root = the root view of the memory graph.",
    type: "string",
    defaultValue: DEFAULT_CONFIG.renderMode,
    presets: RENDER_MODE_PRESETS,
  }),
  setting("observerMode", {
    label: "Observer mode",
    description:
      "When the Observer captures memory. On threshold = throughout the session, after a turn " +
      "once enough new text accumulates; On compaction = all at once, at compaction time only.",
    type: "string",
    defaultValue: DEFAULT_CONFIG.observerMode,
    presets: OBSERVER_MODE_PRESETS,
  }),
  setting("builderMode", {
    label: "Builder mode",
    description:
      "Builder trigger. On compaction (cheapest); Every N observations; On session context threshold; " +
      "On root view threshold.",
    type: "string",
    defaultValue: DEFAULT_CONFIG.builderMode,
    presets: BUILDER_MODE_PRESETS,
  }),
  setting("selectorMode", {
    label: "Selector mode",
    description:
      "Selector trigger (only when render mode is Selected root). On compaction (default) or " +
      "On session context threshold.",
    type: "string",
    defaultValue: DEFAULT_CONFIG.selectorMode,
    presets: SELECTOR_MODE_PRESETS,
  }),
  setting("commandResultCap", {
    label: "Command result cap",
    description: "Max items a /mk:* command shows before a '... +N more' footer. No limit = show all.",
    type: "number",
    defaultValue: DEFAULT_CONFIG.commandResultCap,
    min: 0,
    presets: COMMAND_RESULT_CAP_PRESETS,
  }),
  setting("findTimeoutMs", {
    label: "Find timeout",
    description: "Max duration a find or mk_recall search may run before it is stopped.",
    type: "duration",
    defaultValue: DEFAULT_CONFIG.findTimeoutMs,
    min: 1000,
    presets: FIND_TIMEOUT_PRESETS,
  }),
  setting("llmCallTimeoutMs", {
    label: "LLM call timeout",
    description: "Aborts any Observer, Builder, or Selector LLM call that runs longer than this. Infinite = no limit.",
    type: "duration",
    defaultValue: DEFAULT_CONFIG.llmCallTimeoutMs,
    min: MIN_LLM_CALL_TIMEOUT_MS,
    presets: LLM_CALL_TIMEOUT_PRESETS,
  }),
  setting("toolResultTokenBudget", {
    label: "Tool result token budget",
    description:
      "Max size (in tokens) of a single cat/find/ls/mk_recall result. A larger result shows fewer items or less detail (each item stays whole); reading one observation in full is never cut off.",
    type: "number",
    defaultValue: DEFAULT_CONFIG.toolResultTokenBudget,
    min: MIN_TOOL_RESULT_TOKEN_BUDGET,
    presets: TOOL_RESULT_TOKEN_BUDGET_PRESETS,
  }),
  setting("debugLog", {
    label: "Debug log",
    description: "Write detailed trace logs to the log file.",
    type: "boolean",
    defaultValue: DEFAULT_CONFIG.debugLog,
  }),

  // ── Observer ───────────────────────────────────────────────────────────────
  setting("observerModel", {
    label: "Observer model",
    description: "Overrides the default model for the Observer.",
    type: "model",
    defaultValue: DEFAULT_CONFIG.observerModel,
  }),
  setting("observerThresholdTokens", {
    label: "Observer threshold tokens",
    description: "On-threshold gate: emit a batch when accumulated unobserved tokens (chars/4) reach this.",
    type: "number",
    defaultValue: DEFAULT_CONFIG.observerThresholdTokens,
    min: 1,
    presets: OBSERVER_THRESHOLD_PRESETS,
  }),
  setting("observerIncludeThinking", {
    label: "Include thinking",
    description: "Include non-redacted thinking blocks in rendered chunks (redacted always skipped).",
    type: "boolean",
    defaultValue: DEFAULT_CONFIG.observerIncludeThinking,
  }),
  setting("observerToolBlockCapTokens", {
    label: "Observer tool block cap tokens",
    description:
      "When capturing tool calls and results, trim each block to this many tokens (keeping the start and end). No limit = keep the whole block.",
    type: "number",
    defaultValue: DEFAULT_CONFIG.observerToolBlockCapTokens,
    min: 0,
    presets: OBSERVER_TOOL_CAP_PRESETS,
  }),
  setting("observerMaxTokens", {
    label: "Observer max tokens",
    description: "Maximum output tokens per Observer LLM call.",
    type: "number",
    defaultValue: DEFAULT_CONFIG.observerMaxTokens,
    min: MIN_MAX_TOKENS,
    presets: MAX_TOKENS_PRESETS,
  }),
  setting("observerThinkingLevel", {
    label: "Observer thinking level",
    description: "Thinking level for the Observer. Inherit default = use Default thinking level; off = no thinking.",
    type: "thinking-level",
    defaultValue: DEFAULT_CONFIG.observerThinkingLevel,
    presets: THINKING_LEVEL_INHERIT_PRESETS,
  }),

  // ── Builder ────────────────────────────────────────────────────────────────
  setting("builderModel", {
    label: "Builder model",
    description: "Overrides the default model for the Builder.",
    type: "model",
    defaultValue: DEFAULT_CONFIG.builderModel,
  }),
  setting("builderEveryNObservations", {
    label: "Builder every N observations",
    description: "N for the Every N observations builder mode.",
    type: "number",
    defaultValue: DEFAULT_CONFIG.builderEveryNObservations,
    min: 1,
    presets: BUILDER_EVERY_N_PRESETS,
  }),
  setting("builderSessionContextThresholdTokens", {
    label: "Builder session context threshold tokens",
    description: "Threshold for the On session context threshold builder mode.",
    type: "number",
    defaultValue: DEFAULT_CONFIG.builderSessionContextThresholdTokens,
    min: 1,
    presets: CONTEXT_THRESHOLD_PRESETS,
  }),
  setting("builderRootViewThreshold", {
    label: "Builder root view threshold",
    description:
      "Target size (in tokens) for the root view of the memory graph. " +
      "Also: the trigger for On root view threshold mode, and the budget builderSkipWithinBudget checks.",
    type: "number",
    defaultValue: DEFAULT_CONFIG.builderRootViewThreshold,
    min: 1,
    presets: ROOT_VIEW_PRESETS,
  }),
  setting("builderSkipWithinBudget", {
    label: "Skip when within budget",
    description:
      "Skip the Builder when the root view is already within budget. Off = the Builder always runs at least once.",
    type: "boolean",
    defaultValue: DEFAULT_CONFIG.builderSkipWithinBudget,
  }),
  setting("maxBuilderPasses", {
    label: "Max builder passes",
    description: "Max passes per Builder run.",
    type: "number",
    defaultValue: DEFAULT_CONFIG.maxBuilderPasses,
    min: 1,
    presets: MAX_PASSES_PRESETS,
  }),
  setting("builderMaxTokens", {
    label: "Builder max tokens",
    description: "Maximum output tokens per Builder LLM call.",
    type: "number",
    defaultValue: DEFAULT_CONFIG.builderMaxTokens,
    min: MIN_MAX_TOKENS,
    presets: MAX_TOKENS_PRESETS,
  }),
  setting("builderThinkingLevel", {
    label: "Builder thinking level",
    description: "Thinking level for the Builder. Inherit default = use Default thinking level; off = no thinking.",
    type: "thinking-level",
    defaultValue: DEFAULT_CONFIG.builderThinkingLevel,
    presets: THINKING_LEVEL_INHERIT_PRESETS,
  }),

  // ── Selector ───────────────────────────────────────────────────────────────
  setting("selectorModel", {
    label: "Selector model",
    description: "Overrides the default model for the Selector.",
    type: "model",
    defaultValue: DEFAULT_CONFIG.selectorModel,
  }),
  setting("selectorSessionContextThresholdTokens", {
    label: "Selector session context threshold tokens",
    description: "Threshold for the On session context threshold selector mode (separate from the Builder's).",
    type: "number",
    defaultValue: DEFAULT_CONFIG.selectorSessionContextThresholdTokens,
    min: 1,
    presets: CONTEXT_THRESHOLD_PRESETS,
  }),
  setting("selectorRootViewThreshold", {
    label: "Selector root view threshold",
    description: "Target size (in tokens) for the root view of the selected tree.",
    type: "number",
    defaultValue: DEFAULT_CONFIG.selectorRootViewThreshold,
    min: 1,
    presets: ROOT_VIEW_PRESETS,
  }),
  setting("maxSelectorPasses", {
    label: "Max selector passes",
    description: "Max passes per Selector run.",
    type: "number",
    defaultValue: DEFAULT_CONFIG.maxSelectorPasses,
    min: 1,
    presets: MAX_PASSES_PRESETS,
  }),
  setting("selectorMaxTokens", {
    label: "Selector max tokens",
    description: "Maximum output tokens per Selector LLM call.",
    type: "number",
    defaultValue: DEFAULT_CONFIG.selectorMaxTokens,
    min: MIN_MAX_TOKENS,
    presets: MAX_TOKENS_PRESETS,
  }),
  setting("selectorThinkingLevel", {
    label: "Selector thinking level",
    description: "Thinking level for the Selector. Inherit default = use Default thinking level; off = no thinking.",
    type: "thinking-level",
    defaultValue: DEFAULT_CONFIG.selectorThinkingLevel,
    presets: THINKING_LEVEL_INHERIT_PRESETS,
  }),
];

const TABS: readonly SettingsTabSchema[] = [
  {
    label: "General",
    settingIds: [
      "enabled",
      "defaultModel",
      "defaultThinkingLevel",
      "renderMode",
      "observerMode",
      "builderMode",
      "selectorMode",
      "commandResultCap",
      "findTimeoutMs",
      "llmCallTimeoutMs",
      "toolResultTokenBudget",
      "debugLog",
    ],
  },
  {
    label: "Observer",
    settingIds: [
      "observerModel",
      "observerThresholdTokens",
      "observerIncludeThinking",
      "observerToolBlockCapTokens",
      "observerMaxTokens",
      "observerThinkingLevel",
    ],
  },
  {
    label: "Builder",
    settingIds: [
      "builderModel",
      "builderEveryNObservations",
      "builderSessionContextThresholdTokens",
      "builderRootViewThreshold",
      "builderSkipWithinBudget",
      "maxBuilderPasses",
      "builderMaxTokens",
      "builderThinkingLevel",
    ],
  },
  {
    label: "Selector",
    settingIds: [
      "selectorModel",
      "selectorSessionContextThresholdTokens",
      "selectorRootViewThreshold",
      "maxSelectorPasses",
      "selectorMaxTokens",
      "selectorThinkingLevel",
    ],
  },
];

const { globalPath, projectPath } = settingsFilePaths("avtc-pi-memkeeper");

export const MEMKEEPER_SCHEMA: SettingsSchema = {
  settings: [...SETTINGS],
  tabs: [...TABS],
  globalPath,
  projectPath,
};

// ---------------------------------------------------------------------------
// Handle ownership + live read
// ---------------------------------------------------------------------------

/** The runtime settings-ui handle carries `loadSettingsIntoMemory` (avtc-pi-settings-ui
 *  factory.ts returns it), but the public `SettingsHandle` type omits it (loading is "internal").
 *  `reloadMemkeeperConfig` needs it, so widen the handle with this structural member. */
type ReloadableSettingsHandle = SettingsHandle<MemkeeperConfig> & {
  loadSettingsIntoMemory(cwd?: string, globalDir?: string): void;
};

let handle: SettingsHandle<MemkeeperConfig> | undefined;

/** Test-only override for the settings read (the repo DI/mock pattern): when set,
 *  getMemkeeperSettings returns this instead of the real handle. Cleared by
 *  _resetGetMemkeeperSettings. */
let _getSettingsOverride: (() => MemkeeperConfig) | null = null;

/** Test-only: inject a mock settings source (pass `null` to restore the real handle). */
export function _setGetMemkeeperSettings(fn: (() => MemkeeperConfig) | null): void {
  _getSettingsOverride = fn;
}

/** Test-only: clear the mock override (restore real-handle reads). */
export function _resetGetMemkeeperSettings(): void {
  _getSettingsOverride = null;
}

/** Test-only: clear BOTH the override AND the module handle (full reset back to the
 *  pre-init state — getMemkeeperSettings returns DEFAULT_CONFIG). Use this in a
 *  file-level afterAll so the handle (set by initMemkeeperSettings) does not
 *  leak across test files under isolate:false. */
export function _resetMemkeeperSettingsHandle(): void {
  _getSettingsOverride = null;
  handle = undefined;
}

const REGISTRATION_OPTIONS: RegisterSettingsOptions = {
  commandName: "mk:settings",
  title: "Memkeeper Settings",
  titleRight: "avtc-pi-memkeeper",
  storageLevels: ["session", "project", "global"],
  envVar: "PI_SETTINGS_MEMKEEPER",
};

/** Register the /mk:settings command + tabbed modal once (from activate); stores the handle. */
export function initMemkeeperSettings(pi: ExtensionAPI): SettingsHandle<MemkeeperConfig> {
  handle = registerFn<MemkeeperConfig>(pi, MEMKEEPER_SCHEMA, REGISTRATION_OPTIONS);
  return handle;
}

/** Live config read — every entry point calls this at trigger time (NOT cached at session start).
 *  Test override takes precedence; otherwise the real handle when initialized, or the frozen
 *  DEFAULT_CONFIG before init (early callers never crash). */
export function getMemkeeperSettings(): MemkeeperConfig {
  if (_getSettingsOverride) return _getSettingsOverride();
  return handle ? handle.getSettings() : DEFAULT_CONFIG;
}

/** Re-read settings from env (PI_SETTINGS_MEMKEEPER) first, then files — refreshes the
 *  in-memory cache. Lets a host (e.g. avtc-pi-bench-compact) reconfigure memkeeper LIVE
 *  without ctx.reload() (which invalidates the command ctx). No-op before initMemkeeperSettings
 *  (handle undefined — nothing to reload). */
export function reloadMemkeeperConfig(): void {
  (handle as ReloadableSettingsHandle | undefined)?.loadSettingsIntoMemory(
    RELOAD_USE_DEFAULT_CWD,
    RELOAD_KEEP_GLOBAL_DIR,
  );
}
