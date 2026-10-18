// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// Layer 4 / the exact-edge source: the readable-transcript pass. The file is
// the authoritative verification — `last-prompt` rows name the live tip
// (leafUuid; an explicit-null marker clears it), every chain row carries
// parentUuid, and the pass yields EXACT edges for the lineage ledger. Over
// the 4 MiB read cap the pass reports over-cap: the CLI Node helper covers
// those files (a full pass only at bootstrap / divergence-verify keeps
// steady-state cost off the stress anchor). The transcript JSONL is an
// internal engine format — parse tolerantly; lines that are not chain rows
// are skipped.

import { log } from "../../core/src/log.js";
import type { LineageEdge } from "./lineage.js";

const READ_CAP_CHARS = 4 * 1024 * 1024;

/** A chain row: uuid + parentUuid (message rows; metadata rows carry no uuid). */
function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export interface ChainRow {
  uuid: string;
  parentUuid: string | null;
}

export type TranscriptPass =
  | { kind: "ok"; rows: ChainRow[]; tip: string | null; rewound: boolean }
  | { kind: "over-cap" };

/** Parse a transcript file's text into chain rows + the resolved live tip.
 *  The tip = the LAST `last-prompt` row's leafUuid when present (an
 *  explicit-null marker leaves no tip), else the LAST chain row that is no
 *  other row's parent (the newest append — a dead fork leaf sits earlier in
 *  file order). `rewound` carries that marker's engine-stamped rewind flag
 *  (newer builds write `rewound:true` on the restore path — corroborating
 *  evidence for a divergence, never a substitute for the chain math). */
export function parseTranscript(text: string): TranscriptPass {
  if (text.length > READ_CAP_CHARS) return { kind: "over-cap" };
  const rows: ChainRow[] = [];
  let tip: string | null = null;
  let rewound = false;
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch (err) {
      log.info(`transcript parse: malformed line dropped: ${trimmed.slice(0, 60)} — ${errText(err)}`);
      continue;
    }
    if (parsed === null || typeof parsed !== "object") continue;
    const row = parsed as Record<string, unknown>;
    if (row.type === "last-prompt") {
      tip = typeof row.leafUuid === "string" ? row.leafUuid : null;
      rewound = row.rewound === true;
      continue;
    }
    if (typeof row.uuid !== "string") continue; // metadata without a chain slot
    rows.push({ uuid: row.uuid, parentUuid: typeof row.parentUuid === "string" ? row.parentUuid : null });
  }
  if (tip === null && rows.length > 0) {
    const parents = new Set(rows.map((r) => r.parentUuid).filter((p): p is string => p !== null));
    for (let i = rows.length - 1; i >= 0; i -= 1) {
      if (!parents.has(rows[i].uuid)) {
        tip = rows[i].uuid;
        break;
      }
    }
  }
  return { kind: "ok", rows, tip, rewound };
}

/** Exact edges from one pass (first occurrence wins — a duplicate uuid is an
 *  engine rewrite the NEXT pass corrects via supersede). */
export function exactEdges(rows: readonly ChainRow[]): LineageEdge[] {
  const seen = new Set<string>();
  const edges: LineageEdge[] = [];
  for (const r of rows) {
    if (seen.has(r.uuid)) continue;
    seen.add(r.uuid);
    edges.push({ uuid: r.uuid, parent: r.parentUuid, exact: true });
  }
  return edges;
}

/** Verify the alignment junction: is P* a real chain row, and what is its
 *  exact parent (the correction a provisional junction needs)? */
export function verifyJunction(
  rows: readonly ChainRow[],
  pStar: string,
): { present: boolean; exactParent: string | null } {
  const row = rows.find((r) => r.uuid === pStar);
  if (row === undefined) return { present: false, exactParent: null };
  return { present: true, exactParent: row.parentUuid };
}

/** The file's LIVE chain uuid set — the newest append's chain united with
 *  the last-prompt leaf's. The api form reflects the last built request and
 *  can sit a whole turn behind the file at a turn boundary; known rows
 *  still inside this set are view lag, not a rewind (a real rewrite drops
 *  them from the file, and a dead fork sits off both live chains). */
export function liveChainSet(rows: readonly ChainRow[], lastPromptTip: string | null): Set<string> {
  const byUuid = new Map(rows.map((r) => [r.uuid, r] as const));
  const index = new Map(rows.map((r, i) => [r.uuid, i] as const));
  const chainFrom = (leaf: string, into: Set<string>): void => {
    let cur = byUuid.get(leaf);
    const seen = new Set<string>();
    while (cur !== undefined && !seen.has(cur.uuid)) {
      seen.add(cur.uuid);
      into.add(cur.uuid);
      if (cur.parentUuid !== null) {
        cur = byUuid.get(cur.parentUuid);
        continue;
      }
      // The engine RESTARTS the parent chain (parentUuid null roots) at
      // resumes and compactions — walk across the restart the same way the
      // mirror's inferred-edge rule does: continue at the row immediately
      // before this one in file order. Without the bridge the walk stops at
      // the newest segment and every historical segment reads dead (a false
      // mass re-anchor). A root with no earlier row still ends it.
      const at = index.get(cur.uuid) ?? -1;
      cur = at > 0 ? byUuid.get(rows[at - 1].uuid) : undefined;
    }
  };
  const live = new Set<string>();
  // the newest append — the LAST row that is no other row's parent (a dead
  // fork leaf sits earlier in file order)
  const parents = new Set(rows.map((r) => r.parentUuid).filter((p): p is string => p !== null));
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    if (!parents.has(rows[i].uuid)) {
      chainFrom(rows[i].uuid, live);
      break; // only the newest append's chain
    }
  }
  if (lastPromptTip !== null && byUuid.has(lastPromptTip)) chainFrom(lastPromptTip, live);
  return live;
}
