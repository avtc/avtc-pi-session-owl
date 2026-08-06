# Configuration

memkeeper is configured via `/mk:settings` (a tabbed modal) and stored in `avtc-pi-memkeeper-settings.json`, merged from three layers:

| Scope | Path |
|---|---|
| Global | `~/.pi/agent/avtc-pi-memkeeper-settings.json` |
| Project | `<project>/.pi/avtc-pi-memkeeper-settings.json` |
| Session | in-memory (survives `/reload`, lost on `/new`) |

All settings are **live-toggleable** — changes take effect at the next trigger, no reload needed. The `PI_SETTINGS_MEMKEEPER` environment variable propagates the merged session+project config to subagents.

## General

| Setting | Type | Default | Description |
|---|---|---|---|
| `enabled` | boolean | `true` | Master switch for memkeeper. Off = memkeeper stops capturing memory and stops adding its compaction summary (pi's compaction and other extensions are unaffected). |
| `defaultModel` | model | `null` | One model for all components. `null`/unset uses the current session model. Per-component models override this. |
| `renderMode` | string | `selected-root` | What memkeeper injects after compaction (and what `/mk:*` recall reads). `selected-root` = a focused, task-relevant view the Selector builds; `observations-root` = the root view of the memory graph. |
| `observerMode` | string | `on-threshold` | When the Observer captures memory. `on-threshold` = throughout the session, after a turn once enough new text accumulates; `on-compaction` = all at once, at compaction time only. |
| `builderMode` | string | `on-compaction` | When the Builder runs: `on-compaction` (cheapest), `each-N-observations`, `on-session-context-threshold`, or `on-root-view-threshold`. |
| `selectorMode` | string | `on-compaction` | When the Selector runs (only if `renderMode=selected-root`): `on-compaction` or `on-session-context-threshold`. |
| `commandResultCap` | number | `50` | Max items a `/mk:*` command shows before a `... +N more` footer. `null` = show all. |
| `findTimeoutMs` | duration | `30000` | Max duration a `find`/`mk_recall` search may run before it is stopped. |
| `toolResultTokenBudget` | number | `6000` | Max size (in tokens) of a single `cat`/`find`/`ls`/`mk_recall` result. A larger result shows fewer items or less detail (each item stays whole); reading one observation in full is never cut off. |

## Observer

| Setting | Type | Default | Description |
|---|---|---|---|
| `observerModel` | model | `null` | Overrides `defaultModel` for the Observer. |
| `observerThresholdTokens` | number | `4000` | `on-threshold` gate: emit a batch when accumulated unobserved tokens reach this. |
| `observerIncludeThinking` | boolean | `false` | Include non-redacted thinking blocks in the chunks the Observer reads. |
| `observerToolBlockCapTokens` | number | `400` | When capturing tool calls and results, trim each block to this many tokens (keeping the start and end). `null` = keep the whole block. |

## Builder

| Setting | Type | Default | Description |
|---|---|---|---|
| `builderModel` | model | `null` | Overrides `defaultModel` for the Builder. |
| `builderEveryNObservations` | number | `40` | N for the `each-N-observations` `builderMode`. |
| `builderSessionContextThresholdTokens` | number | `200000` | Threshold for the `on-session-context-threshold` `builderMode`. |
| `builderRootViewThreshold` | number | `40000` | Target size (in tokens) for the root view of the memory graph. Also: the trigger for `on-root-view-threshold` mode, and the budget `builderSkipWithinBudget` checks. |
| `builderSkipWithinBudget` | boolean | `false` | Skip the Builder when the root view is already within budget. Off = the Builder always runs at least once. |
| `maxBuilderPasses` | number | `3` | Max passes per Builder run. |

## Selector

(Only meaningful when `renderMode=selected-root`.)

| Setting | Type | Default | Description |
|---|---|---|---|
| `selectorModel` | model | `null` | Overrides `defaultModel` for the Selector. |
| `selectorSessionContextThresholdTokens` | number | `200000` | Threshold for the `on-session-context-threshold` `selectorMode`. |
| `selectorRootViewThreshold` | number | `20000` | Target size (in tokens) for the root view of the selected tree. |
| `maxSelectorPasses` | number | `3` | Max passes per Selector run. |

## Models

Each component (Observer, Builder, Selector) resolves its model by the first of:

1. its **component-specific** model (`observerModel` / `builderModel` / `selectorModel`), if set;
2. else **`defaultModel`**, if set;
3. else the **current session model**.

So set a per-component model to tune individually (e.g. a larger model for the Builder), set `defaultModel` to apply one model everywhere, or leave both unset to follow the session.

## Settings UI & environment

- **`/mk:settings`** opens the tabbed modal (General · Observer · Builder · Selector). Changes apply live.
- **`PI_SETTINGS_MEMKEEPER`** — the merged session+project config is serialized into this env var so subagents inherit it.
