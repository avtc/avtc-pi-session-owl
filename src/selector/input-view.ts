import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import {
  extractTouchedFiles,
  isMessageEntry,
  renderTouchedFiles,
  type TouchedFilesContext,
} from "../compaction/touched-files.js";
import { formatNodeLine, RENDER_LEGEND } from "../format/render.js";
import { cloneGraph } from "../graph/clone.js";
import { orderActiveSetRoots } from "../graph/read-tools.js";
import { isUnstuckAutoContinue } from "../lifecycle.js";
import { buildChunks, type ChunkOptions, renderAssistantTextBlock } from "../observer/chunk.js";
import type { MemkeeperGraph, NodeId, ObsId } from "../types.js";
import { makeNode, N_IRRELEVANT, nowStoredTimestamp, ROOT_PARENT } from "../types.js";

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
  const clone = cloneGraph(source);

  // Drop obsolete nodes; collect their children for reparenting and note each
  // dropped node's parent so its childNodeIds can be cleaned (no phantom links).
  const toReparent: NodeId[] = [];
  const droppedParents: Array<{ parent: NodeId | null; dropped: NodeId }> = [];
  for (const [id, node] of clone.nodes) {
    if (node.state === "obsolete") {
      toReparent.push(...node.childNodeIds);
      droppedParents.push({ parent: node.parentNode, dropped: id });
      clone.nodes.delete(id);
    }
  }
  // Remove each dropped obsolete id from its parent's childNodeIds.
  for (const { parent, dropped } of droppedParents) {
    if (parent === null) continue;
    const parentNode = clone.nodes.get(parent);
    if (parentNode === undefined) continue; // parent itself dropped (nested obsolete)
    parentNode.childNodeIds = parentNode.childNodeIds.filter((cid) => cid !== dropped);
  }
  // Reparent a non-obsolete orphan whose parent was dropped to the root.
  for (const childId of toReparent) {
    const child = clone.nodes.get(childId);
    if (child !== undefined && child.parentNode !== null && !clone.nodes.has(child.parentNode)) {
      child.parentNode = null;
    }
  }
  // Drop observations whose parent node was excluded (obsolete subtree).
  const obsToDrop: ObsId[] = [];
  for (const [obsId, obs] of clone.observations) {
    if (!clone.nodes.has(obs.parentNode)) {
      obsToDrop.push(obsId);
    }
  }
  for (const obsId of obsToDrop) clone.observations.delete(obsId);

  // Inject nIrrelevant (predefined demote bin; summary "Irrelevant", empty, root).
  if (!clone.nodes.has(N_IRRELEVANT)) {
    clone.nodes.set(
      N_IRRELEVANT,
      makeNode({
        id: N_IRRELEVANT,
        summary: "Irrelevant",
        importance: "medium",
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
    const agentBlock = renderAssistantTextBlock(agentEntry); // sanitized, text-only
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
  return chunks.map((chunk) => chunk.text).join("");
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
    if (renderAssistantTextBlock(entry).length > 0) return i; // has text
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

/** One todo item (read-only view sourced from the avtc-pi-todo bridge, T22). */
export interface TodoItem {
  id: string;
  name: string;
  status: "in_progress" | "pending" | "completed";
  details?: string;
}

/** Port over the (optional) avtc-pi-todo bridge. `null`/undefined bridge → no
 *  todo context (graceful degrade; not an error). */
export interface TodoContext {
  getInProgress: () => TodoItem | null;
  getPending: () => TodoItem[];
}

const TODO_HEADING = "Todo";
const NO_IN_PROGRESS = "(nothing in progress)";

/**
 * Render the Selector's todo context: the in-progress item with its full
 * details, plus the pending items as a terse list (no details). When there is
 * no in-progress item, an explicit placeholder is shown so the Selector knows
 * the work state. (Pending details are drilled via the `todo_list` tool, T16.)
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

/** The tail legend (Observer XML-tag format), WITHOUT the E= attribute — the
 *  Selector needs the tag glossary, not the citation convention. */
const TAIL_LEGEND_NO_E = "U user · A assistant · C tool-call · R tool-result · T thinking";

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
  view: string;
  /** The stable context (everything EXCEPT the working-tree section): the
   *  current-task context (tail + todo + touched files) + legends. Re-rendered
   *  fresh each pass so the per-pass message reflects the live working copy
   *  (the working tree mutates across passes; the context does not). */
  contextView: string;
  workingCopy: SelectorWorkingCopy;
}

/**
 * Assemble the Selector's agentLoop-start payload: the working tree
 * (the deep-copied, nIrrelevant-injected graph rendered at its roots), the
 * current-task context (recent tail + todo + touched files), and two legends.
 *
 * The working copy is returned alongside so the Selector's tools (T16) operate
 * on it; the source graph is untouched.
 */
export function buildSelectorInputView(args: SelectorInputViewArgs): SelectorInputView {
  const workingCopy = buildWorkingCopy(args.sourceGraph);

  const workingTree = renderWorkingRoots(workingCopy);

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
  contextSections.push(TAIL_LEGEND_NO_E);

  const contextView = contextSections.join("\n\n");
  const view = [`Working tree\n\n${workingTree}`, contextView].join("\n\n");

  return { view, contextView, workingCopy };
}

/** Render the working copy's non-obsolete roots: nGoal first, then the rest by
 *  importance desc / recency desc, nIrrelevant last. Exported so the Selector
 *  run re-renders the working tree each pass (it mutates across passes). */
export function renderWorkingRoots(workingCopy: SelectorWorkingCopy): string {
  const graph = workingCopy.graph;
  const roots = [...graph.nodes.values()].filter(
    (node) => node.parentNode === ROOT_PARENT && node.state !== "obsolete",
  );
  const ordered = orderActiveSetRoots(roots);
  return ordered.map((node) => formatNodeLine(node, { viewer: "nonBuilder" })).join("\n");
}
