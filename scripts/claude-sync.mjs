#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

/**
 * claude-sync — vendor the host-free core into claude/core/ and gate drift.
 *
 * The Claude port runs the pi extension's engine code twice: once on the pi
 * host (src/, untouched) and once inside the Claude plugin (claude/core/,
 * byte-copies). The boundary between what is vendored and what is re-hosted
 * on the plugin API is decided here, in HOST_SET, and enforced by this
 * script — never re-derived by hand.
 *
 * Usage:
 *   node scripts/claude-sync.mjs           copy core files, then verify
 *   node scripts/claude-sync.mjs --check   verify only; write nothing
 *
 * Exit codes:
 *   0  ok (synced, or --check found no drift)
 *   1  drift (claude/core/ out of date: content, membership, or version lock)
 *      or error (unparseable state, HOST_SET naming a missing file)
 *
 * Why jscpd (npm run dupes) stays scoped to src/: claude/core/ is a
 * byte-copy of src/ by design, so duplication between the two trees is the
 * mechanism itself, not a smell. The `dupes` gate must keep pointing at
 * src/ only.
 *
 * HOST_SET dispositions (why each entry is re-hosted rather than vendored):
 *   src/index.ts          re-export root of the pi extension entry
 *   src/lifecycle.ts      pi extension lifecycle (engine.create/finished-$)
 *   src/notify.ts         pi notify() adapter
 *   src/commands/**       pi command registration surface
 *   src/widget/**         pi TUI widget surface
 *   src/todo/wiring.ts    pi todo-bridge wiring against the pi host API
 *   src/runtime/model.ts  pi model selection (spawned-model resolution)
 *   src/runtime/stages.ts pi stage-agent construction surface
 *   src/selector/tools.ts pi fs read-tools re-wiring (mutation subset stays
 *                         core in graph/mutate-tools.ts)
 *   src/conflicts/detect.ts  mechanically clean, but conflict channels are
 *                         re-hosted (cross-plugin exchange goes over plugin
 *                         events/state, not pi nouns)
 *   src/conflicts/pause.ts   mechanically clean (config/schema is core), but
 *                         the hit store + live predicate are host state; a
 *                         vendored copy would be a second hit store and dead
 *                         code — the pause timeline lives beside them
 *   src/snippets/**       prompt snippets are folded into the port's prompt
 *                         surfaces
 *
 * The one inversion: src/runtime/agent-loop.ts is vendored as core even
 * though its stage-engine behavior is host territory — it value-imports
 * `agentLoop` from @earendil-works/pi-agent-core, which resolves to the
 * local shim package inside the plugin (the shim's runtime is the Claude
 * stage engine). This is the single place vendored core imports host
 * behavior, inverted through the shim.
 */
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const SRC = path.join(ROOT, "src");
const CORE_DIR = path.join(ROOT, "claude", "core");
const CHECK = process.argv.includes("--check");

const HOST_SET = [
  "src/index.ts",
  "src/lifecycle.ts",
  "src/notify.ts",
  "src/commands/**",
  "src/widget/**",
  "src/todo/wiring.ts",
  "src/runtime/model.ts",
  "src/runtime/stages.ts",
  "src/selector/tools.ts",
  "src/conflicts/detect.ts",
  "src/conflicts/pause.ts",
  "src/snippets/**",
];

// ---------------------------------------------------------------------------
// Sync-time specifier rewrites (the owner-approved table): the vendored core
// stays byte-identical to src/ EXCEPT these import specifiers, rewritten in
// the vendored copies only. The hooks-module loader refuses bare package
// specifiers closure-wide (any depth, TS or JS, installed or not), while
// RELATIVE paths into claude/node_modules load and fire — so the family
// libraries and typebox are consumed relatively from the vendored core.
// The drift gate asserts byte-identity MODULO this table (the same rewrite
// is applied to the src bytes before comparing).
// ---------------------------------------------------------------------------

const REWRITES = [
  { from: "typebox", artifact: "node_modules/typebox/build/index.mjs" },
  // log.ts imports the PLUGIN-OWNED backend (installs the translating default
  //  at ITS load — order-independent against the loader's import ordering).
  { from: "avtc-pi-logger", artifact: "host/log/backend.js" },
  { from: "avtc-pi-settings-ui", artifact: "node_modules/avtc-claude-settings-ui/dist/index.js" },
  // The regex sandbox: the closure refuses node:worker_threads, so the core's
  //  worker runner swaps for the contract-identical host port (the approved
  //  host-replacement role). Two specifier spellings, two importer files.
  { from: "./regex-runner.js", artifact: "host/graph/regex-sandbox.js" },
  { from: "../graph/regex-runner.js", artifact: "host/graph/regex-sandbox.js" },
  // The vendored core's two remaining bare VALUE imports swap for the local
  //  shims (contract-identical, kit-tested): pi-ai's StringEnum (schema.ts —
  //  a typebox-only helper) and pi-tui's Text (owl-recall.ts — the transcript
  //  render path, dead code on this platform). TYPE-only clauses of the same
  //  specifiers are left alone (rewriteSpecifiers skips them; they erase at
  //  emit and the committed type shims cover them).
  { from: "@earendil-works/pi-ai", artifact: "shims/pi-ai/index.js" },
  { from: "@earendil-works/pi-tui", artifact: "shims/pi-tui/index.js" },
];

// ---------------------------------------------------------------------------
// Family-library materialization: the hooks loader refuses paths that leave
// the plugin tree (a node_modules SYMLINK to a sibling checkout resolves
// outside it — the validator says "no such file under claude"), so the
// dev tree carries REAL COPIES of the family dists. `npm install` re-creates
// the symlinks; a sync pass replaces them with copies and --check verifies
// byte-identity against the sibling sources. (Installed-marketplace copies
// materialize real node_modules themselves — this bridges the dev layout.)
// ---------------------------------------------------------------------------

const FAMILY_LIBS = {
  "avtc-claude-logger": "../avtc-pi-logger/claude",
  "avtc-claude-settings-ui": "../avtc-pi-settings-ui/claude",
};

function materializeFamilyLibs(problems) {
  for (const [name, siblingRel] of Object.entries(FAMILY_LIBS)) {
    const src = path.resolve(ROOT, siblingRel);
    const dst = path.join(ROOT, "claude", "node_modules", name);
    if (!fs.existsSync(path.join(src, "dist", "index.js"))) {
      problems.push(`family lib ${name}: sibling dist missing at ${siblingRel}/dist — build the sibling repo first`);
      continue;
    }
    // The copy set: dist/ + package.json (the loader only reads imported
    // files; package.json rides along for tooling).
    const expected = [];
    const walk = (dir, rel) => {
      for (const entry of fs.readdirSync(dir).sort()) {
        const full = path.join(dir, entry);
        const relPath = rel ? `${rel}/${entry}` : entry;
        if (fs.statSync(full).isDirectory()) walk(full, relPath);
        else expected.push(relPath);
      }
    };
    walk(path.join(src, "dist"), "dist");
    expected.push("package.json");

    const needsMaterialize = (() => {
      if (fs.existsSync(dst) && fs.lstatSync(dst).isSymbolicLink()) return true;
      for (const rel of expected) {
        const dstFile = path.join(dst, rel);
        if (!fs.existsSync(dstFile)) return true;
        if (fs.readFileSync(dstFile).equals(fs.readFileSync(path.join(src, rel)))) continue;
        return true;
      }
      return false;
    })();

    if (CHECK) {
      if (needsMaterialize) problems.push(`family lib ${name}: not materialized (run 'npm run claude:sync')`);
    } else if (needsMaterialize) {
      fs.rmSync(dst, { recursive: true, force: true });
      fs.mkdirSync(dst, { recursive: true });
      for (const rel of expected) {
        const dstFile = path.join(dst, rel);
        fs.mkdirSync(path.dirname(dstFile), { recursive: true });
        fs.copyFileSync(path.join(src, rel), dstFile);
      }
      console.log(`[claude-sync] materialized ${name} (${expected.length} files)`);
    }
  }
}

/** The claude/node_modules-relative import specifier for one artifact, as seen
 *  from one vendored file's directory (per-file depth — the loader refuses
 *  bare specifiers, so every vendored import of these packages goes relative). */
function artifactSpecifier(vendoredRel, artifact) {
  const fileDir = path.dirname(path.join("claude/core", vendoredRel));
  const target = path.join("claude", artifact);
  let rel = path.relative(fileDir, target).split(path.sep).join("/");
  if (!rel.startsWith(".")) rel = `./${rel}`;
  return rel;
}

/** Apply the rewrite table to one file's text (import clauses only; a
 *  TYPE-only clause is skipped — it erases at emit, and rewriting it toward
 *  a shim that does not export those types would break compilation). */
function rewriteSpecifiers(text, vendoredRel) {
  for (const { from, artifact } of REWRITES) {
    const to = artifactSpecifier(vendoredRel, artifact);
    const re = new RegExp(
      `(import(?!\\s+type\\b)[^;'"\\n]*from\\s+["'])${from.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\\\$&")}(["'])`,
      "g",
    );
    text = text.replace(re, `$1${to}$2`);
  }
  return text;
}

// ---------------------------------------------------------------------------
// Import graph: VALUE edges only. TYPE-only imports do not reach the host at
// runtime (they erase at emit), so they never pull a file out of the core;
// the type surfaces they need come from the committed shims instead.
// ---------------------------------------------------------------------------

function resolveSpecifier(fromFile, spec) {
  if (!spec.startsWith(".")) return null; // package import — not a src edge
  const base = path.resolve(path.dirname(fromFile), spec);
  for (const cand of [base, `${base}.ts`, base.replace(/\.js$/, ".ts"), path.join(base, "index.ts")]) {
    if (fs.existsSync(cand) && fs.statSync(cand).isFile()) return path.relative(ROOT, cand).split(path.sep).join("/"); // "src/…"-prefixed
  }
  return null;
}

/** Parse one TS file's import edges. Returns [{ to, kind }] with kind "value"|"type". */
function importEdges(file) {
  const text = fs.readFileSync(file, "utf8");
  const edges = [];
  const importRe = /import\s+([\s\S]*?)\s*from\s*["']([^"']+)["']|import\s+["']([^"']+)["']/g;
  for (const m of text.matchAll(importRe)) {
    if (m[3] !== undefined) {
      // bare side-effect import — a value edge
      const to = resolveSpecifier(file, m[3]);
      if (to) edges.push({ to, kind: "value" });
      continue;
    }
    const clause = m[1].trim();
    const spec = m[2];
    let kind;
    if (clause.startsWith("type ") || clause.startsWith("type{")) {
      kind = "type"; // `import type {…}` — the whole clause erases at emit
    } else {
      const braces = clause.match(/\{([\s\S]*)\}/);
      if (!braces) {
        kind = "value"; // default/namespace import carries runtime code
      } else {
        // named list, possibly with inline `type` markers: all-type ⇒ type edge
        const names = braces[1]
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
        const allType = names.length > 0 && names.every((n) => n.startsWith("type ") || n.startsWith("type{"));
        kind = allType ? "type" : "value";
      }
    }
    const to = resolveSpecifier(file, spec);
    if (to) edges.push({ to, kind });
  }
  // re-exports carry the module in: `export {x} from` / `export * from`
  const exportRe = /export\s+(type\s+)?(?:\{[^}]*\}|\*)\s*from\s*["']([^"']+)["']/g;
  for (const m of text.matchAll(exportRe)) {
    const to = resolveSpecifier(file, m[2]);
    if (to) edges.push({ to, kind: m[1] ? "type" : "value" });
  }
  return edges;
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

function globToRe(pattern) {
  // "**" spans directories, "*" stays inside one segment; split on "**"
  // first so the escaped "*" mapping never touches it.
  const parts = pattern.split("**");
  const re = parts.map((p) => p.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*")).join(".*");
  return new RegExp(`^${re}$`);
}

function listSrcFiles() {
  const out = [];
  const walk = (dir) => {
    for (const name of fs.readdirSync(dir).sort()) {
      const full = path.join(dir, name);
      const rel = path.relative(ROOT, full).split(path.sep).join("/"); // "src/…"-prefixed, like HOST_SET
      if (fs.statSync(full).isDirectory()) walk(full);
      else if (rel.endsWith(".ts")) out.push(rel);
    }
  };
  walk(SRC);
  return out;
}

const fail = (msg) => {
  console.error(`[claude-sync] ${msg}`);
  process.exit(1);
};

function main() {
  const srcFiles = listSrcFiles();
  const hostMatchers = HOST_SET.map((p) => ({ pattern: p, re: globToRe(p) }));

  // HOST_SET integrity: every pattern must match at least one src file, and
  // every matched file must exist (guards classification churn — a refactor
  // that moves a host file must update HOST_SET in the same commit).
  const hostFiles = new Set();
  for (const { pattern, re } of hostMatchers) {
    const matched = srcFiles.filter((f) => re.test(f));
    if (matched.length === 0)
      fail(`HOST_SET pattern ${pattern} matches no src file — update the list in scripts/claude-sync.mjs`);
    for (const f of matched) hostFiles.add(f);
  }

  const edgesByFile = new Map(); // relFile -> [{to, kind}]
  const srcPath = (rel) => path.join(ROOT, rel);
  for (const rel of srcFiles) edgesByFile.set(rel, importEdges(srcPath(rel)));

  // CORE = every non-HOST file whose transitive VALUE-import closure (within
  // src/) avoids HOST files. Compute by walking value edges per candidate.
  const hostByClosure = []; // { file, via }
  const core = [];
  for (const rel of srcFiles) {
    if (hostFiles.has(rel)) continue;
    const seen = new Set();
    const stack = [rel];
    let hit = null;
    while (stack.length > 0 && !hit) {
      const cur = stack.pop();
      if (seen.has(cur)) continue;
      seen.add(cur);
      for (const e of edgesByFile.get(cur) ?? []) {
        if (e.kind !== "value") continue;
        if (hostFiles.has(e.to)) {
          hit = e.to;
          break;
        }
        if (!seen.has(e.to)) stack.push(e.to);
      }
    }
    if (hit) hostByClosure.push({ file: rel, via: hit });
    else core.push(rel);
  }
  core.sort();

  // D4 version lock: root package.json, plugin.json and claude/package.json
  // move together — one version number per repo.
  const rootVersion = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).version;
  const pluginJson = JSON.parse(fs.readFileSync(path.join(ROOT, "claude", ".claude-plugin", "plugin.json"), "utf8"));
  const claudePkg = JSON.parse(fs.readFileSync(path.join(ROOT, "claude", "package.json"), "utf8"));
  if (pluginJson.version !== rootVersion)
    fail(`version lock: claude/.claude-plugin/plugin.json ${pluginJson.version} != root package.json ${rootVersion}`);
  if (claudePkg.version !== rootVersion)
    fail(`version lock: claude/package.json ${claudePkg.version} != root package.json ${rootVersion}`);

  console.log(`[claude-sync] version lock ok: ${rootVersion}`);
  console.log(
    `[claude-sync] src files ${srcFiles.length} | HOST_SET ${hostFiles.size} | host-by-closure ${hostByClosure.length} | CORE ${core.length}`,
  );

  // Advisory (non-gating): host-API identifiers referenced in core code.
  // The core reaches the host only through injected contexts; these counts
  // are a change signal for reviewers, not a gate.
  const ADVISORY = ["ExtensionAPI", "ExtensionContext", "ExtensionCommandContext", "sessionManager"];
  const advisory = [];
  for (const rel of core) {
    const lines = fs.readFileSync(srcPath(rel), "utf8").split(/\r?\n/);
    const counts = {};
    lines.forEach((line) => {
      if (/^\s*import\s+type\b/.test(line)) return; // type-only import — shim territory
      for (const id of ADVISORY) {
        if (new RegExp(`\\b${id}\\b`).test(line)) counts[id] = (counts[id] ?? 0) + 1;
      }
    });
    if (Object.keys(counts).length > 0) advisory.push({ file: rel, counts });
  }

  // Membership drift: the vendored tree records the last sync's CORE set.
  const existing = new Set();
  if (fs.existsSync(CORE_DIR)) {
    const walk = (dir) => {
      for (const name of fs.readdirSync(dir).sort()) {
        const full = path.join(dir, name);
        if (fs.statSync(full).isDirectory()) walk(full);
        else if (name.endsWith(".ts") && !name.endsWith(".d.ts"))
          existing.add(path.relative(CORE_DIR, full).split(path.sep).join("/")); // .d.ts = hand-written shims, not vendored modules
      }
    };
    walk(CORE_DIR);
  }
  const expected = new Set(core);
  const missing = [...expected].filter((f) => !existing.has(f)).sort();
  const stale = [...existing].filter((f) => !expected.has(f)).sort();

  const problems = [];
  materializeFamilyLibs(problems);
  if (missing.length > 0) problems.push(`not vendored (run 'npm run claude:sync'): ${missing.join(", ")}`);
  if (stale.length > 0)
    problems.push(`vendored but no longer CORE (membership drift; re-run sync): ${stale.join(", ")}`);

  // Content drift: byte-compare every expected file against its src twin
  // MODULO the rewrite table (the same rewrite applied to the src bytes).
  for (const rel of core) {
    const srcText = rewriteSpecifiers(fs.readFileSync(srcPath(rel), "utf8"), rel);
    const dst = path.join(CORE_DIR, rel);
    if (!fs.existsSync(dst)) continue; // already reported as missing
    const dstText = fs.readFileSync(dst, "utf8");
    if (srcText !== dstText)
      problems.push(`content drift: claude/core/${rel} differs from src/${rel} (modulo rewrites)`);
  }

  if (CHECK) {
    if (problems.length > 0) {
      for (const p of problems) console.error(`[claude-sync] drift: ${p}`);
      process.exit(1);
    }
    console.log("[claude-sync] --check: no drift");
  } else {
    fs.mkdirSync(CORE_DIR, { recursive: true });
    for (const rel of core) {
      const dst = path.join(CORE_DIR, rel);
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.writeFileSync(dst, rewriteSpecifiers(fs.readFileSync(srcPath(rel), "utf8"), rel), "utf8");
    }
    for (const rel of stale) fs.rmSync(path.join(CORE_DIR, rel));
    // remove now-empty directories left behind by stale removals
    for (const rel of stale) {
      let dir = path.dirname(path.join(CORE_DIR, rel));
      while (dir.startsWith(CORE_DIR) && fs.existsSync(dir) && fs.readdirSync(dir).length === 0) {
        fs.rmSync(dir);
        dir = path.dirname(dir);
      }
    }
    // verify the copy (belt and braces: catches a mid-sync write collision
    // or AV interference) — modulo the same rewrite table
    for (const rel of core) {
      const expected = rewriteSpecifiers(fs.readFileSync(srcPath(rel), "utf8"), rel);
      if (expected !== fs.readFileSync(path.join(CORE_DIR, rel), "utf8")) {
        fail(`copy verification failed: claude/core/${rel} is not src/${rel} modulo rewrites`);
      }
    }
    console.log(
      `[claude-sync] vendored ${core.length} files into claude/core/ (byte-verified${missing.length + stale.length > 0 ? `, removed ${stale.length} stale` : ""})`,
    );
  }

  // Report the boundary (always printed — the auditable list).
  console.log(`[claude-sync] CORE (${core.length}):`);
  for (const rel of core) console.log(`  ${rel}`);
  console.log(`[claude-sync] HOST by closure (${hostByClosure.length}):`);
  for (const { file, via } of hostByClosure) console.log(`  ${file}  (imports host ${via})`);
  if (advisory.length > 0) {
    console.log("[claude-sync] advisory host-API refs in core (non-gating):");
    for (const { file, counts } of advisory) console.log(`  ${file}: ${JSON.stringify(counts)}`);
  }
}

main();
