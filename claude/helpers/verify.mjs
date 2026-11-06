// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// The over-cap transcript pass: streams a transcript JSONL line-by-line
// (never holding the file) and prints ONE compact JSON line to stdout —
// the chain rows (uuid/parentUuid) and the live tip (the last
// `last-prompt` row's leafUuid) the rewind verifier's file tier needs.
// Serves the design's over-cap tier: `$.fs.read` refuses files over the
// 4 MiB platform cap, so the CLI Node helper supplies the same facts the
// whole-file read would have.
//
// Usage:
//   node helpers/verify.mjs <transcript.jsonl> [--after <uuid>] [--max-edges N]
//
// stdout (exit 0): {"ok":true,"tip":<string|null>,"edges":[[uuid,parent|null],...],"rowsAfter":N}
// --after limits edges to rows appended after that uuid (the incremental
// steady-state mode); the tip is always the file's live one. --max-edges
// caps the output (default 30000, ~2.4 MB — under any truncation budget).
// --tail N (exclusive mode) answers the live chain verifier's tail tier:
// the LAST N uuid-bearing rows as [uuid,parent|null,boundary01] triples
// plus a torn flag (the file's last byte is not a newline, or its final
// line is not JSON — a mid-write tail the caller must back off from).
// Exit codes: 0 ok, 1 stream/read failure ({"ok":false,"error":...}), 2 usage.

import { closeSync, createReadStream, fstatSync, openSync, readSync } from "node:fs";
import process from "node:process";
import { createInterface } from "node:readline";

const argv = process.argv.slice(2);
const file = argv[0];
const flag = (name, def) => {
  const i = argv.indexOf(`--${name}`);
  return i !== -1 && argv[i + 1] !== undefined ? argv[i + 1] : def;
};
const after = flag("after", null);
const maxEdges = Number(flag("max-edges", 30000));
const tailN = flag("tail", null) !== null ? Number(flag("tail", null)) : null;

if (
  file === undefined ||
  Number.isNaN(maxEdges) ||
  maxEdges <= 0 ||
  (tailN !== null && (Number.isNaN(tailN) || tailN <= 0))
) {
  process.stderr.write(
    "usage: node helpers/verify.mjs <transcript.jsonl> [--after <uuid>] [--max-edges N] [--tail N]\n",
  );
  process.exit(2);
}

// --tail mode: read BACKWARD from EOF in blocks (the file can be far
// past the 4 MiB cap — the forward stream would pay the whole file per
// read). Only the last N uuid-bearing rows and the torn signal matter,
// so the scan stops as soon as the ring is full.
if (tailN !== null) {
  const newest = []; // the newest-first rows (the scan reads backward)
  let torn = false;
  const fd = openSync(file, "r");
  try {
    const st = fstatSync(fd);
    const size = st.size;
    if (size > 0) {
      // the trailing-newline check: a last byte that is not a newline
      // means the final line may still be mid-write
      const one = Buffer.alloc(1);
      if (readSync(fd, one, 0, 1, size - 1) === 1 && one[0] !== 0x0a) torn = true;
    }
    const CHUNK = 64 * 1024;
    let pos = size;
    // the line being assembled, oldest chunk first: the bytes between the
    // newest newline seen so far and the line already collected after it.
    // Kept as a chunk list and joined once at the line's start — a single
    // row can be ~100 MB, and re-concatenating per block is quadratic.
    let pending = [];
    // the bytes after the file's last newline are an unterminated final
    // fragment (already flagged torn) — never a row; the first newline
    // found closes that fragment
    let pastFinalFragment = false;
    let sawNewestComplete = false; // the newest complete line has a junk rule
    const collect = (line) => {
      if (line === undefined || line.trim() === "") return;
      if (!sawNewestComplete) {
        sawNewestComplete = true;
        // the newest complete line failing to parse is mid-write suspicion
        try {
          JSON.parse(line);
        } catch {
          torn = true;
        }
      }
      let row;
      try {
        row = JSON.parse(line);
      } catch {
        return; // middle junk — skipped as content, never torn evidence
      }
      if (row === null || typeof row !== "object") return;
      // every chain slot the capture can name: rows written with no uuid
      // (command rows, file-history snapshots) are mirrored under their
      // messageId, so the tail window must count them too
      const id = typeof row.uuid === "string" ? row.uuid : typeof row.messageId === "string" ? row.messageId : null;
      if (id === null) return; // metadata — never a tail row
      const parent =
        typeof row.parentUuid === "string"
          ? row.parentUuid
          : typeof row.logicalParentUuid === "string"
            ? row.logicalParentUuid
            : null;
      const boundary = row.type === "system" && row.subtype === "compact_boundary" ? 1 : 0;
      const content = row.message && typeof row.message === "object" ? row.message.content : undefined;
      const toolResult =
        Array.isArray(content) && content.some((b) => b !== null && typeof b === "object" && b.type === "tool_result")
          ? 1
          : 0;
      newest.push([id, parent, boundary, toolResult]);
    };
    // the ring fills with UUID rows only: a raw-line window lets dense
    // metadata (api requests, queue operations, attachments) crowd the
    // uuid rows out of the scan and the caller reads queued rows as
    // absent — a false amputation verdict
    // a line is decoded only once whole (its bytes joined across every
    // block it spans), so a block boundary never splits a row or a
    // multibyte character
    const emit = (head) => {
      const line = pending.length === 0 ? head : Buffer.concat([head, ...pending]);
      pending = [];
      collect(line.toString("utf8"));
    };
    while (pos > 0 && newest.length < tailN) {
      const readLen = Math.min(CHUNK, pos);
      pos -= readLen;
      const buf = Buffer.alloc(readLen);
      readSync(fd, buf, 0, readLen, pos);
      let end = readLen; // the buf bytes not yet assigned to a line
      let nl = buf.lastIndexOf(0x0a, end - 1);
      while (nl !== -1 && newest.length < tailN) {
        if (pastFinalFragment) emit(buf.subarray(nl + 1, end));
        else pastFinalFragment = true; // the final fragment ends here — dropped
        end = nl;
        nl = end > 0 ? buf.lastIndexOf(0x0a, end - 1) : -1;
      }
      if (newest.length >= tailN) break;
      // the buf's head belongs to a line that starts in an older block
      // (inside the final fragment it is dropped)
      if (pastFinalFragment && end > 0) pending.unshift(buf.subarray(0, end));
    }
    // the file's first line has no newline before it
    if (pos === 0 && pastFinalFragment && pending.length > 0 && newest.length < tailN) emit(Buffer.alloc(0));
    // `newest` holds only complete uuid rows, newest-first
    const out = newest.slice(0, tailN).reverse(); // oldest-first
    process.stdout.write(`${JSON.stringify({ ok: true, torn, tail: out })}\n`);
    process.exit(0);
  } catch (err) {
    process.stdout.write(`${JSON.stringify({ ok: false, error: String(err?.message || err) })}\n`);
    process.exit(1);
  } finally {
    closeSync(fd);
  }
}

let rowsAfter = 0;
let edges = [];
const all = []; // the --after buffer (sliced once the cursor is known)
let tip = null;
let rewound = false;
try {
  const rl = createInterface({ input: createReadStream(file, { encoding: "utf8" }), crlfDelay: Infinity });
  for await (const line of rl) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    let row;
    try {
      row = JSON.parse(trimmed);
    } catch {
      continue; // tolerant: non-JSON lines are skipped, same as the TS parser
    }
    if (row === null || typeof row !== "object") continue;
    if (row.type === "last-prompt") {
      tip = typeof row.leafUuid === "string" ? row.leafUuid : null;
      rewound = row.rewound === true;
      continue;
    }
    if (typeof row.uuid !== "string") continue; // metadata without a chain slot
    // normalized parent: parentUuid, else the logical link (compaction-boundary
    // rows carry null parentUuid + logicalParentUuid)
    const parent =
      typeof row.parentUuid === "string"
        ? row.parentUuid
        : typeof row.logicalParentUuid === "string"
          ? row.logicalParentUuid
          : null;
    const edge = [row.uuid, parent];
    if (after === null) {
      if (edges.length < maxEdges) edges.push(edge);
      rowsAfter += 1;
      continue;
    }
    // --after: buffer every row (bounded by the same cap), slice from the
    // cursor at the end — a cursor that never appears (the file was
    // rewritten past it) degrades to the FULL pass, the caller's facts
    if (all.length < maxEdges) all.push(edge);
  }
} catch (err) {
  process.stdout.write(`${JSON.stringify({ ok: false, error: String(err?.message || err) })}\n`);
  process.exit(1);
}
if (after !== null) {
  const cursorAt = all.findIndex((e) => e[0] === after);
  // the cursor row itself is excluded; an absent cursor (the file was
  // rewritten past it) degrades to the FULL pass
  edges = cursorAt === -1 ? all : all.slice(cursorAt + 1);
  rowsAfter = edges.length;
}
process.stdout.write(`${JSON.stringify({ ok: true, tip, rewound, edges, rowsAfter })}\n`);
