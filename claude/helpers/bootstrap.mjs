// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>
//
// The user-run transcript bootstrap: streams a transcript JSONL line-by-line
// (never holding the file) and writes owl mirror batches directly into the
// session's owl directory — engine uninvolved. A summary JSON line goes to
// stderr (files are the output).
//
// Usage:
//   node helpers/bootstrap.mjs <transcript.jsonl> [--config-dir <dir>]
//        [--session-id <id>] [--after <uuid>] [--live-path] [--page-bytes N] [--limit K]
//
// Row derivation: transcript rows carry type/isMeta/compact_boundary where
// the live event carries door/origin — the same outcome mapping as the
// host's transcript-reader (test-pinned together). Batch naming follows the
// storage writer: m<seq>-<p8>.jsonl with .k<n> continuation parts under ONE
// seq per run, each under the page budget. The oversized-row .p<k> part
// mechanism of the TS writer is not reimplemented (a single row above the
// budget lands whole — unreachable at observed row sizes). Exit codes:
// 0 ok, 1 stream/read failure (summary carries {error}), 2 usage.

import { createReadStream, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";
import { createInterface } from "node:readline";

const argv = process.argv.slice(2);
const file = argv[0];
const flag = (name, def) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? def : argv[i + 1];
};
// a string flag whose value is another flag token (--session-id --limit 5)
// would silently operate on a garbage dir — reject it up front
const stringFlag = (name, def) => {
  const raw = flag(name, null);
  if (raw === null) return def;
  if (typeof raw !== "string" || raw === "undefined" || raw.startsWith("--")) {
    process.stderr.write(
      "usage: node helpers/bootstrap.mjs <transcript.jsonl> [--config-dir <dir>] [--session-id <id>] [--after <uuid>] [--live-path] [--page-bytes N] [--limit K]\n" +
        `note: --${name} needs a value that is not another flag\n`,
    );
    process.exit(2);
  }
  return raw;
};
const numericFlag = (name, def) => {
  const raw = flag(name, null);
  if (raw === null) return def;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    process.stderr.write(`invalid --${name}: ${raw}\n`);
    process.exit(2);
  }
  return n;
};

if (file === undefined) {
  process.stderr.write(
    "usage: node helpers/bootstrap.mjs <transcript.jsonl> [--config-dir <dir>] [--session-id <id>] [--after <uuid>] [--live-path] [--page-bytes N] [--limit K]\n" +
      "note: a rerun re-writes rows (no absent-check here — pass --after <lastMirroredUuid> to bound it)\n",
  );
  process.exit(2);
}

const configDir =
  stringFlag("config-dir", null) ??
  process.env.CLAUDE_CONFIG_DIR ??
  join(process.env.HOME ?? process.env.USERPROFILE ?? ".", ".claude");
const sessionIdRaw = stringFlag("session-id", null) ?? (file.split(/[\\/]/).pop() ?? "").replace(/\.jsonl$/, "");
// The layout's sanitizer invariant (host/state.ts sanitize): percent-encode
// everything outside [A-Za-z0-9._-], and never a bare '.'/'..' segment — a
// raw id containing path separators must not escape the sessions root.
// The layout's sanitizer invariant (host/state.ts sanitize is the CANONICAL
// rule — this copy exists only because a Node .mjs helper cannot import the
// TS module; keep the two byte-identical and change them together).
function sanitizeSegment(segment) {
  let clean = segment.replace(/[^a-zA-Z0-9._-]/g, (ch) => `%${ch.charCodeAt(0).toString(16).padStart(2, "0")}`);
  if (clean === "." || clean === "..") clean = "_";
  return clean.length > 0 ? clean : "_";
}
const sessionId = sanitizeSegment(sessionIdRaw);
const afterPresent = argv.includes("--after");
const afterRaw = flag("after", null);
if (afterPresent && (typeof afterRaw !== "string" || afterRaw === "undefined" || afterRaw.startsWith("--"))) {
  // a valueless --after (trailing flag) or a flag token as its value
  // (e.g. `--after --limit 5`) would otherwise never match any row and
  // silently mirror NOTHING (exit 0, zero rows) — reject it like the
  // sibling helpers reject malformed values
  process.stderr.write(
    "usage: node helpers/bootstrap.mjs <transcript.jsonl> [--config-dir <dir>] [--session-id <id>] [--after <uuid>] [--live-path] [--page-bytes N] [--limit K]\n" +
      "note: a rerun re-writes rows (no absent-check here — pass --after <lastMirroredUuid> to bound it)\n",
  );
  process.exit(2);
}
const afterUuid = afterPresent ? afterRaw : null;
const livePathMode = argv.includes("--live-path");
const pageBytes = numericFlag("page-bytes", 3 * 1024 * 1024); // stay under the 4 MiB cap
const limit = numericFlag("limit", Infinity);

const sessDir = join(configDir, "session-owl", "sessions", sessionId);
mkdirSync(sessDir, { recursive: true });

// the producer tag must be hexadecimal (the batch-name grammar) and carry
// BOTH a timestamp and the pid inside its 8 chars: last-4 ts hex + pid hex
// padded to 4 — concurrent runs differ by pid, sequential runs by the seq
// scan, so names never collide
const producer8 = `${Date.now().toString(16).slice(-4)}${process.pid.toString(16).padStart(4, "0")}`.slice(0, 8);
let seq = 0;
for (const name of readdirSync(sessDir)) {
  const m = /^m(\d+)-/.exec(name);
  if (m !== null) seq = Math.max(seq, Number(m[1]));
}
seq += 1;

/** UTF-8 byte length without allocating a buffer (the page budget and the
 *  platform cap are BYTES; JS string length is UTF-16 code units — CJK
 *  content inflates 3x over the char count). */
function byteLength(text) {
  let bytes = 0;
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff) {
      bytes += 4;
      i += 1;
    } else bytes += 3;
  }
  return bytes;
}

/** The concatenated text of a meta row's message content (the
 *  system-reminder stamp lives inside the text) — parity with the host
 *  reader's transcriptMetaText. */
function metaText(row) {
  const content = row.message?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  let out = "";
  for (const b of content) {
    if (typeof b === "object" && b !== null && b.type === "text" && typeof b.text === "string") out += b.text;
  }
  return out;
}

/** The door/origin derivation (outcome parity with the host reader:
 *  conversation rows are type user|assistant with a uuid; everything else
 *  is metadata and skipped upstream). The isMeta split matches the host's
 *  rowFromTranscript exactly: reminder-tag rows are the skipped engine
 *  class, other isMeta USER rows are plugin appends (the note door with a
 *  plugin origin — the grouper's custom_message split). The compaction
 *  door rides the row's own flag OR the pending-boundary carry — this
 *  build writes the boundary as a preceding system row and stamps nothing
 *  on the summary row itself. */
function deriveRow(row, atBoundary) {
  let door = "prompt";
  let origin = { kind: "composer" };
  if (row.compact_boundary === true || atBoundary) {
    door = "compaction";
    origin = { kind: "system" };
  } else if (row.isMeta === true && metaText(row).includes("<system-reminder")) {
    door = "attachment";
    origin = { kind: "engine" };
  } else if (row.isMeta === true && row.type === "user") {
    door = "note";
    origin = { kind: "plugin" };
  } else if (row.isMeta === true) {
    door = "attachment";
    origin = { kind: "engine" };
  } else if (row.type === "assistant") {
    door = "response";
    origin = { kind: "model", model: row.message?.model ?? "" };
  } else {
    const content = Array.isArray(row.message?.content) ? row.message.content : [];
    if (content.some((b) => b?.type === "tool_result")) {
      door = "tool-result";
      origin = { kind: "tool" };
    }
  }
  return {
    uuid: row.uuid,
    parentUuid: row.parentUuid ?? row.logicalParentUuid ?? null,
    agentId: typeof row.agentId === "string" ? row.agentId : undefined,
    door,
    origin,
    message: { ...(row.message ?? { content: [] }), type: row.type },
    timestamp: row.timestamp,
  };
}

let seenAfter = afterUuid === null;
let lines = [];
let bytes = 0;
let cont = 0;
let out = 0n;
let n = 0;
let pages = 0;

function writeBatch() {
  if (lines.length === 0) return;
  const name = `m${seq}-${producer8}${cont > 0 ? `.k${cont}` : ""}.jsonl`;
  // wx: never silently overwrite (a concurrent same-tag run must fail loud)
  writeFileSync(join(sessDir, name), `${lines.join("\n")}\n`, { encoding: "utf8", flag: "wx" });
  cont += 1;
  pages += 1;
  lines = [];
  bytes = 0;
}

// Normalized file edges for EVERY uuid-bearing row (chrome included):
// parentUuid, else the logical link (compaction-boundary rows), else null.
// Mirror rows resolve their parents THROUGH the chrome this helper never
// writes onto the nearest mirrored ancestor — a raw file parent would dangle
// at every skipped system row and later chain walks would bridge it by
// arrival order, which can cross a rewind fork onto the abandoned branch.
const fileEdges = new Map();
const mirrored = new Set();
function resolveParent(uuid) {
  let cur = uuid;
  const seen = new Set();
  while (cur !== null && !mirrored.has(cur) && !seen.has(cur) && fileEdges.has(cur)) {
    seen.add(cur);
    cur = fileEdges.get(cur) ?? null;
  }
  return cur;
}

let streamError = null;

// --live-path: pass 1 streams the file once to collect every uuid-bearing
// edge, the carried (user/assistant) set, and the LAST last-prompt leaf;
// the live chain then resolves through chrome onto the nearest carried row
// (the mirror of the host reader's livePath), and the mirroring pass keeps
// only that lineage — an abandoned fork's rows never mirror. The edges are
// COMPLETE before any row mirrors, so parent resolution never dangles.
const carriedSet = new Set();
let tipLeaf = null;
if (livePathMode) {
  const rl0 = createInterface({ input: createReadStream(file, { encoding: "utf-8" }), crlfDelay: Infinity });
  for await (const line0 of rl0) {
    if (line0.length === 0) continue;
    let row0;
    try {
      row0 = JSON.parse(line0);
    } catch {
      continue;
    }
    if (row0.type === "last-prompt") {
      if (typeof row0.leafUuid === "string") tipLeaf = row0.leafUuid;
      continue;
    }
    const uuid0 = typeof row0.uuid === "string" ? row0.uuid : null;
    if (uuid0 === null) continue;
    if (!fileEdges.has(uuid0)) {
      fileEdges.set(
        uuid0,
        typeof row0.parentUuid === "string"
          ? row0.parentUuid
          : typeof row0.logicalParentUuid === "string"
            ? row0.logicalParentUuid
            : null,
      );
    }
    if (row0.type === "user" || row0.type === "assistant") carriedSet.add(uuid0);
  }
}
const liveSet = new Set();
if (livePathMode) {
  let leaf = tipLeaf;
  if (leaf !== null && !carriedSet.has(leaf)) {
    let cur = leaf;
    const seenResolve = new Set();
    while (cur !== null && !carriedSet.has(cur) && !seenResolve.has(cur) && fileEdges.has(cur)) {
      seenResolve.add(cur);
      cur = fileEdges.get(cur) ?? null;
    }
    leaf = cur;
  }
  let cursor = leaf;
  const seenChain = new Set();
  while (cursor !== null && !seenChain.has(cursor)) {
    seenChain.add(cursor);
    liveSet.add(cursor);
    cursor = fileEdges.has(cursor) ? (fileEdges.get(cursor) ?? null) : null;
  }
}

const rl = createInterface({ input: createReadStream(file, { encoding: "utf-8" }), crlfDelay: Infinity });
let pendingBoundary = false; // a seen system compact_boundary awaits its carrier row
try {
  for await (const line of rl) {
    if (line.length === 0) continue;
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      continue; // corrupt line: counted in the summary, never fatal
    }
    const uuid = typeof row.uuid === "string" ? row.uuid : null;
    if (uuid === null) continue; // metadata row kinds are not conversation rows
    if (!fileEdges.has(uuid)) {
      fileEdges.set(
        uuid,
        typeof row.parentUuid === "string"
          ? row.parentUuid
          : typeof row.logicalParentUuid === "string"
            ? row.logicalParentUuid
            : null,
      );
    }
    if (row.type === "system" && row.subtype === "compact_boundary") {
      pendingBoundary = true;
      continue;
    }
    if (row.type !== "user" && row.type !== "assistant") continue; // same filter as the host reader
    if (livePathMode && !liveSet.has(uuid)) continue; // off the tip's lineage
    if (!seenAfter) {
      if (uuid === afterUuid) seenAfter = true;
      continue;
    }
    if (n >= limit) break;
    mirrored.add(uuid);
    const rawParent = typeof row.parentUuid === "string" ? row.parentUuid : null;
    const plain = JSON.stringify({
      uuid,
      parentUuid: rawParent === null ? null : resolveParent(rawParent),
      row: deriveRow(row, pendingBoundary),
    });
    pendingBoundary = false;
    out += BigInt(byteLength(line));
    n += 1;
    const lineBytes = byteLength(plain) + 1;
    if (bytes + lineBytes > pageBytes && lines.length > 0) writeBatch();
    lines.push(plain);
    bytes += lineBytes;
    if (bytes >= pageBytes) writeBatch();
  }
  writeBatch();
} catch (err) {
  streamError = err instanceof Error ? err.message : String(err);
}
const summary = JSON.stringify(
  streamError === null
    ? { done: true, rows: n, sourceBytes: out.toString(), pages, sessionDir: sessDir }
    : { done: false, error: streamError, rows: n, pages, sessionDir: sessDir },
);
// stderr for humans; the SAME line on stdout for the engine-run caller
// ($.process.run exposes stdout - the startup wiring parses the last line)
process.stderr.write(`${summary}\n`);
process.stdout.write(`${summary}\n`);
if (streamError !== null) process.exit(1);
