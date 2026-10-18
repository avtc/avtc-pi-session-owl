// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import type { AssistantMessage, ToolResultMessage, Usage, UserMessage } from "@earendil-works/pi-ai";
// PURE row-to-entry grouper: Claude rows -> pi-shaped SessionEntry[] by a
// fixed mapping table. No fs, no $, no clock — a pure function of the rows.
// The produced entries feed the vendored renderGroups/chunking unchanged.
//
// Shapes (pi-coding-agent/pi-ai): every entry carries {type, id, parentId,
// timestamp}; message entries wrap AgentMessage (user/assistant/toolResult);
// plugin user appends become custom_message entries.
//
// Grouping rule for assistant rows: consecutive rows of ONE API response
// (same message.id) merge into one assistant entry, items in row order
// (apiBlockIndex when present, arrival order otherwise). A missing id
// degrades to one-entry-per-row (never merges unrelated responses).
import type { CompactionEntry, CustomMessageEntry, SessionEntry } from "@earendil-works/pi-coding-agent";

/** The verbatim row payload (session.append input + derived link fields). */
export interface ClaudeRow {
  uuid: string;
  parentUuid: string | null;
  agentId?: string;
  door: string;
  origin: { kind: string; model?: string; tool?: string; plugin?: string };
  message: {
    type: "user" | "assistant" | "attachment" | "system";
    role?: "user" | "assistant";
    isMeta?: boolean;
    id?: string;
    apiBlockIndex?: number;
    text?: string;
    /** the engine's per-response accounting fields (assistant rows). */
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_read_input_tokens?: number;
      cache_creation_input_tokens?: number;
    };
    stop_reason?: string;
    content: Array<{
      type: string;
      text?: string;
      thinking?: string;
      id?: string;
      name?: string;
      input?: unknown;
      tool_use_id?: string;
      content?: unknown;
      is_error?: boolean;
    }>;
  };
  timestamp?: string;
}

const SKIPPED_DOORS = new Set(["attachment", "hook-context", "notice"]);

/** The content blocks of a row; a non-array content degrades to []. */
function blocksOf(row: ClaudeRow): ClaudeRow["message"]["content"] {
  return Array.isArray(row.message.content) ? row.message.content : [];
}

function textOfBlocks(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (
      typeof block === "object" &&
      block !== null &&
      (block as { type?: string }).type === "text" &&
      typeof (block as { text?: unknown }).text === "string"
    ) {
      parts.push((block as { text: string }).text);
    }
  }
  return parts.join("\n");
}

function ts(row: ClaudeRow): string {
  return row.timestamp ?? "1970-01-01T00:00:00.000Z";
}

function base(row: ClaudeRow, id?: string) {
  return { id: id ?? row.uuid, parentId: row.parentUuid, timestamp: ts(row) };
}

function userEntry(row: ClaudeRow, text: string): SessionEntry {
  const message: UserMessage = { role: "user", content: text, timestamp: Date.parse(ts(row)) || 0 };
  return { ...base(row), type: "message", message };
}

function customMessageEntry(row: ClaudeRow, text: string, plugin: string): SessionEntry {
  const entry: CustomMessageEntry = {
    ...base(row),
    type: "custom_message",
    customType: `claude.plugin.${plugin}`,
    content: text,
    display: true,
  };
  return entry;
}

/** Group consecutive assistant rows of one API response into one entry. */
function assistantEntries(rows: readonly ClaudeRow[]): SessionEntry[] {
  const out: SessionEntry[] = [];
  let group: ClaudeRow[] = [];
  let groupId: string | undefined;
  const flushGroup = () => {
    if (group.length === 0) return;
    const ordered = [...group].sort((a, b) => (a.message.apiBlockIndex ?? 0) - (b.message.apiBlockIndex ?? 0));
    const first = ordered[0];
    if (first === undefined) return;
    const items: unknown[] = [];
    for (const row of ordered) {
      for (const block of blocksOf(row)) {
        if (block.type === "thinking" && typeof block.thinking === "string") {
          items.push({ type: "thinking", thinking: block.thinking });
        } else if (block.type === "text" && typeof block.text === "string") {
          items.push({ type: "text", text: block.text });
        } else if (block.type === "tool_use" && typeof block.id === "string" && typeof block.name === "string") {
          items.push({
            type: "toolCall",
            id: block.id,
            name: block.name,
            arguments: (block.input ?? {}) as Record<string, unknown>,
          });
        }
      }
    }
    const usageRow = ordered.find((r) => r.message.usage !== undefined);
    const hasToolUse = ordered.some((r) => blocksOf(r).some((b) => b.type === "tool_use"));
    const stopOverride = mapStopReason(first.message.stop_reason);
    const message: AssistantMessage = {
      role: "assistant",
      content: items as AssistantMessage["content"],
      api: "anthropic",
      provider: "anthropic",
      model: first.origin.model ?? "",
      usage: usageRow !== undefined ? mapUsage(usageRow.message.usage) : emptyUsage(),
      stopReason: stopOverride ?? (hasToolUse ? "toolUse" : "stop"),
      timestamp: Date.parse(ts(first)) || 0,
    };
    out.push({ ...base(first), type: "message", message });
    group = [];
  };
  for (const row of rows) {
    const id = row.message.id;
    if (row.message.type !== "assistant") {
      flushGroup();
      continue;
    }
    if (id !== undefined && id === groupId) {
      group.push(row);
    } else {
      flushGroup();
      groupId = id;
      group.push(row);
    }
  }
  flushGroup();
  return out;
}

function emptyUsage(): Usage {
  // the pi-ai Usage shape — structural defaults when the row carries no
  // accounting fields; rendering never reads them (cost is zero-filled)
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

/** Map the engine's per-response token fields onto the pi-ai Usage shape
 *  (totalTokens includes the cache tokens — pi's own usage computation). */
function mapUsage(u: ClaudeRow["message"]["usage"]): Usage {
  const input = u?.input_tokens ?? 0;
  const output = u?.output_tokens ?? 0;
  const cacheRead = u?.cache_read_input_tokens ?? 0;
  const cacheWrite = u?.cache_creation_input_tokens ?? 0;
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    totalTokens: input + output + cacheRead + cacheWrite,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

/** Engine stop_reason vocabulary -> pi-ai StopReason. A pi-native value
 *  passes through; an unknown engine value degrades to "stop" (never an
 *  unsound cross-vocabulary passthrough). */
function mapStopReason(raw: string | undefined): AssistantMessage["stopReason"] | undefined {
  if (raw === undefined) return undefined;
  switch (raw) {
    case "stop":
    case "length":
    case "toolUse":
    case "error":
    case "aborted":
    case "deferred":
      return raw;
    case "end_turn":
    case "stop_sequence":
    case "pause_turn":
      return "stop";
    case "max_tokens":
      return "length";
    case "tool_use":
      return "toolUse";
    default:
      return "stop";
  }
}

/** toolName resolution: prefer the paired call in the same batch. */
function buildCallIndex(rows: readonly ClaudeRow[]): Map<string, string> {
  const byId = new Map<string, string>();
  for (const row of rows) {
    if (row.message === undefined || row.message.type !== "assistant") continue;
    for (const block of blocksOf(row)) {
      if (block.type === "tool_use" && typeof block.id === "string" && typeof block.name === "string") {
        byId.set(block.id, block.name);
      }
    }
  }
  return byId;
}

function toolResultEntries(rows: readonly ClaudeRow[], calls: Map<string, string>): SessionEntry[] {
  const out: SessionEntry[] = [];
  for (const row of rows) {
    // ONE entry per row (the entry-id uniqueness invariant): all blocks of
    // the row join into one content array keyed by the first block's call
    const parts: Array<{ type: "text"; text: string }> = [];
    let toolCallId: string | null = null;
    let isError = false;
    for (const block of blocksOf(row)) {
      if (block.type !== "tool_result" || typeof block.tool_use_id !== "string") continue;
      if (toolCallId === null) toolCallId = block.tool_use_id;
      parts.push({ type: "text", text: textOfBlocks(block.content) });
      if (block.is_error === true) isError = true;
    }
    if (toolCallId === null) continue;
    const message: ToolResultMessage = {
      role: "toolResult",
      toolCallId,
      toolName: calls.get(toolCallId) ?? "",
      content: parts,
      isError,
      timestamp: Date.parse(ts(row)) || 0,
    };
    out.push({ ...base(row), type: "message", message });
  }
  return out;
}

/**
 * The full table. Rows are consumed in order; assistant groups absorb their
 * member rows, tool-result rows produce toolResult entries, and the output
 * preserves row order (grouped assistant entries at their first row's spot).
 *
 * ID-NAMESPACE INVARIANT: an entry's id is its FIRST row's uuid — the other
 * rows' uuids (pending-list entries, ledger CHECK tips, mirror anchors) are
 * row ids, never entry ids; the two namespaces must not be mixed. A
 * toolResult entry's parentId points at its call's row uuid, which is not
 * an entry id (nothing in the vendored core walks entry parentId today).
 */
export function groupRows(rows: readonly ClaudeRow[]): SessionEntry[] {
  const calls = buildCallIndex(rows);
  const out: SessionEntry[] = [];
  let group: ClaudeRow[] = [];
  const flushAssistant = () => {
    out.push(...assistantEntries(group));
    group = [];
  };
  for (const row of rows) {
    // malformed rows degrade to a skip (never a throw): one bad row must not
    // kill the conversation's trigger evaluation or details resolution
    if (row === null || typeof row !== "object" || row.origin === undefined || row.message === undefined) {
      continue;
    }
    const m = row.message;
    if (m.type === "assistant") {
      group.push(row);
      continue;
    }
    flushAssistant();
    if (SKIPPED_DOORS.has(row.door)) continue;
    if (row.door === "compaction") {
      // treated as a pi CompactionEntry: present in the entry list (the
      // boundary is model-context, not observer scope), skipped as an
      // observer source by renderGroups itself
      const summary = textOfBlocks(m.content) || (typeof m.text === "string" ? m.text : "");
      const entry: CompactionEntry = {
        ...base(row),
        type: "compaction",
        summary,
        firstKeptEntryId: "",
        tokensBefore: 0,
        details: { summary },
      };
      out.push(entry);
      continue;
    }
    if (row.door === "command") {
      // the command door has its own rule (the {text} prints and Claude
      // reads it) — a plugin's command output is a USER message, not a
      // custom_message; checked before the generic plugin-origin split
      if (m.type === "user" && typeof m.text === "string") {
        out.push(userEntry(row, m.text));
      }
      continue;
    }
    if (row.origin.kind === "plugin") {
      // the plugin split: user appends -> custom_message; system -> skipped;
      // isMeta does NOT gate (engine-stamped meta user appends are model-read)
      if (m.type === "user") {
        out.push(customMessageEntry(row, textOfBlocks(m.content) || (m.text ?? ""), row.origin.plugin ?? "unknown"));
      }
      continue;
    }
    if (row.door === "note") {
      // engine notes skipped unless plugin-origin user (handled above)
      continue;
    }
    if (row.door === "tool-result" || row.door === "tool-message") {
      const hasToolResult = blocksOf(row).some((b) => b.type === "tool_result");
      if (hasToolResult) {
        out.push(...toolResultEntries([row], calls));
      } else if (m.type === "user") {
        out.push(userEntry(row, textOfBlocks(m.content)));
      }
      continue;
    }
    // prompt / response / delivery: user-visible text. Unknown doors have
    // no rule in the table — fail closed (skip) rather than fabricate
    // model-visibility for a door the port never verified
    if ((row.door === "prompt" || row.door === "response" || row.door === "delivery") && m.type === "user") {
      out.push(userEntry(row, textOfBlocks(m.content)));
    }
  }
  flushAssistant();
  return out;
}
