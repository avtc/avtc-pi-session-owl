// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// Shared graph MUTATE tool factories (mkdir/mv/merge/set_summary) parameterized
// by a MutateContext that names BOTH the policy (source vs workingCopy) AND the
// persistence strategy (append the delta to the store, or drop it). The Builder
// (source graph, store-appending) and the Selector (working copy, no store
// append — the final tree is persisted once at run completion) build their
// mutate tools from these factories — no duplication.

import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import type { Importance, MemkeeperGraph, NodeId, ObsId } from "../types.js";
import { GraphInvariantError } from "./invariants.js";
import {
  applyCreateNode,
  applyMerge,
  applyMv,
  applySetMeta,
  type GraphDelta,
  type MutationPolicy,
} from "./mutations.js";

// --- named constants (no bare literals at call sites) ----------------------

export const MKDIR_TOOL = "mkdir";
export const MV_TOOL = "mv";
export const MERGE_TOOL = "merge";
export const SET_SUMMARY_TOOL = "set_summary";

const DEFAULT_NODE_IMPORTANCE: Importance = "medium";

// --- MutateContext (the source-vs-working-copy seam) -----------------------

/** The context every shared mutate tool binds to. `policy` selects the
 *  protection matrix (`source` enforces nGoal/oInitialPrompt; `workingCopy`
 *  skips it); `persist` decides what happens to the applied delta (the Builder
 *  appends it to the store; the Selector drops it — its working copy is
 *  transient). Both still enforce the structural invariants (the
 *  always-attached observation invariant, no cycles, and auto-dissolution). */
export interface MutateContext {
  policy: MutationPolicy;
  persist: (delta: GraphDelta) => void;
}

/** A success mutate result: the ack text + the applied delta recorded in
 *  `details` (the Builder surfaces it for inspection; the Selector passes a
 *  no-op persist so no delta leaks). */
function okResult(text: string, delta: GraphDelta, ctx: MutateContext): AgentToolResult<unknown> {
  return { content: [{ type: "text", text }], details: { ok: true as const, delta, persisted: ctx.policy } };
}

/** An error mutate result: the model sees the message and can retry. The graph
 *  is unchanged (the mutator threw before mutating). */
function errorResult(message: string): AgentToolResult<unknown> {
  return { content: [{ type: "text", text: message }], details: { error: true } };
}

/** Run a mutation, persist its delta via `ctx.persist`, and report success — or
 *  catch a structural rejection (GraphInvariantError) and surface it as an error
 *  result the model can retry from. A rejected mutate leaves the graph (and the
 *  delta log, when the Builder persists) unchanged (the mutator throws before
 *  mutating). `describe(delta)` builds the success text from the APPLIED delta so
 *  the model learns any new/resolved ids (e.g. merge with destId=null resolves a
 *  new root id). */
export function runMutate(
  ctx: MutateContext,
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
  ctx.persist(delta);
  return okResult(describe(delta), delta, ctx);
}

// --- schemas ---------------------------------------------------------------

export const MKDIR_PARAMS = Type.Object({
  summary: Type.String({ minLength: 1, description: "The new node's summary." }),
  parentId: Type.Optional(Type.String({ description: "A parent node, or omit/null for the root." })),
});

export const MV_PARAMS = Type.Object({
  sourceIds: Type.Array(Type.String(), { minItems: 1, description: "The items to move. At least one." }),
  destId: Type.Optional(Type.String({ description: "The destination node, or null for the root." })),
  newSummary: Type.Optional(
    Type.String({ minLength: 1, description: "Optionally rewrite the destination node's summary." }),
  ),
});

export const MERGE_PARAMS = Type.Object({
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

export const SET_SUMMARY_PARAMS = Type.Object({
  nodeId: Type.String({ description: "The node whose summary to rewrite." }),
  summary: Type.String({ minLength: 1, description: "A new (typically condensed) summary for the node." }),
});

// --- mkdir -----------------------------------------------------------------

/** Build the `mkdir` tool: create a container node (zero observations OK) under
 *  an optional parent, state `active`, default importance medium. */
export function makeMkdirTool(graph: MemkeeperGraph, ctx: MutateContext): AgentTool<typeof MKDIR_PARAMS> {
  return {
    name: MKDIR_TOOL,
    description: "Create an empty container node for grouping. Returns the new node's id.",
    label: "Create container",
    parameters: MKDIR_PARAMS,
    async execute(_toolCallId, params) {
      // generate the id from the counter BEFORE applyCreateNode (which advances it).
      const id = `n${graph.nextNodeId}` as NodeId;
      return runMutate(
        ctx,
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

// --- mv --------------------------------------------------------------------

/** Build the `mv` tool: move observations and/or nodes to a new parent (or to
 *  the root when destId is null). An optional newSummary rewrites the dest
 *  node's summary as part of the same atomic mutate (ignored when destId is
 *  null — promoting to root touches no dest). */
export function makeMvTool(graph: MemkeeperGraph, ctx: MutateContext): AgentTool<typeof MV_PARAMS> {
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
      return runMutate(
        ctx,
        "mv",
        () =>
          applyMv(
            graph,
            {
              sourceIds: params.sourceIds as Array<ObsId | NodeId>,
              destId,
              ...(newSummary !== undefined ? { newSummary } : {}),
            },
            ctx.policy,
          ),
        () => {
          const where = destId === null ? "the root" : destId;
          return `Moved ${params.sourceIds.length} item(s) to ${where}.`;
        },
      );
    },
  };
}

// --- merge -----------------------------------------------------------------

/** Build the `merge` tool: fold absorbed nodes into a target. newSummary is
 *  required when destId is null (names the new root node); optional when merging
 *  into an existing dest (a refreshed synthesis — omit to keep the dest summary).
 *  Absorbed nodes dissolve once emptied. */
export function makeMergeTool(graph: MemkeeperGraph, ctx: MutateContext): AgentTool<typeof MERGE_PARAMS> {
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
      return runMutate(
        ctx,
        "merge",
        () =>
          applyMerge(
            graph,
            {
              sourceIds: params.sourceIds as NodeId[],
              destId,
              ...(params.newSummary !== undefined ? { newSummary: params.newSummary } : {}),
            },
            ctx.policy,
          ),
        () => {
          const where = newRootId ?? destId;
          return `Merged ${params.sourceIds.length} node(s) into ${where}.`;
        },
      );
    },
  };
}

// --- set_summary (summary-only) --------------------------------------------

/** Build the `set_summary` tool: rewrite a node's summary (typically condensing
 *  or clarifying it to fit the budget). Summary-only — structurally forbids
 *  importance/archived params (those are source properties, Builder-only via
 *  set_meta). Implemented over the shared set_meta mutator passing summary only. */
export function makeSetSummaryTool(graph: MemkeeperGraph, ctx: MutateContext): AgentTool<typeof SET_SUMMARY_PARAMS> {
  return {
    name: SET_SUMMARY_TOOL,
    description: "Rewrite a node's summary — condense or clarify it to fit the budget.",
    label: "Edit summary",
    parameters: SET_SUMMARY_PARAMS,
    async execute(_toolCallId, params) {
      return runMutate(
        ctx,
        "set_summary",
        () =>
          applySetMeta(
            graph,
            {
              nodeId: params.nodeId as NodeId,
              importance: null,
              archived: null,
              obsolete: null,
              summary: params.summary,
            },
            ctx.policy,
          ),
        () => `Updated ${params.nodeId}.`,
      );
    },
  };
}
