// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>
//
// The pause-recovery wiring pins: a Channel C foreign-row hit actually
// pauses (the live set recomputes), and a reload wave without the
// conflicting mod lifts the pause (the wave converges per envelope).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { _setStaticHitsForTest, recomputePauseSet } from "../../host/conflicts/activation.js";
import { recordLiveOutcome, resetWaveLiveHits } from "../../host/conflicts/channel-b.js";
import { _resetConflictStateForTest, isConflictPaused } from "../../host/conflicts/pause.js";
import { setOwlEnabled } from "../../host/state.js";
import { createHarness } from "../helpers/harness.js";

const pausedNow = () => isConflictPaused(() => ({ enabled: true, ignoreConflicts: false }));

/** The main-simple transcript fixture as jsonl (the answered-compaction
 *  recipe from registration.spec's takeover wiring). */
function mainSimpleJsonl(): string {
  const data = JSON.parse(readFileSync(join(__dirname, "../fixtures/transcripts/main-simple.json"), "utf8")) as {
    rows: Record<string, unknown>[];
  };
  return `${data.rows
    .map((r) => {
      if (r.kind === "metadata" || r.kind === "metadata-tip") return String(r.raw);
      const { kind: _kind, ...row } = r;
      void _kind;
      return JSON.stringify(row);
    })
    .join("\n")}\n`;
}

/** Read this session's unioned timeline text (adjudication evidence). */
async function timelineText(h: ReturnType<typeof createHarness>): Promise<string> {
  const paths = h.fsPaths().filter((p: string) => /session-owl\/sessions\/sess-an\/timeline-[^/]+\.jsonl$/.test(p));
  return (await Promise.all(paths.map((p: string) => h.fsRead(p) as unknown as string))).join("\n");
}

describe("the conflict pause wiring — hit→pause and reload recovery", () => {
  let h: ReturnType<typeof createHarness>;
  afterEach(() => {
    // isolate:false: leave no armed hits for later test files (a leaked hit
    // turns every pause-predicate assertion downstream false)
    _resetConflictStateForTest();
    resetWaveLiveHits();
  });
  beforeEach(async () => {
    _resetConflictStateForTest();
    resetWaveLiveHits();
    setOwlEnabled(true);
    h = createHarness();
    await h.load();
    h.env.set("CLAUDE_CONFIG_DIR", "/cfg");
    await h.dispatch("classic.SessionStart", {
      session_id: "s-c",
      cwd: "/w",
      source: "startup",
      transcript_path: "/t/s-c.jsonl",
    });
    // the classic anchor's timeline enable append is void-fired — settle it
    await new Promise((r) => setTimeout(r, 20));
  });

  test("a Channel C foreign-compaction-row hit flips the live pause on", async () => {
    expect(pausedNow()).toBe(false); // armed but unpaused
    await h.dispatch("session.append", {
      uuid: "foreign-row-1",
      door: "compaction",
      timestamp: Date.now(),
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(pausedNow()).toBe(true); // the C hit recorded + the set recomputed
  });

  test("a reload wave without the conflicting mod lifts the pause (auto-recovery)", async () => {
    // prime: a live B hit pauses (as the envelope listener would)
    recordLiveOutcome({ channel: "B", name: "other-mod@x", evidence: "session.compact" }, null);
    recomputePauseSet();
    expect(pausedNow()).toBe(true);
    // the wave: engine.create resets the live set; the surviving mod's clean
    // envelope re-fires; the envelope-end recompute converges to unpaused
    await h.dispatch("engine.create", { plugins: ["session-owl"] });
    await h.dispatch("plugin.register", {
      name: "clean-mod",
      tier: "user",
      root: "/mods/clean-mod",
      uses: { events: ["turn.start"] },
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(pausedNow()).toBe(false); // the stale hit did not survive the wave
    // the timeline mirrors the resume (the Channel C window closes)
    const tl = h
      .fsPaths()
      .filter((p: string) => /session-owl\/sessions\/s-c\/timeline-[^/]+\.jsonl$/.test(p))
      .map((p: string) => h.fsRead(p) as unknown as string);
    const texts = await Promise.all(tl);
    expect(texts.join("\n")).toContain('"t":"resume"');
  });

  test("a NATIVE compaction (owl's hook skipped it) does not pause — the row adjudicates as owl-known", async () => {
    // owl's session.compact shell passes through here: owl
    // WAS consulted and declined — the row that follows is owl-known, not
    // foreign. Without this, the first native /compact of any owl-enabled
    // session spuriously pauses with false evidence.
    await h.dispatch("session.compact", { reason: "user" });
    await h.dispatch("session.append", {
      uuid: "native-row-1",
      door: "compaction",
      timestamp: Date.now(),
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(pausedNow()).toBe(false); // no spurious hit
    const texts = (
      await Promise.all(
        h
          .fsPaths()
          .filter((p: string) => /session-owl\/sessions\/s-c\/timeline-[^/]+\.jsonl$/.test(p))
          .map((p: string) => h.fsRead(p) as unknown as string),
      )
    ).join("\n");
    expect(texts).toContain('"t":"compact-skip"');
    expect(texts).toContain("native-row-1"); // the coordinate claim — re-ingest inert
  });

  test("CONCURRENT compactions: main + subagent rows are each claimed by their own event", async () => {
    await h.dispatch("session.compact", { reason: "user" }); // the main loop
    await h.dispatch("session.compact", { reason: "auto", agentId: "sub-1" }); // the subagent loop
    await h.dispatch("session.append", { uuid: "main-row", door: "compaction", timestamp: Date.now() });
    await h.dispatch("session.append", {
      uuid: "sub-row",
      door: "compaction",
      agentId: "sub-1",
      timestamp: Date.now(),
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(pausedNow()).toBe(false); // BOTH rows claimed — no false Channel C
  });

  test("the skip claim covers the compaction's FULL row set (the platform persists TWO rows per compaction — kickoff cell 3)", async () => {
    await h.dispatch("session.compact", { reason: "user" });
    await h.dispatch("session.append", { uuid: "native-one", door: "compaction", timestamp: Date.now() });
    await new Promise((r) => setTimeout(r, 20));
    expect(pausedNow()).toBe(false); // the first row claimed the skip
    await h.dispatch("session.append", { uuid: "native-two", door: "compaction", timestamp: Date.now() });
    await new Promise((r) => setTimeout(r, 20));
    expect(pausedNow()).toBe(false); // the SAME compaction's second row is owl-known too
  });

  test("an OUT-OF-ORDER row (older than the skip) does not consume the claim", async () => {
    await h.dispatch("session.compact", { reason: "user" });
    const skipAt = Date.now();
    await h.dispatch("session.append", { uuid: "late-arrival", door: "compaction", timestamp: skipAt - 5_000 });
    await new Promise((r) => setTimeout(r, 20));
    // the old row hit (it predates the skip — not owl-known)... unless the
    // enable window had not opened yet at its timestamp; the CLAIM itself
    // must survive for the actual next in-window row
    await h.dispatch("session.append", { uuid: "native-after-late", door: "compaction", timestamp: Date.now() });
    await new Promise((r) => setTimeout(r, 20));
    expect(pausedNow()).toBe(false); // the claim was NOT spent on the old row
  });

  test("the skip claim EXPIRES after 60s (an aged row is foreign again)", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: Date.now() });
    try {
      await h.dispatch("session.compact", { reason: "user" });
      vi.setSystemTime(Date.now() + 61_000); // age past COMPACT_SKIP_CLAIM_MS
      await h.dispatch("session.append", { uuid: "aged-row", door: "compaction", timestamp: Date.now() });
      await new Promise((r) => setTimeout(r, 20));
      expect(pausedNow()).toBe(true); // expired claim — the row hits
    } finally {
      vi.useRealTimers();
    }
  });

  test("a static Channel A hit survives the wave (restart-only recovery — pi parity)", async () => {
    // a static Channel A hit survives waves (restart-only recovery)
    _setStaticHitsForTest([{ channel: "A", name: "old-mod@disk", evidence: "hooks.json session.compact" }]);
    recomputePauseSet();
    expect(pausedNow()).toBe(true);
    await h.dispatch("engine.create", { plugins: ["session-owl"] });
    await h.dispatch("plugin.register", {
      name: "clean-mod",
      tier: "user",
      root: "/mods/clean-mod",
      uses: { events: ["turn.start"] },
    });
    expect(pausedNow()).toBe(true); // static hits re-enumerate at process start only
  });
});

describe("compaction claim coverage — owl's OWN rows never hit Channel C", () => {
  // The platform persists a compaction as up to TWO door-compaction rows
  // (compact_boundary + summary), and owl's ensure-ready
  // gate can take arbitrarily long before its verdict (LLM phases under a
  // 20-min per-call timeout) — so the claim must cover the compaction's
  // WHOLE row set, refreshed at the verdict for answered compactions —
  // an owl-answered compaction that self-pauses via Channel C is
  // the takeover inverting itself.
  let h: ReturnType<typeof createHarness>;
  afterEach(() => {
    _resetConflictStateForTest();
    resetWaveLiveHits();
  });

  /** A session whose compaction owl actually ANSWERS (the takeover recipe). */
  async function answeredSession(): Promise<void> {
    h = createHarness();
    h.env.set("CLAUDE_CONFIG_DIR", "/cfg");
    h.env.set("CLAUDE_SETTINGS_SESSION_OWL", JSON.stringify({ builderSkipWithinBudget: false, keepRecentTokens: 1 }));
    await h.load();
    await h.fsWrite("/cfg/projects/p/sess-an.jsonl", mainSimpleJsonl());
    await h.dispatch("classic.SessionStart", {
      source: "startup",
      session_id: "sess-an",
      transcript_path: "/cfg/projects/p/sess-an.jsonl",
      cwd: "/w",
    });
    await h.dispatch("session.append", {
      uuid: "an-c1",
      parentUuid: null,
      door: "prompt",
      origin: { kind: "composer" },
      message: { type: "user", content: [{ type: "text", text: `post-start ${"k".repeat(6000)}` }] },
    });
    h.sessionApi.set([]);
    const tail = [
      { role: "user", text: "first prompt", toolUses: [] },
      { role: "assistant", text: "a reply", toolUses: [] },
    ];
    const result = (await h.dispatch("session.compact", { trigger: "manual", messages: tail })) as {
      messages: Array<{ role: string; text: string }>;
    };
    expect(result.messages[0]?.text.startsWith("# Memory")).toBe(true); // owl ANSWERED
  }

  test("an ANSWERED compaction's persisted rows are owl-known: both rows adjudicate compact-answer, no pause", async () => {
    await answeredSession();
    expect(pausedNow()).toBe(false);
    // the platform persists the answer as its compaction rows — the
    // two-row shape; they must NOT read as a foreign override
    await h.dispatch("session.append", { uuid: "ans-row-1", door: "compaction", timestamp: Date.now() });
    await h.dispatch("session.append", { uuid: "ans-row-2", door: "compaction", timestamp: Date.now() });
    await new Promise((r) => setTimeout(r, 20));
    expect(pausedNow()).toBe(false); // owl's own answer — never foreign
    const texts = await timelineText(h);
    expect(texts).toContain('"t":"compact-answer"');
    expect(texts).toContain("ans-row-1"); // adjudicated — re-ingest inert
    expect(texts).toContain("ans-row-2");
  });

  test("the answer claim EXPIRES after 60s (a much-later row is foreign again)", async () => {
    await answeredSession();
    vi.useFakeTimers({ toFake: ["Date"], now: Date.now() });
    try {
      vi.setSystemTime(Date.now() + 61_000); // age past the claim window
      await h.dispatch("session.append", { uuid: "aged-answer-row", door: "compaction", timestamp: Date.now() });
      await new Promise((r) => setTimeout(r, 20));
      expect(pausedNow()).toBe(true); // expired claim — the row hits
    } finally {
      vi.useRealTimers();
    }
  });
});
