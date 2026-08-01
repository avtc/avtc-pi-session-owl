// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import { describe, expect, it } from "vitest";
import type { TodoContext, TodoItem } from "../../src/selector/input-view.js";
import type { TodoBridge } from "../../src/selector/tools.js";
import { makeTodoAdapter, type TodoProxy } from "../../src/todo/bridge.js";

/** Build a minimal fake proxy for testing (only the methods the adapter uses). */
function fakeProxy(items: RawItem[]): TodoProxy {
  return {
    getItems: (filter: { status: "pending" | "in_progress" | "completed" } | null) => {
      const filtered =
        filter === null
          ? items
          : items.filter((i) =>
              filter.status === "completed"
                ? i.status === "completed" || i.status === "decomposed"
                : i.status === filter.status,
            );
      return filtered;
    },
  };
}

/** Raw item shape the vendored proxy returns (looser than TodoReadyItem for tests). */
interface RawItem {
  id: string;
  parentId: string | null;
  name: string;
  details: string;
  status: string;
}

describe("todo bridge adapter", () => {
  describe("mapTodoItem (status normalization)", () => {
    it("maps a pending raw item to a TodoItem (status literal union, details kept)", () => {
      const { context } = makeTodoAdapter(
        fakeProxy([{ id: "1", parentId: null, name: "A", details: "do A", status: "pending" }]),
      );
      const pending = context.getPending();
      expect(pending.length).toBe(1);
      const item = pending[0] as TodoItem;
      expect(item).toEqual({ id: "1", name: "A", status: "pending", details: "do A" });
      // parentId dropped (not part of memkeeper's TodoItem)
      expect("parentId" in item).toBe(false);
    });

    it("maps status 'decomposed' -> 'completed'", () => {
      const { context } = makeTodoAdapter(
        fakeProxy([
          { id: "1", parentId: null, name: "Folder", details: "x", status: "decomposed" },
          { id: "2", parentId: "1", name: "Child", details: "y", status: "pending" },
        ]),
      );
      const completed = context.getPending(); // none pending at the literal level? 2 is pending
      expect(completed.length).toBe(1);
      // the decomposed parent is NOT pending:
      expect(completed[0].id).toBe("2");
    });

    it("normalizes empty details string to undefined", () => {
      const { context } = makeTodoAdapter(
        fakeProxy([{ id: "1", parentId: null, name: "A", details: "", status: "pending" }]),
      );
      const item = context.getPending()[0] as TodoItem;
      expect(item.details).toBeUndefined();
    });

    it("clamps an unknown status to a safe terminal value (no invalid union member leaks in)", () => {
      // cross-extension data: a future avtc-pi-todo status (e.g. 'cancelled')
      // must not pass the cast through as an invalid TodoItem.status.
      const { bridge } = makeTodoAdapter(
        fakeProxy([{ id: "9", parentId: null, name: "X", details: "x", status: "cancelled" }]),
      );
      const all = bridge.getItems();
      expect(all.length).toBe(1);
      const status = all[0].status;
      // must be one of the known union members, never the raw 'cancelled'
      expect(["pending", "in_progress", "completed"]).toContain(status);
      expect(status).not.toBe("cancelled");
    });
  });

  describe("TodoContext", () => {
    it("getInProgress returns null when no in_progress item", () => {
      const { context } = makeTodoAdapter(
        fakeProxy([{ id: "1", parentId: null, name: "A", details: "x", status: "pending" }]),
      );
      expect(context.getInProgress()).toBeNull();
    });

    it("getInProgress returns the single in_progress item (mapped)", () => {
      const { context } = makeTodoAdapter(
        fakeProxy([
          { id: "1", parentId: null, name: "A", details: "x", status: "in_progress" },
          { id: "2", parentId: null, name: "B", details: "y", status: "pending" },
        ]),
      );
      const ip = context.getInProgress();
      expect(ip).not.toBeNull();
      expect(ip?.id).toBe("1");
      expect(ip?.status).toBe("in_progress");
    });

    it("getPending returns only pending items", () => {
      const { context } = makeTodoAdapter(
        fakeProxy([
          { id: "1", parentId: null, name: "A", details: "x", status: "in_progress" },
          { id: "2", parentId: null, name: "B", details: "y", status: "pending" },
          { id: "3", parentId: null, name: "C", details: "z", status: "completed" },
        ]),
      );
      const pending = context.getPending();
      expect(pending.length).toBe(1);
      expect(pending[0].id).toBe("2");
    });
  });

  describe("TodoBridge (todo_list tool)", () => {
    it("getItems with no filter returns all items (mapped)", () => {
      const { bridge }: { bridge: TodoBridge } = makeTodoAdapter(
        fakeProxy([
          { id: "1", parentId: null, name: "A", details: "x", status: "in_progress" },
          { id: "2", parentId: null, name: "B", details: "y", status: "pending" },
        ]),
      );
      const all = bridge.getItems();
      expect(all.length).toBe(2);
      expect(all.map((i) => i.status).sort()).toEqual(["in_progress", "pending"]);
    });

    it("getItems with an empty filter object returns all items", () => {
      const { bridge }: { bridge: TodoBridge } = makeTodoAdapter(
        fakeProxy([
          { id: "1", parentId: null, name: "A", details: "x", status: "in_progress" },
          { id: "2", parentId: null, name: "B", details: "y", status: "pending" },
          { id: "3", parentId: null, name: "C", details: "z", status: "completed" },
        ]),
      );
      // filter present but status undefined → all items (not just pending)
      const all = bridge.getItems({});
      expect(all.length).toBe(3);
    });

    it("getItems with a status filter narrows by status", () => {
      const { bridge }: { bridge: TodoBridge } = makeTodoAdapter(
        fakeProxy([
          { id: "1", parentId: null, name: "A", details: "x", status: "in_progress" },
          { id: "2", parentId: null, name: "B", details: "y", status: "pending" },
          { id: "3", parentId: null, name: "C", details: "z", status: "completed" },
        ]),
      );
      const pending = bridge.getItems({ status: "pending" });
      expect(pending.length).toBe(1);
      expect(pending[0].id).toBe("2");
    });

    it("getItems({status:'completed'}) includes decomposed items mapped to completed", () => {
      const { bridge }: { bridge: TodoBridge } = makeTodoAdapter(
        fakeProxy([
          { id: "1", parentId: null, name: "Folder", details: "f", status: "decomposed" },
          { id: "2", parentId: null, name: "Done", details: "d", status: "completed" },
        ]),
      );
      const completed = bridge.getItems({ status: "completed" });
      // both the decomposed folder and the completed item surface under completed
      expect(completed.length).toBe(2);
      expect(completed.every((i) => i.status === "completed")).toBe(true);
    });
  });

  describe("TodoContext return type", () => {
    it("satisfies the TodoContext interface (getInProgress/getPending)", () => {
      const { context }: { context: TodoContext } = makeTodoAdapter(fakeProxy([]));
      expect(typeof context.getInProgress).toBe("function");
      expect(typeof context.getPending).toBe("function");
    });
  });
});
