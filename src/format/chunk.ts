// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import type { AssistantMessage, TextContent, ToolCall } from "@earendil-works/pi-ai";
import type {
  BranchSummaryEntry,
  CustomMessageEntry,
  SessionEntry,
  SessionMessageEntry,
} from "@earendil-works/pi-coding-agent";
import { CHARS_PER_TOKEN_ESTIMATE } from "../types.js";
import { stripAnsi } from "./sanitize.js";

/**
 * One rendered tag-block in the Observer's XML-tagged chunk format. A block is
 * the atomic citation unit (carries entry=entryId). Within an entry's group, a
 * tool-call block is always immediately followed by its result block so the
 * pair reads as one adjacency unit.
 */
export interface RenderBlock {
  readonly text: string;
  readonly entryId: string;
}

/**
 * One entry's rendered blocks kept together as an atomic chunking unit (a whole
 * entry is never split across chunks). An assistant entry carrying tool calls
 * absorbs each call's matched tool-result entry into its group.
 */
export interface RenderGroup {
  readonly blocks: readonly RenderBlock[];
}

export interface ChunkOptions {
  /** Emit a chunk once accumulated entry-groups reach this many tokens (chars/4). */
  readonly tokenThreshold: number;
  /** Cap each tool arg/result block to this many tokens (head/tail + marker); null = no cap. */
  readonly toolBlockCapTokens: number | null;
  /** Include non-redacted thinking blocks (redacted always skipped). */
  readonly includeThinking: boolean;
  /** Emit the `entry=id` attribute on each tag (the Observer cites source ids;
   *  recall consumers — Builder/Selector/agent — have no use for raw entry ids). */
  readonly includeEntryId: boolean;
}

export interface RenderedChunk {
  readonly text: string;
  readonly allowedIds: ReadonlySet<string>;
  /** The highest-branch-position source entry id in this chunk — used to advance
   *  the observer frontier over the contiguous successful prefix. Captured at
   *  flush time (blocks are in entry order) so callers need not re-scan the gap. */
  readonly lastEntryId: string;
}

// --- constants --------------------------------------------------------------

/** Entry types the Observer renders as citation sources (the chunk input). */
const RENDERABLE_ENTRY_TYPES: ReadonlySet<string> = new Set(["message", "custom_message", "branch_summary"]);

/** Whether an entry is an Observer-renderable source (message/custom_message/branch_summary). */
export function isRenderableEntry(entry: SessionEntry): boolean {
  return RENDERABLE_ENTRY_TYPES.has(entry.type);
}

const TRUNCATION_MARKER = "[…truncated…]";
const THINKING_PREFIX_PATTERN = /^Thinking:\s*/;
const ATTR_ERROR = "error";
/** Separator between rendered blocks (each tag on its own line — readability for
 *  the Observer LLM and recall consumers; the inner text is already cleaned). */
export const BLOCK_SEP = "\n";

// --- sanitization & truncation ---------------------------------------------

function sanitizeThinking(text: string): string {
  return stripAnsi(text).replace(THINKING_PREFIX_PATTERN, "");
}

/** Cap a tool block's inner text to `capTokens` tokens (chars/4): keep head + tail. null = no cap. */
function capBlock(text: string, capTokens: number | null): string {
  if (capTokens === null) return text;
  const budgetChars = capTokens * CHARS_PER_TOKEN_ESTIMATE;
  if (text.length <= budgetChars) return text;
  const half = Math.trunc(budgetChars / 2);
  const head = text.slice(0, half);
  const tail = text.slice(text.length - half);
  return `${head}${TRUNCATION_MARKER}${tail}`;
}

/** Extract joinable text from a content array (skip images), then strip ANSI. */
function cleanText(content: string | readonly (TextContent | { readonly type: string })[]): string {
  const raw =
    typeof content === "string"
      ? content
      : content
          .filter((part): part is TextContent => part.type === "text")
          .map((part) => part.text)
          .join("");
  return stripAnsi(raw);
}

// --- block constructors (final inner text already cleaned/capped) -----------

function uBlock(id: string, inner: string, includeEntryId: boolean): RenderBlock {
  const attr = includeEntryId ? ` entry=${id}` : "";
  return { entryId: id, text: `<USER${attr}>${inner}</USER>` };
}

function aBlock(id: string, inner: string, includeEntryId: boolean): RenderBlock {
  const attr = includeEntryId ? ` entry=${id}` : "";
  return { entryId: id, text: `<ASSISTANT${attr}>${inner}</ASSISTANT>` };
}

function tBlock(id: string, inner: string, includeEntryId: boolean): RenderBlock {
  const attr = includeEntryId ? ` entry=${id}` : "";
  return { entryId: id, text: `<THINKING${attr}>${inner}</THINKING>` };
}

function cBlock(id: string, toolName: string, inner: string, includeEntryId: boolean): RenderBlock {
  const attr = includeEntryId ? ` entry=${id}` : "";
  return { entryId: id, text: `<TOOLCALL:${toolName}${attr}>${inner}</TOOLCALL>` };
}

function rBlock(id: string, inner: string, isError: boolean, includeEntryId: boolean): RenderBlock {
  const entryAttr = includeEntryId ? ` entry=${id}` : "";
  const attr = isError ? `${entryAttr} ${ATTR_ERROR}` : entryAttr;
  return { entryId: id, text: `<TOOLRESULT${attr}>${inner}</TOOLRESULT>` };
}

// --- per-entry group rendering ----------------------------------------------

function renderCustomMessageGroup(entry: CustomMessageEntry, includeEntryId: boolean): RenderGroup | null {
  const text = cleanText(entry.content);
  if (text.length === 0) return null;
  return { blocks: [uBlock(entry.id, text, includeEntryId)] };
}

function renderBranchSummaryGroup(entry: BranchSummaryEntry, includeEntryId: boolean): RenderGroup | null {
  const text = stripAnsi(entry.summary);
  if (text.length === 0) return null;
  return { blocks: [uBlock(entry.id, text, includeEntryId)] };
}

/**
 * Render the entry list into entry-bounded groups. Each renderable entry is one
 * group (its blocks never split across chunks). An assistant entry's tool calls
 * absorb their matched tool-result entries into the group (C immediately
 * followed by its R); matched results are consumed and skipped when reached.
 */
export function renderGroups(entries: readonly SessionEntry[], options: ChunkOptions): RenderGroup[] {
  const cap = options.toolBlockCapTokens;
  const includeEntryId = options.includeEntryId;
  const resultByCallId = buildResultIndex(entries);
  const consumedResultIds = new Set<string>();
  const groups: RenderGroup[] = [];

  for (const entry of entries) {
    switch (entry.type) {
      case "message": {
        const blocks = renderMessageBlocks(entry, options, cap, resultByCallId, consumedResultIds);
        if (blocks.length > 0) groups.push({ blocks });
        break;
      }
      case "custom_message": {
        const group = renderCustomMessageGroup(entry, includeEntryId);
        if (group !== null) groups.push(group);
        break;
      }
      case "branch_summary": {
        const group = renderBranchSummaryGroup(entry, includeEntryId);
        if (group !== null) groups.push(group);
        break;
      }
      // operational entries (model_change, thinking_level_change, label,
      // session_info, custom) are not renderable Observer sources — skip.
      default:
        break;
    }
  }
  return groups;
}

function buildResultIndex(entries: readonly SessionEntry[]): Map<string, SessionMessageEntry> {
  const resultByCallId = new Map<string, SessionMessageEntry>();
  for (const entry of entries) {
    if (entry.type !== "message") continue;
    const message = entry.message;
    if (typeof message === "object" && message !== null && message.role === "toolResult") {
      resultByCallId.set(message.toolCallId, entry);
    }
  }
  return resultByCallId;
}

function renderMessageBlocks(
  entry: SessionMessageEntry,
  options: ChunkOptions,
  cap: number | null,
  resultByCallId: Map<string, SessionMessageEntry>,
  consumedResultIds: Set<string>,
): RenderBlock[] {
  const message = entry.message;
  if (typeof message !== "object" || message === null) return [];
  const id = entry.id;
  const includeEntryId = options.includeEntryId;

  if (message.role === "user") {
    const text = cleanText(message.content);
    return text.length > 0 ? [uBlock(id, text, includeEntryId)] : [];
  }

  if (message.role === "toolResult") {
    if (consumedResultIds.has(id)) return []; // already absorbed into its call's group
    const text = capBlock(cleanText(message.content), cap);
    return [rBlock(id, text, message.isError, includeEntryId)];
  }

  if (message.role === "assistant") {
    return renderAssistantBlocks(message, id, options, cap, resultByCallId, consumedResultIds);
  }
  return [];
}

/** The cleaned non-empty text of each text part of an assistant message, in
 *  content order (thinking / tool-call parts skipped). Shared by the chunk
 *  pipeline's assistant renderer and the Selector's text-only preceding-agent
 *  prelude so the text-extraction logic lives in one place. */
function assistantTextParts(message: AssistantMessage): string[] {
  const out: string[] = [];
  for (const part of message.content) {
    if (part.type !== "text") continue;
    const text = cleanText([part]);
    if (text.length > 0) out.push(text);
  }
  return out;
}

function renderAssistantBlocks(
  message: AssistantMessage,
  id: string,
  options: ChunkOptions,
  cap: number | null,
  resultByCallId: Map<string, SessionMessageEntry>,
  consumedResultIds: Set<string>,
): RenderBlock[] {
  const includeEntryId = options.includeEntryId;
  const blocks: RenderBlock[] = [];
  for (const part of message.content) {
    switch (part.type) {
      case "text": {
        const text = cleanText([part]);
        if (text.length > 0) blocks.push(aBlock(id, text, includeEntryId));
        break;
      }
      case "thinking": {
        if (!options.includeThinking) break;
        if (part.redacted === true) break; // redacted always skipped
        const cleaned = sanitizeThinking(part.thinking);
        if (cleaned.length > 0) blocks.push(tBlock(id, cleaned, includeEntryId));
        break;
      }
      case "toolCall": {
        emitToolCallPair(part, id, cap, includeEntryId, resultByCallId, consumedResultIds, blocks);
        break;
      }
      default:
        break;
    }
  }
  return blocks;
}

function emitToolCallPair(
  call: ToolCall,
  callEntryId: string,
  cap: number | null,
  includeEntryId: boolean,
  resultByCallId: Map<string, SessionMessageEntry>,
  consumedResultIds: Set<string>,
  blocks: RenderBlock[],
): void {
  // args are structured JSON (not free text) — capped but not ANSI-stripped
  const argsText = capBlock(JSON.stringify(call.arguments), cap);
  blocks.push(cBlock(callEntryId, call.name, argsText, includeEntryId));

  const resultEntry = resultByCallId.get(call.id);
  if (resultEntry === undefined) return; // orphan call (result absent mid-stream)
  const result = resultEntry.message;
  if (typeof result !== "object" || result === null || result.role !== "toolResult") return;
  const resultText = capBlock(cleanText(result.content), cap);
  blocks.push(rBlock(resultEntry.id, resultText, result.isError, includeEntryId));
  consumedResultIds.add(resultEntry.id);
}

// --- public: flat block list (for render verification) ---------------------

export function renderBlocks(entries: readonly SessionEntry[], options: ChunkOptions): RenderBlock[] {
  return renderGroups(entries, options).flatMap((group) => group.blocks);
}

// --- chunk splitting (entry-bounded) ----------------------------------------

/**
 * Split entries into entry-bounded, token-gated chunks. A whole entry (its
 * group) is never split across chunks. Each chunk reports `allowedIds`: the entry=
 * ids cited in its blocks (the allowed source-id set the Observer's
 * `record_observations` must draw from).
 */
export function buildChunks(entries: readonly SessionEntry[], options: ChunkOptions): RenderedChunk[] {
  const groups = renderGroups(entries, options);
  const chunks: RenderedChunk[] = [];
  let current: RenderBlock[] = [];
  let currentTokens = 0;

  const flush = (): void => {
    if (current.length === 0) return;
    const text = current.map((block) => block.text).join(BLOCK_SEP);
    const allowedIds = new Set(current.map((block) => block.entryId));
    const lastEntryId = current[current.length - 1]?.entryId ?? "";
    chunks.push({ text, allowedIds, lastEntryId });
    current = [];
    currentTokens = 0;
  };

  for (const group of groups) {
    current.push(...group.blocks);
    // chars/4 over the group's joined text (same as estimateContentTokens on the
    // join) — computed by summing block lengths, avoiding the temp string alloc.
    const groupChars = group.blocks.reduce((sum, block) => sum + block.text.length, 0);
    currentTokens += Math.ceil(groupChars / CHARS_PER_TOKEN_ESTIMATE);
    if (currentTokens >= options.tokenThreshold) flush();
  }
  flush(); // trailing remainder
  return chunks;
}

/**
 * Render an assistant message's TEXT as `<ASSISTANT>text</ASSISTANT>` blocks
 * (text-only — thinking/tool calls dropped), one block per text part (matching
 * the chunk pipeline), with the same ANSI sanitization. Returns "" when the
 * message carries no text. Used by the Selector tail pairing (text-only
 * preceding-agent prelude) — a recall consumer, so it omits `entry=id`.
 */
export function renderAssistantTextBlock(entry: SessionEntry, includeEntryId: boolean): string {
  if (entry.type !== "message") return "";
  if (entry.message.role !== "assistant") return "";
  return assistantTextParts(entry.message)
    .map((text) => aBlock(entry.id, text, includeEntryId).text)
    .join("");
}

/** Cheap presence predicate: true when the entry is an assistant message with
 *  at least one non-empty cleaned text part. Avoids the full render+join of
 *  `renderAssistantTextBlock` when only presence is needed (e.g. a scan). */
export function hasAssistantText(entry: SessionEntry): boolean {
  if (entry.type !== "message") return false;
  if (entry.message.role !== "assistant") return false;
  return assistantTextParts(entry.message).length > 0;
}
