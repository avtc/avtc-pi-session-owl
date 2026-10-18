# session-owl — Claude Code port (development)

All runtime wirings are live and the full gate chain runs behind the repo's
`npm test`. This file carries the port's development notes, gates, and
release runbook.

## Layout

| Path | What |
|---|---|
| `.claude-plugin/plugin.json` | the plugin manifest (name `session-owl`; version locked to the repo package version) |
| `.claude-plugin/types/` | the committed generated types of the pinned build |
| `hooks/hooks.json` + `hooks/register.ts` | the single hooks module (all event wiring) |
| `core/` | the vendored host-free core (byte-identical to the pi source modulo the recorded specifier rewrites in `scripts/claude-sync.mjs` (REWRITES) — enforced by `claude-sync --check`) |
| `host/` | the host adapters: capture, compaction, recall, commands, widget, conflicts, rewind, stage runs, storage, settings, usage, dumps, retention, todo bridge |
| `helpers/` | Node CLI helpers (transcript bootstrap; the mirror-retention prune sweep) |
| `shims/` | the engine-shape shims the vendored core compiles against |
| `tests/` | the Node test suites (vitest; run with the repo's `npm test`) |
| `plugin-test/` | the engine-kit twins (`claude plugin test ./claude`) |
| `assets/` | the images the README ships (self-contained with the plugin) |

## Gates (the repo's `npm test` runs them all)

- `claude:sync-check` — the vendored core is byte-identical (modulo the
  recorded specifier rewrite) and versions are locked together
- `claude:validate` / `claude:test` — offline `claude plugin validate` /
  `plugin test` (skip with a warning when no claude binary)
- `live:smoke` — a real offline `claude -p` session proves the plugin loads,
  fires hooks, and serves a forced `owl_recall` round-trip (local mock
  Anthropic endpoint; no network)
- `inertness:smoke` — with hooks disabled (`disableAllHooks: true` and, in a
  second run, `--safe-mode`) the plugin is inert: no load, no writes
- `h5-host-untouched` (via the acceptance suite) — the pi source tree stays
  byte-identical to the pre-port baseline (modulo the recorded,
  content-pinned hunks)
- `acceptance-checklist` — `node scripts/acceptance-checklist.cjs` prints
  PASS/FAIL per done-condition area (1–14)

## Release runbook

1. Verify the gates: `npm test` (the full chain) + `claude plugin validate
   ./claude` + `claude plugin test ./claude`.
2. `claude/package.json` carries the registry specs (`avtc-claude-logger`,
   `avtc-claude-settings-ui`); refresh `claude/package-lock.json` only
   after the siblings are live on the registry (`npm install` in
   `claude/` — offline they still resolve via `claude/node_modules`).
3. Keep the version lock: the root package.json, `plugin.json`, and
   `claude/package.json` versions move together (one number per repo).
4. Publish: the catalog lives in the `avtc` marketplace
   (github.com/avtc/avtc-claude-marketplace) with this repo's `claude/`
   directory as the `git-subdir` source — push MAIN (the squash-merge
   branch; feature branches are never pushed), bump versions, and the
   marketplace serves the new copy; then `claude plugin tag --push`
   (creates the `<name>--v<version>` git tag) for version-range consumers.
5. The engine may rewrite `claude/.claude-plugin/types/` when its build
   differs — leave them as written (restore from HEAD with
   `git show HEAD:<path> > <path>` only when a gate run needs the
   committed baseline).

## Development notes

- Dev installs materialize the family libraries as REAL COPIES under
  `claude/node_modules/` (`npm run claude:sync` re-materializes them from the
  sibling checkouts of `avtc-pi-logger/claude` and
  `avtc-pi-settings-ui/claude`; `claude:sync-check` verifies byte-identity).
  `claude/package.json` carries the registry specs; the lockfile keeps `file:`
  entries only until the siblings are live on npm.
- A `--plugin-dir` plugin loads at process start; restart the CLI after
  code changes (installed-plugin edits are cached by the engine). NEVER edit
  the plugin tree while a session is live: the engine reloads the module on
  file change and every armed in-memory state dies with the reload
  (commands answer nothing, the widget stops, the settings pane reports
  not-loaded) — run long test sessions against a stable copy of the tree.
  (A healthy session keeps its hooks worker through compaction: the gate
  serves `await_stage` in ~9s slices so the worker's heartbeat never
  starves; live tree edits are the reload path that remains.)
- session-owl declares `session-owl-subagent-support` (the stage spawner
  companion at `../claude-subagent-support`) as a plugin dependency — a
  session that loads `claude/` without the companion refuses to start the
  plugin. Pass the REPO ROOT as one `--plugin-dir` (the engine loads every
  child folder with a `.claude-plugin/`): both plugins come up and the
  local companion copy satisfies the dependency.
- The engine rewrites `claude/.claude-plugin/types/` only opportunistically
  (an engine-fired write when the files are missing or its build differs);
  a real load leaves the committed set untouched. Restore the committed
  baseline with `git show HEAD:<path> > <path>` — never delete the files to
  force a regeneration (no toolchain entry point regenerates them).
