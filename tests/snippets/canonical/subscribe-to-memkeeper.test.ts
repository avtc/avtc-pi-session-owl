// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import {
  type MemkeeperReadyApi,
  subscribeToMemkeeper,
} from "../../../src/snippets/canonical/subscribe-to-memkeeper.js";

/** Minimal fake pi: captures `on`/`events.on` listeners; `events.on` returns a
 *  real unsub (mirrors pi's shared eventBus); `fire` dispatches all listeners. */
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
  const remove = (event: string, handler: (...args: unknown[]) => void) => {
    const list = handlers.get(event);
    if (list) {
      const idx = list.indexOf(handler);
      if (idx >= 0) list.splice(idx, 1);
    }
  };
  return {
    _handlers: handlers,
    on: (event, handler) => reg(event, handler),
    events: {
      on: (event, handler) => {
        reg(event, handler);
        return () => remove(event, handler);
      },
    },
  };
}

function fire(pi: FakePi, event: string, ...args: unknown[]): void {
  for (const h of pi._handlers.get(event) ?? []) h(...args);
}

describe("subscribeToMemkeeper (canonical snippet)", () => {
  it("returns safe defaults before :ready fires (memkeeper absent)", () => {
    const pi = makeFakePi();
    const proxy = subscribeToMemkeeper(pi as unknown as ExtensionAPI);
    expect(proxy.getConfig()).toBeNull();
    // no-op reloadConfig must not throw
    expect(() => proxy.reloadConfig()).not.toThrow();
  });

  it("delegates to the api after memkeeper:ready fires", () => {
    const pi = makeFakePi();
    const proxy = subscribeToMemkeeper(pi as unknown as ExtensionAPI);
    const reloadConfig = vi.fn();
    const getConfig = vi.fn(() => ({ enabled: false }));
    const api: MemkeeperReadyApi = { reloadConfig, getConfig };
    fire(pi, "memkeeper:ready", api);

    proxy.reloadConfig();
    expect(reloadConfig).toHaveBeenCalledTimes(1);

    expect(proxy.getConfig()).toEqual({ enabled: false });
    expect(getConfig).toHaveBeenCalledTimes(1);
  });

  it("returns null from getConfig when the bridge is older (no getConfig method)", () => {
    const pi = makeFakePi();
    const proxy = subscribeToMemkeeper(pi as unknown as ExtensionAPI);
    // older memkeeper: has reloadConfig but NOT getConfig
    fire(pi, "memkeeper:ready", { reloadConfig() {} });
    expect(proxy.getConfig()).toBeNull();
    expect(() => proxy.reloadConfig()).not.toThrow();
  });

  it("exposes getConflictPause; null when the bridge is older (indistinguishable from not-paused)", () => {
    const pi = makeFakePi();
    const proxy = subscribeToMemkeeper(pi as unknown as ExtensionAPI);
    const hits = [{ entry: "npm:pi-blackhole", matched: "pi-blackhole" }];
    fire(pi, "memkeeper:ready", {
      reloadConfig() {},
      getConflictPause: () => hits,
    });
    expect(proxy.getConflictPause()).toEqual(hits);

    const older = makeFakePi();
    const olderProxy = subscribeToMemkeeper(older as unknown as ExtensionAPI);
    fire(older, "memkeeper:ready", { reloadConfig() {}, getConfig() {} });
    expect(olderProxy.getConflictPause()).toBeNull();
  });

  it("session_shutdown cleans the :ready listener (reload-safe)", () => {
    const pi = makeFakePi();
    subscribeToMemkeeper(pi as unknown as ExtensionAPI);
    // before shutdown, both listeners are registered
    expect((pi._handlers.get("memkeeper:ready") ?? []).length).toBe(1);
    expect((pi._handlers.get("session_shutdown") ?? []).length).toBe(1);
    fire(pi, "session_shutdown");
    // after shutdown, listeners are cleared
    expect((pi._handlers.get("memkeeper:ready") ?? []).length).toBe(0);
  });
});
