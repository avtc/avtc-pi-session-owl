// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// Stage dumps — one timestamped file per Observer/Builder/Selector/goal-extract
// LLM run, capturing what the model saw (system prompt, tools, per-call input)
// and produced (thinking, text, tool calls, results) in the tagged memory
// format. Gated by the `debugDumpLimit` setting (0 = disabled): `openStageDump`
// returns null and every `appendDump` becomes a no-op. Writes are synchronous
// (appendFileSync) so output is flushed immediately — nothing is lost if the
// process dies mid-run. Materialization (dir creation + pruning of older
// same-stage dumps) is deferred to the FIRST append: a run that opens but never
// writes (skipped early, or a throw before the header) leaves the dump dir and
// every existing dump untouched — opening never destroys debug data.
//
// Location: ~/.pi/session-owl/dumps/<sanitized-cwd>/ — OUTSIDE the project so
// dumps never land in a repo (.pi is not gitignored by default in user
// projects) and survive the project being moved/cleaned. The sanitized cwd
// (path separators → "-", filename-safe chars only) keeps per-project dumps
// separate, mirroring the featyard artifact-path convention.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";

/** "Dumps disabled" sentinel — the null dump path (every append no-ops). */
export const NO_DUMP: string | null = null;
/** "Use the default dump dir" (~/.pi/session-owl/dumps/<sanitized-cwd>) — the null dumpDir. */
export const DEFAULT_DUMP_BASE: string | null = null;

const TXT_EXT = ".txt";
/** Monotonic counter for same-millisecond dump ordering (deterministic prune
 *  order: filename sort = creation order within a process). */
let dumpCounter = 0;

/** Opened-but-not-yet-written dumps: path → where/how to materialize. Consumed
 *  by the first `appendDump` (dir creation + prune happen there, not at open). */
const pendingDumps = new Map<string, { dir: string; stage: string; limit: number }>();

/** Sanitize an absolute path for use as a single directory name (featyard
 *  artifact-path convention: strip traversal, separators → "-", keep only
 *  filename-safe chars, collapse/trim hyphens). */
export function sanitizeForPath(value: string): string {
  return value
    .replace(/\.\./g, "") // path traversal
    .replace(/[\\/]/g, "-") // path separators
    .replace(/[^a-zA-Z0-9._-]/g, "") // keep only filename-safe chars
    .replace(/--+/g, "-") // collapse repeated hyphens
    .replace(/^-|-$/g, ""); // strip leading/trailing hyphens
}

/** Test seam for the home dir (os.homedir is not spyable under ESM). */
let dumpHomeOverride: string | null = null;
/** Override the home dir used for the default dump location (tests). */
export function _setDumpHomeForTest(home: string | null): void {
  dumpHomeOverride = home;
}

/** The default dump dir for THIS project: ~/.pi/session-owl/dumps/<sanitized-cwd>/. */
function defaultProjectDumpDir(): string {
  const home = dumpHomeOverride ?? os.homedir();
  return path.join(home, ".pi", "session-owl", "dumps", sanitizeForPath(process.cwd()));
}

/**
 * Reserve a new timestamped dump path `<stage>-<isoTs>-<counter>-<nonce>.txt`
 * under `<dumpDir | default>` and return it. Touches NO filesystem —
 * the dir is created, and older files with the same stage prefix are pruned to
 * keep at most `limit` (newest kept), on the dump's FIRST `appendDump`. Returns
 * null when `limit <= 0` (dumps disabled).
 *
 * `dumpDir: string | null` — the dump dir; null uses the default
 *  `~/.pi/session-owl/dumps/<sanitized-cwd>/`. Tests inject a temp dir so they
 *  never touch the user's home.
 */
export function openStageDump(stage: string, limit: number, dumpDir: string | null): string | null {
  if (limit <= 0) return null; // dumps disabled (debugDumpLimit = 0)
  const dir = dumpDir ?? defaultProjectDumpDir();
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  // Filename = <stage>-<isoTs>-<paddedCounter>-<nonce>.txt: the padded counter
  // breaks same-ms ties deterministically (pruning sorts by filename, not
  // mtime); the nonce guards cross-process/restart collisions.
  const seq = dumpCounter++;
  const nonce = Math.random().toString(16).slice(2, 8);
  const dumpPath = path.join(dir, `${stage}-${timestamp}-${seq.toString().padStart(6, "0")}-${nonce}${TXT_EXT}`);
  pendingDumps.set(dumpPath, { dir, stage, limit });
  return dumpPath;
}

/** Delete oldest same-stage dumps so the new file keeps the count at `limit`.
 *  Best-effort: a locked file (Windows editor/AV) is skipped — the count can
 *  exceed the limit until the lock clears. */
function pruneStageDumps(dir: string, stage: string, limit: number): void {
  const existing = fs
    .readdirSync(dir)
    .filter((f) => f.startsWith(`${stage}-`) && f.endsWith(TXT_EXT))
    .sort()
    .map((f) => path.join(dir, f));
  while (existing.length >= limit) {
    const oldest = existing.shift();
    if (!oldest) break;
    try {
      fs.unlinkSync(oldest);
    } catch {
      /* best-effort */
    }
  }
}

/** Append content to a dump file (synchronously flushed). Never throws. The
 *  first append to a freshly opened dump creates the dump dir and prunes
 *  older same-stage dumps to the limit; no-op on a null path (dumps disabled)
 *  — call sites pass the `openStageDump` result through unconditionally. */
export function appendDump(dumpPath: string | null, content: string): void {
  if (!dumpPath) return; // disabled — no-op
  try {
    const pending = pendingDumps.get(dumpPath);
    if (pending !== undefined) {
      pendingDumps.delete(dumpPath);
      if (!fs.existsSync(pending.dir)) fs.mkdirSync(pending.dir, { recursive: true });
      pruneStageDumps(pending.dir, pending.stage, pending.limit);
    }
    fs.appendFileSync(dumpPath, content);
  } catch {
    // best-effort — dumping must not break the stage run
  }
}

/** The closing tag appended at run end. */
export const DUMP_FOOTER = "</dump>\n";

/** Format one `<tool name=…>` block (description + parameters JSON; the
 *  description tag is omitted for a tool without one). Pure — no I/O. Shared
 *  by the dump header and per-chunk tool records (the Observer's
 *  `record_observations` differs per chunk only in its `allowedIds`). */
export function dumpToolBlock(tool: AgentTool): string {
  const description =
    typeof tool.description === "string" && tool.description.length > 0
      ? `<description>\n${tool.description}\n</description>\n`
      : "";
  return `<tool name="${tool.name}">\n${description}<parameters>\n${JSON.stringify(tool.parameters)}\n</parameters>\n</tool>\n`;
}

/** Format the dump header: the `<dump>` open tag with stage + started attrs and
 *  the `<system-prompt>` block, plus a `<tools>` block (one `<tool name=…>` per
 *  tool) when there are any — a toolless run (goal-extract one-shot) omits the
 *  section. Pure — no I/O, testable. */
export function stageDumpHeader(
  stage: string,
  startedIso: string,
  systemPrompt: string,
  tools: readonly AgentTool[],
): string {
  const toolBlocks = tools.map((tool) => dumpToolBlock(tool)).join("");
  const toolsSection = toolBlocks.length > 0 ? `<tools>\n${toolBlocks}</tools>\n` : "";
  return (
    `<dump stage="${stage}" started="${startedIso}">\n` +
    `<system-prompt>\n${systemPrompt}\n</system-prompt>\n` +
    toolsSection
  );
}
