// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

//  todo bridge — the defensive consumption path. Detection via the
// plugin.register fingerprint (an avtcTodo noun) or $.tool.list()
// (mcp__todo__*); consumption is literal-spelled inside try/catch (the
// scanner rule); an absent noun = TypeError = null degrade, exactly pi's
// listen-then-null pattern; $.tool.call on the list tool is the fallback.
import { describe, expect, test } from "vitest";
import { makeTodoListTool } from "../../host/runs/selector-tools.js";
import {
  adaptTodoApi,
  detectTodoByFingerprint,
  detectTodoByToolList,
  makeTodoBridge,
  toolCallFallback,
} from "../../host/todo/bridge-consumer.js";

const RAW_ITEMS = [
  { id: "t1", parentId: null, name: "first", details: "the details", status: "in_progress" },
  { id: "t2", parentId: "t1", name: "second", details: "", status: "pending" },
  { id: "t3", parentId: null, name: "folder", details: "", status: "decomposed" },
];

/** A stub $ carrying (or omitting) the avtcTodo noun — the literal-spelled
 *  consumption path stays in the wiring; here the capsule mirrors it. */
function stub$(api: Record<string, unknown> | null): Record<string, unknown> {
  return api === null ? ({} as Record<string, unknown>) : { avtcTodo: api };
}

describe("detection — the plugin.register fingerprint", () => {
  test("a mod exposing an avtcTodo noun matches (the uses.calls envelope)", () => {
    // the platform fingerprint shape: uses = {events, calls} — the declared
    // noun.method call strings ride uses.calls
    expect(detectTodoByFingerprint({ uses: { events: [], calls: ["fs.read", "avtcTodo.getItems"] } })).toBe(true);
    expect(detectTodoByFingerprint({ uses: { events: [], calls: ["avtcTodo"] } })).toBe(true);
  });

  test("no noun, no fingerprint payload, foreign nouns, malformed uses — no match", () => {
    expect(detectTodoByFingerprint({ uses: { events: [], calls: ["fs.read", "ui.log"] } })).toBe(false);
    expect(detectTodoByFingerprint({ uses: { events: [] } })).toBe(false);
    expect(detectTodoByFingerprint({})).toBe(false);
    expect(detectTodoByFingerprint(null)).toBe(false);
    expect(detectTodoByFingerprint({ uses: "not-an-object" })).toBe(false);
    expect(detectTodoByFingerprint({ uses: { calls: "not-an-array" } })).toBe(false);
  });
});

describe("detection — the tool.list surface", () => {
  test("an mcp__todo__* tool matches; others do not", () => {
    expect(detectTodoByToolList(["mcp__todo__list", "Read"])).toBe(true);
    expect(detectTodoByToolList(["Read", "mcp__other__list"])).toBe(false);
    expect(detectTodoByToolList([])).toBe(false);
  });
});

describe("consumption — the null degrade (pi's listen-then-null pattern)", () => {
  test("an absent noun ⇒ TypeError ⇒ null (graceful, never an error)", async () => {
    const $ = stub$(null);
    const bridge = await makeTodoBridge({
      avtcTodoGetItems: () => ($ as { avtcTodo: { getItems(): unknown } }).avtcTodo.getItems(),
    });
    expect(bridge).toBeNull();
  });

  test("a throwing noun call ⇒ null", async () => {
    const bridge = await makeTodoBridge({
      avtcTodoGetItems: () => {
        throw new Error("bridge exploded");
      },
    });
    expect(bridge).toBeNull();
  });

  test("a live noun adapts into the TodoContext/TodoBridge pair", async () => {
    const $ = stub$({ getItems: () => RAW_ITEMS });
    const bridge = await makeTodoBridge({
      avtcTodoGetItems: () => ($ as { avtcTodo: { getItems(): unknown } }).avtcTodo.getItems(),
    });
    expect(bridge?.context.getInProgress()?.id).toBe("t1");
  });
});

describe("adaptTodoApi — the vendored mapping over fetched items", () => {
  test("maps raw items: decomposed→completed, empty details dropped, status guarded", () => {
    const adapted = adaptTodoApi(RAW_ITEMS);
    expect(adapted.context.getInProgress()).toEqual({
      id: "t1",
      name: "first",
      status: "in_progress",
      details: "the details",
    });
    expect(adapted.context.getPending()).toEqual([{ id: "t2", name: "second", status: "pending" }]);
    expect(adapted.bridge.getItems()).toHaveLength(3);
    expect(adapted.bridge.getItems({ status: "completed" })[0]).toMatchObject({ id: "t3", status: "completed" });
  });
});

describe("the todo_list tool (the Selector's drill-down — pi-verbatim)", () => {
  test("empty list ⇒ '(no todos)' with count 0", async () => {
    const tool = makeTodoListTool({ getItems: () => [] });
    const r = (await tool.execute("id1", {})) as { content: { text: string }[]; details: { count: number } };
    expect(r.content[0]?.text).toBe("(no todos)");
    expect(r.details.count).toBe(0);
  });

  test("renders status · name pairs, details on their own line, blank-line separated", async () => {
    const tool = makeTodoListTool({
      getItems: () => [
        { id: "t1", name: "first", status: "in_progress", details: "line one" },
        { id: "t2", name: "second", status: "pending" },
      ],
    });
    const r = (await tool.execute("id2", {})) as { content: { text: string }[]; details: { count: number } };
    expect(r.content[0]?.text).toBe("in_progress · first\nline one\n\npending · second");
    expect(r.details.count).toBe(2);
  });

  test("the status filter passes through", async () => {
    const seen: unknown[] = [];
    const tool = makeTodoListTool({
      getItems: (f) => {
        seen.push(f);
        return [];
      },
    });
    await tool.execute("id3", { status: "pending" });
    expect(seen).toEqual([{ status: "pending" }]);
  });
});

describe("the $.tool.call fallback", () => {
  test("the list tool's items feed the same adapter; a failure ⇒ null", async () => {
    const items = await toolCallFallback({
      toolCall: async (name: string) => (name === "mcp__todo__list" ? { items: RAW_ITEMS } : null),
    });
    expect(items?.context.getInProgress()?.id).toBe("t1");
    const failed = await toolCallFallback({
      toolCall: () => {
        throw new Error("nope");
      },
    });
    expect(failed).toBeNull();
  });
});
