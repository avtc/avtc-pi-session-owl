// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// The zero-observation ranges over the SERVED branch, with a mirror
// fallback for interval resolution. The served branch prunes off-chain
// rows (forks, re-imported twins); an observation made when such a row was
// still on the branch names it as a coversFrom/coversUpTo endpoint, and the
// interval then resolves on neither end — the span it genuinely observed
// loses coverage and every renderable entry in it reads as a hole. The
// fallback resolves such intervals over the mirror's full row order and
// covers every served entry whose uuid falls inside the span. Endpoints
// that resolve on the branch keep the plain semantics.

import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { isRenderableEntry } from "../../core/src/format/chunk.js";
import type { ObservationEntry } from "../../core/src/store/codecs.js";
import { OBSERVATION_TYPE } from "../../core/src/store/codecs.js";
import type { UncoveredRange } from "../../core/src/triggers.js";

function isUserMessageEntry(entry: SessionEntry): boolean {
  return (
    entry.type === "message" &&
    typeof entry.message === "object" &&
    entry.message !== null &&
    entry.message.role === "user"
  );
}

/** The zero-observation holes behind `lastCoveredId`, mirror-resolving
 *  observation intervals whose endpoints fell off the served branch. */
export function computeUncoveredRangesWithMirrorFallback(
  entries: readonly SessionEntry[],
  lastCoveredId: string | null,
  mirrorPos: (uuid: string) => number | null,
): UncoveredRange[] {
  const positionById = new Map<string, number>();
  for (let i = 0; i < entries.length; i += 1) positionById.set(entries[i].id, i);

  const frontierPos = lastCoveredId === null ? -1 : (positionById.get(lastCoveredId) ?? -1);
  if (frontierPos === -1) return [];

  const firstUserIndex = entries.findIndex(isUserMessageEntry);
  const anchor = firstUserIndex === -1 ? entries.length : firstUserIndex + 1;

  // each served entry's mirror position, resolved once (customs are not
  // mirror rows and carry none — they are never range territory)
  const mirrorPositionOf: Array<number | null> = entries.map((e) => mirrorPos(e.id));

  const covered = new Set<number>();
  for (const entry of entries) {
    if (entry.type !== "custom" || entry.customType !== OBSERVATION_TYPE) continue;
    const payload = entry.data as ObservationEntry | undefined;
    if (payload === undefined) continue;
    const recordBearing = Array.isArray(payload.records) && payload.records.length > 0;
    const from = payload.coversFromId === null ? undefined : positionById.get(payload.coversFromId);
    const to = positionById.get(payload.coversUpToId);
    if (recordBearing && from !== undefined && to !== undefined && to >= from) {
      for (let i = from; i <= to; i += 1) covered.add(i);
    } else if (recordBearing) {
      // the mirror fallback: an endpoint off the served branch resolves over
      // the full row order; the span covers every served entry inside it
      const mFrom = payload.coversFromId === null ? null : mirrorPos(payload.coversFromId);
      const mTo = mirrorPos(payload.coversUpToId);
      if (mFrom !== null && mTo !== null && mTo >= mFrom) {
        for (let i = 0; i < entries.length; i += 1) {
          const m = mirrorPositionOf[i];
          if (m !== null && m >= mFrom && m <= mTo) covered.add(i);
        }
      }
    }
    if (Array.isArray(payload.records)) {
      for (const record of payload.records) {
        for (const srcId of record?.sourceEntryIds ?? []) {
          const pos = positionById.get(srcId);
          if (pos !== undefined) covered.add(pos);
        }
      }
    }
  }

  const ranges: UncoveredRange[] = [];
  let current: SessionEntry[] = [];
  for (let i = anchor; i <= frontierPos && i < entries.length; i += 1) {
    if (covered.has(i)) {
      if (current.length > 0) {
        ranges.push({ entries: current });
        current = [];
      }
      continue;
    }
    if (isRenderableEntry(entries[i])) current.push(entries[i]);
  }
  if (current.length > 0) ranges.push({ entries: current });
  return ranges;
}
