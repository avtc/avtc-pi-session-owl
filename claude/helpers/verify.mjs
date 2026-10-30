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

// --tail mode: stream a ring buffer of the last N rows, then report.
if (tailN !== null) {
  const ring = [];
  let lastLineJunk = false;
  try {
    const rl = createInterface({ input: createReadStream(file, { encoding: "utf8" }), crlfDelay: Infinity });
    for await (const line of rl) {
      const trimmed = line.trim();
      if (trimmed === "") continue;
      let row;
      try {
        row = JSON.parse(trimmed);
      } catch {
        lastLineJunk = true; // provisional; cleared if more lines follow
        continue;
      }
      // any parseable line clears the junk flag — uuid-less metadata rows
      // are legitimate content, never torn evidence
      lastLineJunk = false;
      if (row === null || typeof row !== "object") continue;
      if (typeof row.uuid !== "string") continue;
      const parent =
        typeof row.parentUuid === "string"
          ? row.parentUuid
          : typeof row.logicalParentUuid === "string"
            ? row.logicalParentUuid
            : null;
      const boundary = row.type === "system" && row.subtype === "compact_boundary" ? 1 : 0;
      ring.push([row.uuid, parent, boundary]);
      if (ring.length > tailN) ring.shift();
    }
    // the trailing-newline check: a last byte that is not \n means the
    // final line may still be mid-write
    let torn = lastLineJunk;
    try {
      const fd = openSync(file, "r");
      try {
        const st = fstatSync(fd);
        if (st.size > 0) {
          const buf = Buffer.alloc(1);
          const got = readSync(fd, buf, 0, 1, st.size - 1);
          if (got === 1 && buf[0] !== 0x0a) torn = true;
        }
      } finally {
        closeSync(fd);
      }
    } catch {
      // the byte check is best-effort; the line signals carry torn alone
    }
    process.stdout.write(`${JSON.stringify({ ok: true, torn, tail: ring })}\n`);
  } catch (err) {
    process.stdout.write(`${JSON.stringify({ ok: false, error: String(err?.message || err) })}\n`);
    process.exit(1);
  }
  process.exit(0);
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
