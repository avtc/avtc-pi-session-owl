// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// The owl_compact wiring through the registered hooks: the tool.call serve
// (main conversation schedules, a subagent loop is refused) and the
// turn.complete fire (an answered turn compacts with the notes; an
// interrupted or failed turn drops the request — no compaction, no
// continuation).

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  clearPendingCompactForSession,
  OWL_COMPACT_SCHEDULED_TEXT,
  peekPendingCompact,
} from "../../core/src/compaction/agent-compact-core.js";
import { OWL_COMPACT_SUBAGENT_TEXT } from "../../host/compaction/agent-compact.js";
import { OWL_COMPACT_FULL_NAME } from "../../host/compaction/agent-compact-spec.js";
import { createHarness } from "../helpers/harness.js";

const SESSION = "sess-ac-wiring";

let h: ReturnType<typeof createHarness>;

beforeEach(async () => {
  h = createHarness();
  h.env.set("CLAUDE_CONFIG_DIR", "/cfg");
  await h.load();
  await h.dispatch("classic.SessionStart", {
    source: "startup",
    session_id: SESSION,
    transcript_path: `/cfg/projects/p/${SESSION}.jsonl`,
    cwd: "/w",
  });
});

afterEach(() => {
  clearPendingCompactForSession(SESSION);
});

/** Let the deferred fire (the timer lane) run. */
async function settleTimers(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
}

describe("owl_compact serve", () => {
  test("the main conversation schedules", async () => {
    const out = await h.dispatch("tool.call", {
      tool: OWL_COMPACT_FULL_NAME,
      tool_use_id: "u-ac1",
      continue_notes: "the plan",
    });
    expect(out).toEqual({ result: OWL_COMPACT_SCHEDULED_TEXT });
    expect(peekPendingCompact(SESSION)?.notes).toBe("the plan");
  });

  test("a subagent loop is refused with the reason, and nothing is stashed", async () => {
    const out = await h.dispatch("tool.call", {
      tool: OWL_COMPACT_FULL_NAME,
      tool_use_id: "u-ac2",
      agentId: "ag-1",
      continue_notes: "the plan",
    });
    expect(out).toEqual({ deny: OWL_COMPACT_SUBAGENT_TEXT });
    expect(peekPendingCompact(`${SESSION}|ag-1`)).toBeNull();
  });
});

describe("owl_compact fire at turn.complete", () => {
  async function schedule(): Promise<void> {
    await h.dispatch("tool.call", { tool: OWL_COMPACT_FULL_NAME, tool_use_id: "u-ac3", continue_notes: "the plan" });
  }

  test("an answered turn compacts with the notes as the instructions", async () => {
    await schedule();
    await h.dispatch("turn.complete", { reason: "answer", answer: "done", isAborted: false });
    await vi.waitFor(() => expect(h.sessionCompacts).toEqual([{ instructions: "the plan" }]));
  });

  test.each(["aborted", "error", "refusal"])(
    "a turn that ended %s drops the request — no compaction, no continuation",
    async (reason) => {
      await schedule();
      await h.dispatch("turn.complete", { reason, answer: "", isAborted: reason === "aborted" });
      await settleTimers();
      expect(h.sessionCompacts).toEqual([]);
      expect(h.promptSubmits).toEqual([]);
      expect(peekPendingCompact(SESSION)).toBeNull();
    },
  );
});
