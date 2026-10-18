// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// The resume exemption: right after a resume/clear/fork start the first check
// must not read the engine's capture-vs-persist gap as a rewind. Rows owl
// captured live but the engine never persists (the command/exit ceremony)
// are legitimately absent from the transcript when the first check runs —
// the ONE-SHOT boundary exempts them: it is seeded at the pre-start mirror
// tip, read from the PERSISTED mirror whenever the storage assembly is
// fresh (every real resume — session.end released the old one), and it is
// cleared by the first check that actually knows our rows.

import { beforeEach, describe, expect, test } from "vitest";
import { checkpointService } from "../../host/rewind/checkpoint-service.js";
import { conversationKey as conversationKeyOf } from "../../host/state.js";
import { getSessionStorage, releaseSessionStorage } from "../../host/storage/session-storage.js";
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

/** One assistant row carrying TWO parallel tool_use blocks. */
function parallelToolUseRow(uuid: string, parentUuid: string | null): Record<string, unknown> {
  return {
    uuid,
    parentUuid,
    door: "assistant",
    origin: { kind: "engine" },
    message: {
      type: "assistant",
      role: "assistant",
      content: [
        { type: "tool_use", id: "pt1", name: "Read", input: { path: "/a" } },
        { type: "tool_use", id: "pt2", name: "Read", input: { path: "/b" } },
      ],
    },
  };
}

/** A tool_result row (each of the parallel calls' results). */
function toolResultRow(uuid: string, parentUuid: string | null, toolUseId: string): Record<string, unknown> {
  return {
    uuid,
    parentUuid,
    door: "tool",
    origin: { kind: "engine" },
    message: {
      type: "user",
      role: "user",
      content: [{ type: "tool_result", tool_use_id: toolUseId, content: "ok" }],
    },
  };
}

const apiMsg = (text: string) => ({ role: "user", content: [{ type: "text", text }] });
const apiAssistantTools = () => ({
  role: "assistant",
  content: [
    { type: "tool_use", id: "pt1", name: "Read", input: { path: "/a" } },
    { type: "tool_use", id: "pt2", name: "Read", input: { path: "/b" } },
  ],
});
const apiToolResult = (toolUseId: string) => ({
  role: "user",
  content: [{ type: "tool_result", tool_use_id: toolUseId, content: "ok" }],
});

async function logText(): Promise<string> {
  const parts: string[] = [];
  for (const p of harness.fsPaths().filter((x) => x.startsWith("/cfg/logs/"))) {
    parts.push((await harness.fsRead(p)) ?? "");
  }
  return parts.join("\n");
}

describe("resume exemption — the process-start check at a resume", () => {
  test("a resume whose rebuilt view carries none of the mirror yet stays CLEAN (no false rewind)", async () => {
    await harness.dispatch("classic.SessionStart", { session_id: "sess-rx1", transcript_path: "/t/rx1.jsonl" });
    await harness.dispatch("session.append", promptRow("u1", null, "hello"));
    await harness.dispatch("session.append", promptRow("u2", "u1", "world"));
    harness.sessionApi.set([apiMsg("hello"), apiMsg("world")]);
    await harness.dispatch("turn.complete", { answer: "done", isAborted: false });

    // the exit + resume: the engine rebuilds its view; at the start check
    // the api view holds nothing of ours yet (continuation still forming)
    harness.sessionApi.set([]);
    await harness.dispatch("classic.SessionStart", {
      session_id: "sess-rx1",
      transcript_path: "/t/rx1.jsonl",
      source: "resume",
    });
    await new Promise((r) => setTimeout(r, 30));
    const text = await logText();
    expect(text).not.toContain("rewind detected");
    expect(text).not.toContain("records quarantined");
  });

  test("the exemption is ONE-SHOT: a real rewind after the resumed turn still fires", async () => {
    await harness.dispatch("classic.SessionStart", { session_id: "sess-rx2", transcript_path: "/t/rx2.jsonl" });
    await harness.dispatch("session.append", promptRow("u1", null, "hello"));
    await harness.dispatch("session.append", promptRow("u2", "u1", "world"));
    harness.sessionApi.set([apiMsg("hello"), apiMsg("world")]);
    await harness.dispatch("turn.complete", { answer: "done", isAborted: false });

    // resume + the first clean (the boundary clears here)
    harness.sessionApi.set([]);
    await harness.dispatch("classic.SessionStart", {
      session_id: "sess-rx2",
      transcript_path: "/t/rx2.jsonl",
      source: "resume",
    });
    // the resumed conversation serves its rebuilt view + the new turn
    harness.sessionApi.set([apiMsg("hello"), apiMsg("world")]);
    await harness.dispatch("session.append", promptRow("u3", "u2", "third"));
    await harness.dispatch("turn.complete", { answer: "done", isAborted: false });

    // a REAL rewind now: u3 dies, the view carries the rewound branch
    await harness.dispatch("session.append", promptRow("u4", "u2", "rewound branch"));
    harness.sessionApi.set([apiMsg("hello"), apiMsg("world"), apiMsg("rewound branch")]);
    await harness.dispatch("turn.complete", { answer: "done", isAborted: false });

    await new Promise((r) => setTimeout(r, 30));
    const text = await logText();
    expect(text).toContain("rewind detected");
    expect(text).toContain("sess-rx2");
  });

  test("parallel tool calls survive the resumed clean check attached (the one-level parenting)", async () => {
    await harness.dispatch("classic.SessionStart", { session_id: "sess-rx3", transcript_path: "/t/rx3.jsonl" });
    await harness.dispatch("session.append", promptRow("u1", null, "run both checks"));
    await harness.dispatch("session.append", parallelToolUseRow("a1", "u1"));
    await harness.dispatch("session.append", toolResultRow("r1", "a1", "pt1"));
    await harness.dispatch("session.append", toolResultRow("r2", "a1", "pt2"));
    await harness.dispatch("session.append", promptRow("u2", "r2", "done"));
    // the api view mirrors the full turn shape — user, the parallel
    // tool_use row, BOTH tool_results, the closing user row
    harness.sessionApi.set([
      apiMsg("run both checks"),
      apiAssistantTools(),
      apiToolResult("pt1"),
      apiToolResult("pt2"),
      apiMsg("done"),
    ]);
    await harness.dispatch("turn.complete", { answer: "done", isAborted: false });

    // resume: the rebuilt (condensed) view drops the tool detail — the
    // exemption keeps this clean
    harness.sessionApi.set([]);
    await harness.dispatch("classic.SessionStart", {
      session_id: "sess-rx3",
      transcript_path: "/t/rx3.jsonl",
      source: "resume",
    });
    await new Promise((r) => setTimeout(r, 30));
    const text = await logText();
    const mine = text
      .split("\n")
      .filter((l) => l.includes("sess-rx3"))
      .join("\n");
    expect(mine).not.toContain("rewind detected");
    // their tool_use row (the one-level parenting survives the resume)
    const storage = getSessionStorage(conversationKeyOf("sess-rx3", null), "sess-rx3", null);
    const served = storage.mirror.servedBranch(storage.mirror.tipUuid() ?? "") ?? [];
    expect(served).toContain("a1");
    expect(served).toContain("r1");
    expect(served).toContain("r2");
  });
});

describe("resume exemption — the released-storage (real cross-process) shape", () => {
  /** Prior process: run the conversation, capture + FLUSH its rows (one of
   *  them the exit-ceremony row the engine never writes to any transcript),
   *  then release the assembly — exactly what session.end teardown does to
   *  a process that is about to resume. */
  async function releasedStartIntoResume(sessionId: string): Promise<string> {
    await harness.dispatch("classic.SessionStart", {
      session_id: sessionId,
      transcript_path: `/t/${sessionId}.jsonl`,
    });
    await harness.dispatch("session.append", promptRow("u1", null, "hello"));
    await harness.dispatch("session.append", promptRow("u2", "u1", "world"));
    // the capture-ahead residue: an exit ceremony mirrored live, never in
    // the transcript file (the engine drops it at command-exit)
    await harness.dispatch("session.append", promptRow("x1", "u2", "<command-name>/exit</command-name>"));
    const key = conversationKeyOf(sessionId, null);
    await getSessionStorage(key, sessionId, null).mirror.flush();
    releaseSessionStorage(key);
    harness.sessionApi.set([]);
    await harness.dispatch("classic.SessionStart", {
      session_id: sessionId,
      transcript_path: `/t/${sessionId}.jsonl`,
      source: "resume",
    });
    await new Promise((r) => setTimeout(r, 30));
    return key;
  }

  test("the tip comes from the PERSISTED mirror when the writer assembly is fresh", async () => {
    const key = await releasedStartIntoResume("sess-rxp1");
    const text = await logText();
    expect(text).toContain(`start boundary: resume exemption seeded conv=${key} source=resume tip=`);
    expect(checkpointService().resumeBoundaryOf(key)).not.toBeNull();
  });

  test("the knowledge-less process-start check does NOT consume the one-shot", async () => {
    const key = await releasedStartIntoResume("sess-rxp2");
    // the start checkpoint runs BEFORE the sweep: it knows no rows of ours,
    // so its (vacuous) clean must leave the boundary armed for the first
    // check that does know them
    expect(checkpointService().resumeBoundaryOf(key)).not.toBeNull();
  });

  test("the first turn after a released resume stays clean (no re-anchor over the exit row)", async () => {
    const _key = await releasedStartIntoResume("sess-rxp3");
    // the restarted session: the rebuilt view carries the pre-exit rows,
    // never the ceremony — x1 is exempt at-or-below the seeded tip
    harness.sessionApi.set([apiMsg("hello"), apiMsg("world")]);
    await harness.dispatch("session.append", promptRow("u2b", "x1", "again"));
    // NOTE: the view's tip rows chain through x1 (mirrored), so a live
    // junction here exercises the exempted tail rather than a real rewind
    harness.sessionApi.set([apiMsg("hello"), apiMsg("world"), apiMsg("again")]);
    await harness.dispatch("turn.complete", { answer: "done", isAborted: false });
    await new Promise((r) => setTimeout(r, 30));
    const text = await logText();
    const mine = text
      .split("\n")
      .filter((l) => l.includes("sess-rxp3"))
      .join("\n");
    expect(mine).toContain("start boundary: resume exemption seeded");
    expect(mine).not.toContain("re-anchored");
    expect(mine).not.toContain("records quarantined");
  });

  /** The fork shape: the engine COPIES the transcript under a new session id
   *  and (branch store copy) the origin's owl store travels with it — but the
   *  transcript copy never gains the capture-ahead residue. Same
   *  released-assembly mechanics as above; only the start source differs. */
  async function releasedStartIntoFork(sessionId: string): Promise<string> {
    await harness.dispatch("classic.SessionStart", {
      session_id: sessionId,
      transcript_path: `/t/${sessionId}.jsonl`,
    });
    await harness.dispatch("session.append", promptRow("u1", null, "hello"));
    await harness.dispatch("session.append", promptRow("u2", "u1", "world"));
    // mirrror-only residue the copied transcript will never carry
    await harness.dispatch("session.append", promptRow("x1", "u2", "<command-name>/exit</command-name>"));
    const key = conversationKeyOf(sessionId, null);
    await getSessionStorage(key, sessionId, null).mirror.flush();
    releaseSessionStorage(key);
    harness.sessionApi.set([]);
    await harness.dispatch("classic.SessionStart", {
      session_id: sessionId,
      transcript_path: `/t/${sessionId}.jsonl`,
      source: "fork",
    });
    await new Promise((r) => setTimeout(r, 30));
    return key;
  }

  test("a fork start whose carried store knows our rows seeds the exemption (source=fork)", async () => {
    const key = await releasedStartIntoFork("sess-rxf1");
    const text = await logText();
    expect(text).toContain(`start boundary: resume exemption seeded conv=${key} source=fork tip=`);
    expect(checkpointService().resumeBoundaryOf(key)).not.toBeNull();
  });

  test("the first turn after a fork stays clean (no re-anchor over the copied residue)", async () => {
    const _key = await releasedStartIntoFork("sess-rxf2");
    // the forked session serves the copied view (pre-exit rows only) and
    // continues — x1's residue must be tolerated once, then detection is live
    harness.sessionApi.set([apiMsg("hello"), apiMsg("world")]);
    await harness.dispatch("session.append", promptRow("u2b", "x1", "again"));
    harness.sessionApi.set([apiMsg("hello"), apiMsg("world"), apiMsg("again")]);
    await harness.dispatch("turn.complete", { answer: "done", isAborted: false });
    await new Promise((r) => setTimeout(r, 30));
    const text = await logText();
    const mine = text
      .split("\n")
      .filter((l) => l.includes("sess-rxf2"))
      .join("\n");
    expect(mine).toContain("start boundary: resume exemption seeded");
    expect(mine).not.toContain("re-anchored");
    expect(mine).not.toContain("records quarantined");
  });
});
