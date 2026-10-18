// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import { runsLog } from "../runs/seams.js";

//  debug dumps — the ring-slot port of src/debug-dump.ts:
// same module, same constants, same content format, three mechanical
// adaptations forced by the $.fs surface (no append, no delete, no rename):
//
//   append   → read-modify-write (the dump file is tens of KB — far under
//              the 4 MiB cap; per-record durability is pi-equivalent modulo
//              the platform's flush semantics);
//   prune    → ring slots: each stage owns `limit` fixed slot filenames
//              <stage>-<slot>.txt, slot 0..limit-1; the first append claims
//              the slot whose existing dump is oldest (the header's started
//              attr, $.fs.stat mtime as tiebreak) and overwrites it — the
//              outcome is pi's prune (at most limit dumps per stage, oldest
//              replaced) with the creation timestamp inside the header;
//   location → <dataDir>/dumps/<sanitized-cwd>/ (the owl data dir seam —
//              outside the project, per-project, the pi shape).
//
// The disable gate (debugDumpLimit 0 — the default) returns a null handle
// and every append no-ops; opening touches NO filesystem (materialization
// is deferred to the first append, exactly pi); nothing here ever throws
// (dumping must not break a stage run). The pure builders below are
// pi-verbatim host copies (the core debug-dump.ts value-imports node:fs,
// which the closure refuses — only its format lives on here).
/** The run-dump buffer the stage call sites fill (host/stage/runs.ts's
 *  StageRunState.dump shape — structural, so this module stays capsule-free
 *  inside the hooks closure). */
export interface StageDumpBuffer {
  outputRows: unknown[];
  handback: { tool: string; result: unknown } | null;
  fabricatedStop: string | null;
  sections: string[];
  pendingCloser: string | null;
}

/** The narrow dump IO surface: the $.fs capsule the wiring injects (the
 *  same data-only-capsule rule as storage's FsAdapter, plus mtime — the
 *  claim tiebreak reads it; listDir of a missing dir yields []). */
export interface DumpFs {
  readText(path: string): Promise<string>;
  writeText(path: string, text: string): Promise<void>;
  listDir(path: string): Promise<string[]> | Promise<readonly string[]>;
  statMtime(path: string): Promise<number | null>;
}

/** What a run needs to open its dump: the fs capsule, the owl data dir,
 *  and the session cwd (the per-project dir stem) plus the debugging stamp
 *  (session/agent — the dumps dir is per-PROJECT, so a file alone cannot
 *  say whose run wrote it). */
export interface StageDumpLocation {
  fs: DumpFs;
  baseDir: string;
  cwd: string;
  session?: string | null;
  agent?: string | null;
}

/** An opened dump: the reserved ring-slot target. Carries no resources —
 *  claiming + materialization happen on the first append. */
export interface StageDumpHandle {
  /** The ring-slot file path this run targets. */
  path: string;
  /** The stage label (the slot filename prefix — also the claim filter). */
  stage: string;
  /** The run's start (the header's started attr; the claim's age key). */
  startedIso: string;
  /** The debugging stamp (the header's session/agent attrs — dumps are
   *  per-project, so attribution rides the file). */
  session: string | null;
  agent: string | null;
  /** Flip side of the deferred materialization: false until the first
   *  append claims the slot. */
  claimed: boolean;
}

const TXT_EXT = ".txt";
/** The `<dump …>` header's `started` attr — the claim's primary age key.
 *  The header may also carry the debugging session/agent stamp after it. */
const STARTED_RE = /started="([^"]*)"/;

/** Sanitize an absolute path for use as a single directory name (pi's
 *  debug-dump.ts, verbatim: strip traversal, separators → "-", keep only
 *  filename-safe chars, collapse/trim hyphens). */
export function sanitizeForPath(value: string): string {
  return value
    .replace(/\.\./g, "") // path traversal
    .replace(/[\\/]/g, "-") // path separators
    .replace(/[^a-zA-Z0-9._-]/g, "") // keep only filename-safe chars
    .replace(/--+/g, "-") // collapse repeated hyphens
    .replace(/^-|-$/g, ""); // strip leading/trailing hyphens
}

/** The ring-slot filename for a stage + slot index. */
function slotPath(dir: string, stage: string, slot: number): string {
  return `${dir}/${stage}-${slot}${TXT_EXT}`;
}

/** Where a run's dump opens. Exported for the wiring (the runs pass the
 *  resolved owl data dir + the session cwd). */
export function dumpsDirFor(baseDir: string, cwd: string): string {
  return `${baseDir.replace(/[\\/]+$/, "")}/dumps/${sanitizeForPath(cwd)}`;
}

/** Reserve a dump slot for a stage run. Touches NO filesystem — the slot
 *  is claimed and the dir materialized on the first append. Returns null
 *  when `limit <= 0` (debugDumpLimit = 0: dumps disabled — the default). */
export function openStageDump(
  stage: string,
  limit: number,
  loc: { baseDir: string; cwd: string; now: number; session?: string | null; agent?: string | null },
): StageDumpHandle | null {
  if (limit <= 0) return null; // dumps disabled (debugDumpLimit = 0)
  const dir = dumpsDirFor(loc.baseDir, loc.cwd);
  const handle: StageDumpHandle = {
    path: slotPath(dir, stage, 0),
    stage,
    startedIso: new Date(loc.now).toISOString(),
    session: loc.session ?? null,
    agent: loc.agent ?? null,
    claimed: false,
  };
  limits.set(handle, limit);
  return handle;
}

/** The started attr of a dump file's header, or null when unreadable /
 *  headerless (the mtime tiebreak covers those). */
async function startedOf(fs: DumpFs, path: string): Promise<string | null> {
  try {
    const head = (await fs.readText(path)).slice(0, 256);
    const m = STARTED_RE.exec(head);
    return m === null ? null : (m[1] ?? null);
  } catch (err) {
    runsLog(`dump slot header unreadable (${path}) — mtime tiebreak decides`, err);
    return null;
  }
}

/** Claim the slot this run overwrites: the lowest FREE slot when any exist,
 *  else the OLDEST occupied one (header started attr; stat mtime tiebreak;
 *  lowest index as the final deterministic tiebreak). Best-effort — an
 *  unreadable slot loses (its content is already unknowable). */
async function claimSlot(fs: DumpFs, handle: StageDumpHandle, limit: number): Promise<number> {
  const dir = handle.path.slice(0, handle.path.lastIndexOf("/"));
  let names: readonly string[] = [];
  try {
    names = await fs.listDir(dir);
  } catch (err) {
    runsLog(`dump slot listDir failed (${dir}) — every slot free`, err);
    names = [];
  }
  const prefix = `${handle.stage}-`;
  const occupied = new Set<number>();
  for (const name of names) {
    if (!name.startsWith(prefix) || !name.endsWith(TXT_EXT)) continue;
    const idx = Number(name.slice(prefix.length, name.length - TXT_EXT.length));
    if (Number.isInteger(idx) && idx >= 0 && idx < limit) occupied.add(idx);
  }
  for (let i = 0; i < limit; i += 1) if (!occupied.has(i)) return i; // lowest free
  let oldest = -1;
  let oldestKey = "";
  for (let i = 0; i < limit; i += 1) {
    const path = slotPath(dir, handle.stage, i);
    const started = (await startedOf(fs, path)) ?? "";
    const mtime = (await fs.statMtime(path)) ?? 0;
    // key: started attr first, stat mtime as the tiebreak (equal starts —
    // and always for a headerless slot, whose empty started sorts oldest),
    // index last — the lexicographic composition keeps the comparison total
    const key = `${started}\u0000${String(mtime).padStart(16, "0")}\u0000${String(i).padStart(6, "0")}`;
    if (oldest === -1 || key < oldestKey) {
      oldest = i;
      oldestKey = key;
    }
  }
  return oldest === -1 ? 0 : oldest;
}

/** Append content to the dump file (read-modify-write). The FIRST append
 *  claims the ring slot (the deferred materialization — an open that never
 *  writes leaves every existing dump untouched). Never throws; no-op on a
 *  null handle (dumps disabled). */
export async function appendDump(fs: DumpFs, handle: StageDumpHandle | null, content: string): Promise<void> {
  if (handle === null) return; // disabled — no-op
  try {
    const limit = limitOf(handle);
    let truncate = false;
    if (!handle.claimed) {
      handle.claimed = true;
      truncate = true; // the claiming append REPLACES the oldest dump (pi's prune+create)
      const dir = handle.path.slice(0, handle.path.lastIndexOf("/"));
      handle.path = slotPath(dir, handle.stage, await claimSlot(fs, handle, limit));
    }
    let prev = "";
    if (!truncate) {
      try {
        prev = await fs.readText(handle.path);
      } catch (err) {
        runsLog(`dump slot read-back empty (${handle.path}) — fresh slot`, err);
        prev = ""; // a fresh slot
      }
    }
    await fs.writeText(handle.path, prev + content);
  } catch (err) {
    runsLog(`dump append failed (${handle.path}) — content lost this call`, err);
    // best-effort — dumping must not break the stage run
  }
}

/** The limit a handle carries: the stage's slot count (stamped at open —
 *  the runs know debugDumpLimit; the map is keyed by handle identity and
 *  dies with it, one handle per run). */
const limits = new WeakMap<StageDumpHandle, number>();

function limitOf(handle: StageDumpHandle): number {
  return limits.get(handle) ?? 1;
}

/** Append a run's dump header durably: the best-effort append can lose its
 *  content (the slot claim survives, the write does not — left live runs
 *  whose dumps started straight at <input>/<output> with the <dump>
 *  <system-prompt> opener gone), so the write is read back and RETRIED once,
 *  and the caller learns whether the header actually landed (false = it
 *  never did — the run logs it instead of silently keeping a headerless
 *  file). Never throws; a null handle (dumps disabled) resolves true. */
export async function appendHeaderDurable(
  fs: DumpFs,
  handle: StageDumpHandle | null,
  header: string,
): Promise<boolean> {
  if (handle === null) return true; // dumps disabled — nothing to place
  for (let attempt = 0; attempt <= 1; attempt += 1) {
    await appendDump(fs, handle, header);
    try {
      const head = (await fs.readText(handle.path)).slice(0, header.length);
      if (head === header) return true;
    } catch (err) {
      runsLog(`dump header read-back failed (${handle.path}) — retrying`, err);
      // unreadable after the write — the retry below gets one more chance
    }
  }
  return false;
}

/** The buffered run dump (host/stage/runs.ts StageDumpState — the call-site
 *  buffer the shim/relay fill; this module materializes it once). */
export interface RunDumpParts {
  inputs: readonly string[];
  sections: readonly string[];
  outputRows: readonly unknown[];
  handback: { tool: string; result: unknown } | null;
  fabricatedStop: string | null;
}

/** Render one output row: a recorded string passes through verbatim; a
 *  role/content row (the engine's captured append rows) renders its text
 *  blocks; anything else JSON-stringifies. Never throws (the JSON fallback
 *  is itself guarded — a circular structure degrades to String()). */
function dumpRowText(row: unknown): string {
  if (typeof row === "string") return row;
  if (typeof row === "object" && row !== null) {
    const r = row as { role?: unknown; content?: unknown };
    if (typeof r.role === "string" && typeof r.content === "string") return `[${r.role}] ${r.content}`;
    if (typeof r.role === "string" && Array.isArray(r.content)) {
      const texts = r.content
        .map((b) =>
          typeof b === "object" && b !== null && (b as { type?: unknown }).type === "text"
            ? String((b as { text?: unknown }).text ?? "")
            : "",
        )
        .filter((t) => t.length > 0);
      if (texts.length > 0) return `[${r.role}] ${texts.join("\n")}`;
    }
  }
  return safeJson(row);
}

/** Append one drain's content (NO footer — the run module drains per
 *  pass/chunk and closes once at run end): the input blocks, the section
 *  wrappers, the output rows, the handback pair, the fabricated stop
 *  marker. Null handle no-ops (disabled). Never throws. */
export async function appendRunParts(fs: DumpFs, handle: StageDumpHandle | null, parts: RunDumpParts): Promise<void> {
  if (handle === null) return;
  let out = "";
  for (const input of parts.inputs) out += `<input>\n${input}\n</input>\n`;
  // section containment: the wrappers must WRAP the drain's content —
  // opener/mid sections render before the rows, closers (the pending
  // closer completeStageRun flushed) render after (pi's <pass>/<chunk>
  // wrap their call's output)
  const closers: string[] = [];
  for (const s of parts.sections) {
    if (s.startsWith("</")) closers.push(s);
    else out += s;
  }
  if (parts.outputRows.length > 0) {
    out += "<output>\n";
    for (const row of parts.outputRows) out += `${dumpRowText(row)}\n`;
    out += "</output>\n";
  }
  if (parts.handback !== null) {
    out += `<handback tool="${parts.handback.tool}">\n${safeJson(parts.handback.result)}\n</handback>\n`;
  }
  if (parts.fabricatedStop !== null) out += `<fabricated-stop>${parts.fabricatedStop}</fabricated-stop>\n`;
  for (const closer of closers) out += closer;
  if (out.length === 0) return;
  await appendDump(fs, handle, out);
}

/** JSON.stringify that never throws (a circular result degrades to
 *  String() — the "never throws" dump contract holds everywhere). */
function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch (err) {
    runsLog("dump JSON.stringify degraded to String()", err);
    return String(value);
  }
}

/** The closing tag appended at run end (pi-verbatim). */
const DUMP_FOOTER = "</dump>\n";

/** Close a run's dump: drain any remaining parts, then the footer. Null
 *  handle no-ops. Never throws. */
export async function flushRunDump(fs: DumpFs, handle: StageDumpHandle | null, parts: RunDumpParts): Promise<void> {
  if (handle === null) return;
  await appendRunParts(fs, handle, parts);
  await appendDump(fs, handle, DUMP_FOOTER);
}

/** Format one `<tool name=…>` block (pi-verbatim host copy): description +
 *  parameters JSON; the description tag is omitted for a tool without one. */
export function dumpToolBlock(tool: { name: string; description?: string; parameters: unknown }): string {
  const description =
    typeof tool.description === "string" && tool.description.length > 0
      ? `<description>\n${tool.description}\n</description>\n`
      : "";
  return `<tool name="${tool.name}">\n${description}<parameters>\n${JSON.stringify(tool.parameters)}\n</parameters>\n</tool>\n`;
}

/** Format the dump header (pi-verbatim host copy): the `<dump>` open tag
 *  with stage + started attrs, the `<system-prompt>` block, and a `<tools>`
 *  block when there are any (a toolless run omits the section). */
export function stageDumpHeader(
  stage: string,
  startedIso: string,
  systemPrompt: string,
  tools: readonly { name: string; description?: string; parameters: unknown }[],
  stamp?: { session: string | null; agent: string | null },
): string {
  const toolBlocks = tools.map((tool) => dumpToolBlock(tool)).join("");
  const toolsSection = toolBlocks.length > 0 ? `<tools>\n${toolBlocks}</tools>\n` : "";
  const sessionAttr = stamp?.session != null && stamp.session !== "" ? ` session="${stamp.session}"` : "";
  const agentAttr = stamp?.agent != null && stamp.agent !== "" ? ` agent="${stamp.agent}"` : "";
  return (
    `<dump stage="${stage}" started="${startedIso}"${sessionAttr}${agentAttr}>\n` +
    `<system-prompt>\n${systemPrompt}\n</system-prompt>\n` +
    toolsSection
  );
}

/** The empty archive view (the drain no-op when nothing accumulated). */
export const EMPTY_ARCHIVE: {
  outputRows: unknown[];
  handback: { tool: string; result: unknown } | null;
  fabricatedStop: string | null;
  sections: string[];
} = { outputRows: [], handback: null, fabricatedStop: null, sections: [] };

/** Adapt a stage's archived dump into RunDumpParts (the run modules' drain
 *  convenience — takeStageDump's shape maps 1:1). */
export function partsFromArchive(archive: {
  sections: readonly string[];
  outputRows: readonly unknown[];
  handback: { tool: string; result: unknown } | null;
  fabricatedStop: string | null;
}): RunDumpParts {
  return {
    inputs: [],
    sections: [...archive.sections],
    outputRows: [...archive.outputRows],
    handback: archive.handback,
    fabricatedStop: archive.fabricatedStop,
  };
}
