// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// The cut — the kept-tail computation, the ported pi stack rule: walk back
// from the newest message accumulating chars/4 token estimates until
// approximately `keepRecentTokens` of recent context is retained, choosing
// boundaries that keep every tool result with its call. The kept rows are
// returned AS RECEIVED — handle-bearing rows stand as the engine's own
// messages, whole (images included, via the engine's own row semantics).
import type { SessionMessage } from "claude-code";
import { CHARS_PER_TOKEN_ESTIMATE } from "../../core/src/types.js";

/** One call block's request size (the tool name + the arguments the model
 *  gave, as stored — the call side of the pair). */
function inputChars(block: unknown): number {
  if (typeof block !== "object" || block === null) return 0;
  const b = block as { tool?: unknown; input?: unknown };
  const name = typeof b.tool === "string" ? b.tool.length : 0;
  let args = 0;
  if (b.input !== undefined) {
    const rendered = typeof b.input === "string" ? b.input : JSON.stringify(b.input);
    args = rendered === undefined ? 0 : rendered.length;
  }
  return name + args;
}

/** One result block's outcome text (the result side — the text the model
 *  read; the pair's outcome appears HERE, never on the call block, so a
 *  completed pair is counted exactly once). */
function resultText(block: unknown): number {
  if (typeof block !== "object" || block === null) return 0;
  const text = (block as { text?: unknown }).text;
  return typeof text === "string" ? text.length : 0;
}

/** The message's chars/4 token estimate over the whole row the engine would
 *  stand: its text, its calls' arguments, and its results' texts. A call
 *  block's own outcome copy (`text`/`result` once the transcript holds it)
 *  duplicates the paired result block's text — counting both would
 *  double-count every completed pair, so the call side counts input only. */
export function estimateMessageTokens(message: SessionMessage): number {
  let chars = message.text.length;
  for (const use of message.toolUses) chars += inputChars(use);
  if (message.toolResults !== undefined) {
    for (const result of message.toolResults) chars += resultText(result);
  }
  return Math.ceil(chars / CHARS_PER_TOKEN_ESTIMATE);
}

/** Whether the message answers tool calls (its results must stay with the
 *  preceding call message — the pair rule's split detector). */
function answersToolCalls(message: SessionMessage | undefined): boolean {
  return message !== undefined && message.toolResults !== undefined && message.toolResults.length > 0;
}

export interface KeptTail {
  /** The kept suffix, oldest first, as received (handles preserved). */
  kept: SessionMessage[];
  /** The index of the first kept message in the input (0 when everything is
   *  kept; equals the input length for an empty transcript). */
  firstKeptIndex: number;
}

/** Compute the kept tail: walk back from the newest message accumulating
 *  chars/4 until the budget is reached (the message that crosses the budget
 *  is kept — the tail is approximately the budget, never under-cut by a
 *  boundary), then extend the boundary so every kept tool result keeps its
 *  call. */
export function computeKeptTail(messages: readonly SessionMessage[], budgetTokens: number): KeptTail {
  let accumulated = 0;
  let firstKept = messages.length;
  // walk back while the retained estimate is still under the budget — the
  // crossing message IS kept (inclusive stop: the tail approaches the budget
  // from above, exactly the stack's "approximately retained" rule)
  while (firstKept > 0 && accumulated < budgetTokens) {
    firstKept -= 1;
    accumulated += estimateMessageTokens(messages[firstKept] as SessionMessage);
  }
  // a degenerate zero budget still keeps the newest message — the tail is
  // never empty while the transcript is not
  if (firstKept === messages.length && messages.length > 0) firstKept = messages.length - 1;
  // pair rule: a kept message that answers tool calls keeps its call —
  // extend the boundary past every result block whose call would be cut
  while (answersToolCalls(messages[firstKept]) && firstKept > 0) {
    firstKept -= 1;
  }
  return { kept: messages.slice(firstKept) as SessionMessage[], firstKeptIndex: firstKept };
}
