// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// The bounded source scan for foreign compaction overriders (Channels
// A/B). pi's walk discipline and constants port verbatim
// (src/conflicts/detect.ts): depth 2, ≤40 scannable files per package,
// ≤4 MiB per file, node_modules/dotfiles/.d.ts skipped, never throwing.
// The registration marker adapts to the platform's seam: Claude compaction
// hooks register on("session.compact", …) and an OVERRIDER answers the
// event — `return { messages: … }` / `return { skip: … }` near the
// registration (pi's shapes were cancel/summary). Registration alone is
// not a conflict: passive listeners are fine.

/** The filesystem seam (the $-capsule bridge supplies it at runtime). */
function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export interface ScanIo {
  /** Directory listing (name + kind), like $.fs.list. */
  list: (dir: string) => Promise<Array<{ name: string; kind: "file" | "directory" }>>;
  /** Whole-file read, like $.fs.read. */
  read: (path: string) => Promise<string>;
  /** Size probe, like $.fs.stat. */
  stat: (path: string) => Promise<{ size: number }>;
}

/** One detected foreign compaction handler (the hit record). */
export interface ConflictHit {
  /** Which channel found it: "A" (disk), "A-prime" (fold list), "B" (live envelope), "C" (integrity net). */
  channel: "A" | "A-prime" | "B" | "C";
  /** The mod's identity: registry key, envelope name, or fold-list entry. */
  name: string;
  /** What matched: the scan marker, the envelope's event pattern, or the row door. */
  evidence: string;
}

/** Bounded-scan limits: activation must stay fast even with many mods. */
export const SCAN_MAX_DEPTH = 2;
/** The depth a fresh scan starts at (explicit at every root call site). */
export const SCAN_ROOT_DEPTH = 0;
export const SCAN_MAX_FILES_PER_PACKAGE = 40;
export const SCAN_MAX_FILE_BYTES = 4 * 1024 * 1024;

const SCAN_ROOT_BUDGET = (): { files: number } => ({ files: SCAN_MAX_FILES_PER_PACKAGE });

const COMPACT_HOOK_MARKER = "session.compact";

/**
 * Override-shaped return near a compaction-hook registration: `return
 * { messages… }` / `return { skip… }` / the arrow-object `=> ({ … })` form,
 * within the pi-verbatim window (1200 chars to the return, 260 inside it).
 * Merely REGISTERING the hook is not a conflict — passive listeners are
 * exempt; best-effort by nature (indirect/delegated returns defeat syntax
 * matching — those live on the curated list, which ships empty).
 */
const COMPACT_OVERRIDE_PATTERN =
  /on\(["']session\.compact["'][\s\S]{0,1200}?(?:return\s*\{|\)\s*:\s*\{|\]\s*:\s*\{|=>\s*\(\s*\{)[^}]{0,260}?(messages|skip)\b/i;

function isScannableSource(file: string): boolean {
  if (file.endsWith(".d.ts")) return false; // type-decl mentions are not runtime registrations
  return /\.(js|cjs|mjs|ts)$/.test(file);
}

/**
 * Bounded recursive walk: does any runtime source in `dir` contain an
 * override-shaped compaction-hook registration? Depth + budget explicit at
 * every call site (roots pass the fresh-scan constants). Never throws —
 * unreadable entries are skipped (pi: "never crash activation over a
 * scan").
 */
export async function scansCompactOverride(
  dir: string,
  io: ScanIo,
  depth = SCAN_ROOT_DEPTH,
  budget: { files: number } = SCAN_ROOT_BUDGET(),
): Promise<boolean> {
  if (depth > SCAN_MAX_DEPTH) return false;
  let entries: Array<{ name: string; kind: "file" | "directory" }>;
  try {
    entries = await io.list(dir);
  } catch (err) {
    log.info(`conflict scan: dir list failed (${dir}): ${errText(err)}`);
    return false;
  }
  for (const ent of entries) {
    if (ent.name === "node_modules" || ent.name.startsWith(".")) continue;
    const full = joinPath(dir, ent.name);
    if (ent.kind === "directory") {
      if (await scansCompactOverride(full, io, depth + 1, budget)) return true;
      continue;
    }
    if (ent.kind !== "file" || !isScannableSource(ent.name) || budget.files <= 0) continue;
    try {
      if ((await io.stat(full)).size > SCAN_MAX_FILE_BYTES) continue;
      if (COMPACT_OVERRIDE_PATTERN.test(await io.read(full))) return true;
    } catch (err) {
      log.info(`conflict scan: file read failed (${full}): ${errText(err)}`);
      // unreadable file — skip, never crash activation over a scan
    } finally {
      budget.files -= 1;
    }
  }
  return false;
}

/** Platform-join (the io paths are engine strings; backslash-safe join). */
export function joinPath(dir: string, name: string): string {
  const sep = dir.includes("\\") && !dir.includes("/") ? "\\" : "/";
  return `${dir.replace(/[\\/]+$/, "")}${sep}${name}`;
}

export { COMPACT_HOOK_MARKER, COMPACT_OVERRIDE_PATTERN };

import { log } from "../../core/src/log.js";
