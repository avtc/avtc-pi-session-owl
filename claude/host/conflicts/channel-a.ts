// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// Channel A — the disk enumeration at the awaited first session.start.
// The loader's on-disk registry (installed_plugins.json,
// one entry per install with the absolute dir) unioned with the
// enabledPlugins settings key per source, deduped, filtered to enabled
// entries by the engine's precedence, then: self + family namespace
// skipped, curated markers checked (the list ships EMPTY — no known Claude
// mod answers session.compact today; the source-verified-sweep procedure
// extends it), and hooks-declared mods deep-scanned with the bounded scan
// for an override-shaped session.compact registration. Unscannable
// candidates fail safe (hit). Unreadable inputs degrade to empty — the
// enumeration never throws.

import { log } from "../../core/src/log.js";
import { type ConflictHit, joinPath, type ScanIo, scansCompactOverride } from "./scan.js";

/** The curated marker list — pi's analog shipped 14 names; on this platform
 *  no known mod answers session.compact, so it ships EMPTY. Extension
 *  procedure (pi's, ported): sweep the mod marketplaces/sources for
 *  session.compact registrants that answer (messages/skip), verify the
 *  override shape in their sources, and add the name substring here. */
export const CONFLICT_MARKERS: readonly string[] = [];

/** The settings sources the engine reads enabledPlugins from, in ascending
 *  precedence (policy > flag > local > project > user; the highest source
 *  that MENTIONS the key wins — an explicit false at a higher precedence
 *  disables). */
const SOURCES = ["user", "project", "local", "flag", "policy"] as const;
export type SettingsSource = (typeof SOURCES)[number];

/** The io seam (the $-capsule bridge supplies it at runtime). */
export interface ChannelAIo extends ScanIo {
  /** Parsed installed_plugins.json (null when missing/malformed). */
  readInstalledPlugins: () => Promise<unknown>;
  /** The enabledPlugins map from one settings source (null when the source does not mention the key). */
  readEnabledPlugins: (source: SettingsSource) => Promise<Record<string, boolean> | null>;
}

/** One registry install, normalized. */
interface InstallEntry {
  key: string;
  installPath: string;
}

/** An advisory (no pause): a curated-name match that is disabled, or a
 *  classic-pattern-only live registrant (Channel B). */
export interface ConflictAdvisory {
  name: string;
  evidence: string;
  reason: "disabled" | "classic-only";
}

export interface ChannelAResult {
  hits: ConflictHit[];
  advisories: ConflictAdvisory[];
  /** Every enabled entry seen (name@marketplace) — Channel A-prime roots
   *  itself against this set. */
  rootedNames: string[];
}

/** Normalize the registry into entries; malformed input degrades to []. */
export function parseInstalledPlugins(parsed: unknown): InstallEntry[] {
  if (typeof parsed !== "object" || parsed === null) return [];
  const plugins = (parsed as { plugins?: unknown }).plugins;
  if (typeof plugins !== "object" || plugins === null) return [];
  const out: InstallEntry[] = [];
  for (const [key, installs] of Object.entries(plugins as Record<string, unknown>)) {
    if (typeof key !== "string" || !Array.isArray(installs)) continue;
    for (const inst of installs) {
      if (typeof inst !== "object" || inst === null) continue;
      const installPath = (inst as { installPath?: unknown }).installPath;
      if (typeof installPath === "string" && installPath.length > 0) out.push({ key, installPath });
    }
  }
  return out;
}

/** Resolve the effective enablement per key: the highest-precedence source
 *  that mentions the key wins; unmentioned keys default to enabled (the
 *  install itself implies the engine may load it). */
export async function effectiveEnabled(
  readEnabledPlugins: (source: SettingsSource) => Promise<Record<string, boolean> | null>,
): Promise<Map<string, boolean>> {
  const decided = new Map<string, boolean>();
  for (const source of SOURCES) {
    // ascending precedence: a later (higher) source overrides earlier ones
    let map: Record<string, boolean> | null = null;
    try {
      map = await readEnabledPlugins(source);
    } catch (err) {
      log.info(`conflict scan: enabled-plugins read failed (${source}): ${errText(err)}`);
      map = null;
    }
    if (map === null || typeof map !== "object") continue;
    for (const [key, value] of Object.entries(map)) {
      decided.set(key, value !== false);
    }
  }
  return decided;
}

function isWithin(child: string, parent: string): boolean {
  const rel = relativePath(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbs(rel));
}

function relativePath(from: string, to: string): string {
  const norm = (p: string): string[] => p.replace(/\\/g, "/").replace(/\/+$/, "").split("/");
  const a = norm(from);
  const b = norm(to);
  let i = 0;
  while (i < a.length && i < b.length && a[i].toLowerCase() === b[i].toLowerCase()) i++;
  const up = a.length - i;
  const rest = b.slice(i);
  return [...Array(up).fill(".."), ...rest].join("/");
}

function isAbs(p: string): boolean {
  return p.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(p);
}

/** True when the entry is session-owl itself (own name or own root). */
function isSelfEntry(key: string, installPath: string, selfName: string, selfRoot: string): boolean {
  if (key.toLowerCase().includes(selfName.toLowerCase())) return true;
  return isWithin(installPath, selfRoot) || isWithin(selfRoot, installPath);
}

/** Read the hooks declaration at an install: {modules: string[]} (missing /
 *  malformed / empty ⇒ no hooks). */
async function readHooksModules(installPath: string, io: ChannelAIo): Promise<string[] | null> {
  let text: string;
  try {
    text = await io.read(joinPath(joinPath(installPath, "hooks"), "hooks.json"));
  } catch (err) {
    log.info(`conflict scan: no hooks file at ${installPath}: ${errText(err)}`);
    return null; // no hooks file — a command/skill/MCP plugin
  }
  try {
    const parsed = JSON.parse(text) as { modules?: unknown };
    if (!Array.isArray(parsed.modules)) return null;
    return parsed.modules.filter((m): m is string => typeof m === "string");
  } catch (err) {
    log.info(`conflict scan: malformed hooks.json at ${installPath}: ${errText(err)}`);
    return null;
  }
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Run Channel A: the disk enumeration over registry + settings. */
export async function runChannelA(opts: {
  io: ChannelAIo;
  selfName: string;
  selfRoot: string;
  familyPrefix: string;
  markers?: readonly string[];
}): Promise<ChannelAResult> {
  const { io, selfName, selfRoot, familyPrefix } = opts;
  const markers = opts.markers ?? CONFLICT_MARKERS;

  const entries = await (async () => {
    try {
      return parseInstalledPlugins(await io.readInstalledPlugins());
    } catch (err) {
      log.info(`conflict scan: installed-plugins read failed: ${errText(err)}`);
      return [];
    }
  })();
  const enabled = await effectiveEnabled(io.readEnabledPlugins);

  const hits: ConflictHit[] = [];
  const advisories: ConflictAdvisory[] = [];
  const rootedNames: string[] = [];
  const seen = new Set<string>();

  for (const entry of entries) {
    const dedup = `${entry.key}|${entry.installPath}`;
    if (seen.has(dedup)) continue;
    seen.add(dedup);

    if (enabled.get(entry.key) === false) {
      const lower = `${entry.key} ${entry.installPath}`.toLowerCase();
      const marker = markers.find((m) => lower.includes(m.toLowerCase()));
      if (marker !== undefined) {
        advisories.push({ name: entry.key, evidence: marker, reason: "disabled" });
      }
      continue; // installed-but-disabled cannot run (pi parity: scan what loads)
    }

    if (isSelfEntry(entry.key, entry.installPath, selfName, selfRoot)) continue;
    if (entry.key.toLowerCase().includes(familyPrefix.toLowerCase())) continue;

    rootedNames.push(entry.key);

    const lower = `${entry.key} ${entry.installPath}`.toLowerCase();
    const marker = markers.find((m) => lower.includes(m.toLowerCase()));
    if (marker !== undefined) {
      hits.push({ channel: "A", name: entry.key, evidence: marker });
      continue; // curated hit — no need to also scan its sources
    }

    const modules = await readHooksModules(entry.installPath, io);
    if (modules === null || modules.length === 0) continue; // no hooks declared — clean

    // hooks declared: fail safe when the dir cannot even be listed
    try {
      await io.list(joinPath(entry.installPath, "hooks"));
    } catch (err) {
      log.info(`conflict scan: hooks dir unscannable (${entry.key}): ${errText(err)}`);
      hits.push({ channel: "A", name: entry.key, evidence: "unscannable" });
      continue;
    }
    if (await scansCompactOverride(entry.installPath, io)) {
      hits.push({ channel: "A", name: entry.key, evidence: "session.compact" });
    }
  }

  return { hits, advisories, rootedNames };
}
