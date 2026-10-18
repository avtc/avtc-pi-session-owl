// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// The kept tail's aggregated thinking. The engine's compact answer carries
// no thinking field anywhere (its session-message model is role/text/tool
// blocks), so the tail the hook hands back loses every thinking block the
// transcript holds — the one channel a plugin MAY use to keep that content
// model-visible is a single text-only assistant row at the answer's END
// (mid-answer built rows are never served). This module collects the kept
// tail's thinking from the branch view and renders that trailing row.
import type { SessionEntry, SessionMessageEntry } from "@earendil-works/pi-coding-agent";
import { stripAnsi } from "../../core/src/format/sanitize.js";

/** The trailing row's lead-in (model-visible text). */
export const THINKING_ROW_LEAD = "Reasoning from earlier turns (attributed):";

/** The summary-fold section heading (pinned render). */
export const THINKING_SECTION_HEADING = "## Reasoning from turns kept in conversation history";

/** The separator between two attributed reasoning blocks. */
const BLOCK_SEPARATOR = "\n\n---\n\n";

const THINKING_PREFIX_PATTERN = /^Thinking:\s*/;

/** One sanitized thinking text (ANSI stripped, the engine's lead-in removed). */
function sanitizeThinking(text: string): string {
  return stripAnsi(text).replace(THINKING_PREFIX_PATTERN, "");
}

function isMessageEntry(entry: SessionEntry): boolean {
  return entry.type === "message";
}

/** The thinking texts of the kept tail (oldest first), redacted blocks skipped.
 *  `entries` is the conversation's branch view; `fromEntryId` is the cut's
 *  entry-space boundary (null = the whole view, matching the cut's
 *  fallback rule). */
export function collectTailThinking(entries: readonly SessionEntry[], fromEntryId: string | null): string[] {
  let started = fromEntryId === null;
  const out: string[] = [];
  for (const entry of entries) {
    if (!started) {
      if (entry.id === fromEntryId) started = true;
      else continue;
    }
    if (!isMessageEntry(entry)) continue;
    const message = (entry as SessionMessageEntry).message;
    if (message.role !== "assistant") continue;
    const content = message.content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (part.type !== "thinking") continue;
      if ((part as { redacted?: boolean }).redacted === true) continue; // redacted never re-shown
      const cleaned = sanitizeThinking((part as { thinking: string }).thinking);
      if (cleaned.length > 0) out.push(cleaned);
    }
  }
  return out;
}

/** The reasoning section folded into the '# Memory' summary row, or null
 *  when there is nothing to carry. The engine serves user rows and skips
 *  synthetic assistant rows (a trailing assistant row persisted as
 *  model="<synthetic>" never reaches the model) — the summary row is the
 *  only model-visible vehicle for the kept tail's thinking. */
export function renderThinkingSection(thinking: readonly string[]): string | null {
  if (thinking.length === 0) return null;
  return `${THINKING_SECTION_HEADING}\n\n${thinking.join(BLOCK_SEPARATOR)}`;
}
