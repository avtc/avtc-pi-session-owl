// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// Conflict detection for co-installed compaction-handling extensions. Pi's
// compaction hook is last-registration-wins and pi has no pre-load veto, so the
// only sane coexistence policy is self-restraint: when another known
// compaction-handling package is installed, memkeeper skips registering its
// hooks/tools for this process (runtime pause — nothing persisted, so it
// auto-recovers once the other package is removed).

import { type Dirent, existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

/** One installed package that conflicts with memkeeper's compaction role. */
export interface ConflictHit {
  /** The settings `packages` entry that matched (npm:/git:/path source form). */
  entry: string;
  /** The curated marker substring that matched. */
  matched: string;
}

/**
 * Known compaction-handling packages (source-verified 2026-08 — see
 * .featyard/research/2026-08-26-pi-compaction-memory-landscape.md). Matched as
 * substrings against settings entries, so forks and local checkouts (path or
 * git sources) match too.
 */
export const CONFLICT_PACKAGE_MARKERS: readonly string[] = [
  "pi-observational-memory",
  "pi-blackhole",
  "pi-vcc",
  "pi-mcb",
  "pi-press",
  "pi-pact",
  "pi-mega-compact",
  "pi-smart-compact",
  "billion-context-pi",
  "pi-di18n",
  "pi-magic-context",
  "pi-contemplator",
  "pi-viking-memory",
  "pi-compaction-model",
];

/** Test seam for the home dir (os.homedir is not spyable under ESM). */
let conflictsHomeOverride: string | null = null;

export function _setConflictsHomeForTest(home: string | null): void {
  conflictsHomeOverride = home;
}

/** This package's own root (…/avtc-pi-memkeeper), derived from this module file. */
function defaultSelfRoot(): string {
  // <pkgRoot>/dist/conflicts/detect.js (or src/ under test) → three dirs up.
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
}

/** True when the settings entry is memkeeper itself (own npm name or own path). */
function isSelfEntry(entry: string, selfRoot: string): boolean {
  if (entry.toLowerCase().includes("avtc-pi-memkeeper")) return true;
  // Only bare paths can be resolved against selfRoot — npm:/git:/http source
  // specs are not paths (path.resolve would fold them into cwd, which sits
  // inside our own package root and false-positive as "self").
  if (/^(npm:|git:|https?:)/i.test(entry)) return false;
  const resolved = path.resolve(entry);
  return isWithin(resolved, path.resolve(selfRoot)) || isWithin(path.resolve(selfRoot), resolved);
}

function isWithin(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/** The compaction-hook registration marker (a string literal — survives bundling). */
const COMPACT_HOOK_MARKER = "session_before_compact";

/**
 * Override-shaped return near a hook registration: `return { cancel… }` /
 * `return { summary… }` / the arrow-object `=> ({ cancel… })` form. Merely
 * REGISTERING the hook is not a conflict — passive listeners are fine (e.g.
 * avtc-pi-notification rings a bell on compaction) — so the generic net looks
 * for the override return shape, not the registration alone. Best-effort by
 * nature (indirect/delegated returns defeat syntax matching — those live on
 * the curated list); validated 2026-08 against 30 real packages: 9/16 known
 * overriders matched, zero false positives on observers.
 */
const COMPACT_OVERRIDE_PATTERN =
  /on\(["']session_before_compact["'][\s\S]{0,1200}?(?:return\s*\{|\)\s*:\s*\{|\]\s*:\s*\{|=>\s*\(\s*\{)[^}]{0,260}?(cancel|summary)\b/i;

/** Bounded-scan limits: activation must stay fast even with many packages. */
const SCAN_MAX_DEPTH = 2;
const SCAN_MAX_FILES_PER_PACKAGE = 40;
const SCAN_MAX_FILE_BYTES = 4 * 1024 * 1024;

function isScannableSource(file: string): boolean {
  if (file.endsWith(".d.ts")) return false; // type-decl mentions are not runtime registrations
  return /\.(js|cjs|mjs|ts)$/.test(file);
}

/** Bounded recursive walk: does any runtime source in `dir` contain an
 *  override-shaped compaction-hook registration? */
function dirRegistersCompactHook(dir: string, depth = 0, budget = { files: SCAN_MAX_FILES_PER_PACKAGE }): boolean {
  if (depth > SCAN_MAX_DEPTH) return false;
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return false;
  }
  for (const ent of entries) {
    if (ent.name === "node_modules" || ent.name.startsWith(".")) continue;
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      if (dirRegistersCompactHook(full, depth + 1, budget)) return true;
      continue;
    }
    if (!ent.isFile() || !isScannableSource(ent.name) || budget.files <= 0) continue;
    try {
      if (statSync(full).size > SCAN_MAX_FILE_BYTES) continue;
      if (COMPACT_OVERRIDE_PATTERN.test(readFileSync(full, "utf8"))) return true;
    } catch {
      // unreadable file — skip, never crash activation over a scan
    } finally {
      budget.files -= 1;
    }
  }
  return false;
}

/** Best-effort resolve of a settings entry to its installed package directory. */
function resolvePackageDir(entry: string, home: string): string | null {
  if (/^npm:/i.test(entry)) {
    const spec = entry.slice(4).replace(/@[^/@]+$/, ""); // strip @version, keep @scope
    return path.join(home, ".pi", "agent", "npm", "node_modules", ...spec.split("/"));
  }
  if (/^(git:|https?:)/i.test(entry)) {
    const repo = entry
      .replace(/^git:/i, "")
      .replace(/^https?:\/\/[^/]+\//i, "")
      .replace(/\.git$/, "")
      .split(/[@#]/)[0];
    const name = repo.split("/").pop() ?? "";
    return name ? path.join(home, ".pi", "agent", "git", name) : null;
  }
  const resolved = path.resolve(entry);
  try {
    return statSync(resolved).isDirectory() ? resolved : null;
  } catch {
    return null;
  }
}

/** Read the `packages` array from one pi settings file; missing/malformed = []. */
function readPackages(settingsFile: string): string[] {
  if (!existsSync(settingsFile)) return [];
  try {
    const parsed = JSON.parse(readFileSync(settingsFile, "utf8")) as { packages?: unknown };
    if (!Array.isArray(parsed.packages)) return [];
    return parsed.packages.filter((entry): entry is string => typeof entry === "string");
  } catch {
    return []; // malformed JSON — treat as no packages rather than crashing activation
  }
}

/**
 * Detect co-installed compaction-handling packages: pi settings entries
 * (`~/.pi/agent/settings.json` + `<projectDir>/.pi/settings.json`) matched
 * against the curated list, then a generic bounded source scan for the
 * compaction-hook registration marker in resolved package dirs and the
 * legacy user extensions dir — so unknown and future extensions are caught
 * too, not just the curated names.
 */
export function detectConflicts(options?: { projectDir?: string; selfRoot?: string }): ConflictHit[] {
  const home = conflictsHomeOverride ?? homedir();
  const projectDir = options?.projectDir ?? process.cwd();
  const selfRoot = options?.selfRoot ?? defaultSelfRoot();

  const entries = [
    ...readPackages(path.join(home, ".pi", "agent", "settings.json")),
    ...readPackages(path.join(projectDir, ".pi", "settings.json")),
  ];

  const hits: ConflictHit[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    if (seen.has(entry) || isSelfEntry(entry, selfRoot)) continue;
    const lower = entry.toLowerCase();
    const marker = CONFLICT_PACKAGE_MARKERS.find((m) => lower.includes(m));
    if (marker !== undefined) {
      seen.add(entry);
      hits.push({ entry, matched: marker });
      continue; // curated hit — no need to also scan its sources
    }
    const dir = resolvePackageDir(entry, home);
    // The avtc-pi-* suite is our own namespace — its members are co-designed
    // companions (passive listeners at most), exempt from the generic net.
    const isSuiteNamespace = lower.includes("avtc-pi-");
    if (!isSuiteNamespace && dir !== null && !isSelfEntry(dir, selfRoot) && dirRegistersCompactHook(dir)) {
      seen.add(entry);
      hits.push({ entry, matched: COMPACT_HOOK_MARKER });
    }
  }

  // Legacy/manual installs that never appear in settings (mega-compact's
  // scan-scope lesson): scan each subdir of ~/.pi/agent/extensions/.
  const extensionsDir = path.join(home, ".pi", "agent", "extensions");
  try {
    for (const ent of readdirSync(extensionsDir, { withFileTypes: true })) {
      if (!ent.isDirectory() || ent.name.startsWith(".")) continue;
      if (ent.name.includes("avtc-pi-")) continue; // own suite namespace — see above
      const dir = path.join(extensionsDir, ent.name);
      if (isSelfEntry(dir, selfRoot) || seen.has(dir)) continue;
      if (dirRegistersCompactHook(dir)) hits.push({ entry: dir, matched: COMPACT_HOOK_MARKER });
    }
  } catch {
    // no legacy extensions dir — fine
  }
  return hits;
}
