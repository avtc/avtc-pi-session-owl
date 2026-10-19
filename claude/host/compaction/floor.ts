// SPDX-License-Identifier: MIT
// SPDXFileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// The observation floor: owl's own answered compaction summaries are
// boundaries of the catch-up scope. Two witnesses of the same fact mark a
// summary row owl's own, the NEWEST position on the live path winning: the
// store's recorded summary texts (a re-served user row matches by exact
// normalized identity) and the branch's own compaction entries (chrome rows
// carrying the rendered summary heading — the engine's native summaries
// never open with it, and a plain user row never takes part in this
// detection). Native and foreign-mod summaries are never boundaries — their
// rows may still be observed, the full-session re-observation they require.
// The block strictly after the floor is the catch-up scope, so a lost or
// reset coverage state rebuilds from the boundary instead of re-ingesting
// condensed history. A plain /owl-rescan re-observes through the trigger
// path, which reads the recorded texts only.

import type { SessionEntry, SessionMessageEntry } from "@earendil-works/pi-coding-agent";
import { normalizeSummaryText } from "../storage/summary-identity.js";

function isMessageEntry(entry: SessionEntry): boolean {
  return (entry as SessionMessageEntry).message !== undefined;
}

/** A message entry's user-role text (string content or joined text blocks). */
function userTextOf(entry: SessionEntry): string | null {
  if (!isMessageEntry(entry)) {
    const compaction = entry as { type?: string; summary?: unknown };
    if (compaction.type === "compaction" && typeof compaction.summary === "string") {
      return compaction.summary;
    }
    return null;
  }
  const message = (entry as SessionMessageEntry).message;
  if (message.role !== "user") return null;
  const content = message.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return null;
  return content
    .map((part) =>
      part !== null && typeof part === "object" && "text" in part ? String((part as { text: unknown }).text) : "",
    )
    .join("");
}

/** The index of the NEWEST own-summary entry on the block (-1 when none):
 * observation starts strictly AFTER this index. */
export function ownSummaryFloorIndex(entries: readonly SessionEntry[], ownTexts: ReadonlySet<string>): number {
  if (ownTexts.size === 0) return -1;
  let floor = -1;
  for (let i = 0; i < entries.length; i += 1) {
    const text = userTextOf(entries[i] as SessionEntry);
    if (text === null) continue;
    if (ownTexts.has(normalizeSummaryText(text))) floor = i;
  }
  return floor;
}

/** The heading every owl-rendered summary opens with (the engine's own
 *  summaries never do). On a compaction entry — chrome, never user
 *  content — this marks a compaction owl answered itself; plain user rows
 *  never take part in this detection. */
const OWN_SUMMARY_HEADING = "# Memory";

/** Whether the entry is a compaction owl answered (the rendered summary
 *  heading on the chrome row). */
function isOwnCompaction(entry: SessionEntry): boolean {
  const c = entry as { type?: string; summary?: unknown };
  return c.type === "compaction" && typeof c.summary === "string" && c.summary.startsWith(OWN_SUMMARY_HEADING);
}

/** The NEWEST index of a compaction owl answered (-1 when none): the
 *  on-file witness of the observation floor. A compaction entry is chrome —
 *  never a user row — so the rendered-summary heading marks owl's own
 *  answer there (the engine's native summaries never open with it); a
 *  plain user message never takes part in this detection. */
export function ownCompactionFloorIndex(entries: readonly SessionEntry[]): number {
  let floor = -1;
  for (let i = 0; i < entries.length; i += 1) {
    const entry = entries[i];
    if (entry !== undefined && isOwnCompaction(entry)) floor = i;
  }
  return floor;
}
