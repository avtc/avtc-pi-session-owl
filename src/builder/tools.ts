// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// The Builder MUTATE tools (mkdir/mv/merge/supersede/set_meta) — each an
// AgentTool whose execute applies a T3 mutator to the SOURCE graph with
// `MUTATE_SOURCE` policy (the nGoal/oInitialPrompt protection matrix is
// enforced) and appends the delta to the store. The shared read tools
// (ls/cat/find) + try_finish + the root-view render/measure helpers live in
// `../graph/read-tools.js` (parameterized by viewer) and are assembled into the
// full Builder toolset below.

import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import type { MemkeeperConfig } from "../config/schema.js";
import { GraphInvariantError } from "../graph/invariants.js";
import {
  applyCreateNode,
  applyMerge,
  applyMv,
  applySetMeta,
  applySupersede,
  type GraphDelta,
  MUTATE_SOURCE,
} from "../graph/mutations.js";
import {
  makeReadTools,
  makeTryFinishTool,
  measureRootViewTokens,
  renderRootView,
  TRY_FINISH_TOOL,
} from "../graph/read-tools.js";
import { appendGraphDelta, type StoreContext } from "../store/graph-store.js";
import type { Importance, MemkeeperGraph, NodeId, ObsId } from "../types.js";

// Re-export the shared read-tool names + helpers so existing import sites
// (compaction/hook, the run, tests) keep resolving through this module while
// the canonical definitions live in graph/read-tools.
export {
  CAT_TOOL,
  FIND_TOOL,
  LS_TOOL,
  measureRootViewTokens,
  paginate,
  type ResolvedPage,
  renderRootView,
  resolvePage,
  TRY_FINISH_TOOL,
} from "../graph/read-tools.js";

// --- named mutate constants ------------------------------------------------

export const MKDIR_TOOL = "mkdir";
export const MV_TOOL = "mv";
export const MERGE_TOOL = "merge";
export const SUPERSEDE_TOOL = "supersede";
export const SET_META_TOOL = "set_meta";

/** The five Builder mutate tools (no-op detection: a pass with none of these
 *  applied is a no-op run). Read tools (ls/cat/find) and try_finish excluded. */
export const MUTATE_TOOL_NAMES: ReadonlySet<string> = new Set([
  MKDIR_TOOL,
  MV_TOOL,
  MERGE_TOOL,
  SUPERSEDE_TOOL,
  SET_META_TOOL,
]);

/** Default importance for Builder-created container nodes. */
const DEFAULT_NODE_IMPORTANCE: Importance = "medium";

// --- mutate result helpers -------------------------------------------------

/** A success mutation result: the ack text + the applied delta recorded in
 *  `details` for inspection/tests. */
function okResult(text: string, delta: GraphDelta): AgentToolResult<unknown> {
  return { content: [{ type: "text", text }], details: { ok: true as const, delta } };
}

/** An error mutation result: the model sees the message and can retry. The
 *  graph is unchanged (the mutator threw before mutating). */
function errorResult(message: string): AgentToolResult<unknown> {
  return { content: [{ type: "text", text: message }], details: { error: true } };
}

/** Run a mutation, persist its delta, and report success — or catch a structural
 *  rejection (GraphInvariantError) and surface it as an error result the model
 *  can retry from. A rejected mutate leaves the graph AND the delta log
 *  unchanged (the mutator throws before mutating). `describe(delta)` builds the
 *  success text from the APPLIED delta so the model learns any new/resolved ids
 *  (e.g. merge with destId=null resolves a new root id). */
function applyAndPersist(
  store: StoreContext,
  what: string,
  apply: () => GraphDelta,
  describe: (delta: GraphDelta) => string,
): AgentToolResult<unknown> {
  let delta: GraphDelta;
  try {
    delta = apply();
  } catch (cause) {
    if (cause instanceof GraphInvariantError) {
      return errorResult(`${what}: ${cause.message}`);
    }
    throw cause;
  }
  appendGraphDelta(store, delta);
  return okResult(describe(delta), delta);
}

// --- mkdir -----------------------------------------------------------------

/** Build the `mkdir` tool: create a container node (zero observations OK) under
 *  an optional parent, state `active`, default importance medium. */
function makeMkdirTool(graph: MemkeeperGraph, store: StoreContext): AgentTool<typeof MKDIR_PARAMS> {
  return {
    name: MKDIR_TOOL,
    description: "Create an empty container node for grouping. Returns the new node's id.",
    label: "Create container",
    parameters: MKDIR_PARAMS,
    async execute(_toolCallId, params) {
      // generate the id from the counter BEFORE applyCreateNode (which advances it).
      const id = `n${graph.nextNodeId}` as NodeId;
      return applyAndPersist(
        store,
        `mkdir ${id}`,
        () =>
          applyCreateNode(graph, {
            id,
            summary: params.summary,
            importance: DEFAULT_NODE_IMPORTANCE,
            parentNode: (params.parentId ?? null) as NodeId | null,
            state: "active",
          }),
        () => `Created ${id} (active).`,
      );
    },
  };
}

const MKDIR_PARAMS = Type.Object({
  summary: Type.String({ minLength: 1, description: "The new node's summary." }),
  parentId: Type.Optional(Type.String({ description: "A parent node, or omit/null for the root." })),
});

// --- mv --------------------------------------------------------------------

/** Build the `mv` tool: move observations and/or nodes to a new parent (or to
 *  the root when destId is null). An optional newSummary rewrites the dest
 *  node's summary as part of the same atomic mutate (ignored when destId is
 *  null — promoting to root touches no dest). */
function makeMvTool(graph: MemkeeperGraph, store: StoreContext): AgentTool<typeof MV_PARAMS> {
  return {
    name: MV_TOOL,
    description:
      "Move items (nodes and/or observations) into a destination node or to the root — for grouping, splitting, or reparenting.",
    label: "Move",
    parameters: MV_PARAMS,
    async execute(_toolCallId, params) {
      const destId = (params.destId ?? null) as NodeId | null;
      // newSummary is meaningful only when there is a dest node to rewrite.
      const newSummary = destId === null ? undefined : params.newSummary;
      return applyAndPersist(
        store,
        "mv",
        () =>
          applyMv(
            graph,
            {
              sourceIds: params.sourceIds as Array<ObsId | NodeId>,
              destId,
              ...(newSummary !== undefined ? { newSummary } : {}),
            },
            MUTATE_SOURCE,
          ),
        () => {
          const where = destId === null ? "the root" : destId;
          return `Moved ${params.sourceIds.length} item(s) to ${where}.`;
        },
      );
    },
  };
}

const MV_PARAMS = Type.Object({
  sourceIds: Type.Array(Type.String(), { minItems: 1, description: "The items to move. At least one." }),
  destId: Type.Optional(Type.String({ description: "The destination node, or null for the root." })),
  newSummary: Type.Optional(
    Type.String({ minLength: 1, description: "Optionally rewrite the destination node's summary." }),
  ),
});

// --- merge -----------------------------------------------------------------

/** Build the `merge` tool: fold absorbed nodes into a target. newSummary is
 *  required when destId is null (names the new root node); optional when merging
 *  into an existing dest (a refreshed synthesis — omit to keep the dest summary).
 *  Absorbed nodes dissolve once emptied. */
function makeMergeTool(graph: MemkeeperGraph, store: StoreContext): AgentTool<typeof MERGE_PARAMS> {
  return {
    name: MERGE_TOOL,
    description:
      "Fold nodes into a destination, combining their contents; the absorbed nodes dissolve. Write a fresh summary for the result.",
    label: "Merge",
    parameters: MERGE_PARAMS,
    async execute(_toolCallId, params) {
      const destId = (params.destId ?? null) as NodeId | null;
      if (destId === null && (params.newSummary === undefined || params.newSummary.length === 0)) {
        return errorResult("merge: newSummary is required when destId is null (names the new root node).");
      }
      // When destId is null, applyMerge creates a new root at n<nextNodeId>; capture
      // the id BEFORE the call so the result can surface it to the model.
      const newRootId = destId === null ? (`n${graph.nextNodeId}` as NodeId) : null;
      return applyAndPersist(
        store,
        "merge",
        () =>
          applyMerge(
            graph,
            {
              sourceIds: params.sourceIds as NodeId[],
              destId,
              ...(params.newSummary !== undefined ? { newSummary: params.newSummary } : {}),
            },
            MUTATE_SOURCE,
          ),
        () => {
          const where = newRootId ?? destId;
          return `Merged ${params.sourceIds.length} node(s) into ${where}.`;
        },
      );
    },
  };
}

const MERGE_PARAMS = Type.Object({
  sourceIds: Type.Array(Type.String(), {
    minItems: 1,
    description: "The nodes to fold in (their observations and children come along). At least one.",
  }),
  destId: Type.Optional(Type.String({ description: "The destination node, or null to create a new root node." })),
  newSummary: Type.Optional(
    Type.String({
      minLength: 1,
      description: "A synthesized summary for the destination (required when `destId` is null).",
    }),
  ),
});

// --- supersede -------------------------------------------------------------

/** Build the `supersede` tool: mark nodes obsolete, each carrying supersededBy
 *  pointing at the replacement. The superseded nodes retain their evidence. */
function makeSupersedeTool(graph: MemkeeperGraph, store: StoreContext): AgentTool<typeof SUPERSEDE_PARAMS> {
  return {
    name: SUPERSEDE_TOOL,
    description: "Retire nodes as obsolete, pointing each at a replacement node.",
    label: "Supersede",
    parameters: SUPERSEDE_PARAMS,
    async execute(_toolCallId, params) {
      return applyAndPersist(
        store,
        "supersede",
        () =>
          applySupersede(
            graph,
            { nodeId: params.nodeId as NodeId, supersededNodeIds: params.supersededNodeIds as NodeId[] },
            MUTATE_SOURCE,
          ),
        () => `Superseded ${params.supersededNodeIds.length} node(s) with ${params.nodeId}.`,
      );
    },
  };
}

const SUPERSEDE_PARAMS = Type.Object({
  nodeId: Type.String({ description: "The replacement node — the current truth." }),
  supersededNodeIds: Type.Array(Type.String(), {
    minItems: 1,
    description: "The nodes to retire. At least one.",
  }),
});

// --- set_meta --------------------------------------------------------------

/** Build the `set_meta` tool: re-rate importance, archive/un-archive, condense
 *  the summary, or resurrect an obsolete node. obsolete:true is rejected (use
 *  supersede). nGoal allows summary only. */
function makeSetMetaTool(graph: MemkeeperGraph, store: StoreContext): AgentTool<typeof SET_META_PARAMS> {
  return {
    name: SET_META_TOOL,
    description:
      "Change a node's importance, archive or resurrect it, or rewrite its summary. (`nGoal` allows summary only.)",
    label: "Edit metadata",
    parameters: SET_META_PARAMS,
    async execute(_toolCallId, params) {
      return applyAndPersist(
        store,
        "set_meta",
        () =>
          applySetMeta(
            graph,
            {
              nodeId: params.nodeId as NodeId,
              importance: (params.importance ?? null) as Importance | null,
              archived: params.archived ?? null,
              obsolete: params.obsolete ?? null,
              summary: params.summary ?? null,
            },
            MUTATE_SOURCE,
          ),
        () => `Updated ${params.nodeId}.`,
      );
    },
  };
}

const SET_META_PARAMS = Type.Object({
  nodeId: Type.String({ description: "The node to update." }),
  importance: Type.Optional(
    StringEnum(["critical", "high", "medium", "low"], {
      description: "New importance — critical, high, medium, or low.",
    }),
  ),
  archived: Type.Optional(Type.Boolean({ description: "True to archive, false to restore to active." })),
  summary: Type.Optional(Type.String({ minLength: 1, description: "A new summary for the node." })),
  obsolete: Type.Optional(
    Type.Boolean({ description: "False to resurrect an obsolete node (clears its replacement link)." }),
  ),
});

// --- factory ---------------------------------------------------------------

/** Build the Builder read tools (ls/cat/find) rendered for the Builder viewer
 *  (the 🆕 glyph is Builder-only — non-Builder consumers render `new` as
 *  `active`). Thin wrapper over the shared read-tool factories. */
export function makeBuilderReadTools(graph: MemkeeperGraph): AgentTool[] {
  return makeReadTools(graph, "builder");
}

/** Build the full Builder toolset (9 tools): ls/cat/find (read) +
 *  mkdir/mv/merge/supersede/set_meta/try_finish (mutate). The mutate tools close
 *  over the store (to append graph deltas) and settings (try_finish threshold).
 *  Builder tools operate on the SOURCE graph with `MUTATE_SOURCE` policy (the
 *  nGoal/oInitialPrompt protection matrix is enforced). */
export function makeBuilderTools(graph: MemkeeperGraph, store: StoreContext, settings: MemkeeperConfig): AgentTool[] {
  return [
    ...makeBuilderReadTools(graph),
    makeMkdirTool(graph, store),
    makeMvTool(graph, store),
    makeMergeTool(graph, store),
    makeSupersedeTool(graph, store),
    makeSetMetaTool(graph, store),
    makeTryFinishTool(graph, { rootViewThreshold: settings.builderRootViewThreshold }, "builder"),
  ];
}
