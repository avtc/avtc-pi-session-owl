// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// STUB (replaced by T20): the real progress tracker + widget render live here.
// T7 imports `initWidget()` so `activate` can hand the lifecycle a WidgetController;
// until T20 lands this returns a no-op controller. T24 wires the final surface.

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

/**
 * The widget controller surface the lifecycle + stages touch (setCtx on start,
 * clearCtx on shutdown, startStage/endStage/setPass/setBatch/onEvent during runs,
 * render to publish). T20 replaces the no-op stub with the real ProgressTracker.
 */
export interface WidgetController {
  setCtx(ctx: ExtensionContext): void;
  clearCtx(): void;
  render(): void;
  /** Begin a stage, optionally seeding its pass/batch counters (S-Widget). */
  startStage(stage: string, init?: { pass?: number; batch?: { done: number; total: number } }): void;
  setPass(pass: number): void;
  setBatch(done: number, total: number): void;
  endStage(): void;
  onEvent(event: unknown): void;
}

const NO_OP = (): void => {};

/** STUB (T20 replaces): return a no-op widget controller. */
export function initWidget(): WidgetController {
  return {
    setCtx: NO_OP,
    clearCtx: NO_OP,
    render: NO_OP,
    startStage: NO_OP,
    setPass: NO_OP,
    setBatch: NO_OP,
    endStage: NO_OP,
    onEvent: NO_OP,
  };
}
