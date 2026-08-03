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
| `enabled` | boolean | `true` | Master switch. `false` turns memkeeper fully off (no hooks, no work). |
| `defaultModel` | model | `null` | One model for all components. `null`/unset uses the current session model. Per-component models override this. |
| `renderMode` | string | `selected-root` | What's injected at compaction and what `mk_recall` drills. `selected-root` = the Selector's curated tree; `observations-root` = the Builder's root view (no Selector). |
| `observerMode` | string | `on-threshold` | `on-threshold` fires at `turn_end` when ≥1 unobserved event and tokens ≥ `observerThresholdTokens`. `on-compaction` catches up at compaction only. |
| `builderMode` | string | `on-compaction` | When the Builder runs: `on-compaction` (cheapest), `each-N-observations`, `on-session-context-threshold`, or `on-root-view-threshold`. |
| `selectorMode` | string | `on-compaction` | When the Selector runs (only if `renderMode=selected-root`): `on-compaction` or `on-session-context-threshold`. |
| `commandResultCap` | number | `50` | Max lines a `/mk:*` command renders before a `... +N more` footer. `null` = no limit. (User commands only; the agent's `mk_recall` paginates separately.) |
| `regexTimeoutMs` | number | `5000` | Max ms a `find`/`mk_recall` regex may run before it is killed. Tests run in a worker thread, so pi stays responsive while a catastrophic pattern is terminated. `0` disables the timeout (not advised — a bad pattern can freeze pi). |

## Observer

| Setting | Type | Default | Description |
|---|---|---|---|
| `observerModel` | model | `null` | Overrides `defaultModel` for the Observer. |
| `observerThresholdTokens` | number | `4000` | `on-threshold` gate: emit a batch when accumulated unobserved tokens reach this. |
| `observerIncludeThinking` | boolean | `false` | Include non-redacted thinking blocks in the chunks the Observer reads. |
| `observerToolBlockCapTokens` | number | `400` | Per tool-arg/result block cap (head N/2 + tail N/2 + marker). `null` = no truncation. |

## Builder

| Setting | Type | Default | Description |
|---|---|---|---|
| `builderModel` | model | `null` | Overrides `defaultModel` for the Builder. |
| `builderEveryNObservations` | number | `40` | N for the `each-N-observations` `builderMode`. |
| `builderSessionContextThresholdTokens` | number | `200000` | Threshold for the `on-session-context-threshold` `builderMode`. |
| `builderRootViewThreshold` | number | `40000` | Triple-use: the `on-root-view-threshold` trigger, the Builder's convergence target (`try_finish` gates on it), and the compaction fast-path (root view below it = ready). |
| `maxBuilderPasses` | number | `3` | Max convergence passes in one Builder run. |

## Selector

(Only meaningful when `renderMode=selected-root`.)

| Setting | Type | Default | Description |
|---|---|---|---|
| `selectorModel` | model | `null` | Overrides `defaultModel` for the Selector. |
| `selectorSessionContextThresholdTokens` | number | `200000` | Threshold for the `on-session-context-threshold` `selectorMode`. |
| `selectorRootViewThreshold` | number | `20000` | The Selector's convergence target (`try_finish` gates on it) + compaction fast-path. |
| `maxSelectorPasses` | number | `3` | Max convergence passes in one Selector run. |

## Models

Each component (Observer, Builder, Selector) resolves its model by the first of:

1. its **component-specific** model (`observerModel` / `builderModel` / `selectorModel`), if set;
2. else **`defaultModel`**, if set;
3. else the **current session model**.

So set a per-component model to tune individually (e.g. a larger model for the Builder), set `defaultModel` to apply one model everywhere, or leave both unset to follow the session.

## Settings UI & environment

- **`/mk:settings`** opens the tabbed modal (General · Observer · Builder · Selector). Changes apply live.
- **`PI_SETTINGS_MEMKEEPER`** — the merged session+project config is serialized into this env var so subagents inherit it.
