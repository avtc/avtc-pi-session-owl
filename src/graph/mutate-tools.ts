// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// Shared graph MUTATE tool factories (mkdir/mv/merge + the Selector's set_meta)
// parameterized by a MutateContext that names BOTH the policy (source vs
// workingCopy) AND the persistence strategy (append the delta to the store, or
// drop it). The Builder (source graph, store-appending) and the Selector
// (working copy, no store append — the final tree is persisted once at run
// completion) build their mutate tools from these factories — no duplication.

import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import { ImportanceSchema } from "../schema.js";
import type { Importance, SessionOwlGraph, NodeId, ObsId } from "../types.js";
import { GraphInvariantError } from "./invariants.js";
import {
  applyCreateNode,
  applyMerge,
  applyMv,
  applySetMeta,
  assertGraphStructure,
  type GraphDelta,
  type MutationPolicy,
} from "./mutations.js";

// --- named constants (no bare literals at call sites) ----------------------

export const MKDIR_TOOL = "mkdir";
export const MV_TOOL = "mv";
export const MERGE_TOOL = "merge";
export const SELECTOR_SET_META_TOOL = "set_meta";

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
 *  `details` for inspection. */
function okResult(text: string, delta: GraphDelta): AgentToolResult<unknown> {
  return { content: [{ type: "text", text }], details: { ok: true as const, delta } };
}

/** An error mutate result: the model sees the message and can retry. The graph
 *  is unchanged (the mutator threw before mutating). */
function errorResult(message: string): AgentToolResult<unknown> {
  return { content: [{ type: "text", text: message }], details: { error: true } };
}

/** Mutator op names that prefix their own `GraphInvariantError` messages. The
 *  tool-facing `runMutate` wrapper strips exactly one such leading prefix so the
 *  surfaced message is not doubled (`"merge: merge: …"`) — the wrapper's own
 *  `${what}:` already provides the op context. */
const OP_ERROR_PREFIXES = ["create_node", "record_observation", "mv", "merge", "supersede", "set_meta"] as const;

function stripOpPrefix(message: string): string {
  for (const op of OP_ERROR_PREFIXES) {
    const prefix = `${op}: `;
    if (message.startsWith(prefix)) return message.slice(prefix.length);
  }
  return message;
}

/** Run a mutation, persist its delta via `ctx.persist`, and report success — or
 *  catch a structural rejection (GraphInvariantError) and surface it as an error
 *  result the model can retry from. The graph is structurally validated BEFORE
 *  the op applies: a graph that is already invalid rejects the call with zero
 *  mutation, so memory never ends up ahead of the delta log (applied-but-
 *  unpersisted state). A structural failure AFTER apply is an op bug — it is
 *  surfaced the same way (never silently swallowed), with nothing persisted.
 *  `describe(delta)` builds the success text from the APPLIED delta so the
 *  model learns any new/resolved ids (e.g. merge with destId=null resolves a
 *  new root id). */
export function runMutate(
  graph: SessionOwlGraph,
  ctx: MutateContext,
  what: string,
  apply: () => GraphDelta,
  describe: (delta: GraphDelta) => string,
): AgentToolResult<unknown> {
  let delta: GraphDelta;
  try {
    assertGraphStructure(graph, what);
    delta = apply();
  } catch (cause) {
    if (cause instanceof GraphInvariantError) {
      return errorResult(`${what}: ${stripOpPrefix(cause.message)}`);
    }
    throw cause;
  }
  ctx.persist(delta);
  return okResult(describe(delta), delta);
}

// --- schemas ---------------------------------------------------------------

export const MKDIR_PARAMS = Type.Object({
  summary: Type.String({ minLength: 1, description: "The new node's summary." }),
  importance: {
    ...ImportanceSchema,
    description: "How much the new node matters if lost — crit, high, med, or low.",
  },
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
  importance: Type.Optional({
    ...ImportanceSchema,
    description:
      "How much the merged node matters if lost — crit, high, med, or low. Required when `destId` is null (names the new root); optional otherwise.",
  }),
});

export const SELECTOR_SET_META_PARAMS = Type.Object({
  nodeId: Type.String({ description: "The node to edit." }),
  summary: Type.Optional(
    Type.String({ minLength: 1, description: "A new (typically condensed) summary for the node." }),
  ),
  importance: Type.Optional({
    ...ImportanceSchema,
    description: "How much the node matters if lost — crit, high, med, or low.",
  }),
});

// --- mkdir -----------------------------------------------------------------

/** Build the `mkdir` tool: create a container node (zero observations OK) under
 *  an optional parent, state `active`, with the given importance. */
export function makeMkdirTool(graph: SessionOwlGraph, ctx: MutateContext): AgentTool<typeof MKDIR_PARAMS> {
  return {
    name: MKDIR_TOOL,
    description: "Create an empty container node for grouping. Returns the new node's id.",
    label: "Create container",
    parameters: MKDIR_PARAMS,
    async execute(_toolCallId, params) {
      // generate the id from the counter BEFORE applyCreateNode (which advances it).
      const id = `n${graph.nextNodeId}` as NodeId;
      return runMutate(
        graph,
        ctx,
        `mkdir ${id}`,
        () =>
          applyCreateNode(graph, {
            id,
            summary: params.summary,
            importance: params.importance as Importance,
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
export function makeMvTool(graph: SessionOwlGraph, ctx: MutateContext): AgentTool<typeof MV_PARAMS> {
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
        graph,
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
export function makeMergeTool(graph: SessionOwlGraph, ctx: MutateContext): AgentTool<typeof MERGE_PARAMS> {
  return {
    name: MERGE_TOOL,
    description: "Fold nodes into a destination, combining their contents; the absorbed nodes dissolve.",
    label: "Merge",
    parameters: MERGE_PARAMS,
    async execute(_toolCallId, params) {
      const destId = (params.destId ?? null) as NodeId | null;
      return runMutate(
        graph,
        ctx,
        "merge",
        () =>
          applyMerge(
            graph,
            {
              sourceIds: params.sourceIds as NodeId[],
              destId,
              ...(params.newSummary !== undefined ? { newSummary: params.newSummary } : {}),
              ...(params.importance !== undefined ? { importance: params.importance as Importance } : {}),
            },
            ctx.policy,
          ),
        // Read the resolved destination id from the APPLIED delta (set by
        // applyMerge when destId === null) so the id derivation lives in one place.
        (delta) => {
          const resolved = delta.type === "merge" ? delta.resolvedDestId : undefined;
          const where = resolved ?? destId;
          return `Merged ${params.sourceIds.length} node(s) into ${where}.`;
        },
      );
    },
  };
}

// --- set_meta (Selector variant: importance + summary, no lifecycle) ------

/** Build the Selector's `set_meta` tool: edit a node's summary and/or
 *  importance. Structurally forbids `archived`/`obsolete` — those lifecycle
 *  transitions are Builder-only (the Selector demotes via `nIrrelevant`, never
 *  by archiving). Implemented over the shared set_meta mutator passing importance
 *  + summary and forcing the lifecycle fields to null. */
export function makeSelectorSetMetaTool(
  graph: SessionOwlGraph,
  ctx: MutateContext,
): AgentTool<typeof SELECTOR_SET_META_PARAMS> {
  return {
    name: SELECTOR_SET_META_TOOL,
    description: "Edit a node's summary and/or importance — condense its wording or re-rate how much it matters.",
    label: "Edit node",
    parameters: SELECTOR_SET_META_PARAMS,
    async execute(_toolCallId, params) {
      const hasSummary = params.summary !== undefined;
      const hasImportance = params.importance !== undefined;
      if (!hasSummary && !hasImportance) {
        return errorResult("set_meta: provide at least one of summary or importance.");
      }
      return runMutate(
        graph,
        ctx,
        "set_meta",
        () =>
          applySetMeta(
            graph,
            {
              nodeId: params.nodeId as NodeId,
              importance: hasImportance ? (params.importance as Importance) : null,
              archived: null,
              obsolete: null,
              summary: hasSummary ? (params.summary as string) : null,
            },
            ctx.policy,
          ),
        () => `Updated ${params.nodeId}.`,
      );
    },
  };
}
