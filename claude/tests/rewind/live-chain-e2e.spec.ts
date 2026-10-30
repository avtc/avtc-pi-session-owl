// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// The end-to-end live-chain session: one conversation driven through the
// full harness — append events, a fake transcript file on disk, turn
// boundaries — across every scenario the verifier owes: clean turns
// (parents from file order, no verdict), a mid-session rewind, a
// pass-through native compaction (the boundary resets the chain), a torn
// giant tail (the deferred tick backs off, the repaired turn is clean),
// and the zero-latency contract (append events never read the tail — no
// helper process runs before a turn boundary).

import { beforeEach, describe, expect, test } from "vitest";
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
    sessionId: "sess-e2e",
    timestamp: "2026-10-30T00:00:00.000Z",
    type: "user",
    message: { role: "user", content: text },
  });
}

function boundaryFileRow(uuid: string): string {
  return JSON.stringify({
    uuid,
    parentUuid: null,
    sessionId: "sess-e2e",
    timestamp: "2026-10-30T00:00:01.000Z",
    type: "system",
    subtype: "compact_boundary",
    message: { role: "system", content: "compact_boundary" },
  });
}

function summaryFileRow(uuid: string, parentUuid: string): string {
  return JSON.stringify({
    uuid,
    parentUuid,
    sessionId: "sess-e2e",
    timestamp: "2026-10-30T00:00:02.000Z",
    type: "assistant",
    message: { role: "assistant", content: "summary" },
  });
}

const jsonl = (...rows: string[]) => `${rows.join("\n")}\n`;

const FILE = "/t/e2e.jsonl";

async function logText(): Promise<string> {
  const parts: string[] = [];
  for (const p of harness.fsPaths().filter((x) => x.startsWith("/cfg/logs/"))) {
    parts.push((await harness.fsRead(p)) ?? "");
  }
  return parts.join("\n");
}

async function turn(): Promise<void> {
  await harness.dispatch("turn.complete", { answer: "done", isAborted: false });
}

async function ledgerRowCount(): Promise<number> {
  const files = harness.fsPaths().filter((p) => p.includes("sessions/sess-e2e/") && /ledger-/.test(p));
  let count = 0;
  for (const p of files) {
    const text = (await harness.fsRead(p)) ?? "";
    count += text.split("\n").filter((line) => line.trim() !== "").length;
  }
  return count;
}

describe("the live chain end-to-end — one session, every scenario", () => {
  test("clean turns verify without verdicts; the rewind, compaction reset, torn tail and zero-latency contract all hold", async () => {
    await harness.dispatch("classic.SessionStart", { session_id: "sess-e2e", transcript_path: FILE });

    // -- turn 1: two rows; the appends queue WITHOUT any tail read (the
    // zero-latency contract: no helper process, no live-chain log yet)
    await harness.dispatch("session.append", promptRow("u1", "hello"));
    await harness.dispatch("session.append", promptRow("u2", "world"));
    expect(harness.processRuns).toEqual([]);
    expect(await logText()).not.toMatch(/live chain:/);
    await harness.fsWrite(FILE, jsonl(fileRow("u1", null, "hello"), fileRow("u2", "u1", "world")));
    await turn();
    let text = await logText();
    expect(text).not.toMatch(/live chain: rewind detected[^\n]*conv sess-e2e/);
    const rowsAfterTurn1 = await ledgerRowCount();
    expect(rowsAfterTurn1).toBeGreaterThan(0);

    // -- turn 2: a third row extends the chain cleanly
    await harness.dispatch("session.append", promptRow("u3", "third"));
    await harness.fsWrite(
      FILE,
      jsonl(fileRow("u1", null, "hello"), fileRow("u2", "u1", "world"), fileRow("u3", "u2", "third")),
    );
    await turn();
    text = await logText();
    expect(text).not.toMatch(/live chain: rewind detected[^\n]*conv sess-e2e/);

    // -- a mid-session rewind: u3 dies, u4 chains from the settle point u2
    await harness.dispatch("session.append", promptRow("u4", "the edited branch"));
    await harness.fsWrite(
      FILE,
      jsonl(fileRow("u1", null, "hello"), fileRow("u2", "u1", "world"), fileRow("u4", "u2", "the edited branch")),
    );
    await turn();
    text = await logText();
    const fires = text.match(/live chain: rewind detected[^\n]*conv sess-e2e/g) ?? [];
    expect(fires).toHaveLength(1);
    expect(text).toMatch(/anchors at u2[^\n]*conv sess-e2e/);

    // -- a pass-through native compaction: the session fits the keep
    // window (the claim stands — the boundary row is owl-known), the
    // boundary resets the chain; the post-compact row verifies clean
    await harness.dispatch("session.compact", {
      trigger: "manual",
      messages: [
        { role: "user", text: "hi", toolUses: [] },
        { role: "user", text: "there", toolUses: [] },
      ],
    });
    await harness.dispatch("session.append", compactionRow("b"));
    await harness.dispatch("session.append", promptRow("u5", "after compact"));
    await harness.fsWrite(
      FILE,
      jsonl(
        fileRow("u1", null, "hello"),
        fileRow("u2", "u1", "world"),
        fileRow("u4", "u2", "the edited branch"),
        boundaryFileRow("b"),
        summaryFileRow("s", "b"),
        fileRow("u5", "s", "after compact"),
      ),
    );
    await turn();
    text = await logText();
    expect(text.match(/live chain: rewind detected[^\n]*conv sess-e2e/g) ?? []).toHaveLength(1);

    // -- a torn giant tail: the last row is mid-write (no trailing
    // newline); the DEFERRED tick reads it, backs off with no verdict, and
    // the queue survives; the repaired row verifies clean on its own turn
    const giant = "g".repeat(4096);
    await harness.dispatch("session.append", promptRow("u6", giant));
    const tornFile = `${jsonl(
      fileRow("u1", null, "hello"),
      fileRow("u2", "u1", "world"),
      fileRow("u4", "u2", "the edited branch"),
      boundaryFileRow("b"),
      summaryFileRow("s", "b"),
      fileRow("u5", "s", "after compact"),
    )}${fileRow("u6", "u5", giant).slice(0, -3)}`;
    await harness.fsWrite(FILE, tornFile);
    // let the deferred tick fire on the torn tail (the wait adapts to the
    // last event; 1.2 s covers it)
    await new Promise((r) => setTimeout(r, 1200));
    text = await logText();
    expect(text.match(/live chain: rewind detected/g) ?? []).toHaveLength(1); // no verdict on a torn read
    await harness.fsWrite(
      FILE,
      jsonl(
        fileRow("u1", null, "hello"),
        fileRow("u2", "u1", "world"),
        fileRow("u4", "u2", "the edited branch"),
        boundaryFileRow("b"),
        summaryFileRow("s", "b"),
        fileRow("u5", "s", "after compact"),
        fileRow("u6", "u5", giant),
      ),
    );
    await turn();
    text = await logText();
    expect(text.match(/live chain: rewind detected[^\n]*conv sess-e2e/g) ?? []).toHaveLength(1);

    // -- a real rewind after everything still fires exactly once more
    // (u5, u6 die; u7 chains from u4)
    await harness.dispatch("session.append", promptRow("u7", "rewound to u4"));
    await harness.fsWrite(
      FILE,
      jsonl(
        fileRow("u1", null, "hello"),
        fileRow("u2", "u1", "world"),
        fileRow("u4", "u2", "the edited branch"),
        fileRow("u7", "u4", "rewound to u4"),
      ),
    );
    await turn();
    text = await logText();
    expect(text.match(/live chain: rewind detected[^\n]*conv sess-e2e/g) ?? []).toHaveLength(2);
    expect(text).toMatch(/anchors at u4[^\n]*conv sess-e2e/);

    // the turn rows kept flushing throughout (no blocked checks)
    expect(await ledgerRowCount()).toBeGreaterThan(rowsAfterTurn1);
    // no helper process ever ran (the capsule tier carried every read)
    expect(harness.processRuns).toEqual([]);
  }, 20000);
});
