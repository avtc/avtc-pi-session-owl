#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

/**
 * no-bundled-extension-imports — forbids importing bundled companion
 * extensions as code, enforcing the polyrepo self-sufficiency invariant.
 *
 * Problem: a host extension bundles companion extensions as runtime deps
 * (declared in `dependencies` + loaded via `pi.extensions`) so that
 * `pi install <host>` alone brings the full runtime. But anything in
 * `dependencies` is importable — an agent could accidentally write
 * `import { foo } from "avtc-pi-subagent"` and it would typecheck, silently
 * introducing forbidden leaf-to-leaf coupling.
 *
 * This lint makes such imports a hard error at `npm test` time. Only the
 * avtc-pi-* deps listed in the package.json `pi.allowedCodeDeps` whitelist
 * may be imported; every other avtc-pi-* dep is bundled-for-loading-only
 * and must NOT appear in an import/require.
 *
 * Whitelist is DENY-BY-DEFAULT: forgetting to whitelist a genuinely-imported
 * dep fails loudly (you add it); forgetting on the forbidden side is
 * impossible (there is no opt-out — non-whitelisted = forbidden).
 *
 * Usage:
 *   node scripts/no-bundled-extension-imports.cjs [files-or-dirs...]
 *
 * Defaults to scanning `src/` and `index.ts` when no paths are given.
 * Exits 1 if any forbidden import is found.
 */

const fs = require("node:fs");
const path = require("node:path");

const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
const deps = Object.keys(pkg.dependencies ?? {});
const avtcDeps = deps.filter((d) => d.startsWith("avtc-pi-"));
const whitelist = new Set(pkg.pi?.allowedCodeDeps ?? []);
const forbidden = avtcDeps.filter((d) => !whitelist.has(d));

if (forbidden.length === 0) {
  // Nothing bundled-for-loading-only — nothing to enforce.
  process.exit(0);
}

const roots = process.argv.slice(2);
const scanRoots = roots.length > 0 ? roots : ["src", "index.ts"];

function* walk(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory() && !entry.name.startsWith(".") && entry.name !== "node_modules") {
      yield* walk(full);
    } else if (entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts")) {
      yield full;
    }
  }
}

function* iterFiles() {
  for (const root of scanRoots) {
    if (!fs.existsSync(root)) continue;
    const stat = fs.statSync(root);
    if (stat.isDirectory()) {
      yield* walk(root);
    } else if (root.endsWith(".ts")) {
      yield root;
    }
  }
}

// Match: from "pkg", from 'pkg', require("pkg"), require('pkg'),
// import("pkg"), import('pkg'), import "pkg" (side-effect).
// Catches bare name AND subpaths (pkg/src/foo).
function importRegex(pkgName) {
  const esc = pkgName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // group 1 = the statement prefix context; we only need to know pkgName appears
  // as a module specifier (bounded by quote on both sides, optionally with /subpath)
  return new RegExp(
    [
      `from\\s+["']${esc}(?:/[^"']*)?["']`,
      `require\\s*\\(\\s*["']${esc}(?:/[^"']*)?["']`,
      `import\\s*\\(\\s*["']${esc}(?:/[^"']*)?["']`,
      `import\\s+["']${esc}(?:/[^"']*)?["']`, // side-effect import
    ].join("|"),
  );
}

const regexes = forbidden.map((p) => ({ pkg: p, re: importRegex(p) }));

let violations = 0;
for (const file of iterFiles()) {
  const lines = fs.readFileSync(file, "utf8").split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    for (const { pkg: fpkg, re } of regexes) {
      if (re.test(line)) {
        console.error(
          `${file}:${i + 1}: forbidden import from bundled extension "${fpkg}" — it is bundled for runtime loading only, not for code import. Add it to package.json "pi.allowedCodeDeps" ONLY if this repo genuinely imports it as code.`,
        );
        violations++;
      }
    }
  }
}

if (violations > 0) {
  console.error(`\nno-bundled-extension-imports: ${violations} forbidden import(s) found.`);
  process.exit(1);
}
process.exit(0);
