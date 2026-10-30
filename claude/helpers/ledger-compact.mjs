// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>
//
// The ledger compaction helper: a lineage stream may state each uuid
// exactly once, so the rewrite keeps every NON-lineage record verbatim and
// in fold order and folds all lineage records into ONE consolidated record
// (the final edge per uuid, last-wins — the same rule the load's fold
// applies), deleting the superseded batch files. Real unlink needs a real
// Node process, so the host invokes this through the process seam when the
// load detects a restated lineage uuid. All-or-nothing: every batch is read
// BEFORE any write, and the superseded files are unlinked only after every
// new write succeeded. A crash between the writes and the deletes leaves
// old+new coexisting — the fold's total order still holds (the consolidated
// record reuses the last lineage record's order triple) and the next pass
// re-runs. Idempotent: a healed stream has no restated uuid, so the second
// run is a no-op. DRY-RUN by default; --apply performs the rewrite.
//
// Usage:
//   node helpers/ledger-compact.mjs --session-dir <dir> [--apply]
//
// Summary JSON (stdout + stderr, the scan.mjs protocol):
//   { done, noop, restatedEdges, uniqueEdges, keptRecords, lineageRecords,
//     filesIn, filesOut, sessionDir }
// Exit codes: 0 ok (incl. no-op), 1 failure, 2 usage.

import { randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";

// the platform's whole-file read cap — a rewritten batch stays under it
const READ_CAP_BYTES = 4 * 1024 * 1024;
const LEDGER_PREFIX = "ledger-";
const LEDGER_SUFFIX = ".jsonl";

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

const sessionDir = flag("--session-dir");
const apply = process.argv.includes("--apply");
if (sessionDir === null) {
  fail("usage: node helpers/ledger-compact.mjs --session-dir <dir> [--apply]", 2);
}

// ---- read every batch (all-or-nothing: an unreadable file aborts) -------

let names;
try {
  names = readdirSync(sessionDir)
    .filter((n) => n.startsWith(LEDGER_PREFIX) && n.endsWith(LEDGER_SUFFIX))
    .sort();
} catch (err) {
  fail(`cannot list session dir: ${err instanceof Error ? err.message : String(err)}`, 1);
}

const batches = []; // { name, lines: string[] }
for (const name of names) {
  const full = join(sessionDir, name);
  try {
    const text = readFileSync(full, "utf8");
    const lines = text.split("\n").filter((l) => l !== "");
    batches.push({ name, lines });
  } catch (err) {
    fail(
      `batch unreadable, aborting before any write (${name}): ${err instanceof Error ? err.message : String(err)}`,
      1,
    );
  }
}

// ---- fold order + the duplicate census -----------------------------------

// total order = (ts, producerId, seq) — the load's fold rule
const parsed = [];
for (const b of batches) {
  for (const line of b.lines) {
    try {
      parsed.push({ line, r: JSON.parse(line) });
    } catch {
      parsed.push({ line, r: null }); // malformed: copied verbatim, never interpreted
    }
  }
}
parsed.sort((a, b) => {
  const x = a.r;
  const y = b.r;
  if (x === null || y === null) return 0; // unorderable stays in place (tolerant)
  if (x.ts !== y.ts) return x.ts - y.ts;
  if (x.producerId !== y.producerId) return x.producerId < y.producerId ? -1 : 1;
  return x.seq - y.seq;
});

const edgeMap = new Map(); // uuid -> { uuid, parent, exact }
let restated = 0;
let lastLineageEnvelope = null; // the LAST lineage record's envelope (order + marker)
let lineageRecords = 0;
for (const { line, r } of parsed) {
  if (r === null || r.kind !== "lineage") continue;
  lineageRecords += 1;
  lastLineageEnvelope = line; // remember the raw line for its order triple
  const edges = r.payload && Array.isArray(r.payload.edges) ? r.payload.edges : [];
  for (const e of edges) {
    if (e === null || typeof e !== "object" || typeof e.uuid !== "string") continue;
    if (edgeMap.has(e.uuid)) restated += 1;
    edgeMap.set(e.uuid, {
      uuid: e.uuid,
      parent: typeof e.parent === "string" ? e.parent : null,
      exact: e.exact === true,
    });
  }
}

if (restated === 0) {
  const summary = JSON.stringify({
    done: true,
    noop: true,
    restatedEdges: 0,
    uniqueEdges: edgeMap.size,
    keptRecords: parsed.length,
    lineageRecords,
    filesIn: batches.length,
    filesOut: batches.length,
    sessionDir,
  });
  process.stdout.write(`${summary}\n`);
  process.exit(0);
}

// ---- the rewrite stream ---------------------------------------------------

// non-lineage lines VERBATIM in fold order + one consolidated lineage record
// reusing the LAST lineage record's envelope (its exact order triple — the
// consolidated record sorts where the last lineage record sat)
const outLines = [];
for (const { line, r } of parsed) {
  if (r !== null && r.kind === "lineage") continue;
  outLines.push(line);
}
if (lastLineageEnvelope !== null) {
  const env = JSON.parse(lastLineageEnvelope);
  env.payload = { edges: [...edgeMap.values()] };
  outLines.push(JSON.stringify(env));
}

// roll into fresh batches under the read cap
const outBatches = []; // { name, text }
let current = [];
let currentBytes = 0;
for (const line of outLines) {
  const bytes = Buffer.byteLength(line, "utf8") + 1;
  if (bytes > READ_CAP_BYTES) {
    fail(`a single record exceeds the read cap (${bytes} bytes) — aborting before any write`, 1);
  }
  if (currentBytes + bytes > READ_CAP_BYTES && current.length > 0) {
    outBatches.push({ name: `${LEDGER_PREFIX}${randomUUID()}${LEDGER_SUFFIX}`, text: `${current.join("\n")}\n` });
    current = [];
    currentBytes = 0;
  }
  current.push(line);
  currentBytes += bytes;
}
if (current.length > 0) {
  outBatches.push({ name: `${LEDGER_PREFIX}${randomUUID()}${LEDGER_SUFFIX}`, text: `${current.join("\n")}\n` });
}

const summary = JSON.stringify({
  done: true,
  noop: false,
  restatedEdges: restated,
  uniqueEdges: edgeMap.size,
  keptRecords: parsed.length,
  lineageRecords,
  filesIn: batches.length,
  filesOut: outBatches.length,
  sessionDir,
});

if (!apply) {
  process.stdout.write(`${summary}\n`);
  process.exit(0);
}

try {
  for (const b of outBatches) {
    writeFileSync(join(sessionDir, b.name), b.text);
  }
  for (const b of batches) {
    // only unlink what was read as a FILE (a same-named directory made it unreadable — but that aborted earlier)
    if (statSync(join(sessionDir, b.name)).isFile()) unlinkSync(join(sessionDir, b.name));
  }
} catch (err) {
  const report = JSON.stringify({
    done: false,
    error: `rewrite failed mid-way (old and new batches coexist — the next pass re-runs): ${err instanceof Error ? err.message : String(err)}`,
    sessionDir,
  });
  process.stderr.write(`${report}\n`);
  process.stdout.write(`${report}\n`);
  process.exit(1);
}
mkdirSync(sessionDir, { recursive: true }); // no-op when present; keeps the dir contract explicit
process.stdout.write(`${summary}\n`);
process.exit(0);
