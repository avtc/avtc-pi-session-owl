// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// The lineage ledger: owl owns the chain data (the
// full history, no window). `parentUuid` lives only in the transcript file,
// so owl persists edges into its own ledger record class whenever it can
// read them. Exact edges come from readable transcript passes (verifier.js);
// edges for rows appended while unreadable are INFERRED (per-producer arrival
// order + the tool_result → tool_use row link) and marked unverified.
// Corrections append: a later lineage record for the same uuid supersedes the
// earlier edge, which stays in the file, inert — never rewritten.

import type { LedgerRecord } from "../storage/ledger.js";

/** One chain edge: `uuid`'s parent row. `exact` = read from the transcript;
 *  `false` = inferred (unverified until a readable pass confirms). */
export interface LineageEdge {
  uuid: string;
  parent: string | null;
  exact: boolean;
}

/** The current edge view: uuid → its live edge. */
export type LineageMap = Map<string, { parent: string | null; exact: boolean }>;

/** Fold lineage records (already in the ledger's total order) into the
 *  current edge map — later records supersede earlier ones for the same
 *  uuid, everything else accumulates. Non-lineage records and malformed
 *  payloads are skipped. */
export function foldLineage(records: readonly LedgerRecord[]): LineageMap {
  const map: LineageMap = new Map();
  for (const r of records) {
    if (r.kind !== "lineage") continue;
    const edges = (r.payload as { edges?: unknown } | null)?.edges;
    if (!Array.isArray(edges)) continue;
    for (const e of edges) {
      if (e === null || typeof e !== "object") continue;
      const { uuid, parent, exact } = e as Partial<LineageEdge>;
      if (typeof uuid !== "string") continue;
      map.set(uuid, { parent: typeof parent === "string" ? parent : null, exact: exact === true });
    }
  }
  return map;
}

/** The live path root..leaf along the known edges. Null when the leaf is
 *  unknown, a parent is missing (the chain breaks — rows owl has no edges
 *  for yet), or the edges cycle. */
export function livePathFor(edges: LineageMap, leafId: string): string[] | null {
  const path: string[] = [];
  const seen = new Set<string>();
  let cursor: string | null = leafId;
  while (cursor !== null) {
    if (seen.has(cursor)) return null; // cycle
    seen.add(cursor);
    path.push(cursor);
    const edge = edges.get(cursor);
    if (edge === undefined) return null; // unknown leaf or a mid-chain parent owl has no edge for
    cursor = edge.parent;
  }
  path.reverse();
  return path;
}

/** A minimal ledger-shape append seam (the real writer satisfies it). */
export interface LineageAppend {
  append(kind: "lineage", payload: unknown, marker: string): string;
}

/** Append one lineage record carrying a batch of edges (the fold reads them
 *  back; the marker = the write-tip row the pass read up to). */
export function appendEdges(ledger: LineageAppend, edges: LineageEdge[], marker: string): string {
  return ledger.append("lineage", { edges }, marker);
}

/** A row as the inference source sees it (the mirror/capture shapes feed
 *  this): its uuid plus the tool_use ids it emits / answers. */
export interface ArrivalRow {
  uuid: string;
  toolUseIds?: string[];
  toolResultIds?: string[];
}

/** Infer edges from per-producer append arrival order: linear within the
 *  batch, every edge unverified, PLUS the `tool_use_id` link — a row
 *  answering tool call t links to the row that issued t (the call-id
 *  pairing is in the mirrored content), overriding the linear neighbor.
 *  Junction regions stay marked unverified until a readable pass confirms. */
export function inferEdgesFromArrival(order: readonly string[], rows?: readonly ArrivalRow[]): LineageEdge[] {
  const edges: LineageEdge[] = [];
  const byToolUse = new Map<string, string>();
  if (rows !== undefined) {
    for (const r of rows) {
      for (const id of r.toolUseIds ?? []) byToolUse.set(id, r.uuid);
    }
  }
  const rowById = new Map((rows ?? []).map((r) => [r.uuid, r]));
  for (let i = 0; i < order.length; i += 1) {
    const uuid = order[i];
    let parent: string | null = i === 0 ? null : order[i - 1];
    const answered = rowById.get(uuid)?.toolResultIds;
    if (answered !== undefined && answered.length > 0) {
      const issuer = byToolUse.get(answered[0]);
      if (issuer !== undefined && issuer !== uuid) parent = issuer;
    }
    edges.push({ uuid, parent, exact: false });
  }
  return edges;
}
