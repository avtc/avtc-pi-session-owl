// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { createTodoWiring } from "../../src/todo/wiring.js";

/** Minimal fake pi: captures events.on / on listeners + a way to fire them. */
interface FakePi {
  _handlers: Map<string, Array<(...args: unknown[]) => void>>;
  on(event: string, handler: (...args: unknown[]) => void): void;
  events: {
    on(event: string, handler: (...args: unknown[]) => void): () => void;
  };
}

function makeFakePi(): FakePi {
  const handlers = new Map<string, Array<(...args: unknown[]) => void>>();
  const reg = (event: string, handler: (...args: unknown[]) => void) => {
    const list = handlers.get(event) ?? [];
    list.push(handler);
    handlers.set(event, list);
  };
  return {
    _handlers: handlers,
    on: reg,
    events: {
      on: (event, handler) => {
        reg(event, handler);
        return () => {};
      },
    },
  };
}

describe("createTodoWiring", () => {
  it("returns null context + bridge before pi-todo:ready fires (avtc-pi-todo absent)", () => {
    const pi = makeFakePi();
    const wiring = createTodoWiring(pi as unknown as ExtensionAPI);
    expect(wiring.getContext()).toBeNull();
    expect(wiring.getBridge()).toBeNull();
  });

  it("returns a non-null context + bridge after pi-todo:ready fires (installed)", () => {
    const pi = makeFakePi();
    const wiring = createTodoWiring(pi as unknown as ExtensionAPI);
    // fire pi-todo:ready with a minimal api (getItems)
    for (const h of pi._handlers.get("pi-todo:ready") ?? []) {
      h({ disableBuiltInFollowUp() {}, getItems: () => [] });
    }
    expect(wiring.getContext()).not.toBeNull();
    expect(wiring.getBridge()).not.toBeNull();
  });

  it("context reflects items after ready fires (in_progress + pending derived)", () => {
    const pi = makeFakePi();
    const wiring = createTodoWiring(pi as unknown as ExtensionAPI);
    const items = [
      { id: "1", parentId: null, name: "A", details: "do A", status: "in_progress" },
      { id: "2", parentId: null, name: "B", details: "do B", status: "pending" },
    ];
    // a filter-respecting fake (mirrors the real avtc-pi-todo getItems)
    const getItems = (filter: { status: string } | null) => {
      const filtered =
        filter === null
          ? items
          : items.filter((i) =>
              filter.status === "completed"
                ? i.status === "completed" || i.status === "decomposed"
                : i.status === filter.status,
            );
      return filtered;
    };
    for (const h of pi._handlers.get("pi-todo:ready") ?? []) {
      h({ disableBuiltInFollowUp() {}, getItems });
    }
    const ctx = wiring.getContext();
    expect(ctx).not.toBeNull();
    expect(ctx?.getInProgress()?.id).toBe("1");
    expect(ctx?.getPending().map((i) => i.id)).toEqual(["2"]);
  });
});
