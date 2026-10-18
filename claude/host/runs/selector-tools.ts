// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// The Selector toolset — HOST PORT of src/selector/tools.ts's graph half (the
// pi file value-imports pi-coding-agent surfaces for the fs_* aliases, so it
// is not vendored). The port maps the dropped pieces onto the engine:
//   - pi's fs_read/fs_grep/fs_find/fs_ls aliases → the ENGINE's built-in
//     Read/Grep/Glob/LS, which the Selector AgentSpec already carries
//     (SELECTOR_FILE_TOOLS — no port code needed);
//   - the conditional todo_list tool rides the todo bridge (its port).
// The graph tools below are pi's composition verbatim: the shared factories
// bound to the deep-copied WORKING COPY — reads render with the nonBuilder
// viewer, mutates apply with the `workingCopy` policy and append nothing.
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { SessionOwlConfig } from "../../core/src/config/schema.js";
import { NON_BUILDER } from "../../core/src/format/render.js";
import {
  MERGE_TOOL,
  MKDIR_TOOL,
  type MutateContext,
  MV_TOOL,
  makeMergeTool,
  makeMkdirTool,
  makeMvTool,
  makeSelectorSetMetaTool,
  SELECTOR_SET_META_TOOL,
} from "../../core/src/graph/mutate-tools.js";
import { MUTATE_WORKING_COPY } from "../../core/src/graph/mutations.js";
import { makeReadTools, makeTryFinishTool } from "../../core/src/graph/read-tools.js";
import type { TodoItem } from "../../core/src/todo/types.js";
import type { SelectorWorkingCopy } from "./selector-input-view.js";

/** Re-export the Selector's set_meta tool name for callers/tests. */
export { SELECTOR_SET_META_TOOL };

/** The four Selector mutate tools (no-op detection for the Selector run: a
 *  pass with none of these applied is a no-op pass). Read tools (ls/cat/find) and
 *  try_finish excluded — mirroring the Builder's MUTATE_TOOL_NAMES. */
export const SELECTOR_MUTATE_TOOL_NAMES: ReadonlySet<string> = new Set([
  MKDIR_TOOL,
  MV_TOOL,
  MERGE_TOOL,
  SELECTOR_SET_META_TOOL,
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

/** Build the Selector graph tools (ls/cat/find/mkdir/mv/merge/set_meta/
 *  try_finish) bound to the working copy. The read tools render with the
 *  "nonBuilder" viewer (new→active); the mutate tools apply with the
 *  `workingCopy` policy and append nothing to the store. */
export function makeSelectorGraphTools(working: SelectorWorkingCopy, settings: SessionOwlConfig): AgentTool[] {
  const ctx = workingCopyMutateContext();
  return [
    ...makeReadTools(working.graph, NON_BUILDER),
    makeMkdirTool(working.graph, ctx),
    makeMvTool(working.graph, ctx),
    makeMergeTool(working.graph, ctx),
    makeSelectorSetMetaTool(working.graph, ctx),
    makeTryFinishTool(working.graph, { rootViewThreshold: settings.selectorRootViewThreshold }, NON_BUILDER),
  ];
}

// --- todo_list (conditional on the optional todo bridge) -------

/** The conditional todo_list tool's name (pi-verbatim). */
export const TODO_LIST_TOOL = "todo_list";

/** The tool's parameters as a JSON literal (the vendored typebox params
 *  JSON-round-tripped — the host closure carries specs as data). */
const TODO_LIST_PARAMS: Record<string, unknown> = {
  type: "object",
  properties: {
    status: {
      type: "string",
      enum: ["in_progress", "pending", "completed"],
      description: "Filter by status — in_progress, pending, or completed. Omit for all.",
    },
  },
};

/** Read-only port over the (optional) todo bridge — pi's tool verbatim:
 *  `null` bridge ⇒ no todo_list tool at all (the run appends it only when
 *  the bridge is live); the body renders status · name pairs with details
 *  on their own line, blank-line separated; empty ⇒ "(no todos)". */
export function makeTodoListTool(bridge: {
  getItems(filter?: { status?: "in_progress" | "pending" | "completed" }): TodoItem[];
}): AgentTool {
  return {
    name: TODO_LIST_TOOL,
    description: "Read the todo list — current and planned tasks with their details.",
    label: "Todo list",
    parameters: TODO_LIST_PARAMS,
    async execute(_toolCallId: string, params: { status?: string }) {
      const status = params.status as TodoItem["status"] | undefined;
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
  } as AgentTool;
}
