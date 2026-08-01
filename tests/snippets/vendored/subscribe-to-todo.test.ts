// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import {
  subscribeToTodo,
  type TodoItemsStatus,
  type TodoReadyApi,
  type TodoReadyItem,
} from "../../../src/snippets/vendored/subscribe-to-todo.js";
import { fire, makeFakePi } from "../../todo/fake-pi.js";

/** No status filter — return all items (the filter param is `{status} | null`). */
const NO_FILTER: { status: TodoItemsStatus } | null = null;

const threeItems: TodoReadyItem[] = [
  { id: "1", parentId: null, name: "A", details: "do A", status: "in_progress" },
  { id: "2", parentId: null, name: "B", details: "do B", status: "pending" },
  { id: "3", parentId: null, name: "C", details: "do C", status: "completed" },
];

/** A fake TodoReadyApi whose getItems respects the status filter. */
function fakeApi(items: TodoReadyItem[]): TodoReadyApi {
  return {
    disableBuiltInFollowUp() {},
    getInProgressItem: () => {
      const ip = items.find((i) => i.status === "in_progress");
      return ip ? `In progress: ▶ ${ip.id}: ${ip.name}\n${ip.details}` : null;
    },
    getItems: (filter) =>
      filter === null
        ? items
        : items.filter((i) =>
            filter.status === "completed"
              ? i.status === "completed" || i.status === "decomposed"
              : i.status === filter.status,
          ),
  };
}

describe("subscribeToTodo (vendored snippet)", () => {
  it("returns safe defaults before pi-todo:ready fires (avtc-pi-todo absent)", () => {
    const pi = makeFakePi();
    const proxy = subscribeToTodo(pi as unknown as ExtensionAPI, false);
    expect(proxy.getItems(NO_FILTER)).toEqual([]);
    expect(proxy.getInProgressItem()).toBeNull();
    expect(proxy.getCompletedItemId()).toBeNull();
    expect(proxy.areAllTodosDone()).toBe(true);
  });

  it("delegates to the api after pi-todo:ready fires", () => {
    const pi = makeFakePi();
    const proxy = subscribeToTodo(pi as unknown as ExtensionAPI, false);
    fire(pi, "pi-todo:ready", fakeApi(threeItems));
    expect(proxy.getItems(NO_FILTER).length).toBe(3);
    expect(proxy.getInProgressItem()).toContain("1: A");
  });

  it("getItems with a status filter narrows (pending only)", () => {
    const pi = makeFakePi();
    const proxy = subscribeToTodo(pi as unknown as ExtensionAPI, false);
    fire(pi, "pi-todo:ready", fakeApi(threeItems));
    const pending = proxy.getItems({ status: "pending" });
    expect(pending.length).toBe(1);
    expect(pending[0].id).toBe("2");
  });

  it("getItems({status:'completed'}) includes decomposed items too", () => {
    const pi = makeFakePi();
    const proxy = subscribeToTodo(pi as unknown as ExtensionAPI, false);
    const items: TodoReadyItem[] = [
      { id: "1", parentId: null, name: "Folder", details: "f", status: "decomposed" },
      { id: "2", parentId: null, name: "Done", details: "d", status: "completed" },
    ];
    fire(pi, "pi-todo:ready", fakeApi(items));
    const completed = proxy.getItems({ status: "completed" });
    expect(completed.length).toBe(2);
  });

  it("returns [] from getItems when the bridge is older (no getItems method)", () => {
    const pi = makeFakePi();
    const proxy = subscribeToTodo(pi as unknown as ExtensionAPI, false);
    // older avtc-pi-todo: has getInProgressItem but NOT getItems
    fire(pi, "pi-todo:ready", { disableBuiltInFollowUp() {}, getInProgressItem: () => "In progress: ▶ 1: X\nx" });
    expect(proxy.getItems(NO_FILTER)).toEqual([]);
    // the older methods still work
    expect(proxy.getInProgressItem()).toContain("1: X");
  });

  it("session_shutdown cleans the pi-todo:ready listener (reload-safe)", () => {
    const pi = makeFakePi();
    subscribeToTodo(pi as unknown as ExtensionAPI, false);
    // before shutdown, the ready listener is registered
    expect((pi._handlers.get("pi-todo:ready") ?? []).length).toBe(1);
    expect((pi._handlers.get("session_shutdown") ?? []).length).toBe(1);
    fire(pi, "session_shutdown");
    // after shutdown, listeners are cleared
    expect((pi._handlers.get("pi-todo:ready") ?? []).length).toBe(0);
  });

  it("disableBuiltInFollowUp=true calls the api's disableBuiltInFollowUp on ready", () => {
    const pi = makeFakePi();
    subscribeToTodo(pi as unknown as ExtensionAPI, true);
    let disabled = false;
    fire(pi, "pi-todo:ready", {
      disableBuiltInFollowUp: () => {
        disabled = true;
      },
      getItems: () => [],
    });
    expect(disabled).toBe(true);
  });
});
