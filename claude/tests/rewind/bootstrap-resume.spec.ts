// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// Bootstrap/resume rewinds: changes made to the transcript BETWEEN owl
// processes (the owner edits the file after exiting Claude Code — a rewind
// in another process, or the manual removal of a compaction's boundary +
// summary rows). The startup sweep re-derives what it can; the live chain
// picks the rest up at the resumed session's first turn: a between-process
// amputation is DETECTED there, a removed boundary must NOT false-fire
// (the chain simply extends past where the boundary stood), and a real
// rewind after the resume still fires.

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { log } from "../../core/src/log.js";
import { createHarness } from "../helpers/harness.js";

const harness = createHarness();

beforeEach(async () => {
  await harness.load();
  harness.env.set("CLAUDE_CONFIG_DIR", "/cfg");
});

function promptRow(uuid: string, text: string): Record<string, unknown> {
  return {
    uuid,
    door: "prompt",
    origin: { kind: "composer" },
    message: { type: "user", content: [{ type: "text", text }] },
  };
}

/** The engine's compaction-ceremony row (door "compaction", a system row —
 *  never captured, always queued into the live chain). */
function compactionRow(uuid: string): Record<string, unknown> {
  return {
    uuid,
    door: "compaction",
    message: { type: "system", subtype: "compact_boundary", content: "compact" },
  };
}

function fileRow(uuid: string, parentUuid: string | null, text: string): string {
  return JSON.stringify({
    uuid,
    parentUuid,
    sessionId: "sess-file",
    timestamp: "2026-10-30T00:00:00.000Z",
    type: "user",
    message: { role: "user", content: text },
  });
}

/** A system/compact_boundary file row — the chain's fresh root. */
function boundaryFileRow(uuid: string): string {
  return JSON.stringify({
    uuid,
    parentUuid: null,
    sessionId: "sess-file",
    timestamp: "2026-10-30T00:00:01.000Z",
    type: "system",
    subtype: "compact_boundary",
    message: { role: "system", content: "compact_boundary" },
  });
}

/** The native compaction's summary row (an assistant row parented at the
 *  boundary — ceremony from the live chain's perspective). */
function summaryFileRow(uuid: string, parentUuid: string): string {
  return JSON.stringify({
    uuid,
    parentUuid,
    sessionId: "sess-file",
    timestamp: "2026-10-30T00:00:02.000Z",
    type: "assistant",
    message: { role: "assistant", content: "summary" },
  });
}

const jsonl = (...rows: string[]) => `${rows.join("\n")}\n`;

let logged: string[] = [];
beforeEach(() => {
  // The production log line is this suite’s seam for live-chain verdicts:
  // captured synchronously at the logger — the writer batches file writes
  // into a window, so the specs must not race the flush.
  logged = [];
  vi.spyOn(log, "info").mockImplementation((message: string) => {
    logged.push(message);
  });
});
afterEach(() => {
  vi.restoreAllMocks();
});

async function logText(): Promise<string> {
  return logged.join("\n");
}

async function turn(): Promise<void> {
  await harness.dispatch("turn.complete", { answer: "done", isAborted: false });
}

describe("bootstrap/resume rewinds — between-process transcript surgery", () => {
  test("an amputation made while away is detected at the resumed session's first turn", async () => {
    await harness.dispatch("classic.SessionStart", {
      session_id: "sess-b1",
      transcript_path: "/t/b1.jsonl",
    });
    await harness.dispatch("session.append", promptRow("u1", "hello"));
    await harness.dispatch("session.append", promptRow("u2", "world"));
    await harness.fsWrite("/t/b1.jsonl", jsonl(fileRow("u1", null, "hello"), fileRow("u2", "u1", "world")));
    await turn();
    await harness.dispatch("session.append", promptRow("u3", "third"));
    await harness.fsWrite(
      "/t/b1.jsonl",
      jsonl(fileRow("u1", null, "hello"), fileRow("u2", "u1", "world"), fileRow("u3", "u2", "third")),
    );
    await turn();

    // the owner exits, rewinds in another process (u3 gone, u4 chains from
    // u2), then resumes THIS session
    await harness.fsWrite("/t/b1.jsonl", jsonl(fileRow("u1", null, "hello"), fileRow("u2", "u1", "world")));
    await harness.dispatch("classic.SessionStart", {
      session_id: "sess-b1",
      transcript_path: "/t/b1.jsonl",
      source: "resume",
    });
    await harness.dispatch("session.append", promptRow("u4", "the edited branch"));
    await harness.fsWrite(
      "/t/b1.jsonl",
      jsonl(fileRow("u1", null, "hello"), fileRow("u2", "u1", "world"), fileRow("u4", "u2", "the edited branch")),
    );
    await turn();

    // the sweep re-mirrored nothing (all rows known); the live chain's
    // first tick names the divergence: u4 anchors at u2, owl's tail is u3
    const text = await logText();
    expect(text).toMatch(/live chain: rewind detected[^\n]*conv sess-b1/);
    expect(text).toMatch(/anchors at u2[^\n]*conv sess-b1/);
  });

  test("manual boundary removal: the resumed chain extends past the removed boundary without firing; a later real rewind still fires", async () => {
    await harness.dispatch("classic.SessionStart", {
      session_id: "sess-b2",
      transcript_path: "/t/b2.jsonl",
    });
    await harness.dispatch("session.append", promptRow("u1", "hello"));
    await harness.dispatch("session.append", promptRow("u2", "world"));
    await harness.fsWrite("/t/b2.jsonl", jsonl(fileRow("u1", null, "hello"), fileRow("u2", "u1", "world")));
    await turn();

    // a native compaction: the session fits the keep window, so the gate
    // passes through (the claim stands — the compaction row is owl-known,
    // no foreign-row pause) — the engine files the boundary + summary rows
    // and re-parents the post-compact rows at the summary
    await harness.dispatch("session.compact", {
      trigger: "manual",
      messages: [
        { role: "user", text: "hi", toolUses: [] },
        { role: "user", text: "there", toolUses: [] },
      ],
    });
    await harness.dispatch("session.append", compactionRow("b"));
    await harness.dispatch("session.append", promptRow("u3", "after compact"));
    await harness.fsWrite(
      "/t/b2.jsonl",
      jsonl(
        fileRow("u1", null, "hello"),
        fileRow("u2", "u1", "world"),
        boundaryFileRow("b"),
        summaryFileRow("s", "b"),
        fileRow("u3", "s", "after compact"),
      ),
    );
    await turn();
    // the boundary reset the chain mid-session — no rewind may fire for it
    let text = await logText();
    expect(text).not.toMatch(/live chain: rewind detected[^\n]*conv sess-b2/);

    // the owner exits and removes the compaction's boundary + summary rows
    await harness.fsWrite(
      "/t/b2.jsonl",
      jsonl(fileRow("u1", null, "hello"), fileRow("u2", "u1", "world"), fileRow("u3", "s", "after compact")),
    );
    await harness.dispatch("classic.SessionStart", {
      session_id: "sess-b2",
      transcript_path: "/t/b2.jsonl",
      source: "resume",
    });
    // the resumed turn continues the chain past where the boundary stood —
    // u4's nearest observable predecessor is u3, exactly owl's tail
    await harness.dispatch("session.append", promptRow("u4", "resumed"));
    await harness.fsWrite(
      "/t/b2.jsonl",
      jsonl(
        fileRow("u1", null, "hello"),
        fileRow("u2", "u1", "world"),
        fileRow("u3", "s", "after compact"),
        fileRow("u4", "u3", "resumed"),
      ),
    );
    await turn();
    text = await logText();
    expect(text).not.toMatch(/live chain: rewind detected[^\n]*conv sess-b2/);

    // a REAL rewind after the resume still fires (u3, u4 amputated; u5
    // chains from u2)
    await harness.dispatch("session.append", promptRow("u5", "rewound"));
    await harness.fsWrite(
      "/t/b2.jsonl",
      jsonl(fileRow("u1", null, "hello"), fileRow("u2", "u1", "world"), fileRow("u5", "u2", "rewound")),
    );
    await turn();
    text = await logText();
    expect(text).toMatch(/live chain: rewind detected[^\n]*conv sess-b2/);
    expect(text).toMatch(/anchors at u2[^\n]*conv sess-b2/);
  });
});
