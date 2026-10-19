// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// Engine-kit twin of the compaction surface: the closure-clean slice — the
// cut (the walk-back budget rule with tool pairs kept whole, handles passed
// through), the answer assembly (the handle-less user-role summary
// message, the takeover shape, the veto) and — with the rewrite-table
// shims resolving the vendored bare edges — the takeover gate module plus
// the conversation binding's compaction deps, loading and constructing
// under the real kit loader's import rules (the full gate itself rides
// the Node suite).
import { describe, expect, test } from "claude-code/testing";
import { buildSkip, buildTakeover, estimateTokensAfter, summaryMessage } from "../host/compaction/answer.js";
import { computeKeptTail, estimateMessageTokens } from "../host/compaction/cut.js";
import { compactionTakeover } from "../host/compaction/hook.js";
import { getBinding, releaseBinding } from "../host/runs/bind.js";
import * as state from "../host/state.js";

describe("compaction surface — engine-run twin", () => {
  test("the cut: walk-back budget with the crossing message kept, oldest dropped", () => {
    const messages = Array.from({ length: 6 }, (_, i) => ({
      role: i % 2 === 0 ? "user" : "assistant",
      text: "x".repeat(400), // ≈100 tokens each
      toolUses: [],
    })) as never[];
    const { kept, firstKeptIndex } = computeKeptTail(messages, 250);
    expect(firstKeptIndex).toBe(3); // the newest ~3 retained
    expect(kept).toEqual(messages.slice(3));
  });

  test("the cut: a tool result stays with its call (the pair rule)", () => {
    const call = {
      role: "assistant",
      text: "call",
      toolUses: [{ tool_use_id: "t1", tool: "owl_recall", input: { query: "q" } }],
    } as never;
    const result = {
      role: "user",
      text: "r",
      toolUses: [],
      toolResults: [{ tool_use_id: "t1", text: "y".repeat(400) }],
    } as never;
    const messages = [
      { role: "user", text: "old", toolUses: [] },
      { role: "assistant", text: "old", toolUses: [] },
      call,
      result,
      { role: "user", text: "new", toolUses: [] },
    ] as never[];
    const { kept } = computeKeptTail(messages, 100);
    expect(kept).toContain(call);
    expect(kept).toContain(result); // the boundary extended to include the call
  });

  test("the answer: one handle-less user-role summary + the kept tail HANDLE-STRIPPED; usage ABSENT", () => {
    const kept = [{ role: "user", text: "kept row", toolUses: [], handle: "h-1" }] as never[];
    const result = buildTakeover({
      summary: "# Memory\n…",
      kept,
      tokensBefore: 9000,
      tokensAfter: estimateTokensAfter([{ role: "user", text: "# Memory\n…", toolUses: [] } as never, ...kept]),
    });
    expect(result.messages).toHaveLength(2);
    expect(result.messages[0]).toEqual({ role: "user", text: "# Memory\n…", toolUses: [] });
    // a handle-bearing kept row re-persists with its pre-boundary parent
    // linkage and the resume walk then goes around the boundary — the
    // tail is handed back BUILT
    expect(result.messages[1]).toEqual({ role: "user", text: "kept row", toolUses: [] });
    expect(result.tokensBefore).toBe(9000);
    expect(typeof result.tokensAfter).toBe("number");
    expect("usage" in result && result.usage !== undefined).toBe(false);
  });

  test("the veto: {skip: reason} leaves the conversation untouched", () => {
    expect(buildSkip("session-owl compaction failed: boom; retry")).toEqual({
      skip: "session-owl compaction failed: boom; retry",
    });
  });

  test("the summary message alone on an empty tail", () => {
    const m = summaryMessage("# Memory\n…");
    expect(m.role).toBe("user");
    expect(m.handle).toBeUndefined();
    expect(estimateMessageTokens(m)).toBeGreaterThan(0);
  });

  test("the wired takeover closure loads: gate entry + the binding's compaction deps (kit import rules)", async () => {
    // The imports at the top already prove the gate module itself resolves
    // under the kit loader's rules (bare specifiers refused; the vendored
    // bare VALUE edges rewritten to the local shims by the sync table).
    expect(typeof compactionTakeover).toBe("function");
    // constructing a binding needs only the config dir (the storage
    // assembly's precondition) — no pin, no disk: its compaction deps hand
    // back the injected contract and release cleanly
    state.resolveConfigDir("/cfg", null);
    const key = "kit-compaction-bind";
    const binding = getBinding(key, key, null);
    try {
      expect(binding.key).toBe(key);
      const deps = binding.compactionDeps({ rewindCheck: async () => {} });
      expect(deps.key).toBe(key);
      expect(typeof deps.getSettings).toBe("function");
      expect(typeof deps.rewindCheck).toBe("function");
      expect(typeof deps.runs.runObserver).toBe("function");
      expect(typeof deps.runs.runBuilder).toBe("function");
      expect(typeof deps.runs.runSelector).toBe("function");
      expect(typeof deps.persistSnapshot).toBe("function");
      expect(typeof deps.newCompactionId).toBe("function");
      expect(typeof deps.keepRecentTokens).toBe("number");
      expect(deps.isPaused()).toBe(false);
      // gate order, entry first: a conflict-paused conversation passes
      // through before anything else is consulted
      const outcome = await compactionTakeover({ trigger: "manual", messages: [] }, { ...deps, isPaused: () => true });
      expect(outcome).toEqual({ kind: "pass" });
    } finally {
      releaseBinding(key);
    }
  });
});
