// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// The mid-session initial-prompt capture: a live session's first prompt
// arrives AFTER the session-start backfill, so the turn boundary of the
// MAIN loop captures it as oInitialPrompt (idempotent) and fires the
// one-shot goal extraction — before the Observer's trigger, so the first
// user message is exclusively oInitialPrompt (pi's every-turn-end gate).

import { beforeEach, describe, expect, test } from "vitest";
import { getBinding } from "../../host/runs/bind.js";
import * as hostState from "../../host/state.js";
import { createHarness } from "../helpers/harness.js";

const harness = createHarness();

beforeEach(async () => {
  await harness.load();
  harness.env.set("CLAUDE_CONFIG_DIR", "/cfg");
});

/** The PRODUCTION envelope shape: session.append carries uuid/message/door/
 *  origin — NO parentUuid (pinned fields only). The parent param stays for
 *  the tests that assert explicit-edge behavior; omit it to mirror the
 *  platform. */
function promptRow(
  uuid: string,
  parentUuid: string | null,
  text: string,
  opts: { envelopeParent?: boolean } = {},
): Record<string, unknown> {
  return {
    uuid,
    ...(opts.envelopeParent ? { parentUuid } : {}),
    door: "prompt",
    origin: { kind: "composer" },
    message: { type: "user", content: [{ type: "text", text }] },
  };
}

describe("initial prompt — the mid-session turn-boundary capture", () => {
  test("a prompt typed after session start is captured at turn.complete and fires goal extraction", async () => {
    await harness.dispatch("classic.SessionStart", { session_id: "sess-g1", transcript_path: "/t/g1.jsonl" });
    // the session STARTED with an empty transcript; the first prompt arrives now
    await harness.dispatch("session.append", promptRow("g1", null, "Build me a demo app"));
    await harness.dispatch("turn.complete", { answer: "ok", isAborted: false });

    const key = hostState.conversationKey("sess-g1", null);
    const graph = getBinding(key, "sess-g1", null).graph();
    expect(graph).not.toBeNull();
    expect(graph?.hasInitialPrompt).toBe(true);

    // the capture is idempotent: the next turn adds nothing new
    await harness.dispatch("session.append", promptRow("g2", "g1", "another turn"));
    await harness.dispatch("turn.complete", { answer: "ok", isAborted: false });
    expect(getBinding(key, "sess-g1", null).graph()?.hasInitialPrompt).toBe(true);
  });
});

describe("initial prompt — the production envelope (no parentUuid on append)", () => {
  test("arrival-inferred chains survive a core reload: the graph keeps its records past turn 1", async () => {
    await harness.dispatch("classic.SessionStart", { session_id: "sess-g2", transcript_path: "/t/g2.jsonl" });
    // turn 1: rows arrive WITHOUT parentUuid (the platform envelope)
    await harness.dispatch("session.append", promptRow("h1", null, "first turn prompt"));
    await harness.dispatch("turn.complete", { answer: "ok", isAborted: false });
    // turn 2: more envelope rows — in production the engine chains these
    // through system rows the envelope never even shows
    await harness.dispatch("session.append", promptRow("h2", "h1", "second turn prompt"));
    await harness.dispatch("turn.complete", { answer: "ok", isAborted: false });

    const key = hostState.conversationKey("sess-g2", null);
    expect(getBinding(key, "sess-g2", null).graph()?.hasInitialPrompt).toBe(true);

    // THE PRODUCTION SHAPE: a core switch away and back (any sub-agent run
    // does this) re-folds the graph from the mirror chain — with null
    // parents the chain is [leaf] alone and the fold drops EVERY record
    // not marked at the leaf (Nodes 0, "No memory yet")
    const { getCore, _resetCoreInstances } = await import("../../host/core-instances.js");
    const emptyCtx = {
      getLeafId: () => null,
      getBranch: () => [],
      appendEntry: () => {},
    } as never;
    await getCore("sess-g2|other-loop", { ctxFactory: () => emptyCtx });
    const back = await getCore(key);
    const storeView = back.store.getGraphStore();
    expect(storeView.graph.nodes.size).toBeGreaterThan(0); // nGoal survives
    expect(storeView.graph.observations.has("oInitialPrompt")).toBe(true);
    _resetCoreInstances();
  });
});

describe("initial prompt — subagent-loop scope (its own state — pi subagent parity)", () => {
  test("a subagent loop seeds nGoal and captures its OWN initial prompt at its step boundary", async () => {
    await harness.dispatch("classic.SessionStart", { session_id: "sess-loop", transcript_path: "/t/lp.jsonl" });
    await harness.dispatch("session.append", {
      ...promptRow("l1", null, "Find the latest Claude Code version"),
      agentId: "loop-a1",
    });
    await harness.dispatch("turn.step", { turnId: "lt", index: 1, agentId: "loop-a1", model: "m" });

    const key = hostState.conversationKey("sess-loop", "loop-a1");
    const graph = getBinding(key, "sess-loop", "loop-a1").graph();
    expect(graph).not.toBeNull();
    expect(graph?.nodes.has("nGoal")).toBe(true);
    expect(graph?.hasInitialPrompt).toBe(true);
  });

  test("an owl-spawned stage loop never seeds (the own-run exclusion)", async () => {
    const bridge = harness.bridge();
    bridge.spawnRegistry.set("owl-77", { launchedAt: 1 });
    await harness.dispatch("classic.SessionStart", { session_id: "sess-st", transcript_path: "/t/st.jsonl" });
    await harness.dispatch("session.append", {
      ...promptRow("x1", null, "stage chatter"),
      agentId: "owl-77",
    });
    await harness.dispatch("turn.step", { turnId: "st", index: 1, agentId: "owl-77", model: "m" });

    const key = hostState.conversationKey("sess-st", "owl-77");
    const graph = getBinding(key, "sess-st", "owl-77").graph();
    expect(graph?.hasInitialPrompt).toBeFalsy();
    expect(graph?.nodes.has("nGoal")).toBe(false);
    bridge.spawnRegistry.delete("owl-77");
  });
});
