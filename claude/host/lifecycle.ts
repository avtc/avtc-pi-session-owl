// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// The lifecycle host port — the slices of pi's src/lifecycle.ts the host
// runs need, ported verbatim (the file itself is HOST_SET: it value-imports
// pi-coding-agent surfaces).

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { TextContent } from "@earendil-works/pi-ai";

/** A message whose content is text-like (the shape user + assistant messages share). */
interface TextualMessage {
  content: string | readonly TextContent[];
}

/** Whether an AgentMessage carries textual content (user/assistant; not custom). */
function isTextualMessage(message: AgentMessage): message is AgentMessage & TextualMessage {
  return typeof message === "object" && message !== null && "content" in message;
}

/** Extract verbatim text from an AgentMessage (string content or TextContent[]). */
export function extractMessageText(message: AgentMessage): string {
  if (!isTextualMessage(message)) return "";
  const content = message.content;
  if (typeof content === "string") return content;
  // join text parts (skip images / non-text)
  return content
    .filter((part): part is TextContent => part.type === "text")
    .map((part) => part.text)
    .join("");
}

/** Exact-content phrases avtc-pi-unstuck auto-injects (NOT real user signals). */
const UNSTUCK_AUTOCONTINUE_PHRASES: ReadonlySet<string> = new Set<string>([
  "continue",
  "please continue",
  "Your response was cut off due to length. Please provide a shorter, more concise response.",
]);

/**
 * Whether an AgentMessage is an avtc-pi-unstuck auto-injected continuation
 * (exact-content match — `deliverAs` is not persisted, so content is the signal).
 * The Selector's last-user-message pairing skips these.
 */
export function isUnstuckAutoContinue(message: AgentMessage): boolean {
  return UNSTUCK_AUTOCONTINUE_PHRASES.has(extractMessageText(message));
}
