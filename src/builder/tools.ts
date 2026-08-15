// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// The Builder MUTATE tools — supersede + set_meta (Builder-only source-graph
// semantics) PLUS the assembly of the full 9-tool Builder toolset. The shared
// mkdir/mv/merge + the Selector's set_meta factories live in `../graph/mutate-tools.js`
// (parameterized by a MutateContext = policy + persistence strategy); the shared
// read tools (ls/cat/find) + try_finish + the root-view render/measure helpers
// live in `../graph/read-tools.js` (parameterized by viewer). The Builder wires
// both with the source-graph policy + the store-appending persist + the
// "builder" viewer.

import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import type { MemkeeperConfig } from "../config/schema.js";
import { BUILDER } from "../format/render.js";
import {
  MERGE_TOOL,
  MKDIR_TOOL,
  type MutateContext,
  MV_TOOL,
  makeMergeTool,
  makeMkdirTool,
  makeMvTool,
  runMutate,
} from "../graph/mutate-tools.js";
import { applySetMeta, applySupersede, MUTATE_SOURCE } from "../graph/mutations.js";
import { makeReadTools, makeTryFinishTool } from "../graph/read-tools.js";
import { ImportanceSchema } from "../schema.js";
import { appendGraphDelta, type StoreContext } from "../store/graph-store.js";
import type { Importance, MemkeeperGraph, NodeId } from "../types.js";

// Re-export the Builder toolset names + param schemas so callers (the run, the
// compaction hook, tests) can name the full Builder surface through the module
// that assembles it. The canonical definitions live in graph/read-tools +
// graph/mutate-tools.
export { MERGE_TOOL, MKDIR_TOOL, MV_TOOL } from "../graph/mutate-tools.js";
export {
  CAT_TOOL,
  FIND_TOOL,
  LS_TOOL,
  measureRootViewTokens,
  renderRootView,
  TRY_FINISH_TOOL,
} from "../graph/read-tools.js";

// --- named Builder-only mutate constants -----------------------------------

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

// --- Builder source-graph mutate context ---------------------------------

/** The Builder's source-graph MutateContext: `source` policy (nGoal/oInitialPrompt
 *  protections enforced) + a persist that appends every applied delta to the
 *  store's event log. The shared runMutate helper applies, persists, and surfaces
 *  structural rejections as error results. */
function sourceMutateContext(store: StoreContext): MutateContext {
  return { policy: MUTATE_SOURCE, persist: (delta) => appendGraphDelta(store, delta) };
}

// --- supersede -------------------------------------------------------------

const SUPERSEDE_PARAMS = Type.Object({
  nodeId: Type.String({ description: "The replacement node — the current truth." }),
  supersededNodeIds: Type.Array(Type.String(), {
    minItems: 1,
    description: "The nodes to retire. At least one.",
  }),
});

/** Build the `supersede` tool: mark nodes obsolete, each carrying supersededBy
 *  pointing at the replacement. The superseded nodes retain their evidence. */
function makeSupersedeTool(graph: MemkeeperGraph, ctx: MutateContext): AgentTool<typeof SUPERSEDE_PARAMS> {
  return {
    name: SUPERSEDE_TOOL,
    description: "Retire nodes as obsolete, pointing each at a replacement node.",
    label: "Supersede",
    parameters: SUPERSEDE_PARAMS,
    async execute(_toolCallId, params) {
      return runMutate(
        graph,
        ctx,
        "supersede",
        () =>
          applySupersede(
            graph,
            { nodeId: params.nodeId as NodeId, supersededNodeIds: params.supersededNodeIds as NodeId[] },
            ctx.policy,
          ),
        () => `Superseded ${params.supersededNodeIds.length} node(s) with ${params.nodeId}.`,
      );
    },
  };
}

// --- set_meta --------------------------------------------------------------

const SET_META_PARAMS = Type.Object({
  nodeId: Type.String({ description: "The node to update." }),
  importance: Type.Optional({
    ...ImportanceSchema,
    description: "How much the node matters if lost — crit, high, med, or low.",
  }),
  archived: Type.Optional(Type.Boolean({ description: "True to archive, false to restore to active." })),
  summary: Type.Optional(Type.String({ minLength: 1, description: "A new summary for the node." })),
  obsolete: Type.Optional(
    Type.Boolean({ description: "False to resurrect an obsolete node (clears its replacement link)." }),
  ),
});

/** Build the `set_meta` tool: re-rate importance, archive/un-archive, condense
 *  the summary, or resurrect an obsolete node. obsolete:true is rejected (use
 *  supersede). nGoal allows summary only. */
function makeSetMetaTool(graph: MemkeeperGraph, ctx: MutateContext): AgentTool<typeof SET_META_PARAMS> {
  return {
    name: SET_META_TOOL,
    description:
      "Change a node's importance, archive or resurrect it, or rewrite its summary. (`nGoal` allows summary only.)",
    label: "Edit metadata",
    parameters: SET_META_PARAMS,
    async execute(_toolCallId, params) {
      return runMutate(
        graph,
        ctx,
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
            ctx.policy,
          ),
        () => `Updated ${params.nodeId}.`,
      );
    },
  };
}

// --- factory ---------------------------------------------------------------

/** Build the Builder read tools (ls/cat/find) rendered for the Builder viewer
 *  (the 🆕 glyph is Builder-only — non-Builder consumers render `new` as
 *  `active`). Thin wrapper over the shared read-tool factories. */
export function makeBuilderReadTools(graph: MemkeeperGraph): AgentTool[] {
  return makeReadTools(graph, BUILDER);
}

/** Build the full Builder toolset (9 tools): ls/cat/find (read) +
 *  mkdir/mv/merge/supersede/set_meta/try_finish (mutate). The mutate tools close
 *  over the store (to append graph deltas) and settings (try_finish threshold).
 *  Builder tools operate on the SOURCE graph with `MUTATE_SOURCE` policy (the
 *  nGoal/oInitialPrompt protection matrix is enforced). */
export function makeBuilderTools(graph: MemkeeperGraph, store: StoreContext, settings: MemkeeperConfig): AgentTool[] {
  const ctx = sourceMutateContext(store);
  return [
    ...makeBuilderReadTools(graph),
    makeMkdirTool(graph, ctx),
    makeMvTool(graph, ctx),
    makeMergeTool(graph, ctx),
    makeSupersedeTool(graph, ctx),
    makeSetMetaTool(graph, ctx),
    makeTryFinishTool(graph, { rootViewThreshold: settings.builderRootViewThreshold }, BUILDER),
  ];
}
