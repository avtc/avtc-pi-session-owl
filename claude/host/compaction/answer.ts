// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// The answer — message assembly for the compaction takeover. The summary is
// ONE handle-less user-role message whose text is renderSummary(...) verbatim
// (it already opens with owl's own `# Memory` header — the engine's
// continuation preamble is reserved for engine-authored summaries); the kept
// tail rides after it HANDLE-STRIPPED — every row handed back BUILT
// (role/text/toolUses[/toolResults]). A handle-bearing row would re-persist
// with its pre-boundary parent linkage and the resume parent-walk then goes
// around the boundary, undoing the compaction (the engine keeps no
// preserved-segment list for a hook's fold — anthropics/claude-code#95328);
// the rebuilt tail cannot carry thinking blocks or images, which is exactly
// the loss the kept-tail thinking knob folds into the summary. The token
// bracket is informational; the engine's `usage` field stays absent for
// hook-answered compactions — owl's own stage cost lands in its usage ledger
// and the details snapshot instead.
import type { SessionCompacted, SessionCompactSkipped, SessionMessage } from "claude-code";
import { estimateMessageTokens } from "./cut.js";

/** The one handle-less user-role summary message (the engine builds it from
 *  role/text — nothing else). */
export function summaryMessage(summary: string): SessionMessage {
  return { role: "user", text: summary, toolUses: [] };
}

export interface TakeoverArgs {
  summary: string;
  /** The kept tail, as received from the cut (handles stripped on the way
   *  out — see the module header). */
  kept: readonly SessionMessage[];
  /** An optional text-only assistant row appended AFTER the kept tail — the
   *  aggregated-thinking collector (the one built-row position past the
   *  summary the engine serves to the model). */
  trailing?: SessionMessage;
  /** The conversation's size before (from the measure snapshot). */
  tokensBefore?: number;
  /** Its estimated size after (chars/4 over the answer's messages). */
  tokensAfter?: number;
}

/** The takeover answer: `[summaryMessage, ...keptTail]` + the token bracket. */
export function buildTakeover(args: TakeoverArgs): SessionCompacted {
  const messages: SessionMessage[] = [summaryMessage(args.summary)];
  for (const m of args.kept) messages.push(stripHandle(m));
  if (args.trailing !== undefined) messages.push(args.trailing);
  const result: SessionCompacted = { messages };
  if (args.tokensBefore !== undefined) result.tokensBefore = args.tokensBefore;
  if (args.tokensAfter !== undefined) result.tokensAfter = args.tokensAfter;
  return result;
}

/** The built-row copy of a kept message: role, text and the tool blocks —
 *  never the engine handle (the resume-walk hazard above). */
function stripHandle(m: SessionMessage): SessionMessage {
  const built: SessionMessage = { role: m.role, text: m.text, toolUses: m.toolUses };
  if (m.toolResults !== undefined) built.toolResults = m.toolResults;
  return built;
}

/** The veto: the conversation stays exactly as it was; the reason reads as
 *  the one-line notice (retry happens at the next trigger). */
export function buildSkip(reason: string): SessionCompactSkipped {
  return { skip: reason };
}

/** The post-takeover size estimate: chars/4 over the answer's own messages
 *  (the summary + the kept tail). */
export function estimateTokensAfter(messages: readonly SessionMessage[]): number {
  let total = 0;
  for (const m of messages) total += estimateMessageTokens(m);
  return total;
}
