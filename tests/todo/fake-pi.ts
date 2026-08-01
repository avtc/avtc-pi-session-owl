// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

/** Minimal fake pi for todo tests: captures `on`/`events.on` listeners, the
 *  `events.on` unsub actually removes (mirrors Pi's shared eventBus), and
 *  `fire` dispatches all listeners for an event. Shared by the vendored-snippet
 *  and wiring tests to avoid duplication. */
export interface FakePi {
  _handlers: Map<string, Array<(...args: unknown[]) => void>>;
  on(event: string, handler: (...args: unknown[]) => void): void;
  events: {
    on(event: string, handler: (...args: unknown[]) => void): () => void;
  };
}

export function makeFakePi(): FakePi {
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
    on: reg,
    events: {
      on: (event, handler) => {
        reg(event, handler);
        return () => remove(event, handler);
      },
    },
  };
}

/** Fire all listeners for an event on the fake pi. */
export function fire(pi: FakePi, event: string, ...args: unknown[]): void {
  for (const h of pi._handlers.get(event) ?? []) h(...args);
}
