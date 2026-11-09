// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// The re-materialized kept tail: rows the platform writes for a
// hook-answered compaction. The answer hands back BUILT rows; the platform
// persists them as fresh rows (fresh uuids, fresh parents) — user-role rows
// as door "note", assistant-role rows as door "response". The originals
// stay observed behind the boundary, so the fresh rows must never become
// observation sources. The matcher: the answer's exact message list is
// recorded at the verdict; the fold's content rows arrive in order right
// after and match one-to-one (role + exact text — the platform writes the
// handed-back text verbatim, except an empty text, which it persists as the
// "(no content)" placeholder: a kept assistant message whose only blocks
// were thinking). Matched rows are stamped `remat` and skipped
// by the grouper; the stamp persists in the mirror, so a resume reads it
// back. A content row that does not match abandons the expectation — a
// block that is not the answer must never skip real rows — and the
// expectation expires after its window: a fold that never lands must not
// arm a stale skip.
import type { SessionMessage } from "claude-code";
import type { ClaudeRow } from "../capture/grouper.js";

/** How long a verdict's expectation stays armed (the fold lands in the same
 *  dispatch as the answer — the window only bounds a lost fold). */
const REMAT_EXPECTATION_MS = 30_000;

interface Expectation {
  at: number;
  /** The messages still awaited, in materialization order. */
  remaining: SessionMessage[];
}

const expectations = new Map<string, Expectation>();

/** The text the platform persists for a built message whose text is empty
 *  (and that carries no tool blocks to stand in for it). */
const EMPTY_TEXT_PLACEHOLDER = "(no content)";

/** Arm the matcher at the verdict: the answer's own messages, exactly as
 *  handed back (the platform materializes them in this order). */
export function setRematExpectation(convKey: string, messages: readonly SessionMessage[]): void {
  if (messages.length === 0) return;
  expectations.set(convKey, { at: Date.now(), remaining: [...messages] });
}

/** The row's text blocks joined (the comparison form on the row side). */
function textOf(row: ClaudeRow): string {
  const content = row.message.content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (block && typeof block === "object" && block.type === "text" && typeof block.text === "string") {
      parts.push(block.text);
    }
  }
  return parts.join("");
}

/** Whether the row's text is what the platform persists for the expected
 *  text (verbatim, or the placeholder for an empty one). */
function textMatches(row: ClaudeRow, expected: string): boolean {
  const text = textOf(row);
  return text === expected || (expected === "" && text === EMPTY_TEXT_PLACEHOLDER);
}

function roleOf(row: ClaudeRow): "user" | "assistant" | null {
  if (row.message.type === "assistant") return "assistant";
  if (row.message.type === "user") return "user";
  return null;
}

/** Whether the row is the fold's next expected content row: consumes it in
 *  order, stamps it for the skip. Chrome inside the block (the boundary
 *  row, attachments, ceremony commands) passes through unconsumed; a
 *  mismatched content row abandons the expectation. */
export function matchRematRow(convKey: string, row: ClaudeRow): boolean {
  const live = expectations.get(convKey);
  if (live === undefined) return false;
  if (Date.now() - live.at > REMAT_EXPECTATION_MS) {
    expectations.delete(convKey);
    return false;
  }
  if (row.door === "compaction" || row.door === "command") return false;
  const role = roleOf(row);
  if (role === null) return false;
  const expected = live.remaining[0];
  if (expected === undefined || expected.role !== role || !textMatches(row, expected.text)) {
    expectations.delete(convKey);
    return false;
  }
  live.remaining.shift();
  if (live.remaining.length === 0) expectations.delete(convKey);
  return true;
}

/** Test-only: drop every expectation. */
export function _resetRematExpectations(): void {
  expectations.clear();
}
