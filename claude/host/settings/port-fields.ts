// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// The port-only settings overlay. Two settings have no pi counterpart and
// therefore no slot in the vendored schema (kept byte-identical to pi's):
//
//   keepRecentTokens    — the platform's compaction contract hands the whole
//                         message list to the plugin (pi's engine builds the
//                         kept tail itself), so the port owns the tail budget;
//
//   mirrorRetentionDays — the Claude-side mirrors/ledgers have no pi cleanup
//                         pass; null keeps them forever (the pi-parity
//                         default), a number opts the startup sweep in.
//
//   keptTailAggregatedThinking — the platform's compact answer carries no
//                         thinking field, so the kept tail would lose every
//                         thinking block; false (default) ships the summary
//                         without the attributed-reasoning section — enabling
//                         folds them into the '# Memory' summary row (the
//                         engine serves user rows — a trailing assistant row
//                         persists as model="<synthetic>" and never reaches
//                         the model);
//
//   injectedSummaryRow — echo the injected summary (tree + the attributed
//                         section when enabled) as ONE visible assistant row
//                         at the tail's end after a compaction — a display
//                         mirror for the user; the model never sees that row.
//                         Default off (no collapsible custom transcript items
//                         exist on this platform, so the block renders
//                         expanded — the knob keeps the chat flow lean).
//
// The overlay appends the entries to the vendored schema and slots them into
// the General tab — the consumer hands the extended schema to the settings
// library, whose normalize/persist are schema-driven and keep the keys.
//
// One SHARED-knob group also ships with port-specific defaults
// (withPortDefaults): the Default-model knob comes pre-set to `haiku` (the
// background stages run on the latest Haiku out of the box) and the
// Default-thinking-level knob to `high` (the background stages reason at
// high by default). Per-component overrides and the chains themselves are
// unchanged, and picking "Session default" persists an explicit value that
// falls the stages back to the same semantics as pi's null default, just
// not the shipped value.

/** The structural slice the overlay needs (both the library's and the
 *  vendored schema satisfy it — the overlay stays generic over either). */
interface SchemaShape {
  settings: readonly { id: string; label: string; type: string; defaultValue: unknown }[];
  tabs: readonly { label: string; settingIds: readonly string[] }[];
}

/** The default kept-tail budget (bind.ts's KEEP_RECENT_TOKENS_DEFAULT mirror —
 *  the pane edits the field the binding already reads). */
export const PORT_KEEP_RECENT_TOKENS_DEFAULT = 20_000;

export const PORT_ONLY_SETTINGS: readonly {
  id: string;
  label: string;
  description?: string;
  type: string;
  min?: number;
  defaultValue: unknown;
  presets?: unknown;
}[] = [
  {
    id: "keepRecentTokens",
    label: "Kept-tail tokens",
    description:
      "Tokens of recent context kept below the memory summary at compaction (this platform's compaction hands the kept tail to session-owl).",
    type: "number",
    min: 0, // 0 = summary-only compaction (no kept tail) is a valid choice
    defaultValue: PORT_KEEP_RECENT_TOKENS_DEFAULT,
  },
  {
    id: "keptTailAggregatedThinking",
    label: "Keep tail thinking",
    description:
      "Fold the kept tail's thinking blocks into the memory summary as an attributed-reasoning section (compaction has no thinking field; disabling drops the reasoning content).",
    type: "boolean",
    defaultValue: false,
  },
  {
    id: "injectedSummaryRow",
    label: "Show injected summary",
    description:
      "On compaction, show memory summary printed above the compaction triggered command. Invisible to the agent.",
    type: "boolean",
    defaultValue: false,
  },
  {
    id: "mirrorRetentionDays",
    label: "Mirror retention days",
    description:
      "How long session-owl's mirror and ledger files are kept. Keep forever is the default; a number prunes older sessions at CLI startup.",
    type: "number",
    min: 1,
    defaultValue: null as never,
    presets: [["Keep forever", null], "30", "90", "365"],
  },
];

/** The port's shipped value for the shared Default-model knob: the latest
 * Haiku via the engine's model alias. */
export const PORT_DEFAULT_MODEL = "haiku";

/** The port's shipped value for the shared Default-thinking-level knob. */
export const PORT_DEFAULT_THINKING_LEVEL = "high";

/** The vendored schema with the port-only fields appended (General tab). */
export function withPortFields<S extends SchemaShape>(base: S): S {
  return {
    ...base,
    settings: [...base.settings, ...PORT_ONLY_SETTINGS] as S["settings"],
    tabs: base.tabs.map((tab) =>
      tab.label === "General"
        ? {
            ...tab,
            settingIds: [
              ...tab.settingIds,
              "keepRecentTokens",
              "keptTailAggregatedThinking",
              "injectedSummaryRow",
              "mirrorRetentionDays",
            ],
          }
        : tab,
    ),
  };
}

/** The port-specific defaults for SHARED knobs, applied after the field
 * overlay: the Default-model knob ships `haiku` and the Default-thinking-
 * level knob `high` instead of the vendored `null`/`null`. Every other row
 * is passed through by reference — this is the only place a shared knob's
 * default may diverge from the vendored schema. */
const PORT_SHARED_DEFAULTS: Readonly<Record<string, unknown>> = {
  defaultModel: PORT_DEFAULT_MODEL,
  defaultThinkingLevel: PORT_DEFAULT_THINKING_LEVEL,
};

export function withPortDefaults<S extends SchemaShape>(base: S): S {
  return {
    ...base,
    settings: base.settings.map((s) =>
      s.id in PORT_SHARED_DEFAULTS ? { ...s, defaultValue: PORT_SHARED_DEFAULTS[s.id] } : s,
    ) as S["settings"],
  };
}
