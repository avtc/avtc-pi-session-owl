// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// Contract test for the shared notify helper: it delegates to ctx.ui.notify,
// forwarding the message and level unchanged. (The run modules + compaction
// hook all surface notifications through this single seam.)

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { notify } from "../src/notify.js";

describe("notify", () => {
  it("forwards the message and level to ctx.ui.notify", () => {
    const notifySpy = vi.fn();
    const ctx = { ui: { notify: notifySpy } } as unknown as ExtensionContext;

    notify(ctx, "something happened", "warning");

    expect(notifySpy).calledOnceWith("something happened", "warning");
  });

  it("forwards the info level", () => {
    const notifySpy = vi.fn();
    const ctx = { ui: { notify: notifySpy } } as unknown as ExtensionContext;

    notify(ctx, "all good", "info");

    expect(notifySpy).calledOnceWith("all good", "info");
  });
});
