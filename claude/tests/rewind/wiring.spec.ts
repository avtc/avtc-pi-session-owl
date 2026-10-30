// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// The rewind wiring surface: the turn.complete live-chain flush verifies
// the turn's rows against the transcript file (the file is the truth
// channel — amputation there is the rewind signal), classic session.start
// arms the transcript path + the process-start check, session.measure
// feeds the tripwires, and a door-compaction row clears the next
// fill-drop suspicion.

import { beforeEach, describe, expect, test } from "vitest";
import { checkpointService } from "../../host/rewind/checkpoint-service.js";
import * as hostState from "../../host/state.js";
import { createHarness } from "../helpers/harness.js";

const harness = createHarness();

beforeEach(async () => {
  await harness.load();
  harness.env.set("CLAUDE_CONFIG_DIR", "/cfg");
});

function promptRow(uuid: string, parentUuid: string | null, text: string): Record<string, unknown> {
  return {
    uuid,
    parentUuid,
    door: "prompt",
    origin: { kind: "composer" },
    message: { type: "user", content: [{ type: "text", text }] },
  };
}

const apiMsg = (text: string) => ({ role: "user", content: [{ type: "text", text }] });

/** A transcript file row (the live chain's truth channel). */
const fileRow = (uuid: string, parentUuid: string | null, text: string): string =>
  JSON.stringify({
    uuid,
    parentUuid,
    sessionId: "sess-file",
    timestamp: "2026-10-30T00:00:00.000Z",
    type: "user",
    message: { role: "user", content: text },
  });

const jsonl = (...rows: string[]) => `${rows.join("\n")}\n`;

/** The reconciliation log lines land through the initLogConsumer backend
 *  (the translating seam) into the harness fs under /cfg/logs/. */
async function logText(): Promise<string> {
  const parts: string[] = [];
  for (const p of harness.fsPaths().filter((x) => x.startsWith("/cfg/logs/"))) {
    parts.push((await harness.fsRead(p)) ?? "");
  }
  return parts.join("\n");
}

describe("rewind wiring — the live chain at the turn boundary", () => {
  test("classic session.start arms the transcript path (state slot)", async () => {
    await harness.dispatch("classic.SessionStart", { session_id: "sess-r1", transcript_path: "/t/r1.jsonl" });
    expect(hostState.getCurrentTranscriptPath()).toBe("/t/r1.jsonl");
  });

  test("a clean turn: the live chain verifies before the flush and appends NO extra CHECK (the flush's CHECK is the boundary)", async () => {
    await harness.dispatch("classic.SessionStart", { session_id: "sess-r2", transcript_path: "/t/r2.jsonl" });
    await harness.dispatch("session.append", promptRow("u1", null, "hello"));
    await harness.dispatch("session.append", promptRow("u2", "u1", "world"));
    harness.sessionApi.set([apiMsg("hello"), apiMsg("world")]);
    await harness.dispatch("turn.complete", { answer: "done", isAborted: false });

    const ledgerFiles = harness.fsPaths().filter((p) => p.includes("sessions/sess-r2/") && /ledger-/.test(p));
    // the mutate → flush pipeline writes one batch file PER persist wave, so
    // the boundary is asserted over the FOLD (ts, producerId, seq) order
    // across every ledger file — the file layout itself is not the contract
    const rows: Array<{ kind: string; ts: number; producerId: string; seq: number }> = [];
    for (const file of ledgerFiles) {
      const text = (await harness.fsRead(file)) ?? "";
      for (const line of text.split("\n")) {
        if (line.length > 0) rows.push(JSON.parse(line) as (typeof rows)[number]);
      }
    }
    rows.sort((a, b) => a.ts - b.ts || a.producerId.localeCompare(b.producerId) || a.seq - b.seq);
    // the start sequence's nGoal seed (the boot backfill runs at start)
    // leads; the flush's boundary CHECK follows — and it is
    // the ONLY CHECK (the clean checkpoint itself persists none)
    expect(rows.slice(0, 2).map((r) => r.kind)).toEqual(["graph_delta", "CHECK"]);
    expect(rows.filter((r) => r.kind === "CHECK")).toHaveLength(1);
    expect(await logText()).not.toContain("rewind detected");
  });

  test("an owl stage agent's turn end runs NO checkpoint and opens NO storage (own-run exclusion)", async () => {
    await harness.dispatch("classic.SessionStart", { session_id: "sess-owl-loop", transcript_path: "/t/rl.jsonl" });
    const bridge = harness.bridge();
    bridge.recordSpawn("ag-owl-loop", { stage: "observer" });
    const svc = checkpointService();
    const original = svc.buildDeps;
    const built: string[] = [];
    svc.buildDeps = ((...args: Parameters<typeof original>) => {
      built.push(String(args[0]));
      return original.apply(svc, args);
    }) as typeof svc.buildDeps;
    try {
      await harness.dispatch("turn.complete", { answer: "done", isAborted: false, agentId: "ag-owl-loop" });
      await new Promise((r) => setTimeout(r, 30)); // the logger's async flush chain
      // owl's own stage loops are not conversations: no checkpoint deps, no
      // per-agent store, no reconcile line for their keys (the trigger
      // matrix and the capture skip exclude them)
      expect(built.filter((k) => k.includes("ag-owl-loop"))).toEqual([]);
      // control: the main loop's checkpoint still runs (the spy is live)
      await harness.dispatch("turn.complete", { answer: "done", isAborted: false });
      expect(built).toContain("sess-owl-loop");
      const agentPaths = harness.fsPaths().filter((p) => p.includes("sessions/sess-owl-loop-ag-owl-loop/"));
      expect(agentPaths).toEqual([]);
      expect(await logText()).not.toContain("sess-owl-loop-ag-owl-loop");
    } finally {
      svc.buildDeps = original;
      bridge.forgetSpawn("ag-owl-loop");
    }
  });

  test("a rewind mid-session: divergence at the boundary, reconciliation logged, the blind-window quarantine applied, the flush still runs", async () => {
    await harness.dispatch("classic.SessionStart", { session_id: "sess-r3", transcript_path: "/t/r3.jsonl" });
    // turn 1: u1..u2 observed, flushed, CHECKed (the file catches up to the
    // engine's own persist before the turn boundary reads it)
    await harness.dispatch("session.append", promptRow("u1", null, "hello"));
    await harness.dispatch("session.append", promptRow("u2", "u1", "world"));
    await harness.fsWrite("/t/r3.jsonl", jsonl(fileRow("u1", null, "hello"), fileRow("u2", "u1", "world")));
    await harness.dispatch("turn.complete", { answer: "done", isAborted: false });
    // the user rewound to u2 and sent an edited prompt — u3 died (the file
    // was amputated past it), u4 chains from the settle point u2
    await harness.dispatch("session.append", promptRow("u3", "u2", "old tail"));
    await harness.fsWrite("/t/r3.jsonl", jsonl(fileRow("u1", null, "hello"), fileRow("u2", "u1", "world")));
    await harness.dispatch("session.append", promptRow("u4", "u2", "new prompt"));
    await harness.fsWrite(
      "/t/r3.jsonl",
      jsonl(fileRow("u1", null, "hello"), fileRow("u2", "u1", "world"), fileRow("u4", "u2", "new prompt")),
    );
    await harness.dispatch("turn.complete", { answer: "done", isAborted: false });

    await new Promise((r) => setTimeout(r, 30)); // the logger's async flush chain
    const text = await logText();
    expect(text).toMatch(/amputated row\(s\), settle at u4[^\n]*conv sess-r3/);
    // the turn still flushed its rows + boundary CHECK
    const ledgerFiles = harness.fsPaths().filter((p) => p.includes("sessions/sess-r3/") && /ledger-/.test(p));
    expect(ledgerFiles.length).toBeGreaterThanOrEqual(1);
  });

  test("a clean turn writes the verified edges into the LEDGER lineage (exact, marker at the batch tip)", async () => {
    await harness.dispatch("classic.SessionStart", { session_id: "sess-lin", transcript_path: "/t/lin.jsonl" });
    await harness.dispatch("session.append", promptRow("u1", null, "hello"));
    await harness.dispatch("session.append", promptRow("u2", "u1", "world"));
    await harness.fsWrite("/t/lin.jsonl", jsonl(fileRow("u1", null, "hello"), fileRow("u2", "u1", "world")));
    await harness.dispatch("turn.complete", { answer: "done", isAborted: false });
    const ledgerFiles = harness.fsPaths().filter((p) => p.includes("sessions/sess-lin/") && /ledger-/.test(p));
    expect(ledgerFiles.length).toBeGreaterThanOrEqual(1);
    const lines: string[] = [];
    for (const f of ledgerFiles)
      lines.push(...((await harness.fsRead(f)) ?? "").split("\n").filter((l) => l.trim() !== ""));
    const lineage = lines
      .map(
        (l) =>
          JSON.parse(l) as {
            kind?: string;
            payload?: { edges?: Array<{ uuid: string; parent: string | null; exact: boolean }> };
            marker?: string;
          },
      )
      .find((r) => r.kind === "lineage");
    expect(lineage).toBeDefined();
    expect(lineage?.payload?.edges).toEqual([
      { uuid: "u1", parent: null, exact: true },
      { uuid: "u2", parent: "u1", exact: true },
    ]);
    // the marker names the write-tip row the pass read up to
    expect(lineage?.marker).toBe("u2");
  });

  test("session.end disposes the live chain: nothing fires after; the next session's chain is fresh", async () => {
    await harness.dispatch("classic.SessionStart", { session_id: "sess-end", transcript_path: "/t/end.jsonl" });
    await harness.dispatch("session.append", promptRow("u1", null, "hello"));
    await harness.dispatch("session.append", promptRow("u2", "u1", "world"));
    await harness.fsWrite("/t/end.jsonl", jsonl(fileRow("u1", null, "hello"), fileRow("u2", "u1", "world")));
    await harness.dispatch("turn.complete", { answer: "done", isAborted: false });
    // the session ends with a pending row queued (its turn never completed)
    await harness.dispatch("session.append", promptRow("u3", "u2", "pending"));
    await harness.dispatch("session.end", {});
    // an amputated transcript appears AFTER the end — the disposed chain
    // must not read it or fire anything
    await harness.fsWrite("/t/end.jsonl", jsonl(fileRow("u1", null, "hello")));
    await new Promise((r) => setTimeout(r, 40));
    const text = await logText();
    expect(text).not.toMatch(/live chain:[^\n]*conv sess-end[^\n]*(rewind|shedding|shrank)/);
    // a NEW session builds its own chain and detects its own rewind
    await harness.dispatch("classic.SessionStart", { session_id: "sess-next", transcript_path: "/t/next.jsonl" });
    await harness.dispatch("session.append", promptRow("v1", null, "one"));
    await harness.dispatch("session.append", promptRow("v2", "v1", "two"));
    await harness.fsWrite("/t/next.jsonl", jsonl(fileRow("v1", null, "one"), fileRow("v2", "v1", "two")));
    await harness.dispatch("turn.complete", { answer: "done", isAborted: false });
    await harness.dispatch("session.append", promptRow("v3", "v2", "doomed"));
    await harness.dispatch("session.append", promptRow("v4", "v2", "branch"));
    await harness.fsWrite(
      "/t/next.jsonl",
      jsonl(fileRow("v1", null, "one"), fileRow("v2", "v1", "two"), fileRow("v4", "v2", "branch")),
    );
    await harness.dispatch("turn.complete", { answer: "done", isAborted: false });
    const text2 = await logText();
    expect(text2).toMatch(/live chain:[^\n]*conv sess-next/);
  });

  test("a subagent loop's turn.complete reads ITS OWN canonical view (agentId-scoped), never the main one", async () => {
    await harness.dispatch("classic.SessionStart", { session_id: "sess-r6", transcript_path: "/t/r6.jsonl" });
    // the loop's rows arrive agentId-scoped
    await harness.dispatch("session.append", {
      uuid: "l1",
      parentUuid: null,
      agentId: "agent-7",
      door: "prompt",
      origin: { kind: "composer" },
      message: { type: "user", content: [{ type: "text", text: "loop hello" }] },
    });
    // the MAIN view (what an unscoped read would return) differs from the
    // loop's — a scoped read must see the loop's own rows (armed per agent;
    // an unscoped read would hit the main view and read a total rewind)
    harness.sessionApi.set(
      [{ role: "user", content: [{ type: "text", text: "MAIN other" }] }],
      [{ uuid: "main-only" }],
    );
    harness.sessionAgentApi.set("agent-7", [apiMsg("loop hello")]);
    await harness.dispatch("turn.complete", { answer: "done", isAborted: false, agentId: "agent-7" });
    // no false "rewind detected" for the loop (the scoped view matched it)
    const text = await logText();
    expect(text).not.toContain("rewind detected — conversation sess-r6");
  });

  test("detection is sticky across turns: the turn after a rewind does not re-fire", async () => {
    await harness.dispatch("classic.SessionStart", { session_id: "sess-r7", transcript_path: "/t/r7.jsonl" });
    await harness.dispatch("session.append", promptRow("u1", null, "hello"));
    await harness.fsWrite("/t/r7.jsonl", jsonl(fileRow("u1", null, "hello")));
    await harness.dispatch("turn.complete", { answer: "done", isAborted: false });
    // the rewind: u2 dies (amputated), u3 is the edited prompt
    await harness.dispatch("session.append", promptRow("u2", "u1", "old"));
    await harness.dispatch("session.append", promptRow("u3", "u1", "new"));
    await harness.fsWrite("/t/r7.jsonl", jsonl(fileRow("u1", null, "hello"), fileRow("u3", "u1", "new")));
    await harness.dispatch("turn.complete", { answer: "done", isAborted: false });
    // the NEXT clean turn on the new branch
    await harness.dispatch("session.append", promptRow("u4", "u3", "more"));
    await harness.fsWrite(
      "/t/r7.jsonl",
      jsonl(fileRow("u1", null, "hello"), fileRow("u3", "u1", "new"), fileRow("u4", "u3", "more")),
    );
    await harness.dispatch("turn.complete", { answer: "done", isAborted: false });
    await new Promise((r) => setTimeout(r, 30));
    const text = await logText();
    expect(text.match(/amputated row\(s\), settle at[^\n]*conv sess-r7/g)).toHaveLength(1);
  });

  test("session.measure feeds the tripwires: a fill drop with no compaction row fires the next degrade correctly", async () => {
    await harness.dispatch("classic.SessionStart", { session_id: "sess-r4", transcript_path: "/t/r4.jsonl" });
    // no api view armed (sessionApi empty) and no rows: the fill series still tracks
    await harness.dispatch("session.measure", { context: { tokens: 1000, window: 200_000 } });
    await harness.dispatch("session.measure", { context: { tokens: 400, window: 200_000 } });
    expect(checkpointService().tripwires().evaluate("sess-r4")).toEqual({ suspected: true });
  });

  test("disabled owl: the checkpoint arm stays dormant (no checkpoint CHECK, no reconciliation log)", async () => {
    await harness.dispatch("classic.SessionStart", { session_id: "sess-r5", transcript_path: "/t/r5.jsonl" });
    // disable BEFORE any arm fires: the settings consumer's live value
    hostState.setOwlEnabled(false);
    await harness.dispatch("session.append", promptRow("u1", null, "hello"));
    // an api view that would read as a divergence if the arm ran
    harness.sessionApi.set([]);
    await harness.dispatch("turn.complete", { answer: "done", isAborted: false });
    const text = await logText();
    expect(text).not.toContain("rewind detected — conversation sess-r5");
    // the flush still ran (rows durable) but no divergence CHECK joined it
    const ledgerFiles = harness.fsPaths().filter((p) => p.includes("sessions/sess-r5/") && /ledger-/.test(p));
    const kinds = ((await harness.fsRead(ledgerFiles[0] ?? "")) ?? "")
      .split("\n")
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l).kind);
    expect(kinds.filter((k) => k === "CHECK").length).toBeLessThanOrEqual(1);
  });

  // -- the compaction exemption ------------------------------------------------

  /** A three-prompt transcript whose kept-tail budget (4 tokens) keeps the
   *  last two rows — the summarized prefix (u1) legitimately vanishes from
   *  the api view when owl answers a compaction. */
  const CUT_TRANSCRIPT = [
    {
      uuid: "u1",
      parentUuid: null,
      sessionId: "sess-cut",
      timestamp: "2026-10-11T10:00:01.000Z",
      type: "user",
      message: { role: "user", content: "one two three four five six seven eight nine ten" },
    },
    {
      uuid: "u2",
      parentUuid: "u1",
      sessionId: "sess-cut",
      timestamp: "2026-10-11T10:00:02.000Z",
      type: "user",
      message: { role: "user", content: "alpha beta gamma" },
    },
    {
      uuid: "u3",
      parentUuid: "u2",
      sessionId: "sess-cut",
      timestamp: "2026-10-11T10:00:03.000Z",
      type: "user",
      message: { role: "user", content: "tail row" },
    },
  ]
    .map((r) => JSON.stringify(r))
    .join("\n");

  test("an owl-answered compaction seeds the alignment exemption — post-compact checkpoints stay clean, real rewinds still diverge", async () => {
    harness.env.set("CLAUDE_SETTINGS_SESSION_OWL", JSON.stringify({ keepRecentTokens: 4 }));
    await harness.fsWrite("/cfg/projects/p/r8.jsonl", CUT_TRANSCRIPT);
    await harness.dispatch("classic.SessionStart", {
      source: "startup",
      session_id: "sess-r8",
      transcript_path: "/cfg/projects/p/r8.jsonl",
      cwd: "/w",
    });
    // the backfill mirrors the three rows; the pre-compact view is whole
    harness.sessionApi.set([
      apiMsg("one two three four five six seven eight nine ten"),
      apiMsg("alpha beta gamma"),
      apiMsg("tail row"),
    ]);
    await harness.dispatch("turn.complete", { answer: "done", isAborted: false });
    let text = await logText();
    expect(text).not.toContain("rewind detected — conversation sess-r8");

    // owl ANSWERS a compaction: the 4-token budget keeps [u2, u3] — u1 is
    // summarized away. The engine writes no row for a hook-answered
    // compaction, so the ANSWER itself must seed the exemption boundary.
    const result = (await harness.dispatch("session.compact", {
      trigger: "manual",
      messages: [
        { role: "user", text: "one two three four five six seven eight nine ten", toolUses: [] },
        { role: "user", text: "alpha beta gamma", toolUses: [] },
        { role: "user", text: "tail row", toolUses: [] },
      ],
    })) as { messages: Array<{ role: string; text: string }> };
    expect(result.messages.map((m) => m.text)).toEqual([
      expect.stringContaining("# Memory"),
      "alpha beta gamma",
      "tail row",
    ]);
    // the cut is persisted: a cut-bearing compact-answer timeline row (the
    // append is fire-and-forget — drain the flush chain before reading)
    await new Promise((resolve) => setTimeout(resolve, 30));
    const timelineFiles = harness
      .fsPaths()
      .filter((p) => p.includes("sessions/sess-r8/") && /timeline-.*\.jsonl$/.test(p));
    const timelineText = (
      await Promise.all(timelineFiles.map((p) => harness.fsRead(p).then((t: string | undefined) => t ?? "")))
    ).join("\n");
    expect(timelineText).toContain('"t":"compact-answer"');
    expect(timelineText).toContain('"cut":"u2"');

    // the post-compact turn: the file legitimately lacks u1 (the cut) —
    // this is NOT a rewind; the chain continues from the kept tail
    await harness.dispatch("session.append", promptRow("u4", "u3", "after cut prompt"));
    await harness.fsWrite(
      "/cfg/projects/p/r8.jsonl",
      `${CUT_TRANSCRIPT}${fileRow("u4", "u3", "after cut prompt")}
`,
    );
    await harness.dispatch("turn.complete", { answer: "done", isAborted: false });
    text = await logText();
    expect(text).not.toMatch(/live chain: rewind detected[^\n]*conv sess-r8/);

    // a REAL rewind of the kept tail still diverges: the exemption masks
    // only the summarized prefix, never the post-cut rows. The engine also
    // REWRITES the transcript — rows the file no longer holds are the dead
    // set's provenance class (u2/u3 carried exact lineage from the earlier
    // verifier pass; the never-filed mirror row alone proves nothing)
    await harness.dispatch("session.append", promptRow("u5", "u2", "rewound branch"));
    await harness.fsWrite(
      "/cfg/projects/p/r8.jsonl",
      jsonl(
        fileRow("u1", null, "one two three four five six seven eight nine ten"),
        fileRow("u2", "u1", "alpha beta gamma"),
        fileRow("u5", "u2", "rewound branch"),
      ),
    );
    await harness.dispatch("turn.complete", { answer: "done", isAborted: false });
    text = await logText();
    expect(text).toMatch(/live chain: rewind detected[^\n]*conv sess-r8/);
    expect(text).toMatch(/anchors at u2[^\n]*conv sess-r8/);
  });

  test("session start re-seeds the compaction boundary from the timeline union (restart persistence)", async () => {
    // a PREVIOUS process answered a compaction with cut u2 — its timeline
    // row outlived the process; the engine wrote no row of its own
    await harness.fsWrite(
      "/cfg/session-owl/sessions/sess-r9/timeline-prev.jsonl",
      '{"t":"compact-answer","at":1000,"cut":"u2"}\n',
    );
    await harness.fsWrite("/cfg/projects/p/r9.jsonl", CUT_TRANSCRIPT.replace(/sess-cut/g, "sess-r9"));
    await harness.dispatch("classic.SessionStart", {
      source: "startup",
      session_id: "sess-r9",
      transcript_path: "/cfg/projects/p/r9.jsonl",
      cwd: "/w",
    });
    // the post-compact view: u1 summarized away, u2/u3 kept
    harness.sessionApi.set([apiMsg("summary stands in"), apiMsg("alpha beta gamma"), apiMsg("tail row")]);
    await harness.dispatch("turn.complete", { answer: "done", isAborted: false });
    const text = await logText();
    expect(text).not.toContain("rewind detected — conversation sess-r9");
  });

  test("an over-cap tail read escalates to the helper tier — the live chain's ladder", async () => {
    await harness.dispatch("classic.SessionStart", {
      source: "startup",
      session_id: "sess-r10",
      transcript_path: "/cfg/projects/p/r10.jsonl",
      cwd: "/w",
    });
    await harness.dispatch("session.append", promptRow("u1", null, "hello"));
    await harness.dispatch("session.append", promptRow("u2", "u1", "world"));
    await harness.fsWrite(
      "/cfg/projects/p/r10.jsonl",
      jsonl(fileRow("u1", null, "hello"), fileRow("u2", "u1", "world")),
    );
    // the read now REFUSES (over the 4 MiB cap) — the tail tier escalates
    // to the helper on EVERY surface (the process capsule is universal)
    harness.fsRefuse("/cfg/projects/p/r10.jsonl");
    const before = harness.processRuns.length;
    await harness.dispatch("turn.complete", { answer: "done", isAborted: false });
    const tailRun = harness.processRuns.slice(before).find((a) => a.some((x) => x.includes("verify.mjs")));
    expect(tailRun).toBeDefined();
    expect(tailRun).toContain("/cfg/projects/p/r10.jsonl");
    expect(tailRun).toContain("--tail");
    // the harness's helper stdout is not a tail report ("pruned") — the
    // tier degrades to missing and the tick retries (never a wrong verdict)
    const text = await logText();
    expect(text).not.toMatch(/live chain: rewind detected[^\n]*conv sess-r10/);
  });
});
