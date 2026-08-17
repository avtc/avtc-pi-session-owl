# avtc-pi-memkeeper

A working-memory extension for [pi](https://github.com/avtc/pi) — maintains a knowledge graph across context compactions and renders a task-relative summary into each compaction, so long sessions keep their goal, decisions, and important context without re-explaining themselves.

![memkeeper](assets/images/<placeholder>.png)

## Features

- **Persistent memory** — observations (immutable, source-backed) are captured continuously and organized into a semantic node graph that lasts across every compaction.
- **Compaction summary** — at compaction, the graph's root level is refined toward a token budget and rendered into the summary pi injects. No full-history re-summary; nothing important is lost.
- **Task-relative** — a Selector picks the nodes that matter to the current work and the planned next tasks; superseded and stale context drops out.
- **Browse session memory** — `/mk:ls`, `/mk:cat`, `/mk:find` let you list, inspect, and search your memory graph; the `mk_recall` tool lets the agent recall on demand.
- **Live status widget** — a footer line shows the active maintenance stage, its progress, and its token cost.

## Installation

```bash
pi install npm:avtc-pi-memkeeper
```

## How it works

memkeeper runs three maintenance stages:

1. **Observer** — watches the session turn-by-turn and captures observations: condensed, source-backed facts. Each captured fact becomes a node in the graph.
2. **Builder** — maintains the graph: groups, merges, supersedes, and re-rates nodes so the structure stays coherent and bounded.
3. **Selector** — curates a task-relative view (the active set) from the maintained graph.

At compaction, the active set is rendered into the compaction summary that pi injects afterward — the agent's post-compaction memory:

```
# Memory
Your session memory. Each item cites an id — use mk_recall for detail.
Legend: n.. node · o.. observation · importance crit high med low (how much it matters if lost) · 📦archived 🪦obsolete

## Initial prompt
Redesign the auth flow: move JWT validation to middleware and drop the legacy login form.

## Active set
nGoal · crit · Redesign auth flow (JWT middleware, drop legacy login) · 3nodes 1obs · Jul 28 14:30 — Jul 29 09:15
n12 · high · Auth flow redesign · 1obs · Jul 28 14:30 — Jul 29 09:15
n8 · high · Decisions · 5obs · Jul 28 14:30 — Jul 29 09:15
n6 · 📦low · Old login form · 2obs · Jul 27 09:00 — Jul 27 18:00
nIrrelevant · med · Irrelevant · 4obs · Jul 28 14:30 — Jul 29 09:15

## Recently touched
Jul 29 09:10 read src/auth/middleware.ts:1-40,120-180
Jul 29 09:12 edit src/auth/jwt.ts
Jul 29 09:15 write src/auth/index.ts
```

After compaction the agent continues with this summary alongside pi's own recent-context tail, which memkeeper leaves untouched.

## The memory graph

The graph is a containment tree of **nodes** (folders) holding **observations** (leaves). It renders the same way everywhere — the agent's `mk_recall`, the Builder and Selector tools, and the `/mk:ls`/`/mk:cat`/`/mk:find` commands:

```
nGoal · crit · The session goal · 4nodes 1obs · Jul 28 14:30
  n12 · high · Auth flow redesign · 1obs · Jul 28 14:30 — Jul 29 09:15
    o31 · med · JWT validation moved to middleware · 2lines 15tokens · Jul 28 14:30
  n8 · high · Decisions · 5obs · Jul 28 14:30 — Jul 29 09:15
  n6 · 📦low · Old login form · 2obs · Jul 27 09:00 — Jul 27 18:00
  n3 · 🪦med · YAML config · → n8 · 1obs · Jul 27 09:00
n5 · med · Scratch · 2obs · Jul 28 14:30 — Jul 29 09:15
```

(*n..* node · *o..* observation; importance *crit*/*high*/*med*/*low* (how much it matters if lost); state glyphs *📦* archived · *🪦* obsolete · *🆕* new, Builder view only.)

**How the agent operates it.** The Builder and Selector navigate and edit the graph with filesystem-style tools — `ls`, `cat`, `find` to read; `mkdir`, `mv`, `merge`, `supersede` (Builder-only), `set_meta` to reorganize; `try_finish` to converge the root view on its budget. The Builder maintains the source graph; the Selector builds a curated copy (the active set) for the summary. The agent itself uses the read-only `mk_recall` to fetch and search on demand.

## Status widget

![status widget](assets/images/<placeholder>.png)

While memkeeper works, a footer line shows the active stage, its progress, and its token cost — hidden when idle:

```
🦉 1005 obs → 95(-10) roots 35k(-10k)/40k #1 · 8.0k/262k · 3.4k tok
```

(observation/node counts with deltas since the stage started · root-view tokens vs budget · context-window usage · streamed output tokens).

## Configuration

Four independent mode axes, all live-toggleable mid-session:

| Setting | Options | Default |
|---|---|---|
| `observerMode` | `on-threshold` · `on-compaction` | `on-threshold` |
| `builderMode` | `on-compaction` · `each-N-observations` · `on-session-context-threshold` · `on-root-view-threshold` | `on-compaction` |
| `selectorMode` | `on-compaction` · `on-session-context-threshold` | `on-compaction` |
| `renderMode` | `selected-root` (Selector curates) · `observations-root` (Builder's root view, no Selector) | `selected-root` |

The defaults are the token-cheapest profile and are provisional — tune the thresholds to your model and workload. See [CONFIGURATION.md](docs/CONFIGURATION.md) for the full schema reference (every knob, defaults, per-component model presets).

## Tools

| Tool | Description |
|---|---|
| `mk_recall` | Recall from memory — fetch by id, filter by time range, or regex search. Targets the rendered tree (selected-root or observations-root). |

## Commands

| Command | Description |
|---|---|
| `/mk:status` | Show memory stats and per-phase token/cost usage (since last compaction and since session start) |
| `/mk:ls [nodeId]` | List root nodes, or a node's children |
| `/mk:cat <id>` | Show a node (with its observations) or a single observation in full |
| `/mk:find <query>` | Search memory (regex; non-obsolete) |
| `/mk:find-all <query>` | Search memory (regex; all, including superseded) |
| `/mk:rescan` | Discard the current memory graph and re-observe the entire session from the start (asks confirmation). With `--reuse-observations`: rebuild the graph structure from the collected observations without re-observing |
| `/mk:reobserve-0-obs-chunks` | Re-observe session ranges that were skipped with zero observations (repair after a degraded model run) |
| `/mk:settings` | Open the settings UI |

## Full suite

Check out the full suite of related extensions, [avtc-pi](https://github.com/avtc/avtc-pi) — deterministic feature development, subagent delegation, working-memory, behavioral learning, parallel-work guardrails, durable decisions, notifications, and more.

Developed with [Z.ai](https://z.ai/subscribe?ic=N5IV4LLOOV) — get 10% off your subscription via this referral link.

## License

MIT
