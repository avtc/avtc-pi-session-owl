// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>
//
// The paused-turn completion pin: completion routing is engine mechanics —
// an in-flight stage run whose pause flipped mid-run (Channel B/C) must
// still complete at turn.complete, or the awaiting orchestration hangs
// holding the run-lock.
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { getCapture } from "../host/capture/append-handler.js";
import { _resetConflictStateForTest, setConflictHits } from "../host/conflicts/pause.js";
import { awaitAgentCompletion } from "../host/engine-bridge.js";
import { conversationKey } from "../host/state.js";
import { getSessionStorage } from "../host/storage/session-storage.js";
import { createHarness } from "./helpers/harness.js";

describe("turn.complete while conflict-paused still routes agent completions", () => {
  let h: ReturnType<typeof createHarness>;
  beforeEach(async () => {
    _resetConflictStateForTest();
    h = createHarness();
    await h.load();
    h.env.set("CLAUDE_CONFIG_DIR", "/cfg");
    await h.dispatch("classic.SessionStart", {
      session_id: "s-pause-1",
      cwd: "/w",
      source: "startup",
      transcript_path: "/t/s-pause-1.jsonl",
    });
  });
  // the file must not END armed — a leaked hit gates every pause-checked
  // branch in the NEXT file (the shared-registry suite boundary)
  afterEach(() => {
    _resetConflictStateForTest();
  });

  test("a paused session's agentId turn.complete resolves the parked await", async () => {
    setConflictHits([{ channel: "B", name: "other-mod@x", evidence: "compaction-hook" }]);
    const parked = awaitAgentCompletion("ag-paused-1");
    let resolved: unknown;
    void parked.then((e) => {
      resolved = e;
    });
    await h.dispatch("turn.complete", { agentId: "ag-paused-1", answer: "done", isAborted: false });
    await new Promise((r) => setTimeout(r, 0));
    expect(resolved).toMatchObject({ agentId: "ag-paused-1", answer: "done" });
  });

  test("session.end flushes still-buffered ledgers BEFORE releasing the assemblies", async () => {
    const sessionId = "s-pause-1";
    const key = conversationKey(sessionId, null);
    const st = await getSessionStorage(key, sessionId, null);
    st.ledger.append("CHECK", {}, "marker-1"); // a record still buffered at teardown
    st.mirror.bufferRow({ uuid: "mr-1", parentUuid: null, row: { tail: true } }); // a row still buffered at teardown
    await h.dispatch("session.end", {});
    await new Promise((r) => setTimeout(r, 20));
    // the record became a ledger part file (durable), not dropped
    const parts = h.fsPaths().filter((p: string) => /sessions\/s-pause-1\/ledger-.*\.jsonl$/.test(p));
    expect(parts.length).toBeGreaterThanOrEqual(1);
    const text = (await h.fsRead(parts[0] as string)) as unknown as string;
    expect(text).toContain('"kind":"CHECK"');
    // the row became a mirror batch file too — its turn never flushed, so
    // the transcript never carries it; teardown MUST write it
    const batches = h.fsPaths().filter((p: string) => /sessions\/s-pause-1\/m\d+-.*\.jsonl$/.test(p));
    expect(batches.length).toBeGreaterThanOrEqual(1);
    const mtext = (await h.fsRead(batches[0] as string)) as unknown as string;
    expect(mtext).toContain('"uuid":"mr-1"');
  });

  test("a paused terminal loop still releases its capture/storage/checkpoint state", async () => {
    setConflictHits([{ channel: "B", name: "other-mod@x", evidence: "compaction-hook" }]);
    const sessionId = "s-pause-1";
    const agentId = "ag-paused-2";
    const key = conversationKey(sessionId, agentId);
    // materialize the loop's in-memory state (the storage assembly identity
    // proves release: a re-get after release returns a FRESH object)
    const before = getSessionStorage(key, sessionId, agentId);
    before.mirror.bufferRow({ uuid: "mr-paused", parentUuid: null, row: { tail: true } }); // buffered at the paused completion
    before.ledger.append("CHECK", {}, "marker-paused");
    await h.dispatch("turn.complete", { agentId, answer: "done", isAborted: false });
    await new Promise((r) => setTimeout(r, 0));
    expect(getCapture(key)).toBeUndefined(); // capture released
    const after = getSessionStorage(key, sessionId, agentId);
    expect(after).not.toBe(before); // storage assembly was released and re-created
    // the release FLUSHED what was still buffered — rows and records are
    // durable on disk, not dropped with the assembly
    const dirPrefix = `sessions/${sessionId}-${agentId}/`;
    const mb = h.fsPaths().filter((p: string) => p.includes(dirPrefix) && /\/m\d+-.*\.jsonl$/.test(p));
    expect(mb.length).toBeGreaterThanOrEqual(1);
    const mtext = (await h.fsRead(mb[0] as string)) as unknown as string;
    expect(mtext).toContain('"uuid":"mr-paused"');
    const lb = h.fsPaths().filter((p: string) => p.includes(dirPrefix) && /\/ledger-.*\.jsonl$/.test(p));
    expect(lb.length).toBeGreaterThanOrEqual(1);
  });
});
