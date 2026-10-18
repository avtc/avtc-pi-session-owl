// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { MirroredRow, MirrorWriter } from "../storage/mirror.js";
// The session.append capture body: parse the row, file it into its
// conversation's row cache + pending list, and hand it to the mirror buffer.
// Owl's own stage-agent loops are SKIPPED (their record is the stage dump,
// matching pi's outside-the-log stage runs) — decided by the spawn registry,
// injected as a predicate so this module stays engine-free.
//
// UNCAPPED: the row cache and the mirror hold full raw content — caps apply
// downstream in chunk rendering only.
import { type ClaudeRow, groupRows } from "./grouper.js";

/** One conversation's capture state (lazily created at its first row). */
export interface ConversationCapture {
  /** the ConversationState key — derived ONLY by state.conversationKey
   *  (sessionId or sessionId|agentId); this module never builds keys */
  key: string;
  /** uuid -> verbatim row (the live process's view). */
  rowCache: Map<string, ClaudeRow>;
  /** uuids only, in arrival order — the pending-observation list. */
  pending: string[];
  mirror: MirrorWriter;
}

const captures = new Map<string, ConversationCapture>();

/** The row as the mirror stores it (verbatim content + chain fields). */
function toMirroredRow(row: ClaudeRow): MirroredRow {
  // The platform append envelope omits parentUuid (the edges live in the
  // transcript file) — a missing edge is null (inferred until a readable
  // pass), never undefined (it would poison the byte accounting).
  return { uuid: row.uuid, parentUuid: row.parentUuid ?? null, row };
}

/** Get-or-create a conversation's capture state. The mirror factory also
 *  receives the creating row (its agentId picks the loop's storage set). */
export function ensureCapture(
  key: string,
  mirrorFor: (key: string, row?: ClaudeRow) => MirrorWriter,
  row?: ClaudeRow,
): ConversationCapture {
  let cap = captures.get(key);
  if (cap === undefined) {
    cap = { key, rowCache: new Map(), pending: [], mirror: mirrorFor(key, row) };
    captures.set(key, cap);
  }
  return cap;
}

export function getCapture(key: string): ConversationCapture | undefined {
  return captures.get(key);
}

/**
 * The session.append body. `isOwlLoop(agentId)` decides the stage-spawn skip
 * (the spawn registry predicate, injected). Returns false when the row was
 * skipped (owl loop or unparseable), true when captured.
 */
export function captureAppend(
  key: string,
  row: ClaudeRow,
  mirrorFor: (key: string, row?: ClaudeRow) => MirrorWriter,
  isOwlLoop: (agentId: string | undefined) => boolean = () => false,
): boolean {
  if (isOwlLoop(row.agentId)) return false;
  if (typeof row.uuid !== "string" || row.uuid.length === 0) return false;
  // The engine's META rows (message.type "system": turn_duration,
  // informational, away_summary, …) are session chrome: chained in the
  // transcript file but NEVER part of messages({as:"api"}). Mirroring them
  // would make the rewind check see a dead row at every turn boundary — a
  // false rewind aborting in-flight runs and quarantining their records.
  if (row.message.type === "system") return false;
  const cap = ensureCapture(key, mirrorFor, row);
  const known = cap.rowCache.has(row.uuid);
  // The envelope carries no timestamp either — a row without one is stamped
  // with its ARRIVAL time (rows arrive ~live; an absent stamp rendered every
  // observation range as the epoch — "Jan 01 03:00").
  const stamped =
    typeof row.timestamp === "string" && row.timestamp.length > 0
      ? row
      : ({ ...row, timestamp: new Date().toISOString() } as typeof row);
  cap.rowCache.set(row.uuid, stamped);
  // a re-delivered uuid refreshes the cache but never re-buffers (one line,
  // one row — the mirror must stay deduplicated)
  if (!known) {
    // The append envelope carries NO parentUuid (pinned fields: message,
    // door, origin, uuid, agentId) — a live row's parent is INFERRED from
    // the arrival order (the write order IS the chain for a live loop; the
    // transcript pass replaces inferences with the file's exact edges).
    // Without it every mirror row chains to null, chainTo() answers a
    // one-row branch, and every fold drops every record not marked at the
    // current leaf — the whole graph vanishing on each core switch.
    cap.mirror.bufferRow(toMirroredRow({ ...stamped, parentUuid: stamped.parentUuid ?? cap.mirror.tipUuid() }));
    cap.pending.push(row.uuid);
  }
  return true;
}

/** Render a conversation's cached rows into pi-shaped entries (the grouper
 *  over the row cache, in arrival order). */
export function entriesForCache(key: string): SessionEntry[] {
  const cap = captures.get(key);
  if (cap === undefined) return [];
  return groupRows([...cap.rowCache.values()]);
}

/** Drop one conversation's capture state (loop teardown). */
export function releaseCapture(key: string): boolean {
  return captures.delete(key);
}

/** Drop every conversation's capture state (session.end teardown). */
export function releaseAllCaptures(): void {
  captures.clear();
}

/** Test-only: drop all capture state. */
export function _resetCapture(): void {
  captures.clear();
}
