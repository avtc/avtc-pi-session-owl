// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// Chain repair: detect broken parent links in a session file (entries whose
// parentId references an id that never made it to disk — a lost append while
// the in-memory tree advanced) and stitch them in place. A broken link stops
// pi's parent-chain walk, so every load after the loss sees only the tail:
// session-owl's reconstruction loses everything before the gap.
//
// Repair = per-orphan re-parent onto the previous file-order entry (appends
// always follow their parents, so the predecessor is the lost parent's slot).
// The patch is byte-length-preserving (ids are equal-length), written in place
// through r+b without truncation — a concurrently appending pi is unaffected
// (appends land at EOF). A fresh file scan (not the host's in-memory entries)
// decides what to patch, so a second process that already repaired the file
// turns the run into a no-op. The file is backed up before any byte changes.

import { closeSync, copyFileSync, existsSync, openSync, readdirSync, readSync, unlinkSync, writeSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { log } from "../log.js";

// --- shared types -----------------------------------------------------------

/** The entry shape chain repair reads (a structural slice of any session entry). */
export interface ChainRepairEntry {
  type?: string;
  id?: string;
  parentId?: string | null;
}

/** One entry whose parentId references an id absent from the file. */
export interface ChainOrphan {
  entryId: string;
  brokenParentId: string;
}

/** The outcome of a file repair attempt. */
export interface ChainRepairResult {
  ok: boolean;
  /** How many links were stitched (0 when the file was already clean). */
  stitched: number;
  /** True when the fresh scan found nothing to fix (concurrent repair). */
  alreadyClean: boolean;
  /** The backup path on success, or the failure reason when ok is false. */
  backupPath?: string;
  reason?: string;
}

// --- protected texts ----------------------------------------------------------

export const CHAIN_DETECT_TITLE = "🦉 session-owl — broken session chain detected";
export const CHAIN_REPAIRED_TITLE = "🦉 session-owl — session file repaired";
export const CHAIN_FAILED_TITLE = "🦉 session-owl — session file repair failed";
export const CLOSE_PI_BUTTON = "Close pi";

export function chainDetectMessage(count: number): string {
  return `Found ${count} broken parent link(s). Yes — session file will be backup-ed and repaired then pi will be closed so you would need to restart. No — stay in the session; session-owl memory cannot work correctly until file is repaired.`;
}

export function chainRepairedMessage(count: number, backupPath: string): string {
  return `Session file repaired: ${count} broken parent link(s) stitched. Backup at: ${backupPath}. Restart pi to continue.`;
}

export function chainFailedMessage(count: number, reason: string): string {
  return `Found ${count} broken parent link(s), repair failed (${reason}). session-owl cannot work correctly until the file is repaired.`;
}

// --- detection ----------------------------------------------------------------

/** Entries whose parentId is truthy but references no entry in the file.
 *  Session headers are excluded from the id set the same way the host's
 *  loader excludes them, so a parent pointing at a header is an orphan too. */
export function findChainOrphans(entries: readonly ChainRepairEntry[]): ChainOrphan[] {
  const ids = new Set<string>();
  for (const entry of entries) {
    if (entry.type === "session" || typeof entry.id !== "string" || entry.id === "") continue;
    ids.add(entry.id);
  }
  const orphans: ChainOrphan[] = [];
  for (const entry of entries) {
    if (entry.type === "session" || typeof entry.id !== "string" || entry.id === "") continue;
    const parent = entry.parentId;
    if (typeof parent === "string" && parent !== "" && !ids.has(parent)) {
      orphans.push({ entryId: entry.id, brokenParentId: parent });
    }
  }
  return orphans;
}

// --- file scan ----------------------------------------------------------------

/** Per-line scan metadata: enough to plan stitches without holding the file. */
interface LineMeta {
  id: string | undefined;
  parentId: string | undefined;
  isSession: boolean;
  /** Byte offset of the parentId value's opening byte (the char after `"parentId":"`). */
  parentIdValueOffset: number | undefined;
  /** Byte length of the parentId value. */
  parentIdValueLength: number | undefined;
}

/** The read-chunk size for the streaming scan. */
const SCAN_CHUNK_BYTES = 1024 * 1024;
/** Buffer slot where scanned/appended bytes start (writeSync/readSync args). */
const BUFFER_START = 0;
/** The sequential file position for readSync (follow the fd's cursor). */
const SEQUENTIAL_POSITION = null;

/**
 * Stream the file once, keeping one small metadata row per line. Byte offsets
 * are exact (multi-byte prefixes accounted for via byteLength of the slice).
 */
function scanFile(filePath: string, onLine: (line: string, lineStart: number, meta: LineMeta) => void): void {
  const fd = openSync(filePath, "r");
  try {
    const buffer = Buffer.allocUnsafe(SCAN_CHUNK_BYTES);
    let pending = Buffer.alloc(0);
    let lineStart = 0;
    while (true) {
      const bytesRead = readSync(fd, buffer, BUFFER_START, buffer.length, SEQUENTIAL_POSITION);
      if (bytesRead === 0) break;
      pending = Buffer.concat([pending, buffer.subarray(0, bytesRead)]);
      let newlineIndex = pending.indexOf(0x0a);
      while (newlineIndex !== -1) {
        const line = pending.subarray(0, newlineIndex).toString("utf8");
        onLine(line, lineStart, metaFor(line, lineStart));
        lineStart += newlineIndex + 1;
        pending = pending.subarray(newlineIndex + 1);
        newlineIndex = pending.indexOf(0x0a);
      }
    }
    if (pending.length > 0) {
      const line = pending.toString("utf8");
      onLine(line, lineStart, metaFor(line, lineStart));
    }
  } finally {
    closeSync(fd);
  }
}

/** Build a line's scan metadata (id, parentId, value byte offset/length). */
function metaFor(line: string, lineStart: number): LineMeta {
  const meta: LineMeta = {
    id: undefined,
    parentId: undefined,
    isSession: true,
    parentIdValueOffset: undefined,
    parentIdValueLength: undefined,
  };
  if (!line.trim()) return meta;
  try {
    const entry = JSON.parse(line) as ChainRepairEntry;
    meta.isSession = entry.type === "session";
    meta.id = typeof entry.id === "string" ? entry.id : undefined;
    if (typeof entry.parentId === "string" && entry.parentId !== "") {
      const needle = `"parentId":"${entry.parentId}"`;
      const index = line.indexOf(needle);
      if (index !== -1) {
        const valueIndex = index + `"parentId":"`.length;
        meta.parentId = entry.parentId;
        meta.parentIdValueOffset = lineStart + Buffer.byteLength(line.slice(0, valueIndex), "utf8");
        meta.parentIdValueLength = Buffer.byteLength(entry.parentId, "utf8");
      }
    }
  } catch {
    // malformed lines contribute nothing (same tolerance as the host loader)
  }
  return meta;
}

// --- repair -------------------------------------------------------------------

/** Backup file suffix pattern: `<session>.owlbak-<stamp>`. */
const BACKUP_SUFFIX = ".owlbak-";
/** How many backups to keep (each is a full copy; disk space matters). */
const BACKUPS_TO_KEEP = 1;

/** Deterministic stamp seam for tests; null = wall clock. */
let stampOverride: string | null = null;

/** Override the backup stamp (tests); null restores the clock. */
export function _setChainRepairStampForTest(stamp: string | null): void {
  stampOverride = stamp;
}

/** The backup stamp: YYYYMMDD-HHMMSS (UTC, filesystem-safe). */
function backupStamp(): string {
  if (stampOverride !== null) return stampOverride;
  return new Date().toISOString().replace(/[-:]/g, "").replace(/T/, "-").slice(0, 15);
}

/** Copy the session file next to itself and prune older backups. */
function backupSessionFile(sessionFile: string): string {
  const backupPath = `${sessionFile}${BACKUP_SUFFIX}${backupStamp()}`;
  copyFileSync(sessionFile, backupPath);
  const prefix = `${basename(sessionFile)}${BACKUP_SUFFIX}`;
  const siblings = readdirSync(dirname(sessionFile))
    .filter((name) => name.startsWith(prefix) && name !== basename(backupPath))
    .sort()
    .reverse();
  const excess = Math.max(0, siblings.length - (BACKUPS_TO_KEEP - 1));
  for (let i = 0; i < excess; i += 1) {
    try {
      unlinkSync(join(dirname(sessionFile), siblings[i]));
    } catch (err) {
      log.warn(`chain-repair: could not prune old backup ${siblings[i]}: ${String(err)}`);
    }
  }
  return backupPath;
}

/** One planned byte patch: replace the parentId value at the recorded offset. */
interface Stitch {
  valueOffset: number;
  oldParentId: string;
  newParentId: string;
  entryId: string;
}

/**
 * Repair the session file in place: back it up, fresh-scan for orphans, stitch
 * each onto the previous file-order entry (equal byte length enforced), and
 * verify by re-scanning. Never throws — failures come back as `ok: false`
 * with a reason.
 */
export function repairSessionChainFile(sessionFile: string): ChainRepairResult {
  if (!existsSync(sessionFile)) {
    return { ok: false, stitched: 0, alreadyClean: false, reason: `session file not found: ${sessionFile}` };
  }
  // Fresh scan #1: line metadata + the id set.
  const lines: LineMeta[] = [];
  const ids = new Set<string>();
  scanFile(sessionFile, (_line, _start, meta) => {
    lines.push(meta);
    if (!meta.isSession && meta.id !== undefined && meta.id !== "") ids.add(meta.id);
  });
  // Plan stitches from the scan rows (previous parsed entry = the lost parent's slot).
  const stitches: Stitch[] = [];
  let previous: LineMeta | null = null;
  for (const meta of lines) {
    if (meta.isSession || meta.id === undefined || meta.id === "") continue;
    const id = meta.id;
    if (meta.parentId !== undefined && !ids.has(meta.parentId)) {
      const prevId = previous?.id;
      if (previous === null) {
        return { ok: false, stitched: 0, alreadyClean: false, reason: `no previous entry to stitch ${id} onto` };
      }
      if (prevId === undefined || prevId === "") {
        return { ok: false, stitched: 0, alreadyClean: false, reason: `previous entry before ${id} has no id` };
      }
      if (meta.parentIdValueOffset === undefined || meta.parentIdValueLength === undefined) {
        return { ok: false, stitched: 0, alreadyClean: false, reason: `parentId not locatable in the ${id} line` };
      }
      if (Buffer.byteLength(prevId, "utf8") !== meta.parentIdValueLength) {
        return {
          ok: false,
          stitched: 0,
          alreadyClean: false,
          reason: `length mismatch: ${id}.parentId (${meta.parentIdValueLength} bytes) vs ${prevId} (${Buffer.byteLength(prevId, "utf8")})`,
        };
      }
      stitches.push({
        valueOffset: meta.parentIdValueOffset,
        oldParentId: meta.parentId,
        newParentId: prevId,
        entryId: id,
      });
    }
    previous = meta;
  }
  if (stitches.length === 0) {
    return { ok: true, stitched: 0, alreadyClean: true };
  }
  // Backup before any byte changes; a failed backup aborts the repair.
  let backupPath: string;
  try {
    backupPath = backupSessionFile(sessionFile);
  } catch (err) {
    return { ok: false, stitched: 0, alreadyClean: false, reason: `backup failed: ${String(err)}` };
  }
  // In-place, byte-length-preserving writes (no truncation — appends are safe).
  const fd = openSync(sessionFile, "r+");
  try {
    for (const stitch of stitches) {
      const value = Buffer.from(stitch.newParentId, "utf8");
      const written = writeSync(fd, value, BUFFER_START, value.length, stitch.valueOffset);
      if (written !== value.length) {
        return {
          ok: false,
          stitched: 0,
          alreadyClean: false,
          reason: `short write at byte ${stitch.valueOffset}`,
          backupPath,
        };
      }
    }
  } finally {
    closeSync(fd);
  }
  // Fresh scan #2: the file must now be orphan-free.
  const orphansAfter = countOrphansByScan(sessionFile);
  if (orphansAfter > 0) {
    return {
      ok: false,
      stitched: 0,
      alreadyClean: false,
      reason: `verify failed: ${orphansAfter} broken link(s) remain`,
      backupPath,
    };
  }
  return { ok: true, stitched: stitches.length, alreadyClean: false, backupPath };
}

/** Re-scan the file and count orphans (the post-patch verification). */
function countOrphansByScan(sessionFile: string): number {
  const ids = new Set<string>();
  const metas: LineMeta[] = [];
  scanFile(sessionFile, (_line, _start, meta) => {
    metas.push(meta);
    if (!meta.isSession && meta.id !== undefined && meta.id !== "") ids.add(meta.id);
  });
  let count = 0;
  for (const meta of metas) {
    if (
      !meta.isSession &&
      meta.id !== undefined &&
      meta.id !== "" &&
      meta.parentId !== undefined &&
      !ids.has(meta.parentId)
    ) {
      count += 1;
    }
  }
  return count;
}

// --- startup flow --------------------------------------------------------------

/** The repaired-dialog auto-dismiss window; any dismissal closes pi. */
const CLOSE_DIALOG_TIMEOUT_MS = 60_000;

/** What the startup flow decided. */
export type ChainRepairOutcome = "no-issue" | "declined" | "repaired" | "failed";

/**
 * The session-start chain-repair gate: detect broken parent links from the
 * host's parsed entries (cheap, no file IO), then either ask (dialog-capable)
 * or repair right away (headless). On a successful repair pi is closed — the
 * running process keeps the broken chain in memory, so the fixed file needs a
 * restart to matter. Declines and failures leave the session running.
 */
export async function runChainRepairFlow(ctx: ExtensionContext): Promise<ChainRepairOutcome> {
  const entries = ctx.sessionManager.getEntries() as ChainRepairEntry[];
  const orphans = findChainOrphans(entries);
  if (orphans.length === 0) return "no-issue";
  log.error(`chain-repair: detected ${orphans.length} broken parent link(s)`);
  const sessionFile = ctx.sessionManager.getSessionFile();
  if (sessionFile === undefined) {
    log.error("chain-repair: failed — no session file path");
    return "failed";
  }
  if (ctx.hasUI) {
    const consent = await ctx.ui.confirm(CHAIN_DETECT_TITLE, chainDetectMessage(orphans.length));
    if (!consent) {
      log.info("chain-repair: user declined repair");
      return "declined";
    }
  }
  const result = repairSessionChainFile(sessionFile);
  if (!result.ok) {
    log.error(`chain-repair: failed — ${result.reason}`);
    if (ctx.hasUI) {
      await ctx.ui.confirm(CHAIN_FAILED_TITLE, chainFailedMessage(orphans.length, result.reason ?? "unknown"));
    }
    return "failed";
  }
  if (result.alreadyClean) {
    log.info("chain-repair: fresh scan found no broken links (repaired by another process)");
    return "no-issue";
  }
  log.error(`chain-repair: backup at ${result.backupPath}`);
  log.error(`chain-repair: stitched ${result.stitched} link(s), verified`);
  const message = chainRepairedMessage(result.stitched, result.backupPath ?? "");
  if (ctx.hasUI) {
    await ctx.ui.select(`${CHAIN_REPAIRED_TITLE}\n${message}`, [CLOSE_PI_BUTTON], { timeout: CLOSE_DIALOG_TIMEOUT_MS });
  } else {
    ctx.ui.notify(`${CHAIN_REPAIRED_TITLE}\n${message}`, "error");
  }
  ctx.shutdown();
  return "repaired";
}
