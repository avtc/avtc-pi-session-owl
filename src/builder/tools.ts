// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// The Builder toolset — 3 read tools here (ls/cat/find) + 5 mutate tools +
// try_finish appended in the mutate-tools task. Each is an AgentTool whose
// execute operates on the source graph (read-only here). The shared one-line
// render format (formatNodeLine/formatObservationLine) is reused across
// Builder ls/find, the Selector, mk_recall, the user commands, and the
// compaction summary.

import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import type { MemkeeperConfig } from "../config/schema.js";
import { formatNodeLine, formatObservationLine, formatTimestamp, importanceAbbr } from "../format/render.js";
import { PageSchema } from "../schema.js";
import {
  IMPORTANCE_RANK,
  type MemkeeperGraph,
  type Node,
  type NodeId,
  type Observation,
  type ObsId,
} from "../types.js";

// --- named constants (no bare literals at call sites) ----------------------

export const LS_TOOL = "ls";
export const CAT_TOOL = "cat";
export const FIND_TOOL = "find";

/** Default page size for cursor pagination. */
const DEFAULT_TAKE = 50;
/** take === 0 means "all" (no pagination). */
const TAKE_ALL = 0;
const INDENT_STEP = 2;
const ROOT_DEPTH = 0;
const ROOT_PARENT: NodeId | null = null;
const NO_AFTER_ID: string | null = null;

/** Resolved cursor pagination: an ordered window into a full results list. */
interface ResolvedPage {
  take: number;
  afterId: string | null;
}

/** Normalize a raw `page` param (all-optional; TypeBox-inferred as unknown) into
 *  a resolved window. */
function resolvePage(page: unknown): ResolvedPage {
  if (page === null || page === undefined || typeof page !== "object") {
    return { take: DEFAULT_TAKE, afterId: NO_AFTER_ID };
  }
  const raw = page as { take?: number; afterId?: string | null };
  return { take: raw.take ?? DEFAULT_TAKE, afterId: raw.afterId ?? NO_AFTER_ID };
}

/** Slice a results list by cursor pagination; return the window, whether more
 *  remain, and how many remain. `take === 0` returns the whole list. */
function paginate<T extends { id: string }>(
  items: T[],
  page: ResolvedPage,
): { window: T[]; more: boolean; remaining: number } {
  if (page.take === TAKE_ALL) return { window: items, more: false, remaining: 0 };
  const startIdx =
    page.afterId === NO_AFTER_ID
      ? 0
      : (() => {
          const i = items.findIndex((item) => item.id === page.afterId);
          return i < 0 ? 0 : i + 1;
        })();
  const window = items.slice(startIdx, startIdx + page.take);
  const remaining = Math.max(0, items.length - (startIdx + page.take));
  return { window, more: remaining > 0, remaining };
}

/** Render a pagination footer (only when more remain). */
function footer(lastId: string, remaining: number): string {
  return `… +${remaining} more · afterId=${lastId}`;
}

/** Indent a line by `depth` levels (2 spaces each). */
function indent(line: string, depth: number): string {
  return `${" ".repeat(depth * INDENT_STEP)}${line}`;
}

// --- ordering --------------------------------------------------------------

/** Importance desc (critical→low), then rangeEnd recency desc (newer first). */
function compareNodeOrder(a: Node, b: Node): number {
  const byImportance = IMPORTANCE_RANK[b.importance] - IMPORTANCE_RANK[a.importance];
  if (byImportance !== 0) return byImportance;
  return b.timestamps.rangeEnd.localeCompare(a.timestamps.rangeEnd);
}

/** Recency desc by timestamp (newer first). */
function compareObservationOrder(a: Observation, b: Observation): number {
  return b.timestamp.localeCompare(a.timestamp);
}

/** A node is obsolete when its state is "obsolete". */
function isObsolete(node: Node): boolean {
  return node.state === "obsolete";
}

// --- ls --------------------------------------------------------------------

/** The roots of the graph: nodes whose parentNode is null. */
function rootNodes(graph: MemkeeperGraph): Node[] {
  return [...graph.nodes.values()].filter((n) => n.parentNode === ROOT_PARENT);
}

/** Direct child nodes + direct observations of a parent node, ordered
 *  nodes-first (importance desc, then recency) then observations (recency). */
function directChildren(graph: MemkeeperGraph, parent: Node): { nodes: Node[]; observations: Observation[] } {
  const nodes = parent.childNodeIds
    .map((id) => graph.nodes.get(id))
    .filter((n): n is Node => n !== undefined)
    .sort(compareNodeOrder);
  const observations = parent.observationIds
    .map((id) => graph.observations.get(id))
    .filter((o): o is Observation => o !== undefined)
    .sort(compareObservationOrder);
  return { nodes, observations };
}

function renderLines(lines: string[]): string {
  return lines.length === 0 ? "(empty)" : lines.join("\n");
}

const LS_PARAMS = Type.Object({
  nodeId: Type.Optional(Type.String()),
  page: Type.Optional(PageSchema),
});

/** Build the `ls` tool: one level of the memory graph. */
function makeLsTool(graph: MemkeeperGraph): AgentTool<typeof LS_PARAMS> {
  return {
    name: LS_TOOL,
    description:
      "List one level of the memory graph — the root nodes with no id, or a node's direct children (subnodes and observations).",
    label: "List",
    parameters: LS_PARAMS,
    async execute(_toolCallId, params) {
      const page = resolvePage(params.page);
      const lines: string[] = [];

      if (params.nodeId === undefined || params.nodeId === null) {
        // roots: non-obsolete only (obsolete hidden by default — findable via find).
        const roots = rootNodes(graph)
          .filter((n) => !isObsolete(n))
          .sort(compareNodeOrder);
        const { window, more, remaining } = paginate(roots, page);
        for (const node of window) lines.push(formatNodeLine(node, { viewer: "builder" }));
        if (more && window.length > 0) lines.push(footer(window[window.length - 1].id, remaining));
        return { content: [{ type: "text", text: renderLines(lines) }], details: { count: window.length, more } };
      }

      const parent = graph.nodes.get(params.nodeId as NodeId);
      if (parent === undefined) {
        return { content: [{ type: "text", text: `No node with id ${params.nodeId}.` }], details: { error: true } };
      }
      // header is the parent itself at depth 0; children indented at depth 1.
      lines.push(indent(formatNodeLine(parent, { viewer: "builder" }), ROOT_DEPTH));
      const { nodes, observations } = directChildren(graph, parent);
      const combined = [
        ...nodes.map((n) => ({ id: n.id, depth: 1, render: formatNodeLine(n, { viewer: "builder" }) })),
        ...observations.map((o) => ({ id: o.id, depth: 1, render: formatObservationLine(o, { viewer: "builder" }) })),
      ];
      const { window, more, remaining } = paginate(combined, page);
      for (const item of window) lines.push(indent(item.render, item.depth));
      if (more && window.length > 0) lines.push(footer(window[window.length - 1].id, remaining));
      return { content: [{ type: "text", text: renderLines(lines) }], details: { count: window.length, more } };
    },
  };
}

// --- cat -------------------------------------------------------------------

const CAT_PARAMS = Type.Object({
  ids: Type.Array(Type.String(), { minItems: 1 }),
  page: Type.Optional(PageSchema),
});

/** Build the `cat` tool: read full text — observations verbatim, or a node's
 *  header plus its direct observations verbatim (child nodes NOT expanded). */
function makeCatTool(graph: MemkeeperGraph): AgentTool<typeof CAT_PARAMS> {
  return {
    name: CAT_TOOL,
    description:
      "Read full text — an observation's content, or a node's header plus the full text of its direct observations. Sub-nodes are not expanded here (use `ls` for them). `ls` shows one-line structure; `cat` shows full content.",
    label: "Read full text",
    parameters: CAT_PARAMS,
    async execute(_toolCallId, params) {
      const page = resolvePage(params.page);
      const lines: string[] = [];

      // Gather full-text blocks per requested id (node → header + its obs;
      // observation → its full content + a compact header).
      const blocks: { id: string; text: string }[] = [];
      for (const id of params.ids) {
        const node = graph.nodes.get(id as NodeId);
        if (node !== undefined) {
          blocks.push({ id: node.id, text: catNodeBlock(graph, node) });
          continue;
        }
        const obs = graph.observations.get(id as ObsId);
        if (obs !== undefined) {
          blocks.push({ id: obs.id, text: catObservationBlock(obs) });
          continue;
        }
        blocks.push({ id, text: `No node or observation with id ${id}.` });
      }

      const { window, more, remaining } = paginate(blocks, page);
      for (const block of window) lines.push(block.text);
      if (more && window.length > 0) lines.push(footer(window[window.length - 1].id, remaining));
      return { content: [{ type: "text", text: lines.join("\n\n") }], details: { count: window.length, more } };
    },
  };
}

/** A content-free header for a cat observation block: id · importance · timestamp
 *  (NO content — that's the body; NO sourceEntryIds — provenance is internal). */
function catObsHeader(obs: Observation): string {
  return `📄 ${obs.id} ${importanceAbbr(obs.importance)} · ${formatTimestamp(obs.timestamp)}`;
}

/** A node's cat block: header line + its direct observations' full content. */
function catNodeBlock(graph: MemkeeperGraph, node: Node): string {
  const header = formatNodeLine(node, { viewer: "builder" });
  const obs = node.observationIds
    .map((id) => graph.observations.get(id))
    .filter((o): o is Observation => o !== undefined)
    .sort(compareObservationOrder);
  if (obs.length === 0) return header;
  const body = obs.map((o) => `${catObsHeader(o)}\n${o.content}`);
  return [header, ...body].join("\n");
}

/** An observation's cat block: a compact header (id · importance · timestamp,
 *  NO sourceEntryIds — provenance is internal-only) + the full content. */
function catObservationBlock(obs: Observation): string {
  return `${catObsHeader(obs)}\n${obs.content}`;
}

// --- find ------------------------------------------------------------------

const FIND_PARAMS = Type.Object({
  query: Type.String(),
  includeSuperseded: Type.Optional(Type.Boolean()),
  page: Type.Optional(PageSchema),
});

interface FindMatch {
  id: string;
  parent: NodeId | null;
  render: string;
}

/** Build the `find` tool: whole-graph regex search over node summaries +
 *  observation content, flat results each carrying `in <parent>`. */
function makeFindTool(graph: MemkeeperGraph): AgentTool<typeof FIND_PARAMS> {
  return {
    name: FIND_TOOL,
    description:
      "Search the whole memory graph by regex — node summaries and observation content. Flat results, each showing its parent.",
    label: "Find",
    parameters: FIND_PARAMS,
    async execute(_toolCallId, params) {
      const includeSuperseded = params.includeSuperseded ?? false;
      let regex: RegExp;
      try {
        regex = new RegExp(params.query);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text", text: `Invalid regex "${params.query}": ${message}. Retry with a fixed pattern.` }],
          details: { error: true },
        };
      }

      const matches: FindMatch[] = [];
      for (const node of graph.nodes.values()) {
        // parent-state gate: skip the node (and its evidence) when obsolete and
        // not including superseded.
        if (isObsolete(node) && !includeSuperseded) continue;
        if (regex.test(node.summary)) {
          matches.push({
            id: node.id,
            parent: node.parentNode,
            render: formatNodeLine(node, { viewer: "builder", showParent: node.parentNode ?? undefined }),
          });
        }
        for (const obsId of node.observationIds) {
          const obs = graph.observations.get(obsId);
          if (obs === undefined) continue;
          if (regex.test(obs.content)) {
            matches.push({
              id: obs.id,
              parent: node.id,
              render: formatObservationLine(obs, { viewer: "builder", showParent: node.id }),
            });
          }
        }
      }

      const page = resolvePage(params.page);
      const { window, more, remaining } = paginate(matches, page);
      const lines = window.map((m) => m.render);
      if (more && window.length > 0) lines.push(footer(window[window.length - 1].id, remaining));
      const text = lines.length === 0 ? "No matches." : lines.join("\n");
      return { content: [{ type: "text", text }], details: { count: window.length, more } };
    },
  };
}

// --- factory ---------------------------------------------------------------

/** Build the Builder read tools over the given source graph. The mutate tools
 *  + try_finish are appended in the mutate-tools task; both fold into a single
 *  `BUILDER_TOOLS` array there. */
export function makeBuilderTools(graph: MemkeeperGraph, _settings: MemkeeperConfig): AgentTool[] {
  return [makeLsTool(graph), makeCatTool(graph), makeFindTool(graph)];
}
