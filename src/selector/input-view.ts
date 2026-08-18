// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import {
  extractTouchedFiles,
  isMessageEntry,
  renderTouchedFiles,
  type TouchedFilesContext,
} from "../compaction/touched-files.js";
import {
  BLOCK_SEP,
  buildChunks,
  type ChunkOptions,
  hasAssistantText,
  renderAssistantTextBlock,
} from "../format/chunk.js";
import { formatNodeLine, NON_BUILDER, RENDER_LEGEND, singleDirectObs } from "../format/render.js";
import { cloneNode, cloneObservation } from "../graph/clone.js";
import { nodeLineOptions, orderedNonObsoleteRoots } from "../graph/read-tools.js";
import { isUnstuckAutoContinue } from "../lifecycle.js";
import type { TodoContext } from "../todo/types.js";
import type { Node, NodeId, Observation, ObsId } from "../types.js";
import { MemkeeperGraph, makeNode, N_IRRELEVANT, nowStoredTimestamp } from "../types.js";

/**
 * The Selector's working copy: a deep-copied, in-memory graph the Selector
 * mutates during a run (its tools operate on `graph`). `nIrrelevantId` is the
 * predefined demote-target node injected into the copy (absent from the source).
 */
export interface SelectorWorkingCopy {
  graph: MemkeeperGraph;
  nIrrelevantId: NodeId;
}

/**
 * Build the Selector's working copy from the source graph: a deep clone of the
 * non-obsolete nodes (active + new + archived) plus their observations, with the
 * predefined `nIrrelevant` node injected. Obsolete nodes are excluded entirely
 * (superseded; their replacement is present); a non-obsolete descendant of a
 * dropped obsolete node is reparented to the root so no active content is lost
 * and the copy stays structurally valid (every observation under one node).
 *
 * The clone is fully independent — mutating it never touches the source graph.
 */
export function buildWorkingCopy(source: MemkeeperGraph): SelectorWorkingCopy {
  // Selective clone: copy ONLY non-obsolete nodes (active + new + archived) and
  // the observations under them, never deep-copying the obsolete portion. A
  // non-obsolete descendant of a dropped obsolete node is reparented to the
  // root so no active content is lost and the copy stays structurally valid.
  const nodes = new Map<NodeId, Node>();
  const droppedObsolete = new Set<NodeId>();
  for (const [id, node] of source.nodes) {
    if (node.state === "obsolete") {
      droppedObsolete.add(id);
    } else {
      nodes.set(id, cloneNode(node));
    }
  }
  // Reparent a non-obsolete node whose parent was dropped (obsolete) to root,
  // and strip dropped obsolete ids from every cloned parent's childNodeIds.
  for (const node of nodes.values()) {
    if (node.parentNode !== null && droppedObsolete.has(node.parentNode)) {
      node.parentNode = null;
    }
    if (node.childNodeIds.length > 0) {
      node.childNodeIds = node.childNodeIds.filter((cid) => !droppedObsolete.has(cid));
    }
  }
  // Copy only observations whose parent survived the obsolete drop.
  const observations = new Map<ObsId, Observation>();
  for (const [obsId, obs] of source.observations) {
    if (nodes.has(obs.parentNode)) {
      observations.set(obsId, cloneObservation(obs));
    }
  }
  const clone = new MemkeeperGraph({
    nodes,
    observations,
    nextObsId: source.nextObsId,
    nextNodeId: source.nextNodeId,
  });

  // Inject nIrrelevant (predefined demote bin; summary "Irrelevant", empty, root).
  if (!clone.nodes.has(N_IRRELEVANT)) {
    clone.nodes.set(
      N_IRRELEVANT,
      makeNode({
        id: N_IRRELEVANT,
        summary: "Irrelevant",
        importance: "med",
        parentNode: null,
        state: "active",
        createdAt: nowStoredTimestamp(),
      }),
    );
  }

  return { graph: clone, nIrrelevantId: N_IRRELEVANT };
}

// --- tail rendering ---------------------------------------------------------

/** Port to read the active branch — identical to {@link TouchedFilesContext}
 *  (both read `getBranch(leafId)`); aliased to avoid a byte-duplicate type. */
export type TailContext = TouchedFilesContext;

/** Tail boundary: `firstKeptEntryId` is the compaction cut (the kept side starts
 *  here). `null` = no compaction cut yet (mid-session) — the tail is undefined
 *  and the Selector defers; the render is empty. */
export interface TailBoundary {
  firstKeptEntryId: string | null;
}

const NOT_FOUND = -1;
const OMIT_ENTRY_ID = false;
const TRUNCATION_MARKER = "…<truncated events>…";

/**
 * Render the Selector's recent-tail context in the Observer's XML-tag chunk
 * format (no truncation). The tail = the active-branch entries from the
 * compaction cut (`firstKeptEntryId`) onward.
 *
 * If the last real (non-unstuck) user message falls OUTSIDE the tail (before the
 * cut), it is surfaced alongside its preceding assistant text message, followed
 * by a truncation marker, then the tail verbatim — so the current ask is always
 * visible. Stuck-injection user messages ("continue" / "please continue") are
 * skipped when finding the "last user message".
 *
 * `firstKeptEntryId === null` (mid-session, no compaction cut) returns "" — the
 * mid-session tail is an open decision; until resolved, the Selector defers.
 */
export function buildTail(ctx: TailContext, boundary: TailBoundary, options: ChunkOptions): string {
  if (boundary.firstKeptEntryId === null) return "";

  const branch = ctx.getBranch(ctx.getLeafId() ?? undefined);
  const cutIndex = branch.findIndex((entry) => entry.id === boundary.firstKeptEntryId);
  if (cutIndex === NOT_FOUND) return "";
  const tail = branch.slice(cutIndex);

  const lastUserIndex = findLastUserMessage(branch);
  // No real user message at all, or the last one is within the tail → verbatim.
  if (lastUserIndex === NOT_FOUND || lastUserIndex >= cutIndex) {
    return renderTail(tail, options);
  }

  // The last user message is before the cut → pair it with its preceding
  // agent TEXT message (text-only — no thinking/tool calls, per the tail spec).
  const precedingAgentIndex = findPrecedingAssistantText(branch, lastUserIndex);
  const userEntry = entryAt(branch, lastUserIndex);
  const preludeParts: string[] = [];
  if (precedingAgentIndex !== NOT_FOUND) {
    const agentEntry = entryAt(branch, precedingAgentIndex);
    const agentBlock = renderAssistantTextBlock(agentEntry, OMIT_ENTRY_ID); // sanitized, text-only; no entry id (recall consumer)
    if (agentBlock.length > 0) preludeParts.push(agentBlock);
  }
  const userText = renderTail([userEntry], options);
  preludeParts.push(userText);

  const preludeText = preludeParts.join("");
  const tailText = renderTail(tail, options);
  return `${preludeText}\n${TRUNCATION_MARKER}\n${tailText}`;
}

/** Join a slice of entries' rendered XML-tag chunks into one text block. */
function renderTail(entries: readonly SessionEntry[], options: ChunkOptions): string {
  const chunks = buildChunks(entries, options);
  return chunks.map((chunk) => chunk.text).join(BLOCK_SEP);
}

/** Index of the last user message that is NOT an avtc-pi-unstuck auto-injection. */
function findLastUserMessage(branch: readonly SessionEntry[]): number {
  for (let i = branch.length - 1; i >= 0; i -= 1) {
    const entry = branch[i];
    if (!isMessageEntry(entry)) continue;
    const { message } = entry;
    if (message.role !== "user") continue;
    if (isUnstuckAutoContinue(message)) continue;
    return i;
  }
  return NOT_FOUND;
}

/** Index of the nearest preceding assistant message carrying TEXT before
 *  `from` — skips textless (tool-call-only / thinking-only) turns so the prelude
 *  surfaces the last contextual agent text, not an empty tool turn. */
function findPrecedingAssistantText(branch: readonly SessionEntry[], from: number): number {
  for (let i = from - 1; i >= 0; i -= 1) {
    const entry = branch[i];
    if (!isMessageEntry(entry)) continue;
    if (entry.message.role !== "assistant") continue;
    if (hasAssistantText(entry)) return i; // has text
  }
  return NOT_FOUND;
}

/** Read a branch entry by index with a runtime guard (indices returned by the
 *  finders are always valid). */
function entryAt(branch: readonly SessionEntry[], index: number): SessionEntry {
  const entry = branch[index];
  if (entry === undefined) throw new Error(`branch index ${index} out of range`);
  return entry;
}

// --- todo context -----------------------------------------------------------

const TODO_HEADING = "Todo";
const NO_IN_PROGRESS = "(nothing in progress)";

/**
 * Render the Selector's todo context: the in-progress item with its full
 * details, plus the pending items as a terse list (no details). When there is
 * no in-progress item, an explicit placeholder is shown so the Selector knows
 * the work state. (Pending details are drilled via the `todo_list` tool.)
 */
export function buildTodo(ctx: TodoContext): string {
  const lines: string[] = [TODO_HEADING];
  const inProgress = ctx.getInProgress();
  if (inProgress === null) {
    lines.push(NO_IN_PROGRESS);
  } else {
    lines.push(`in_progress: ${inProgress.name}`);
    if (inProgress.details !== undefined && inProgress.details.length > 0) {
      lines.push(inProgress.details);
    }
  }
  const pending = ctx.getPending();
  if (pending.length > 0) {
    lines.push("pending:");
    for (const item of pending) lines.push(`- ${item.name}`);
  }
  return lines.join("\n");
}

// --- full input-view assembly ----------------------------------------------

/** The tail legend — the self-documenting uppercase tag forms (no entry=id:
 *  the Selector is a recall consumer, not a citator). */
const TAIL_LEGEND_NO_ENTRY = "<USER> · <ASSISTANT> · <THINKING> · <TOOLCALL:name> · <TOOLRESULT>";

/** Full args for assembling the Selector's agentLoop-start input view. */
export interface SelectorInputViewArgs {
  sourceGraph: MemkeeperGraph;
  tail: TailContext;
  tailBoundary: TailBoundary;
  /** `null` = avtc-pi-todo bridge absent → omit the todo section entirely. */
  todo: TodoContext | null;
  touchedFiles: TouchedFilesContext;
  /** Touched files since this entry id (the compaction cut); null = whole branch. */
  sinceEntryId: string | null;
  chunkOptions: ChunkOptions;
}

/** Result of assembling the Selector input view. */
export interface SelectorInputView {
  /** The stable context (everything EXCEPT the working-tree section): the
   *  current-task context (tail + todo + touched files) + legends. Built ONCE
   *  before the pass loop and reused each pass — the working tree mutates
   *  across passes, but this context does not. */
  contextView: string;
  workingCopy: SelectorWorkingCopy;
}

/**
 * Assemble the Selector's agentLoop-start payload: the working tree
 * (the deep-copied, nIrrelevant-injected graph rendered at its roots), the
 * current-task context (recent tail + todo + touched files), and two legends.
 *
 * The working copy is returned alongside so the Selector's tools operate
 * on it; the source graph is untouched.
 */
export function buildSelectorInputView(args: SelectorInputViewArgs): SelectorInputView {
  const workingCopy = buildWorkingCopy(args.sourceGraph);

  const contextSections: string[] = [];

  // B. Current-task context.
  contextSections.push("Current task");
  const tailText = buildTail(args.tail, args.tailBoundary, args.chunkOptions);
  if (tailText.length > 0) {
    contextSections.push("Recent tail");
    contextSections.push(tailText);
  }
  if (args.todo !== null) {
    contextSections.push(buildTodo(args.todo));
  }
  const touched = extractTouchedFiles(args.touchedFiles, args.sinceEntryId);
  if (touched.length > 0) {
    contextSections.push("Touched since last compaction");
    contextSections.push(renderTouchedFiles(touched).join("\n"));
  }

  // C. Legends.
  contextSections.push("Legend");
  contextSections.push(RENDER_LEGEND);
  contextSections.push(TAIL_LEGEND_NO_ENTRY);

  const contextView = contextSections.join("\n\n");

  return { contextView, workingCopy };
}

/** Render the working copy's non-obsolete roots: nGoal first, then the rest by
 *  importance desc / recency desc, nIrrelevant last. Exported so the Selector
 *  run re-renders the working tree each pass (it mutates across passes). */
export function renderWorkingRoots(workingCopy: SelectorWorkingCopy): string {
  const graph = workingCopy.graph;
  const ordered = orderedNonObsoleteRoots(graph.nodes.values());
  return ordered
    .map((node) =>
      formatNodeLine(node, { ...nodeLineOptions(NON_BUILDER), singleObs: singleDirectObs(node, graph.observations) }),
    )
    .join("\n");
}
