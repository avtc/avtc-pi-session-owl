// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// The stage tools' registration surface: owl's own tools,
// registered once per process via `$.tool.register` and served ONLY to
// owl's stage agents. Three layers:
//
//   specs      the ToolSpecs — plain JSON Schema mirroring the vendored
//              TypeBox param schemas exactly (compiled-form parity is
//              pinned by the spec suite against the live tool objects);
//   gate       every `tool.call` first checks the caller is a LIVE stage
//              run (the runs map via the isLiveStageAgent predicate — the
//              spawn registry's membership outlives the run and never
//              gates) — anything else gets `{deny}`; the names stay
//              discoverable via ToolSearch in the main conversation but
//              the calls cannot touch the graph outside a run;
//   executor   the run-bound execution (mutation persistence inside the
//              handler — the apply-then-persist moment) installs
//              per tool at run setup (the run modules bind the vendored tool
//              bodies to their store contexts); no executor installed is
//              an explicit deny, never a silent success.
//
// Import-free by construction (it sits inside the hooks closure); the
// liveness predicate and executors arrive as parameters/registrations.

/** The pinned deny reason for a non-stage caller — it names the tool the
 *  main conversation should use instead (the engine-prefixed name the
 *  model sees in its tool list). */
export const DENY_REASON = "session-owl internal tool; for memory recall use the mcp__session-owl__owl_recall tool";

/** One registered stage tool (the engine's ToolSpec shape, spelled
 *  structurally). */
export interface StageToolSpec {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /** `true` — the schema waits behind ToolSearch, off the main prompt
   *  (cache-stable insurance, pinned at registration). */
  isDeferred: true;
}

/** The stage tools (Observer's record tool; the Builder's mutate+read
 *  set; the Selector's mutation subset over the same reads — one registered
 *  surface, per-stage reach decided by each AgentSpec's tool list and the
 *  executors' own validation). */
export const STAGE_TOOL_SPECS: readonly StageToolSpec[] = [
  {
    name: "record_observations",
    isDeferred: true,
    description: "[Internal] Record the observations worth keeping from this chunk.",
    inputSchema: {
      type: "object",
      required: ["observations"],
      properties: {
        observations: {
          type: "array",
          items: {
            type: "object",
            required: ["summary", "importance", "sourceEntryIds"],
            properties: {
              summary: {
                type: "string",
                minLength: 1,
                description: "The observation, written concisely as its essential meaning.",
              },
              importance: {
                type: "string",
                enum: ["crit", "high", "med", "low"],
                description: "How much it matters if lost, by nature — crit, high, med, or low.",
              },
              sourceEntryIds: {
                type: "array",
                items: {
                  type: "string",
                },
                minItems: 1,
                description:
                  "Source entry ids this observation draws on — the E=id values in this chunk. At least one; an id not present here rejects this observation.",
              },
            },
          },
        },
      },
    },
  },
  {
    name: "mkdir",
    isDeferred: true,
    description: "[Internal] Create an empty container node for grouping. Returns the new node's id.",
    inputSchema: {
      type: "object",
      required: ["summary", "importance"],
      properties: {
        summary: {
          type: "string",
          minLength: 1,
          description: "The new node's summary.",
        },
        importance: {
          type: "string",
          enum: ["crit", "high", "med", "low"],
          description: "How much the new node matters if lost — crit, high, med, or low.",
        },
        parentId: {
          type: "string",
          description: "A parent node, or omit/null for the root.",
        },
      },
    },
  },
  {
    name: "mv",
    isDeferred: true,
    description:
      "[Internal] Move items (nodes and/or observations) into a destination node or to the root — for grouping, splitting, or reparenting.",
    inputSchema: {
      type: "object",
      required: ["sourceIds"],
      properties: {
        sourceIds: {
          type: "array",
          items: {
            type: "string",
          },
          minItems: 1,
          description: "The items to move. At least one.",
        },
        destId: {
          type: "string",
          description: "The destination node, or null for the root.",
        },
        newSummary: {
          type: "string",
          minLength: 1,
          description: "Optionally rewrite the destination node's summary.",
        },
      },
    },
  },
  {
    name: "merge",
    isDeferred: true,
    description: "[Internal] Fold nodes into a destination, combining their contents; the absorbed nodes dissolve.",
    inputSchema: {
      type: "object",
      required: ["sourceIds"],
      properties: {
        sourceIds: {
          type: "array",
          items: {
            type: "string",
          },
          minItems: 1,
          description: "The nodes to fold in (their observations and children come along). At least one.",
        },
        destId: {
          type: "string",
          description: "The destination node, or null to create a new root node.",
        },
        newSummary: {
          type: "string",
          minLength: 1,
          description: "A synthesized summary for the destination (required when `destId` is null).",
        },
        importance: {
          type: "string",
          enum: ["crit", "high", "med", "low"],
          description:
            "How much the merged node matters if lost — crit, high, med, or low. Required when `destId` is null (names the new root); optional otherwise.",
          "~optional": true,
        },
      },
    },
  },
  {
    name: "supersede",
    isDeferred: true,
    description: "[Internal] Retire nodes as obsolete, pointing each at a replacement node.",
    inputSchema: {
      type: "object",
      required: ["nodeId", "supersededNodeIds"],
      properties: {
        nodeId: {
          type: "string",
          description: "The replacement node — the current truth.",
        },
        supersededNodeIds: {
          type: "array",
          items: {
            type: "string",
          },
          minItems: 1,
          description: "The nodes to retire. At least one.",
        },
      },
    },
  },
  {
    name: "set_meta",
    isDeferred: true,
    description:
      "[Internal] Change a node's importance, archive or resurrect it, or rewrite its summary. (`nGoal` allows summary only.)",
    inputSchema: {
      type: "object",
      required: ["nodeId"],
      properties: {
        nodeId: {
          type: "string",
          description: "The node to update.",
        },
        importance: {
          type: "string",
          enum: ["crit", "high", "med", "low"],
          description: "How much the node matters if lost — crit, high, med, or low.",
          "~optional": true,
        },
        archived: {
          type: "boolean",
          description: "True to archive, false to restore to active.",
        },
        summary: {
          type: "string",
          minLength: 1,
          description: "A new summary for the node.",
        },
        obsolete: {
          type: "boolean",
          description: "False to resurrect an obsolete node (clears its replacement link).",
        },
      },
    },
  },
  {
    name: "ls",
    isDeferred: true,
    description:
      "[Internal] List one level of the memory graph — the root nodes, or a node's children (subnodes and observations).",
    inputSchema: {
      type: "object",
      properties: {
        nodeId: {
          type: "string",
          description: "The node whose direct children to list. Omit or pass null for the root nodes.",
        },
        page: {
          type: "object",
          required: ["take", "afterId"],
          properties: {
            take: {
              type: "integer",
              minimum: 0,
              description: "Page size, default 50; 0 = all.",
            },
            afterId: {
              anyOf: [
                {
                  type: "string",
                },
                {
                  type: "null",
                },
              ],
              description: "The last id from the previous page; omit on the first page.",
            },
          },
        },
      },
    },
  },
  {
    name: "cat",
    isDeferred: true,
    description:
      "[Internal] Read full text — an observation's content, or a node's header plus the full text of its direct observations. Sub-nodes are not expanded here (use `ls` for them). `ls` shows one-line structure; `cat` shows full content. Use `contentPattern` for grep-style excerpts or `lines` for a line range instead of the whole content.",
    inputSchema: {
      type: "object",
      required: ["ids"],
      properties: {
        ids: {
          type: "array",
          items: {
            type: "string",
          },
          minItems: 1,
          description: "Ids to read in full — observations and/or nodes. At least one.",
        },
        contentPattern: {
          type: "string",
          description:
            "Extract matching lines from observations as grep-style excerpts (with `contextLines` and line numbers) instead of the whole text — greps every observation, or just those an `ids` drill or `query` search returns.",
        },
        contextLines: {
          type: "integer",
          minimum: 0,
          description: "Lines of context shown before and after each `contentPattern` match (default 2).",
        },
        lines: {
          type: "string",
          description:
            "Read a line range (e.g. '40-60') of a single observation — pass an observation id, or a node id with one observation.",
        },
        page: {
          type: "object",
          required: ["take", "afterId"],
          properties: {
            take: {
              type: "integer",
              minimum: 0,
              description: "Page size, default 50; 0 = all.",
            },
            afterId: {
              anyOf: [
                {
                  type: "string",
                },
                {
                  type: "null",
                },
              ],
              description: "The last id from the previous page; omit on the first page.",
            },
          },
        },
      },
    },
  },
  {
    name: "find",
    isDeferred: true,
    description: "[Internal] Search the whole memory graph by regex through node summaries and observation content.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description:
            "Find items by regex (JS) over node summaries and observation content. A pattern that runs too long is stopped; partial matches come back with a note to narrow the query.",
        },
        includeSuperseded: {
          type: "boolean",
          description: "Include superseded and obsolete items (default false — current memory only).",
        },
        contentPattern: {
          type: "string",
          description:
            "Extract matching lines from observations as grep-style excerpts (with `contextLines` and line numbers) instead of the whole text — greps every observation, or just those an `ids` drill or `query` search returns.",
        },
        contextLines: {
          type: "integer",
          minimum: 0,
          description: "Lines of context shown before and after each `contentPattern` match (default 2).",
        },
        page: {
          type: "object",
          required: ["take", "afterId"],
          properties: {
            take: {
              type: "integer",
              minimum: 0,
              description: "Page size, default 50; 0 = all.",
            },
            afterId: {
              anyOf: [
                {
                  type: "string",
                },
                {
                  type: "null",
                },
              ],
              description: "The last id from the previous page; omit on the first page.",
            },
          },
        },
      },
    },
  },
  {
    name: "try_finish",
    isDeferred: true,
    description:
      "[Internal] Call when you've finished organizing. Ends the run if the root view fits the budget; otherwise reports the overrun so you can consolidate more.",
    inputSchema: {
      type: "object",
      description: "No parameters.",
      properties: {},
    },
  },
  {
    name: "todo_list",
    isDeferred: true,
    description: "[Internal] Read the todo list — current and planned tasks with their details.",
    inputSchema: {
      type: "object",
      properties: {
        status: {
          type: "string",
          enum: ["in_progress", "pending", "completed"],
          description: "Filter by status — in_progress, pending, or completed. Omit for all.",
        },
      },
    },
  },
];

/** Map a full tool name to owl's short form (null = not a stage tool). */
export function stageToolShortName(tool: string): string | null {
  if (!tool.startsWith("mcp__session-owl__")) return null;
  const short = tool.slice("mcp__session-owl__".length);
  return STAGE_TOOL_SPECS.some((s) => s.name === short) ? short : null;
}

/** A stage tool executor: receives the `tool.call` event (arguments spread
 *  beside `tool`) and answers `{ result }` or `{ deny }` (a validation
 *  refusal the model reads). */
export type StageToolExecutor = (
  e: Record<string, unknown>,
) => Promise<{ result: unknown } | { deny: string }> | { result: unknown } | { deny: string };

const executors = new Map<string, StageToolExecutor>();

/** Install (or replace) one tool's executor. */
export function registerStageToolExecutor(shortName: string, executor: StageToolExecutor): void {
  executors.set(shortName, executor);
}

/** The per-AGENT tool bodies a stage run binds at spawn (the shim's onSpawn
 *  hands the run the agentId; its tools are then served only to that run —
 *  the Builder's source graph and the Selector's working copy must never
 *  share one global binding). */
const agentBodies = new Map<string, Readonly<Record<string, StageToolExecutor>>>();

/** Bind one agent's tool bodies (short name → executor). Replaces any prior
 *  binding for that agent (a re-spawn rebinds). */
export function bindAgentTools(agentId: string, bodies: Readonly<Record<string, StageToolExecutor>>): void {
  agentBodies.set(agentId, bodies);
}

/** Drop an agent's binding (its run ended — the shim's teardown). */
export function unbindAgentTools(agentId: string): void {
  agentBodies.delete(agentId);
}

/** Drop every executor (tests; session teardown). */
export function resetStageToolExecutors(): void {
  executors.clear();
  agentBodies.clear();
}

/**
 * The `tool.call` handler for stage tools. Returns the answer for the call,
 * or null when the tool is not owl's (the caller passes those through).
 * The gate predicate answers "is this caller a LIVE owl stage run" — the
 * spawn registry keeps a run's membership past its completion (the delivery
 * drop and the capture skip read it there), so liveness is the runs map,
 * not membership.
 */
export async function handleStageToolCall(
  e: { tool: string; agentId?: string },
  isLiveStageAgent: (agentId: string) => boolean,
): Promise<{ result: unknown } | { deny: string } | null> {
  const short = stageToolShortName(e.tool);
  if (short === null) return null;
  if (typeof e.agentId !== "string" || !isLiveStageAgent(e.agentId)) {
    return { deny: DENY_REASON };
  }
  const bound = agentBodies.get(e.agentId)?.[short];
  const executor = bound ?? executors.get(short);
  if (executor === undefined) {
    return { deny: `session-owl: stage tool "${short}" has no executor installed (stage runs not wired)` };
  }
  return executor(e as unknown as Record<string, unknown>);
}
