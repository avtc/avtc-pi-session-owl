// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { createTodoWiring } from "../../src/todo/wiring.js";
import { fire, makeFakePi } from "./fake-pi.js";

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

  it("cleans its pi-todo:ready listener on session_shutdown (reload-safe, no leak)", () => {
    const pi = makeFakePi();
    createTodoWiring(pi as unknown as ExtensionAPI);
    // createTodoWiring registers TWO pi-todo:ready listeners: the snippet's own
    // (for _api) + the wiring's readiness flag. And a session_shutdown handler.
    const readyBefore = (pi._handlers.get("pi-todo:ready") ?? []).length;
    expect(readyBefore).toBeGreaterThanOrEqual(2);
    expect((pi._handlers.get("session_shutdown") ?? []).length).toBeGreaterThanOrEqual(1);
    // fire session_shutdown — both the snippet and the wiring clean up.
    fire(pi, "session_shutdown");
    // after shutdown: the wiring's readiness listener is gone (no orphaned
    // listeners accumulating across reloads on the shared eventBus).
    const readyAfter = (pi._handlers.get("pi-todo:ready") ?? []).length;
    expect(readyAfter).toBeLessThan(readyBefore);
    expect(readyAfter).toBe(0);
  });
});
