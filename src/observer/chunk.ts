import type { AssistantMessage, TextContent, ToolCall } from "@earendil-works/pi-ai";
import type {
  BranchSummaryEntry,
  CustomMessageEntry,
  SessionEntry,
  SessionMessageEntry,
} from "@earendil-works/pi-coding-agent";
import { CHARS_PER_TOKEN_ESTIMATE, estimateContentTokens } from "../types.js";

/**
 * One rendered tag-block in the Observer's XML-tagged chunk format. A block is
 * the atomic citation unit (carries E=entryId). A tool-call block (tag "C") is
 * always immediately followed by its result block (tag "R") so the pair reads
 * as one unit; chunking never splits them.
 */
export interface RenderBlock {
  readonly text: string;
  readonly entryId: string;
  readonly tag: "U" | "A" | "T" | "C" | "R";
}

export interface ChunkOptions {
  /** Emit a chunk once accumulated blocks reach this many tokens (chars/4). */
  readonly tokenThreshold: number;
  /** Cap each tool arg/result block to this many tokens (head/tail + marker); null = no cap. */
  readonly toolBlockCapTokens: number | null;
  /** Include non-redacted thinking blocks (redacted always skipped). */
  readonly includeThinking: boolean;
}

export interface RenderedChunk {
  readonly text: string;
  readonly allowedIds: ReadonlySet<string>;
}

// --- constants --------------------------------------------------------------

const TRUNCATION_MARKER = "…(truncated)…";
/** CSI escape sequences (SGR colors, cursor moves, etc.) stripped from rendered text. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI CSI escape sequences are the explicit target here
const ANSI_ESCAPE_PATTERN = /\x1b\[[0-9;]*[A-Za-z]/g;
const THINKING_PREFIX_PATTERN = /^Thinking:\s*/;
const TAG_TOOL = "tool";
const ATTR_ERROR = "error";

// --- sanitization & truncation ---------------------------------------------

function stripAnsi(text: string): string {
  return text.replace(ANSI_ESCAPE_PATTERN, "");
}

function sanitizeThinking(text: string): string {
  return stripAnsi(text).replace(THINKING_PREFIX_PATTERN, "");
}

/** Cap a block's inner text to `capTokens` tokens (chars/4): keep head + tail. null = no cap. */
function capBlock(text: string, capTokens: number | null): string {
  if (capTokens === null) return text;
  const budgetChars = capTokens * CHARS_PER_TOKEN_ESTIMATE;
  if (text.length <= budgetChars) return text;
  const half = Math.trunc(budgetChars / 2);
  const head = text.slice(0, half);
  const tail = text.slice(text.length - half);
  return `${head}${TRUNCATION_MARKER}${tail}`;
}

/** Extract joinable text from a user/assistant/toolResult content array (skip images). */
function extractContentText(content: string | readonly (TextContent | { readonly type: string })[]): string {
  if (typeof content === "string") return content;
  return content
    .filter((part): part is TextContent => part.type === "text")
    .map((part) => part.text)
    .join("");
}

// --- block constructors -----------------------------------------------------

function uBlock(id: string, inner: string): RenderBlock {
  return { tag: "U", entryId: id, text: `<U E=${id}>${inner}</U>` };
}

function aBlock(id: string, inner: string): RenderBlock {
  return { tag: "A", entryId: id, text: `<A E=${id}>${inner}</A>` };
}

function tBlock(id: string, inner: string): RenderBlock {
  return { tag: "T", entryId: id, text: `<T E=${id}>${inner}</T>` };
}

function cBlock(id: string, toolName: string, inner: string): RenderBlock {
  return { tag: "C", entryId: id, text: `<C E=${id} ${TAG_TOOL}=${toolName}>${inner}</C>` };
}

function rBlock(id: string, inner: string, isError: boolean): RenderBlock {
  const attr = isError ? ` ${ATTR_ERROR}` : "";
  return { tag: "R", entryId: id, text: `<R E=${id}${attr}>${inner}</R>` };
}

// --- per-entry rendering ----------------------------------------------------

function renderCustomMessage(entry: CustomMessageEntry): RenderBlock | null {
  const text = extractContentText(entry.content);
  if (text.length === 0) return null;
  return uBlock(entry.id, text);
}

function renderBranchSummary(entry: BranchSummaryEntry): RenderBlock | null {
  if (entry.summary.length === 0) return null;
  return uBlock(entry.id, entry.summary);
}

/**
 * Render the full entry list into a flat ordered block list. Tool calls (C) are
 * always immediately followed by their matched result (R) — paired by toolCallId
 * across entries — so the pair reads as one adjacency unit. Matched tool-result
 * entries are consumed and not re-emitted when reached in the walk.
 */
export function renderBlocks(entries: readonly SessionEntry[], options: ChunkOptions): RenderBlock[] {
  const cap = options.toolBlockCapTokens;
  // index tool-result messages by their toolCallId for C-R pairing
  const resultByCallId = new Map<string, SessionMessageEntry>();
  for (const entry of entries) {
    if (entry.type !== "message") continue;
    const message = entry.message;
    if (typeof message === "object" && message !== null && message.role === "toolResult") {
      resultByCallId.set(message.toolCallId, entry);
    }
  }
  const consumedResultIds = new Set<string>();
  const blocks: RenderBlock[] = [];

  for (const entry of entries) {
    switch (entry.type) {
      case "message":
        renderMessageEntry(entry, options, cap, resultByCallId, consumedResultIds, blocks);
        break;
      case "custom_message": {
        const block = renderCustomMessage(entry);
        if (block !== null) blocks.push(block);
        break;
      }
      case "branch_summary": {
        const block = renderBranchSummary(entry);
        if (block !== null) blocks.push(block);
        break;
      }
      // operational entries (model_change, thinking_level_change, label,
      // session_info, custom) are not renderable Observer sources — skip.
      default:
        break;
    }
  }
  return blocks;
}

function renderMessageEntry(
  entry: SessionMessageEntry,
  options: ChunkOptions,
  cap: number | null,
  resultByCallId: Map<string, SessionMessageEntry>,
  consumedResultIds: Set<string>,
  blocks: RenderBlock[],
): void {
  const message = entry.message;
  if (typeof message !== "object" || message === null) return;
  const id = entry.id;

  if (message.role === "user") {
    const text = extractContentText(message.content);
    if (text.length > 0) blocks.push(uBlock(id, text));
    return;
  }

  if (message.role === "toolResult") {
    if (consumedResultIds.has(id)) return; // already emitted adjacent to its C
    const text = capBlock(extractContentText(message.content), cap);
    blocks.push(rBlock(id, text, message.isError));
    return;
  }

  if (message.role === "assistant") {
    renderAssistantBlocks(message, id, options, cap, resultByCallId, consumedResultIds, blocks);
  }
}

function renderAssistantBlocks(
  message: AssistantMessage,
  id: string,
  options: ChunkOptions,
  cap: number | null,
  resultByCallId: Map<string, SessionMessageEntry>,
  consumedResultIds: Set<string>,
  blocks: RenderBlock[],
): void {
  for (const part of message.content) {
    switch (part.type) {
      case "text": {
        const text = extractContentText([part]);
        if (text.length > 0) blocks.push(aBlock(id, text));
        break;
      }
      case "thinking": {
        if (!options.includeThinking) break;
        if (part.redacted === true) break; // redacted always skipped
        const cleaned = sanitizeThinking(part.thinking);
        if (cleaned.length > 0) blocks.push(tBlock(id, cleaned));
        break;
      }
      case "toolCall": {
        emitToolCallPair(part, id, cap, resultByCallId, consumedResultIds, blocks);
        break;
      }
      default:
        break;
    }
  }
}

function emitToolCallPair(
  call: ToolCall,
  callEntryId: string,
  cap: number | null,
  resultByCallId: Map<string, SessionMessageEntry>,
  consumedResultIds: Set<string>,
  blocks: RenderBlock[],
): void {
  const argsText = capBlock(JSON.stringify(call.arguments), cap);
  blocks.push(cBlock(callEntryId, call.name, argsText));

  const resultEntry = resultByCallId.get(call.id);
  if (resultEntry === undefined) return; // no result yet (result may be absent mid-stream)
  const result = resultEntry.message;
  if (typeof result !== "object" || result === null || result.role !== "toolResult") return;
  const resultText = capBlock(extractContentText(result.content), cap);
  blocks.push(rBlock(resultEntry.id, resultText, result.isError));
  consumedResultIds.add(resultEntry.id);
}

// --- chunk splitting --------------------------------------------------------

/**
 * Split entries into turn-respecting (entry-bounded), token-gated chunks. A
 * tool-call block (C) and its result (R) form an atomic pair — never split.
 * Each chunk reports `allowedIds`: the E= ids cited in its blocks (the allowed
 * source-id set the Observer's `record_observations` must draw from).
 */
export function buildChunks(entries: readonly SessionEntry[], options: ChunkOptions): RenderedChunk[] {
  const blocks = renderBlocks(entries, options);
  const chunks: RenderedChunk[] = [];
  let current: RenderBlock[] = [];
  let currentTokens = 0;

  const flush = (): void => {
    if (current.length === 0) return;
    const text = current.map((b) => b.text).join("");
    const allowedIds = new Set(current.map((b) => b.entryId));
    chunks.push({ text, allowedIds });
    current = [];
    currentTokens = 0;
  };

  for (let i = 0; i < blocks.length; i += 1) {
    const block = blocks[i];
    const isCall = block.tag === "C";
    const next = isCall && i + 1 < blocks.length ? blocks[i + 1] : null;
    // a C is always followed by its R when paired; treat the pair as one atomic unit
    const unit: RenderBlock[] = isCall && next !== null && next.tag === "R" ? [block, next] : [block];

    current.push(...unit);
    currentTokens += estimateContentTokens(unit.map((b) => b.text).join(""));
    if (isCall && next !== null && next.tag === "R") i += 1; // consume the paired R

    if (currentTokens >= options.tokenThreshold) flush();
  }
  flush(); // trailing remainder
  return chunks;
}
