// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// The Selector toolset — operates on the deep-copied WORKING COPY (never the
// source graph). Composition:
//   - graph read tools (ls/cat/find) — reused from graph/read-tools with the
//     "nonBuilder" viewer (new→active, no 🆕 glyph);
//   - graph mutate tools (mkdir/mv/merge/set_summary) — the shared factories from
//     graph/mutate-tools bound to a workingCopy MutateContext (policy `workingCopy`
//     — skips the nGoal/oInitialPrompt rejections; the Selector freely rearranges
//     them in its copy — and a NO-OP persist: the working copy is transient, the
//     final tree is persisted once at run completion);
//   - try_finish (convergence gate on selectorRootViewThreshold, nonBuilder);
//   - fs_* read tools (alias pi's read/grep/find/ls built-ins);
//   - todo_list (conditional on the optional avtc-pi-todo bridge).
// supersede and set_meta are EXCLUDED (Builder-only source-graph semantics).

import type { AgentTool } from "@earendil-works/pi-agent-core";
import { StringEnum } from "@earendil-works/pi-ai";
import {
  createFindTool,
  createGrepTool,
  createLsTool,
  createReadTool,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { MemkeeperConfig } from "../config/schema.js";
import {
  MERGE_TOOL,
  MKDIR_TOOL,
  type MutateContext,
  MV_TOOL,
  makeMergeTool,
  makeMkdirTool,
  makeMvTool,
  makeSetSummaryTool,
  SET_SUMMARY_TOOL,
} from "../graph/mutate-tools.js";

/** Re-export the Selector-only summary tool name for callers/tests. */
export { SET_SUMMARY_TOOL };

import { MUTATE_WORKING_COPY } from "../graph/mutations.js";
import { makeReadTools, makeTryFinishTool } from "../graph/read-tools.js";
import type { SelectorWorkingCopy, TodoItem } from "./input-view.js";

// --- named constants (no bare literals at call sites) ----------------------

/** fs_* aliased pi built-in tool names. */
export const FS_READ_TOOL = "fs_read";
export const FS_GREP_TOOL = "fs_grep";
export const FS_FIND_TOOL = "fs_find";
export const FS_LS_TOOL = "fs_ls";
/** Conditional todo-list tool name. */
export const TODO_LIST_TOOL = "todo_list";

/** The four Selector mutate tools (no-op detection for the Selector run, T17: a
 *  pass with none of these applied is a no-op pass). Read tools (ls/cat/find) and
 *  try_finish excluded — mirroring the Builder's MUTATE_TOOL_NAMES. */
export const SELECTOR_MUTATE_TOOL_NAMES: ReadonlySet<string> = new Set([
  MKDIR_TOOL,
  MV_TOOL,
  MERGE_TOOL,
  SET_SUMMARY_TOOL,
]);

/** A no-op persist: the working copy is transient and the resulting tree is
 *  persisted once at run completion, so per-call mutates append nothing. */
const DROP_DELTA: MutateContext["persist"] = () => {
  // working-copy mutations are not appended to the store
};

/** The Selector's working-copy MutateContext: `workingCopy` policy (skips the
 *  nGoal/oInitialPrompt rejections) + a no-op persist. Built per working copy. */
export function workingCopyMutateContext(): MutateContext {
  return { policy: MUTATE_WORKING_COPY, persist: DROP_DELTA };
}

// --- fs_* external file reads (alias pi's built-ins) -----------------------

/** Wrap a pi factory tool under an `fs_` name so it does not clash with the
 *  graph `ls`/`find` in the same loop. The pi tool's parameters/execute are kept
 *  verbatim — only `name` (and a short `label`) are overridden. Read-only (pi's
 *  bash/edit/write are never aliased here). */
function aliasTool(piTool: AgentTool, name: string, label: string): AgentTool {
  return { ...piTool, name, label };
}

/** Build the four read-only file tools (`fs_read`/`fs_grep`/`fs_find`/`fs_ls`)
 *  as aliases over pi's read/grep/find/ls built-ins bound to `cwd`. Used by the
 *  Selector to inspect the live project (design/plan/research docs, source) to
 *  infer current + planned work beyond the tail. */
export function makeFileReadTools(cwd: string): AgentTool[] {
  return [
    aliasTool(createReadTool(cwd), FS_READ_TOOL, "Read file"),
    aliasTool(createGrepTool(cwd), FS_GREP_TOOL, "Grep files"),
    aliasTool(createFindTool(cwd), FS_FIND_TOOL, "Find files"),
    aliasTool(createLsTool(cwd), FS_LS_TOOL, "List dir"),
  ];
}

// --- todo_list (conditional on the optional avtc-pi-todo bridge) -----------

/** Read-only port over the (optional) avtc-pi-todo bridge. `getItems` returns
 *  the todo list, optionally filtered by status. `null` bridge → avtc-pi-todo is
 *  not installed → no `todo_list` tool (graceful degrade; not an error). This is
 *  the contract T22's `subscribeToTodo` satisfies; the tool here only reads it.
 *  The item shape is the shared `TodoItem` (same as the input-view render). */
export interface TodoBridge {
  getItems(filter?: { status?: TodoItem["status"] }): TodoItem[];
}

const TODO_LIST_PARAMS = Type.Object({
  status: Type.Optional(
    StringEnum(["in_progress", "pending", "completed"], {
      description: "Filter by status — in_progress, pending, or completed. Omit for all.",
    }),
  ),
});

function makeTodoListTool(bridge: TodoBridge): AgentTool<typeof TODO_LIST_PARAMS> {
  return {
    name: TODO_LIST_TOOL,
    description: "Read the todo list — current and planned tasks with their details.",
    label: "Todo list",
    parameters: TODO_LIST_PARAMS,
    async execute(_toolCallId, params) {
      const status = (params.status ?? undefined) as TodoItem["status"] | undefined;
      const items = bridge.getItems(status === undefined ? {} : { status });
      if (items.length === 0) return { content: [{ type: "text", text: "(no todos)" }], details: { count: 0 } };
      const lines = items.map((item) => {
        const head = `${item.status} · ${item.name}`;
        return item.details === undefined || item.details.length === 0 ? head : `${head}\n${item.details}`;
      });
      return {
        content: [{ type: "text", text: lines.join("\n\n") }],
        details: { count: items.length },
      };
    },
  };
}

// --- graph tools + full toolset -------------------------------------------

/** Build the Selector graph tools (ls/cat/find/mkdir/mv/merge/set_summary/
 *  try_finish) bound to the working copy. The read tools render with the
 *  "nonBuilder" viewer (new→active); the mutate tools apply with the
 *  `workingCopy` policy and append nothing to the store. */
export function makeSelectorGraphTools(working: SelectorWorkingCopy, settings: MemkeeperConfig): AgentTool[] {
  const ctx = workingCopyMutateContext();
  return [
    ...makeReadTools(working.graph, "nonBuilder"),
    makeMkdirTool(working.graph, ctx),
    makeMvTool(working.graph, ctx),
    makeMergeTool(working.graph, ctx),
    makeSetSummaryTool(working.graph, ctx),
    makeTryFinishTool(working.graph, { rootViewThreshold: settings.selectorRootViewThreshold }, "nonBuilder"),
  ];
}

/** Args for the full Selector toolset: the working copy to bind the graph tools,
 *  the settings (try_finish threshold), the ctx (cwd for fs_*), and the optional
 *  todo bridge (omitted when avtc-pi-todo is not installed). */
export interface SelectorToolsArgs {
  workingCopy: SelectorWorkingCopy;
  settings: MemkeeperConfig;
  ctx: ExtensionContext;
  todoBridge: TodoBridge | null;
}

/** Build the full Selector toolset: 8 graph tools (ls/cat/find/mkdir/mv/merge/
 *  set_summary/try_finish) + 4 fs_* reads + todo_list (1, only when the bridge is
 *  present). supersede and set_meta are EXCLUDED (Builder-only source-graph
 *  semantics). Nothing writes back to the source graph. */
export function makeSelectorTools(args: SelectorToolsArgs): AgentTool[] {
  const tools: AgentTool[] = [
    ...makeSelectorGraphTools(args.workingCopy, args.settings),
    ...makeFileReadTools(args.ctx.cwd),
  ];
  if (args.todoBridge !== null) tools.push(makeTodoListTool(args.todoBridge));
  return tools;
}
