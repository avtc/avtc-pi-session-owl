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
import { conversationKey as conversationKeyOf } from "../../host/state.js";
import { getSessionStorage } from "../../host/storage/session-storage.js";
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
    await harness.fsWrite("/t/rx2.jsonl", jsonl(fileRow("u1", null, "hello"), fileRow("u2", "u1", "world")));
    await harness.dispatch("turn.complete", { answer: "done", isAborted: false });

    // resume + the first clean (the rebuilt view is the file's own shape —
    // the live chain cannot false-fire on a re-render)
    await harness.dispatch("classic.SessionStart", {
      session_id: "sess-rx2",
      transcript_path: "/t/rx2.jsonl",
      source: "resume",
    });
    await harness.dispatch("session.append", promptRow("u3", "u2", "third"));
    await harness.fsWrite(
      "/t/rx2.jsonl",
      jsonl(fileRow("u1", null, "hello"), fileRow("u2", "u1", "world"), fileRow("u3", "u2", "third")),
    );
    await harness.dispatch("turn.complete", { answer: "done", isAborted: false });

    // a REAL rewind now: u3 dies (amputated), u4 chains from u2
    await harness.dispatch("session.append", promptRow("u4", "u2", "rewound branch"));
    await harness.fsWrite(
      "/t/rx2.jsonl",
      jsonl(fileRow("u1", null, "hello"), fileRow("u2", "u1", "world"), fileRow("u4", "u2", "rewound branch")),
    );
    await harness.dispatch("turn.complete", { answer: "done", isAborted: false });

    await new Promise((r) => setTimeout(r, 30));
    const text = await logText();
    expect(text).toMatch(/live chain: rewind detected[^\n]*conv sess-rx2/);
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
