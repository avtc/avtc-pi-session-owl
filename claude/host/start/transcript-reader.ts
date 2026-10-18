// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import { log } from "../../core/src/log.js";
// The transcript row reader: JSONL parse (conversation rows vs metadata, tip
// marker extraction), the ≤4 MiB whole-read guard (any surface; the Node
// helper handles larger), live-path filtering by the parentUuid chain, and
// the transcript→door derivation that lets the capture grouper consume
// transcript rows unchanged (the transcript carries type/isMeta/
// compact_boundary where the live event carries door/origin — the outcome
// mapping is 1:1 with the verified live doors).
import type { ClaudeRow } from "../capture/grouper.js";
import { byteLength, type FsAdapter } from "../storage/fs-adapter.js";

/** One conversation row from the transcript file (anatomy, verbatim). */
export interface TranscriptRow {
  uuid: string;
  parentUuid: string | null;
  timestamp?: string;
  type: "user" | "assistant";
  message: {
    role?: string;
    id?: string;
    model?: string;
    apiBlockIndex?: number;
    stop_reason?: string;
    usage?: ClaudeRow["message"]["usage"];
    content: unknown;
  };
  isMeta?: boolean;
  isSidechain?: boolean;
  agentId?: string;
  compactBoundary?: boolean;
  sessionId?: string;
  sourceToolAssistantUUID?: string;
  toolUseResult?: unknown;
}

/** The tip marker (last-prompt metadata row): names the live leaf. */
export interface TipMarker {
  leafUuid: string | null;
  sessionId?: string;
}

export interface ParsedTranscript {
  rows: TranscriptRow[];
  tip: TipMarker | null;
  skippedLines: number;
}

/** Parse transcript JSONL text: conversation rows kept verbatim, metadata
 *  rows skipped (the tip marker extracted), corrupt lines counted+skipped. */
export function parseTranscriptRows(text: string): ParsedTranscript {
  const rows: TranscriptRow[] = [];
  let pendingBoundary = false; // a seen system compact_boundary awaits its carrier row
  let tip: TipMarker | null = null;
  let skipped = 0;
  for (const line of text.split("\n")) {
    if (line.length === 0) continue;
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(line) as Record<string, unknown>;
    } catch (err) {
      log.info(`transcript read: malformed line dropped: ${line.slice(0, 60)} — ${errText(err)}`);
      skipped += 1;
      continue;
    }
    if (parsed.type === "last-prompt") {
      // the tip marker: leaf uuid + the session it belongs to (a fork's
      // copied transcript still names the PARENT's session here)
      tip = {
        leafUuid: typeof parsed.leafUuid === "string" ? parsed.leafUuid : null,
        sessionId: typeof parsed.sessionId === "string" ? parsed.sessionId : undefined,
      };
      continue;
    }
    // this build's compaction boundary is a SYSTEM row ({type:"system",
    // subtype:"compact_boundary"}); the summary itself is the NEXT
    // conversation row — the boundary marks that row (the live capture's
    // door mapping then groups it as the pi CompactionEntry, and the status
    // counter counts it after a resume)
    if (parsed.type === "system" && parsed.subtype === "compact_boundary") {
      pendingBoundary = true;
      continue;
    }
    if (typeof parsed.uuid !== "string" || (parsed.type !== "user" && parsed.type !== "assistant")) {
      continue; // metadata row kinds (cost-state, date, model, ...) — not conversation rows
    }
    rows.push({
      uuid: parsed.uuid,
      parentUuid: typeof parsed.parentUuid === "string" ? parsed.parentUuid : null,
      timestamp: typeof parsed.timestamp === "string" ? parsed.timestamp : undefined,
      type: parsed.type,
      message: (parsed.message ?? { content: [] }) as TranscriptRow["message"],
      isMeta: parsed.isMeta === true,
      isSidechain: parsed.isSidechain === true,
      agentId: typeof parsed.agentId === "string" ? parsed.agentId : undefined,
      compactBoundary: parsed.compact_boundary === true || pendingBoundary,
      sessionId: typeof parsed.sessionId === "string" ? parsed.sessionId : undefined,
      sourceToolAssistantUUID:
        typeof parsed.sourceToolAssistantUUID === "string" ? parsed.sourceToolAssistantUUID : undefined,
      toolUseResult: parsed.toolUseResult,
    });
    pendingBoundary = false;
  }
  return { rows, tip, skippedLines: skipped };
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export type ReadTranscriptResult = ({ tooLarge: false } & ParsedTranscript) | { tooLarge: true; byteSize: number };

/** Read a transcript file whole (≤ maxBytes, default the 4 MiB platform
 *  read cap minus margin). Missing file = empty rows (fresh-session truth);
 *  over-cap = tooLarge (the caller takes the Node-helper ladder rung) —
 *  detected from the READ TEXT when it arrives, or from stat when the
 *  platform rejects the over-cap read outright. */
export async function readTranscript(
  fs: FsAdapter,
  path: string,
  opts: { maxBytes?: number } = {},
): Promise<ReadTranscriptResult> {
  const cap = opts.maxBytes ?? READ_CAP;
  let text: string | null = null;
  try {
    text = await fs.readText(path);
  } catch {
    // the platform REJECTS over-cap reads — a present-but-huge file must
    // not masquerade as missing (stat decides)
    let size: number | null = null;
    try {
      const st = await fs.stat(path);
      size = st === null ? null : st.size;
    } catch (err) {
      log.info(`transcript read: stat failed, treated as absent (${path}): ${errText(err)}`);
      size = null;
    }
    if (size !== null && size > cap) return { tooLarge: true, byteSize: size };
    return { tooLarge: false, rows: [], tip: null, skippedLines: 0 };
  }
  const size = byteLength(text);
  if (size > cap) return { tooLarge: true, byteSize: size };
  const parsed = parseTranscriptRows(text);
  return { tooLarge: false, ...parsed };
}

/** The whole-read cap: the platform's 4 MiB read limit minus a safety
 *  margin (shared with the ladder predicate). */
export const READ_CAP = 4 * 1024 * 1024 - 64 * 1024;

/** The live path: rows from the leaf to the root via parentUuid, ordered
 *  root→leaf. A null/unknown leaf degrades to file order (the marker is a
 *  hint; liveness correctness is the absent-from-mirror check's job). */
export function livePath(rows: readonly TranscriptRow[], leafUuid: string | null): TranscriptRow[] {
  const byUuid = new Map<string, TranscriptRow>();
  for (const r of rows) byUuid.set(r.uuid, r);
  if (leafUuid === null || !byUuid.has(leafUuid)) return [...rows];
  const chain: TranscriptRow[] = [];
  let cursor: string | null = leafUuid;
  const seen = new Set<string>();
  while (cursor !== null && byUuid.has(cursor) && !seen.has(cursor)) {
    seen.add(cursor);
    const row = byUuid.get(cursor);
    if (row === undefined) break;
    chain.push(row);
    cursor = row.parentUuid;
  }
  return chain.reverse();
}

/** Subagent loop files: `<parent>/subagents/agent-<hash>.jsonl`. */
export function subagentLoopFiles(names: readonly string[]): string[] {
  return names.filter((n) => /^agent-[0-9a-f]+\.jsonl$/.test(n));
}

/** The concatenated text of a meta row's message content (the
 *  system-reminder stamp lives inside the text). */
function transcriptMetaText(tr: TranscriptRow): string {
  const content = tr.message.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  let out = "";
  for (const b of content) {
    if (typeof b === "object" && b !== null && (b as { type?: string }).type === "text") {
      const t = (b as { text?: unknown }).text;
      if (typeof t === "string") out += t;
    }
  }
  return out;
}

/** Derive the capture-grouper row from a transcript row: the door/origin
 *  mapping 1:1 with the verified live doors so both sources render
 *  through the same grouper with identical outcomes. */
export function rowFromTranscript(tr: TranscriptRow): ClaudeRow {
  let door = "prompt";
  let origin: ClaudeRow["origin"] = { kind: "composer" };
  if (tr.compactBoundary === true) {
    door = "compaction";
    origin = { kind: "system" };
  } else if (tr.isMeta === true && transcriptMetaText(tr).includes("<system-reminder")) {
    // engine-stamped reminders (the system-reminder class): the live event
    // carries a skipped-class door — backfill parity
    door = "attachment";
    origin = { kind: "engine" };
  } else if (tr.isMeta === true && tr.type === "user") {
    // meta USER rows that are NOT reminders are plugin appends persisted by
    // the engine (session.append) — live capture renders them as the note
    // door with a plugin origin (the grouper's custom_message split); the
    // disk row carries no plugin name, so the entry custom-types as unknown
    door = "note";
    origin = { kind: "plugin" };
  } else if (tr.isMeta === true) {
    // other engine-stamped meta: skipped, live parity
    door = "attachment";
    origin = { kind: "engine" };
  } else if (tr.type === "assistant") {
    door = "response";
    origin = { kind: "model", model: tr.message.model ?? "" };
  } else {
    const content = Array.isArray(tr.message.content) ? tr.message.content : [];
    const hasToolResult = content.some(
      (b) => typeof b === "object" && b !== null && (b as { type?: string }).type === "tool_result",
    );
    if (hasToolResult) {
      door = "tool-result";
      origin = { kind: "tool" };
    }
  }
  return {
    uuid: tr.uuid,
    parentUuid: tr.parentUuid,
    agentId: tr.agentId,
    door,
    origin,
    // the transcript carries the kind on the ROW (type), the live event on
    // the MESSAGE — unify so the grouper's dispatch sees the same field
    message: { ...tr.message, type: tr.type } as unknown as ClaudeRow["message"],
    timestamp: tr.timestamp,
  };
}
