// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>
//
// The mirror compaction helper: rewrites a session's mirror batches to ONE
// line per uuid (the latest write wins — batch seq is directory-global, so
// later files are later writes), deleting the superseded duplicate batch
// files. Real unlink needs a real Node process, so the host invokes this
// through the process seam at session resume when the duplicate census
// crosses the threshold. DRY-RUN by default; --apply performs the rewrite.
// Idempotent: a second run finds no duplicates and reports a no-op. A crash
// between the new writes and the deletes leaves old+new coexisting — the
// sweep dedups by uuid (correctness unaffected) and the next pass re-runs.
//
// Usage:
//   node helpers/mirror-compact.mjs --config-dir <dir> --session-id <id> [--apply]
//
// Summary JSON (stdout + stderr, the scan.mjs protocol):
//   { done, noop, kept, removed, lines, unique, filesIn, filesOut, sessionDir }
// Exit codes: 0 ok (incl. no-op), 1 failure (report carries {error}).

import { mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";

function fail(error, code) {
  const summary = JSON.stringify({ done: false, error, sessionDir: null });
  process.stderr.write(`${summary}\n`);
  process.stdout.write(`${summary}\n`);
  process.exit(code);
}

function flag(name) {
  const i = process.argv.indexOf(name);
  if (i === -1) return null;
  const v = process.argv[i + 1];
  return typeof v === "string" && !v.startsWith("--") ? v : null;
}

const configDir = flag("--config-dir");
const sessionId = flag("--session-id");
const apply = process.argv.includes("--apply");
if (configDir === null || sessionId === null) {
  fail("usage: node helpers/mirror-compact.mjs --config-dir <dir> --session-id <id> [--apply]", 2);
}

const sessDir = join(configDir, "session-owl", "sessions", sessionId);
mkdirSync(sessDir, { recursive: true });

const BATCH_RE = /^m(\d+)-([0-9a-f]+)(?:\.k(\d+))?\.jsonl$/;

// pass 1 — read every batch, all-or-nothing: any unreadable file aborts
// with NO writes and NO deletes
const files = [];
for (const name of readdirSync(sessDir)) {
  const m = BATCH_RE.exec(name);
  if (m === null) continue;
  files.push({ name, seq: Number(m[1]), cont: Number(m[3] ?? 0) });
}
files.sort((a, b) => (a.seq !== b.seq ? a.seq - b.seq : a.cont - b.cont));

const byUuid = new Map(); // uuid -> the LATEST line (later files overwrite)
const order = []; // first-occurrence order — the write order for the output
let lines = 0;
try {
  for (const f of files) {
    const text = readFileSync(join(sessDir, f.name), "utf8");
    for (const line of text.split("\n")) {
      if (line === "") continue;
      lines += 1;
      const uuid = JSON.parse(line)?.uuid;
      if (typeof uuid !== "string") continue; // malformed — counted, never kept
      if (!byUuid.has(uuid)) order.push(uuid);
      byUuid.set(uuid, line);
    }
  }
} catch (err) {
  fail(`batch read failed — nothing written, nothing deleted: ${err?.message ?? err}`, 1);
}

const unique = byUuid.size;
const removed = lines - unique;
if (removed === 0) {
  const summary = JSON.stringify({
    done: true,
    noop: true,
    kept: unique,
    removed: 0,
    lines,
    unique,
    filesIn: files.length,
    filesOut: 0,
    sessionDir: sessDir,
  });
  process.stderr.write(`${summary}\n`);
  process.stdout.write(`${summary}\n`);
  process.exit(0);
}

// the output: fresh batches under a new producer tag (ts+pid hex — the
// bootstrap helper's collision-free scheme), seq continues the max
const producer8 = `${Date.now().toString(16).slice(-4)}${process.pid.toString(16).padStart(4, "0")}`.slice(0, 8);
let seq = 0;
for (const f of files) seq = Math.max(seq, f.seq);
seq += 1;

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

const ROLL = 3 * 1024 * 1024; // the mirror's split budget — stay under the platform cap
const written = [];
if (apply) {
  let cont = 0;
  let batch = [];
  let bytes = 0;
  const flush = () => {
    if (batch.length === 0) return;
    const name = `m${seq}-${producer8}${cont > 0 ? `.k${cont}` : ""}.jsonl`;
    writeFileSync(join(sessDir, name), `${batch.join("\n")}\n`, "utf8");
    written.push(name);
    cont += 1;
    batch = [];
    bytes = 0;
  };
  for (const uuid of order) {
    const line = byUuid.get(uuid);
    if (bytes + byteLength(line) + 1 > ROLL) flush();
    batch.push(line);
    bytes += byteLength(line) + 1;
  }
  flush();
  // delete the superseded batches — only after every new write succeeded
  for (const f of files) unlinkSync(join(sessDir, f.name));
}

const summary = JSON.stringify({
  done: true,
  noop: false,
  kept: unique,
  removed,
  lines,
  unique,
  filesIn: files.length,
  filesOut: written.length,
  applied: apply,
  sessionDir: sessDir,
});
process.stderr.write(`${summary}\n`);
process.stdout.write(`${summary}\n`);
