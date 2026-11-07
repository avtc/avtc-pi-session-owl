// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// The Claude owl_compact host: the serve validation + stash, the
// turn-boundary fire (deferred compact call, the continuation prompt on both
// outcomes, the stash cleanup), and the registration-spec drift pin against
// the vendored core texts.

import { describe, expect, it, vi } from "vitest";
import {
  clearPendingCompact,
  OWL_COMPACT_CONTINUE_PROMPT,
  OWL_COMPACT_DISABLED_TEXT,
  OWL_COMPACT_SCHEDULED_TEXT,
  parseAgentCompactValue,
  peekPendingCompact,
  setPendingCompact,
} from "../../core/src/compaction/agent-compact-core.js";
import { firePendingAgentCompact, serveOwlCompactCall } from "../../host/compaction/agent-compact.js";
import {
  OWL_COMPACT_FULL_NAME,
  OWL_COMPACT_INPUT_SCHEMA,
  OWL_COMPACT_TOOL_DESCRIPTION,
  owlCompactDeferredToolSpec,
  owlCompactToolSpec,
} from "../../host/compaction/agent-compact-spec.js";

describe("serveOwlCompactCall", () => {
  const on = parseAgentCompactValue("on");

  it("schedules: stashes and answers the scheduled text", () => {
    const outcome = serveOwlCompactCall(
      { continue_notes: "wrap up the refactor" },
      { setting: on, contextTokensK: null, key: "k" },
    );
    expect(outcome).toEqual({ text: OWL_COMPACT_SCHEDULED_TEXT, error: false });
    expect(peekPendingCompact("k")?.notes).toBe("wrap up the refactor");
    clearPendingCompact("k");
  });

  it("refuses when the setting is off", () => {
    const outcome = serveOwlCompactCall(
      { continue_notes: "x" },
      { setting: parseAgentCompactValue("off"), contextTokensK: null, key: "k" },
    );
    expect(outcome).toEqual({ text: OWL_COMPACT_DISABLED_TEXT, error: true });
    expect(peekPendingCompact("k")).toBeNull();
  });

  it("refuses under the floor with the measured context", () => {
    const setting = parseAgentCompactValue("on>40k");
    const outcome = serveOwlCompactCall({ continue_notes: "x" }, { setting, contextTokensK: 25, key: "k" });
    expect(outcome.text).toBe("compaction not scheduled: context at 25k is below the user set 40k threshold");
    expect(outcome.error).toBe(true);
    expect(peekPendingCompact("k")).toBeNull();
  });

  it("an unknown context never blocks the schedule", () => {
    const setting = parseAgentCompactValue("on>40k");
    const outcome = serveOwlCompactCall({ continue_notes: "x" }, { setting, contextTokensK: null, key: "k" });
    expect(outcome.error).toBe(false);
    clearPendingCompact("k");
  });
});

describe("firePendingAgentCompact", () => {
  const on = parseAgentCompactValue("on");

  function makeDeps() {
    return {
      sessionCompact: vi.fn(async () => ({})),
      promptSubmit: vi.fn(async () => undefined),
      clockAfter: vi.fn((_ms: number, cb: () => void) => cb()),
      log: vi.fn(),
    };
  }

  it("is a no-op without a pending request", () => {
    const deps = makeDeps();
    firePendingAgentCompact("fk", on, deps);
    expect(deps.sessionCompact).not.toHaveBeenCalled();
  });

  it("defers the compact call on the timer lane and passes the notes as instructions, then submits the continuation", async () => {
    peekSet("fk", "the plan");
    const deps = makeDeps();
    firePendingAgentCompact("fk", on, deps);
    expect(deps.clockAfter).toHaveBeenCalled();
    await vi.waitFor(() => expect(deps.promptSubmit).toHaveBeenCalled());
    expect(deps.sessionCompact).toHaveBeenCalledWith({ instructions: "the plan" });
    expect(deps.promptSubmit).toHaveBeenCalledWith({ text: OWL_COMPACT_CONTINUE_PROMPT });
    clearPendingCompact("fk");
  });

  it("a skipped compact sends NO continuation and clears the stash", async () => {
    peekSet("fk2", "the plan");
    const deps = makeDeps();
    deps.sessionCompact = vi.fn(async () => ({ skip: "session-owl: nothing to compact" }));
    firePendingAgentCompact("fk2", on, deps);
    await vi.waitFor(() => expect(deps.log).toHaveBeenCalled());
    expect(deps.promptSubmit).not.toHaveBeenCalled();
    expect(peekPendingCompact("fk2")).toBeNull();
  });

  it("a rejected compact (user abort, provider failure) sends NO continuation and clears the stash", async () => {
    peekSet("fk3", "the plan");
    const deps = makeDeps();
    deps.sessionCompact = vi.fn(async () => {
      throw new Error("a turn runs");
    });
    firePendingAgentCompact("fk3", on, deps);
    await vi.waitFor(() => expect(deps.log).toHaveBeenCalled());
    expect(deps.promptSubmit).not.toHaveBeenCalled();
    expect(peekPendingCompact("fk3")).toBeNull();
  });

  it("a compaction that stood continues exactly once", async () => {
    peekSet("fk5", "the plan");
    const deps = makeDeps();
    deps.sessionCompact = vi.fn(async () => ({ messages: [] }));
    firePendingAgentCompact("fk5", on, deps);
    await vi.waitFor(() => expect(deps.promptSubmit).toHaveBeenCalledTimes(1));
  });

  it("drops the request when the setting flipped off after the call", () => {
    peekSet("fk4", "the plan");
    const deps = makeDeps();
    firePendingAgentCompact("fk4", parseAgentCompactValue("off"), deps);
    expect(deps.sessionCompact).not.toHaveBeenCalled();
    expect(peekPendingCompact("fk4")).toBeNull();
  });
});

describe("the registration spec drift pin", () => {
  it("the description matches the vendored core text", () => {
    expect(OWL_COMPACT_TOOL_DESCRIPTION).toBe(
      "Runs compaction at the end of this turn. continue_notes will be rendered into compaction summary - " +
        "pass everything you keep in mind to effectively continue planned work after compaction. " +
        "The past turns are observed by owl, but future plans are only in your mind. " +
        "Consult with owl_recall to see root nodes summaries if needed",
    );
  });

  it("the schema carries the required unbounded string parameter", () => {
    expect(OWL_COMPACT_INPUT_SCHEMA).toEqual({
      type: "object",
      properties: {
        continue_notes: {
          type: "string",
          description: "What you need to know after compaction to effectively continue planned work",
          minLength: 1,
        },
      },
      required: ["continue_notes"],
    });
  });

  it("the full name is engine-namespaced", () => {
    expect(OWL_COMPACT_FULL_NAME).toBe("mcp__session-owl__owl_compact");
  });

  it("the boot spec is in the prompt's list; the mid-session spec is deferred", () => {
    expect(owlCompactToolSpec().isDeferred).toBe(false);
    expect(owlCompactDeferredToolSpec().isDeferred).toBe(true);
    expect(owlCompactDeferredToolSpec().name).toBe(owlCompactToolSpec().name);
  });
});

function peekSet(key: string, notes: string): void {
  setPendingCompact(key, notes);
}
