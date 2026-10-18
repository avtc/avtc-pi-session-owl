// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// The verbatim row mirror: rows buffered in memory, flushed as one NEW
// m<seq>-<producer8>.jsonl batch per turn-flush (seq = this process's Nth
// batch; per-process-unique names make the directory listing the union across
// terminals). The mirror-tail anchor {lastUuid, seq} is rewritten per flush —
// a START HINT for the re-mirror walk, never correctness: the
// absent-from-mirror check alone decides what to write, and uuids are v4
// (no cross-producer max exists). Size-guard splitting at the roll margin
// writes continuation files (.k<k>) sharing the seq.

import { log } from "../../core/src/log.js";
import { byteLength, type FsAdapter, ROLL_MARGIN, sliceToByteParts } from "./fs-adapter.js";

/** A mirrored row: uuid + parentUuid (the chain data) + the verbatim
 *  content (opaque to storage — the capture pipeline owns its shape). */
export interface MirroredRow {
  uuid: string;
  parentUuid: string | null;
  row: unknown;
}

/** A mirror batch reference (the ids-drill shortcut): the producer + batch
 *  seq of the flushed batch holding a row — carried on observation records
 *  so a cold ids drill reads exactly the covering batches, no sweep. */
export interface MirrorBatchRef {
  producer: string;
  seq: number;
}

export interface MirrorAnchor {
  lastUuid: string;
  seq: number;
}

const BATCH_RE = /^m(\d+)-([0-9a-f]{8,16})(?:\.k(\d+))?\.jsonl$/;

/** The producer's file tag (from a producer id / process id). Two
 *  independent 32-bit rounds -> 16 hex chars: a single 32-bit hash collides
 *  across real process ids often enough to overwrite another producer's
 *  same-seq batch; the pair pushes collision odds past negligible. */
export function producer8(producerId: string): string {
  let h1 = 0;
  let h2 = 0;
  for (let i = 0; i < producerId.length; i += 1) {
    const c = producerId.charCodeAt(i);
    h1 = (h1 * 31 + c) >>> 0;
    h2 = (h2 * 37 + c + i) >>> 0;
  }
  return `${h1.toString(16).padStart(8, "0")}${h2.toString(16).padStart(8, "0")}`;
}

export function mirrorBatchName(seq: number, p8: string, cont: number): string {
  return cont === 0 ? `m${seq}-${p8}.jsonl` : `m${seq}-${p8}.k${cont}.jsonl`;
}

/** A batch file name's ordering parts — the sequence number and the producer
 *  tag (null for a non-batch name). The row-order fix derives each swept
 *  row's tiebreak keys from its holding file's name. */
export function batchNameParts(name: string): { producer: string; seq: number } | null {
  const m = BATCH_RE.exec(name);
  if (m === null) return null;
  return { producer: m[2] ?? "", seq: Number(m[1]) };
}

export function mirrorAnchorName(p8: string): string {
  return `mirror-tail-${p8}.json`;
}

// ---- writer ---------------------------------------------------------------------

/** A row that carries tool_result content — the engine's parallel-tool
 *  results. Only these attach to the served branch: an abandoned fork's
 *  root (an assistant reply, a re-anchored prompt) is topologically the
 *  same one-level child of a path row and must stay dead. */
function isToolResultRow(row: MirroredRow | undefined): boolean {
  if (row === undefined) return false;
  const content = (row.row as { message?: { content?: unknown } }).message?.content;
  if (!Array.isArray(content)) return false;
  return content.some((b) => typeof b === "object" && b !== null && (b as { type?: unknown }).type === "tool_result");
}
export class MirrorWriter {
  private seq = 0;
  private buffer: MirroredRow[] = [];
  /** The in-memory row index (arrival order + by-uuid) — the live session's
   *  view, exactly the role pi's in-memory sessionManager plays. */
  private rowsById = new Map<string, MirroredRow>();
  private order: string[] = [];
  /** Monotonic index version: bumped by EVERY mutation, including the
   *  same-length in-place refresh of a re-delivered uuid (a length check
   *  cannot see those — the details resolver's generation key). */
  private version = 0;
  /** Which flushed batch holds each row (this producer only; adopted rows
   *  from other producers carry no ref) — the observation batch-refs source. */
  private batchSeqByUuid = new Map<string, number>();

  constructor(
    private readonly fs: FsAdapter,
    private readonly dir: string,
    private readonly producerId: string,
  ) {}

  get producerTag(): string {
    return producer8(this.producerId);
  }

  /** The writer's session directory (the sweep/backfill target). */
  get directory(): string {
    return this.dir;
  }

  /** Buffer a row (capture calls this per session.append; disk is touched at
   *  the turn-flush only). A re-delivered uuid REPLACES its row in place. */
  bufferRow(row: MirroredRow): void {
    this.version += 1;
    this.buffer.push(row);
    if (!this.rowsById.has(row.uuid)) this.order.push(row.uuid);
    this.rowsById.set(row.uuid, row);
  }

  /** Adopt another process's rows into the in-memory index (restart backfill
   *  input — indexed, not re-buffered: they are already on disk). */
  adoptRows(rows: readonly MirroredRow[]): void {
    this.version += 1;
    for (const row of rows) {
      if (!this.rowsById.has(row.uuid)) this.order.push(row.uuid);
      this.rowsById.set(row.uuid, row);
    }
  }

  /** Re-sequence the arrival order by an injected total-order key. File
   *  enumeration order is producer-hash order, not conversation order
   *  (same-seq batches from different processes tie and the directory
   *  listing decides) — the load path re-sequences by the fold's own total
   *  order (timestamp, producer, seq) so every order consumer sees the
   *  conversation. Content, uuids, and chain data are untouched; only the
   *  sequence changes. Equal keys keep their current relative order (a
   *  stable sort — same-file rows preserve the producer's write order). */
  reorderBy(keyOf: (uuid: string) => string): void {
    this.version += 1;
    this.order.sort((a, b) => {
      const ka = keyOf(a);
      const kb = keyOf(b);
      return ka < kb ? -1 : ka > kb ? 1 : 0;
    });
  }

  /** All known row uuids in arrival order (the linear fallback branch). */
  arrivalOrder(): string[] {
    return [...this.order];
  }

  /** The inclusive uuid range [fromUuid..toUuid] of the arrival order, in
   *  ONE walk (null when either endpoint is unknown or the range is
   *  reversed — the batch-refs resolution runs this per observation
   *  record, so the O(n) copies of arrivalOrder+indexOf+slice matter on
   *  resumed sessions with tens of thousands of adopted rows). */
  arrivalSlice(fromUuid: string, toUuid: string): string[] | null {
    const slice: string[] = [];
    let inside = false;
    for (const uuid of this.order) {
      if (!inside && uuid === fromUuid) {
        inside = true;
        slice.push(uuid);
        if (uuid === toUuid) return slice; // degenerate range
        continue;
      }
      if (inside) {
        slice.push(uuid);
        if (uuid === toUuid) return slice;
      }
    }
    return null; // an endpoint never reached (unknown or reversed)
  }

  /** The index's monotonic version (bumped by every mutation, including
   *  same-length in-place refreshes — the details resolver's generation). */
  rowVersion(): number {
    return this.version;
  }

  /** The chain root..leafId by parentUuid walk (null when leafId unknown;
   *  a corrupted cycle degrades to null — the linear fallback covers it).
   *  A GAP — a parent the mirror does not know (the engine's compaction
   *  summary row is never delivered through session.append) — continues
   *  from the nearest EARLIER arrival (the inferred-edge rule): the walk
   *  must never amputate the branch's prefix, or every older record and
   *  snapshot falls off the branch and a reload starts from an empty base. */
  chainTo(leafId: string): string[] | null {
    if (!this.rowsById.has(leafId)) return null;
    const chain: string[] = [];
    const visited = new Set<string>();
    const arrivalIndex = new Map(this.order.map((uuid, i) => [uuid, i] as const));
    let at: string | null = leafId;
    while (at !== null) {
      if (visited.has(at)) return null; // cycle (corrupt edges) — no hang
      visited.add(at);
      chain.push(at);
      const parent: string | null = this.rowsById.get(at)?.parentUuid ?? null;
      if (parent !== null && this.rowsById.has(parent)) {
        at = parent;
        continue;
      }
      // a GAP (an unknown parent — the engine's compaction summary row is
      // never delivered) or a REGION BOUNDARY (a null parent mid-history —
      // the engine restarts the parent chain after each compaction):
      // continue from the nearest EARLIER arrival (the inferred-edge rule —
      // only the FIRST row of the whole mirror is a true start). The walk
      // must never amputate the branch's prefix, or every older record and
      // snapshot falls off the branch and a reload starts from an empty base.
      let next: string | null = null;
      const fromIdx: number = (arrivalIndex.get(at) ?? 0) - 1;
      for (let i: number = fromIdx; i >= 0; i -= 1) {
        const candidate: string | undefined = this.order[i];
        if (candidate === undefined || visited.has(candidate)) continue;
        next = candidate;
        break;
      }
      at = next; // null when nothing earlier — the branch's true start
    }
    return chain.reverse();
  }

  /** The SERVED branch for a leaf: the parent chain PLUS the rows attached
   *  to it one level deep (the engine's parallel-tool shape parents each
   *  tool_result at its own tool_use while the chain follows only one
   *  path — the attached results are live, served content). Chain and
   *  attached merge at their ARRIVAL positions (the file's row order —
   *  the same order the engine re-assembles the conversation in). Rows
   *  hanging DEEPER than one level stay off (a dead fork's subtree under
   *  an attached row is not served). Null when the leaf is unknown. */
  servedBranch(leafId: string): string[] | null {
    const chain = this.chainTo(leafId);
    if (chain === null) return null;
    const onChain = new Set(chain);
    const arrivalIndex = new Map(this.order.map((uuid, i) => [uuid, i] as const));
    // per parent: the LAST on-chain child (uuid + arrival index — the
    // orphan guard and its parallel-batch sibling exception)
    const lastOnChainChild = new Map<string, { uuid: string; at: number }>();
    for (const uuid of this.order) {
      const parent = this.rowsById.get(uuid)?.parentUuid ?? null;
      if (parent !== null && onChain.has(uuid)) {
        lastOnChainChild.set(parent, { uuid, at: arrivalIndex.get(uuid) ?? -1 });
      }
    }
    const out: string[] = [];
    for (const uuid of this.order) {
      if (onChain.has(uuid)) {
        out.push(uuid);
        continue;
      }
      const row = this.rowsById.get(uuid);
      const parent = row?.parentUuid ?? null;
      if (parent === null || !onChain.has(parent) || !isToolResultRow(row)) continue;
      // the orphaned-reply shape: the chain continued past this parent to a
      // row that arrived AFTER the off-path result (the engine skipped the
      // reply and attached the next turn to the parent) — that result is
      // dead, not parallel. EXCEPT a SAME-parent parallel batch: when the
      // parent's on-chain continuation is ITSELF a sibling tool-result, the
      // chain simply followed the other result of the same tool_use row —
      // the skipped result is the batch's other live result, not an orphan
      // (both results of one parallel batch are served content).
      const at = arrivalIndex.get(uuid) ?? -1;
      const last = lastOnChainChild.get(parent);
      if (last !== undefined && last.at > at) {
        const lastRow = this.rowsById.get(last.uuid);
        if (lastRow === undefined || !isToolResultRow(lastRow)) continue; // orphaned, not parallel
      }
      out.push(uuid);
    }
    return out;
  }

  /** The newest row by arrival (the live tip; null before any row). */
  tipUuid(): string | null {
    return this.order.length > 0 ? (this.order[this.order.length - 1] ?? null) : null;
  }

  /** Replace the mirror's parent edges with the file's EXACT ones: each
   *  captured row's file parent is resolved THROUGH rows this mirror does
   *  not carry (filtered system/attachment rows, dead forks) onto the
   *  nearest CAPTURED ancestor. The append envelope carries no parentUuid,
   *  so live chains start as arrival inferences — this pass is what makes
   *  a rewound or meta-row-interspersed chain true. Rows the edges do not
   *  mention keep their current parent (no info — never a blind null). */
  patchEdges(edges: readonly { uuid: string; parent: string | null }[]): void {
    const parentOf = new Map<string, string | null>();
    for (const e of edges) parentOf.set(e.uuid, e.parent);
    this.version += 1;
    for (const row of this.rowsById.values()) {
      let cur = parentOf.get(row.uuid);
      if (cur === undefined) continue; // no file info — keep the inference
      let hops = 0;
      while (cur !== null && !this.rowsById.has(cur) && hops < 4096) {
        const next = parentOf.get(cur);
        if (next === undefined) break; // walk exits the file's knowledge
        cur = next;
        hops += 1;
      }
      if (cur !== null && !this.rowsById.has(cur)) continue; // unresolvable — keep
      row.parentUuid = cur;
    }
  }

  /** A row by uuid (the live row cache lookup). */
  rowByUuid(uuid: string): MirroredRow | undefined {
    return this.rowsById.get(uuid);
  }

  /** The flushed batch holding a row (null when the row is still buffered
   *  or was adopted from another producer — no ref then). */
  batchRefFor(uuid: string): MirrorBatchRef | null {
    const seq = this.batchSeqByUuid.get(uuid);
    return seq === undefined ? null : { producer: this.producerId, seq };
  }

  /** Rows currently buffered but not yet on disk. */
  pendingRows(): readonly MirroredRow[] {
    return this.buffer;
  }

  /** Rows stored as numbered part files (a row whose line alone exceeds the
   *  margin — numbered parts + a reassembly line, logged; a rare boundary
   *  case). */
  oversizedRows = 0;

  /** Flush the buffer as one NEW batch (splitting past the roll margin) and
   *  rewrite this producer's anchor. A row whose LINE alone exceeds the
   *  margin is unsplittable within a batch — it goes to numbered part files
   *  plus a small reassembly line in the batch ({"uuid","parentUuid",
   *  "rowParts","rowPrefix"}), logged. The buffer is consumed per written
   *  part (a mid-flush failure retries without duplicating the prefix). */
  async flush(): Promise<string[]> {
    if (this.buffer.length === 0) {
      // still refresh the anchor (a no-row turn re-records the hint)
      await this.writeAnchor(this.lastFlushedUuid);
      return [];
    }
    this.seq += 1;
    const p8 = this.producerTag;
    const written: string[] = [];
    const pending = this.buffer;
    this.buffer = [];
    let consumed = 0; // rows already durable (batch lines written)
    let lastUuid = this.lastFlushedUuid;
    try {
      let cont = 0;
      let lines: string[] = [];
      let bytes = 0;
      const writePart = async () => {
        if (lines.length === 0) return;
        const name = mirrorBatchName(this.seq, p8, cont);
        await this.fs.writeText(`${this.dir}/${name}`, `${lines.join("\n")}\n`);
        written.push(name);
        consumed += lines.length; // the written prefix is durable
        // the batch-refs index: these rows are now in THIS batch (the
        // observation refs source)
        for (const u of lineUuids) this.batchSeqByUuid.set(u, this.seq);
        cont += 1;
        lines = [];
        lineUuids = [];
        bytes = 0;
      };
      let rowIdx = 0;
      let lineUuids: string[] = [];
      for (const row of pending) {
        const plain = JSON.stringify({ uuid: row.uuid, parentUuid: row.parentUuid, row: row.row });
        let line = plain;
        if (byteLength(plain) + 1 > ROLL_MARGIN) {
          // the rare boundary case: part-files + a reassembly line. A failure
          // after part-writes orphans them (inert garbage until the prune —
          // the retry re-encodes under a NEW seq, never colliding).
          console.warn(`session-owl: mirror row ${row.uuid} exceeds the split budget — stored as part files`);
          this.oversizedRows += 1;
          const prefix = `m${this.seq}-${p8}.r${rowIdx}`;
          const parts = sliceToByteParts(plain, ROLL_MARGIN);
          for (let k = 0; k < parts.length; k += 1) {
            await this.fs.writeText(`${this.dir}/${prefix}.p${k}`, parts[k]);
          }
          line = JSON.stringify({
            uuid: row.uuid,
            parentUuid: row.parentUuid,
            rowParts: parts.length,
            rowPrefix: prefix,
          });
        }
        if (bytes + byteLength(line) + 1 > ROLL_MARGIN) await writePart();
        lines.push(line);
        lineUuids.push(row.uuid);
        bytes += byteLength(line) + 1;
        lastUuid = row.uuid;
        rowIdx += 1;
      }
      await writePart();
    } finally {
      // the unwritten tail stays retryable — PREPENDED to whatever arrived
      // while the flush awaited (appends during a flush are kept, never
      // overwritten); rows whose oversized parts were written but whose
      // reassembly line was not simply retry under a new seq
      this.buffer = [...pending.slice(consumed), ...this.buffer];
    }
    this.lastFlushedUuid = lastUuid;
    await this.writeAnchor(lastUuid);
    return written;
  }

  private lastFlushedUuid: string | null = null;

  private async writeAnchor(lastUuid: string | null): Promise<void> {
    if (lastUuid === null) return;
    await this.fs.writeText(
      `${this.dir}/${mirrorAnchorName(this.producerTag)}`,
      `${JSON.stringify({ lastUuid, seq: this.seq } satisfies MirrorAnchor)}\n`,
    );
  }

  /** The producer's current anchor state (for tests / the restart walk hint). */
  anchorState(): MirrorAnchor | null {
    return this.lastFlushedUuid === null ? null : { lastUuid: this.lastFlushedUuid, seq: this.seq };
  }
}

// ---- reader (the sweep) -----------------------------------------------------------

export interface SweepResult {
  /** All mirrored rows in read order (file name then line). */
  rows: MirroredRow[];
  /** uuid -> the batch file holding it (cold sparse drills). */
  uuidFile: Map<string, string>;
  /** Anchor files read: producer8 -> anchor. */
  anchors: Map<string, MirrorAnchor>;
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** One-time sweep: read every mirror batch, building the row list, the
 *  uuid->file map, and the anchors (the optimization data). Live sessions
 *  never sweep — capture pre-warms the row cache. */
export async function sweepMirror(fs: FsAdapter, dir: string): Promise<SweepResult> {
  let names: string[];
  try {
    names = await fs.listDir(dir);
  } catch (err) {
    log.info(`mirror sweep: session dir unreadable (${dir}) — fresh-session truth: ${errText(err)}`);
    names = []; // missing session directory — the fresh-session truth
  }
  const batchNames = names.filter((n) => BATCH_RE.test(n)).sort(batchOrder);
  const rows: MirroredRow[] = [];
  const uuidFile = new Map<string, string>();
  for (const name of batchNames) {
    let text: string;
    try {
      text = await fs.readText(`${dir}/${name}`);
    } catch (err) {
      log.info(`mirror sweep: batch unreadable, skipped (${name}): ${errText(err)}`);
      continue; // orphan class — re-listed next time, never fatal
    }
    for (const line of text.split("\n")) {
      if (line.length === 0) continue;
      try {
        const parsed = JSON.parse(line) as MirroredRow & { rowParts?: unknown; rowPrefix?: unknown };
        if (typeof parsed.uuid !== "string") continue;
        if (
          typeof parsed.rowParts === "number" &&
          typeof parsed.rowPrefix === "string" &&
          !parsed.rowPrefix.includes("/") &&
          !parsed.rowPrefix.includes("\\") &&
          !parsed.rowPrefix.startsWith(".")
        ) {
          // reassembly line: join the part files back into the row (a
          // traversal-shaped prefix or a missing part drops the row — the
          // orphan class; siblings survive)
          let joined = "";
          let ok = true;
          for (let k = 0; k < parsed.rowParts; k += 1) {
            try {
              joined += await fs.readText(`${dir}/${parsed.rowPrefix}.p${k}`);
            } catch (err) {
              log.info(`mirror sweep: row part unreadable, row dropped (${parsed.rowPrefix}.p${k}): ${errText(err)}`);
              ok = false;
              break;
            }
          }
          if (ok) {
            try {
              rows.push({ uuid: parsed.uuid, parentUuid: parsed.parentUuid, row: JSON.parse(joined).row });
            } catch (err) {
              log.info(`mirror sweep: corrupt joined row dropped (${parsed.uuid}): ${errText(err)}`);
              // corrupt joined whole — orphan class
            }
          }
        } else if (parsed.rowParts === undefined) {
          rows.push(parsed);
        }
        // a line WITH rowParts but an invalid/unreadable reassembly is
        // dropped entirely (never pushed raw) — the orphan class; siblings
        // survive; the uuid still maps for cold-drill diagnostics
        if (!uuidFile.has(parsed.uuid)) uuidFile.set(parsed.uuid, name);
      } catch (err) {
        log.info(`mirror sweep: malformed line dropped in ${name}: ${line.slice(0, 60)} — ${errText(err)}`);
        // tolerant reader: a truncated trailing line (crash mid-write) drops
      }
    }
  }
  const anchors = new Map<string, MirrorAnchor>();
  for (const name of names) {
    if (!name.startsWith("mirror-tail-") || !name.endsWith(".json")) continue;
    try {
      const parsed = JSON.parse(await fs.readText(`${dir}/${name}`)) as MirrorAnchor;
      if (typeof parsed.lastUuid === "string" && typeof parsed.seq === "number") {
        anchors.set(name.slice("mirror-tail-".length, -".json".length), parsed);
      }
    } catch (err) {
      log.info(`mirror sweep: corrupt anchor ignored (${name}): ${errText(err)}`);
      // corrupt anchor: hint data only — ignore
    }
  }
  return { rows, uuidFile, anchors };
}

function batchOrder(a: string, b: string): number {
  const ma = BATCH_RE.exec(a);
  const mb = BATCH_RE.exec(b);
  if (ma === null || mb === null) return a < b ? -1 : 1;
  const seqA = Number(ma[1]);
  const seqB = Number(mb[1]);
  if (seqA !== seqB) return seqA - seqB;
  const kA = Number(ma[3] ?? 0);
  const kB = Number(mb[3] ?? 0);
  return kA - kB;
}

/** The correctness rule of the re-mirror walk: a row already present is
 *  skipped. (uuid -> holding file, or null when unknown.) */
export function findUuidFile(sweep: SweepResult, uuid: string): string | null {
  return sweep.uuidFile.get(uuid) ?? null;
}
