// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// Engine-kit twin of the auxiliary surfaces (todo bridge + dump ring): the closure-clean
// slice — the todo bridge consumer (detection + the null degrade over the
// vendored adapter) and the dump ring's pure parts (sanitize + slot
// naming + the disable gate). The status report's builder chain reaches
// core/src/schema.ts (a bare @earendil-works/pi-ai import the kit loader
// refuses — a kit-loader platform gap), so that surface rides the Node
// suite (tests/extras/status-report.spec.ts) with the binding blocked; this
// twin pins the loadable contracts under the real kit loader.
import { describe, expect, test } from "claude-code/testing";
import { dumpsDirFor, openStageDump, sanitizeForPath } from "../host/dumps/module.js";
import {
  adaptTodoApi,
  detectTodoByFingerprint,
  detectTodoByToolList,
  makeTodoBridge,
  toolCallFallback,
} from "../host/todo/bridge-consumer.js";

describe("todo bridge — engine-run twin", () => {
  test("the fingerprint detection over the uses.calls envelope", () => {
    expect(detectTodoByFingerprint({ uses: { events: [], calls: ["fs.read", "avtcTodo.getItems"] } })).toBe(true);
    expect(detectTodoByFingerprint({ uses: { events: [], calls: ["fs.read"] } })).toBe(false);
    expect(detectTodoByFingerprint(null)).toBe(false);
  });

  test("the tool.list detection", () => {
    expect(detectTodoByToolList(["mcp__todo__list"])).toBe(true);
    expect(detectTodoByToolList(["mcp__other__list"])).toBe(false);
  });

  test("the absent-noun degrade: an undefined noun call throws TypeError and nulls", async () => {
    // the literal-spelled consumption the wiring performs: () => $.avtcTodo.getItems()
    const $ = { avtcTodo: undefined } as { avtcTodo: { getItems(): unknown } | undefined };
    const bridge = await makeTodoBridge({
      avtcTodoGetItems: () => $.avtcTodo?.getItems() as unknown,
    });
    expect(bridge).toBeNull();
  });

  test("a live noun adapts; the tool.call fallback reads the same shape", async () => {
    const items = [{ id: "t1", parentId: null, name: "a", details: "", status: "pending" }];
    const nounBridge = await makeTodoBridge({
      avtcTodoGetItems: () => items,
    });
    expect(nounBridge?.context.getPending()).toEqual([{ id: "t1", name: "a", status: "pending" }]);
    const fallback = await toolCallFallback({
      toolCall: async () => ({ items }),
    });
    expect(fallback?.bridge.getItems()).toHaveLength(1);
    const adapted = adaptTodoApi([{ id: "t9", parentId: null, name: "f", details: "", status: "decomposed" }]);
    expect(adapted.bridge.getItems({ status: "completed" })[0]?.status).toBe("completed");
  });
});

describe("dump ring — engine-run twin (the pure slice)", () => {
  test("sanitizeForPath is pi-verbatim (separators, traversal, unsafe chars)", () => {
    expect(sanitizeForPath("E:\\work\\git/proj ect")).toBe("E-work-git-project");
    expect(sanitizeForPath("a..b")).toBe("ab");
  });

  test("the disable gate + the ring-slot location", () => {
    expect(openStageDump("observer", 0, { baseDir: "/d", cwd: "E:\\p", now: 0 })).toBeNull();
    expect(dumpsDirFor("/d", "E:\\p")).toBe("/d/dumps/E-p");
    const h = openStageDump("observer", 2, { baseDir: "/d", cwd: "E:\\p", now: 0 });
    expect(h?.path).toBe("/d/dumps/E-p/observer-0.txt");
  });
});
