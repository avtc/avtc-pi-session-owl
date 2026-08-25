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
| `defaultThinkingLevel` | thinking-level | `null` | Thinking level for all components. `null`/Session default = use the session's thinking level; `off` = no thinking. Per-component levels override this. |
| `renderMode` | string | `observations-root` | What memkeeper injects after compaction (and what `/mk:*` recall reads). `selected-root` = a focused, task-relevant view the Selector builds; `observations-root` = the root view of the memory graph. |
| `observerMode` | string | `on-threshold` | When the Observer captures memory. `on-threshold` = throughout the session, after a turn once enough new text accumulates; `on-compaction` = all at once, at compaction time only. |
| `builderMode` | string | `each-N-observations` | When the Builder runs: `on-compaction` (cheapest), `each-N-observations`, `on-session-context-threshold`, or `on-root-view-threshold`. |
| `selectorMode` | string | `on-compaction` | When the Selector runs (only if `renderMode=selected-root`): `on-compaction` or `on-session-context-threshold`. |
| `rootViewTargetNodes` | number | `null` | Advice for the Builder and Selector on how many roots to keep. A number = aim for about that many roots — a soft target, the token budget wins. No target = no advice; the agent shapes the root view on its own. |
| `rootViewStrategy` | string | `balanced` | How the Builder and Selector organize roots. Balanced = organize arrivals and consolidate related; By task = one root per task, in order; By category = roots by kind (requests, decisions, code understanding, work state, pitfalls, environment — open list); By recency = granular recent, compact older; By importance = dedicated roots for crit/high; By topic = one root per distinct subject. |
| `commandResultCap` | number | `50` | Max items a `/mk:*` command shows before a `... +N more` footer. `null` = show all. |
| `findTimeoutMs` | duration | `30000` | Max duration a `find`/`mk_recall` search may run before it is stopped. |
| `llmCallTimeoutMs` | duration | `1200000` | Aborts any Observer, Builder, or Selector LLM call that runs longer than this. `null` = no limit. |
| `toolResultTokenBudget` | number | `6000` | Max size (in tokens) of a single `cat`/`find`/`ls`/`mk_recall` result. A larger result shows fewer items or less detail (each item stays whole); reading one observation in full is never cut off. |
| `debugLog` | boolean | `false` | Write detailed trace logs to the log file. |
| `debugDumpLimit` | number | `0` | Maximum per-stage dump files kept under `~/.pi/memkeeper/dumps/<project>/` (0 = no dumps). Each dump captures what an Observer/Builder/Selector LLM run saw (system prompt, tools, per-call input) and produced (thinking, text, tool calls, results), in the tagged memory format. |

## Observer

| Setting | Type | Default | Description |
|---|---|---|---|
| `observerModel` | model | `null` | Overrides `defaultModel` for the Observer. |
| `observerThresholdTokens` | number | `4000` | `on-threshold` gate: emit a batch when accumulated unobserved tokens reach this. |
| `observerIncludeThinking` | boolean | `true` | Include non-redacted thinking blocks in the chunks the Observer reads. |
| `observerToolBlockCapTokens` | number | `null` | When capturing tool calls and results, trim each block to this many tokens (keeping the start and end). `null` = keep the whole block. |
| `observerMaxTokens` | number | `16384` | Maximum output tokens per Observer LLM call. |
| `observerThinkingLevel` | thinking-level | `null` | Thinking level for the Observer. `null`/Inherit default = use `defaultThinkingLevel`; `off` = no thinking. |

## Builder

| Setting | Type | Default | Description |
|---|---|---|---|
| `builderModel` | model | `null` | Overrides `defaultModel` for the Builder. |
| `builderEveryNObservations` | number | `40` | N for the `each-N-observations` `builderMode`. |
| `builderSessionContextThresholdTokens` | number | `200000` | Threshold for the `on-session-context-threshold` `builderMode`. |
| `builderRootViewThreshold` | number | `40000` | Target size (in tokens) for the root view of the memory graph. Also: the trigger for `on-root-view-threshold` mode, and the budget `builderSkipWithinBudget` checks. |
| `builderSkipWithinBudget` | boolean | `true` | At compaction only: skip the Builder when the root view is within budget. Background triggers are never skipped. Off = the Builder always runs at least once. |
| `maxBuilderPasses` | number | `3` | Max passes per Builder run. |
| `builderMaxTokens` | number | `32768` | Maximum output tokens per Builder LLM call. |
| `builderThinkingLevel` | thinking-level | `null` | Thinking level for the Builder. `null`/Inherit default = use `defaultThinkingLevel`; `off` = no thinking. |

## Selector

(Only meaningful when `renderMode=selected-root`.)

| Setting | Type | Default | Description |
|---|---|---|---|
| `selectorModel` | model | `null` | Overrides `defaultModel` for the Selector. |
| `selectorSessionContextThresholdTokens` | number | `200000` | Threshold for the `on-session-context-threshold` `selectorMode`. |
| `selectorRootViewThreshold` | number | `20000` | Target size (in tokens) for the root view of the selected tree. |
| `maxSelectorPasses` | number | `3` | Max passes per Selector run. |
| `selectorMaxTokens` | number | `65536` | Maximum output tokens per Selector LLM call. |
| `selectorThinkingLevel` | thinking-level | `null` | Thinking level for the Selector. `null`/Inherit default = use `defaultThinkingLevel`; `off` = no thinking. |

## Models

Each component (Observer, Builder, Selector) resolves its model by the first of:

1. its **component-specific** model (`observerModel` / `builderModel` / `selectorModel`), if set;
2. else **`defaultModel`**, if set;
3. else the **current session model**.

So set a per-component model to tune individually (e.g. a larger model for the Builder), set `defaultModel` to apply one model everywhere, or leave both unset to follow the session.

## Thinking levels

Each component resolves its thinking level by the first of:

1. its **component-specific** level (`observerThinkingLevel` / `builderThinkingLevel` / `selectorThinkingLevel`), if not *Inherit default*;
2. else **`defaultThinkingLevel`**, if not *Session default*;
3. else the **session's thinking level**.

`off` at any tier disables thinking for that component (the reasoning field is omitted from the LLM call). Leave all unset to follow the session, or set `defaultThinkingLevel` once to apply a level everywhere.

## Settings UI & environment

- **`/mk:settings`** opens the tabbed modal (General · Observer · Builder · Selector). Changes apply live.
- **`PI_SETTINGS_MEMKEEPER`** — the merged session+project config is serialized into this env var so subagents inherit it.
