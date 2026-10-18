// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// The load-path row order: file enumeration is producer-hash order, not
// conversation order (same-seq batches from different processes tie and the
// directory listing decides). The backfill must re-sequence the adopted rows
// by the fold's own total order — (timestamp, producer, seq) — so every
// order consumer (capture head selection, branch fallbacks, slices, tips)
// sees conversation order regardless of file names.
import { beforeEach, describe, expect, test } from "vitest";
import { clearDetailsCache } from "../../core/src/format/details.js";
import { getGraphStore, resetForNewSession } from "../../core/src/store/graph-store.js";
import { O_INITIAL_PROMPT } from "../../core/src/types.js";
import { _resetCoreInstances } from "../../host/core-instances.js";
import { runBackfill } from "../../host/start/backfill.js";
import { corePendingEvaluator } from "../../host/start/pending.js";
import { parseTranscriptRows, rowFromTranscript } from "../../host/start/transcript-reader.js";
import { createMemoryFs } from "../../host/storage/fs-adapter.js";
import { type LedgerWriter as Ledger, LedgerWriter } from "../../host/storage/ledger.js";
import { type MirrorWriter as Mirror, MirrorWriter, producer8 } from "../../host/storage/mirror.js";

const mem = createMemoryFs();

beforeEach(async () => {
  mem.files.clear();
  _resetCoreInstances();
  resetForNewSession();
  clearDetailsCache();
});

// The conversation: a head turn (true initial prompt) + a resume turn
// arriving 4 hours later — the exact shape where a hash-first file listing
// inverts the conversation if the sweep order is trusted.
const HEAD_PROMPT = "I want to test the true head prompt";
const RESUME_PROMPT = "Where have we stopped?";
const TRANSCRIPT = [
  JSON.stringify({
    type: "user",
    uuid: "h1",
    parentUuid: null,
    timestamp: "2026-10-10T17:26:55.932Z",
    message: { role: "user", type: "user", content: HEAD_PROMPT },
  }),
  JSON.stringify({
    type: "assistant",
    uuid: "h2",
    parentUuid: "h1",
    timestamp: "2026-10-10T17:27:10.000Z",
    message: { role: "assistant", type: "assistant", content: [{ type: "text", text: "head ack" }] },
  }),
  JSON.stringify({
    type: "user",
    uuid: "r1",
    parentUuid: "h2",
    timestamp: "2026-10-10T21:06:05.472Z",
    message: { role: "user", type: "user", content: RESUME_PROMPT },
  }),
  JSON.stringify({
    type: "assistant",
    uuid: "r2",
    parentUuid: "r1",
    timestamp: "2026-10-10T21:06:20.000Z",
    message: { role: "assistant", type: "assistant", content: [{ type: "text", text: "resume ack" }] },
  }),
].join("\n");

interface Split {
  mirror: Mirror;
  ledger: Ledger;
}

function storageFor(sessionId: string, producer: string): Split {
  const dir = `/cfg/session-owl/sessions/${sessionId}`;
  return {
    mirror: new MirrorWriter(mem.adapter, dir, producer),
    ledger: new LedgerWriter(mem.adapter, dir, producer),
  };
}

async function seedTwoProducers(sessionId: string, transcript: string): Promise<void> {
  const parsed = parseTranscriptRows(transcript);
  const rows = parsed.rows.map((tr) => ({ uuid: tr.uuid, parentUuid: tr.parentUuid, row: rowFromTranscript(tr) }));
  // two producers, both on batch #1: whichever tag sorts FIRST gets the
  // RESUME rows (its file enumerates first — the inversion shape), the
  // other gets the head rows
  const tagA = producer8("producer-alpha");
  const tagB = producer8("producer-beta");
  const resumeFirst = tagA < tagB;
  const headProducer = resumeFirst ? "producer-beta" : "producer-alpha";
  const resumeProducer = resumeFirst ? "producer-alpha" : "producer-beta";
  const head = storageFor(sessionId, headProducer);
  const resume = storageFor(sessionId, resumeProducer);
  for (const r of rows.slice(0, 2)) head.mirror.bufferRow(r);
  for (const r of rows.slice(2)) resume.mirror.bufferRow(r);
  await head.mirror.flush();
  await resume.mirror.flush();
}

async function backfill(sessionId: string, transcriptPath: string): Promise<Mirror> {
  const { mirror, ledger } = storageFor(sessionId, `run-${sessionId}`);
  await runBackfill(mirror, ledger, {
    key: sessionId,
    sessionId,
    agentId: null,
    fs: mem.adapter,
    transcriptPath,
    enabled: true,
    fireGoalExtract: () => {},
    computePending: corePendingEvaluator,
  });
  return mirror;
}

describe("backfill — the load-path row order", () => {
  test("two same-seq producers: conversation order wins over file order; capture takes the true head", async () => {
    const sessionId = "order-two-producers";
    await mem.adapter.writeText(`/t/${sessionId}.jsonl`, `${TRANSCRIPT}\n`);
    await seedTwoProducers(sessionId, TRANSCRIPT);

    // guard the bug shape itself: the resume batch file really sorts first
    const names = [...mem.files.keys()].filter((n) => n.includes(`/sessions/${sessionId}/m1-`)).sort();
    expect(names).toHaveLength(2);
    const resumeFileHasResumeRow = await mem.adapter.readText(names[0] ?? "");
    expect(resumeFileHasResumeRow).toContain(RESUME_PROMPT);

    const mirror = await backfill(sessionId, `/t/${sessionId}.jsonl`);

    // arrival order = conversation order, not file order
    expect(mirror.arrivalOrder()).toEqual(["h1", "h2", "r1", "r2"]);
    // the capture picked the TRUE initial prompt (the head user row)
    const oip = getGraphStore().graph.observations.get(O_INITIAL_PROMPT);
    expect(oip?.summary).toBe(HEAD_PROMPT);
    expect(oip?.sourceEntryIds).toEqual(["h1"]);
  });

  test("identical timestamps tie-break by producer tag, deterministically", async () => {
    const sessionId = "order-tie";
    const transcript = [
      JSON.stringify({
        type: "user",
        uuid: "t-alpha",
        parentUuid: null,
        timestamp: "2026-10-10T18:00:00.000Z",
        message: { role: "user", type: "user", content: "alpha same-ms" },
      }),
      JSON.stringify({
        type: "user",
        uuid: "t-beta",
        parentUuid: null,
        timestamp: "2026-10-10T18:00:00.000Z",
        message: { role: "user", type: "user", content: "beta same-ms" },
      }),
    ].join("\n");
    await mem.adapter.writeText(`/t/${sessionId}.jsonl`, `${transcript}\n`);
    const parsed = parseTranscriptRows(transcript);
    const [alpha, beta] = parsed.rows.map((tr) => ({ uuid: tr.uuid, parentUuid: null, row: rowFromTranscript(tr) }));
    // alpha rows live under the lexicographically-first tag by construction
    const alphaProducer = producer8("producer-alpha") < producer8("producer-beta") ? "producer-alpha" : "producer-beta";
    const betaProducer = alphaProducer === "producer-alpha" ? "producer-beta" : "producer-alpha";
    const a = storageFor(sessionId, alphaProducer);
    const b = storageFor(sessionId, betaProducer);
    a.mirror.bufferRow(alpha ?? { uuid: "x", parentUuid: null, row: {} });
    b.mirror.bufferRow(beta ?? { uuid: "y", parentUuid: null, row: {} });
    await a.mirror.flush();
    await b.mirror.flush();

    const mirror = await backfill(sessionId, `/t/${sessionId}.jsonl`);
    // the lexicographically-first tag's row leads — deterministic regardless
    // of which ids hashed where
    expect(mirror.arrivalOrder()).toEqual(["t-alpha", "t-beta"]);
    // the row buffered under the first-sorting tag really is t-alpha
    expect(producer8(alphaProducer) < producer8(betaProducer)).toBe(true);
  });

  test("a row without a timestamp sorts last, never before timestamped content", async () => {
    const sessionId = "order-no-ts";
    const transcript = [
      JSON.stringify({
        type: "user",
        uuid: "n1",
        parentUuid: null,
        timestamp: "2026-10-10T19:00:00.000Z",
        message: { role: "user", type: "user", content: "timestamped" },
      }),
    ].join("\n");
    await mem.adapter.writeText(`/t/${sessionId}.jsonl`, `${transcript}\n`);
    const seed = storageFor(sessionId, "producer-no-ts");
    const stamped = parseTranscriptRows(transcript).rows[0];
    if (stamped === undefined) throw new Error("fixture row missing");
    seed.mirror.bufferRow({ uuid: "n1", parentUuid: null, row: rowFromTranscript(stamped) });
    seed.mirror.bufferRow({
      uuid: "n0",
      parentUuid: null,
      row: { type: "user", message: { role: "user", content: "no timestamp" } },
    });
    await seed.mirror.flush();

    const mirror = await backfill(sessionId, `/t/${sessionId}.jsonl`);
    const order = mirror.arrivalOrder();
    expect(order[order.length - 1]).toBe("n0");
    expect(order[0]).toBe("n1");
  });

  test("crash-window re-mirrored old rows land chronologically (before newer mirrored rows)", async () => {
    const sessionId = "order-remirror";
    // the mirror holds ONLY the late rows; the transcript knows the whole
    // conversation — the re-mirror writes the absent head rows mid-run and
    // they must still land before the late rows
    await mem.adapter.writeText(`/t/${sessionId}.jsonl`, `${TRANSCRIPT}\n`);
    const parsed = parseTranscriptRows(TRANSCRIPT);
    const seed = storageFor(sessionId, "producer-late-only");
    for (const tr of parsed.rows.slice(2)) {
      seed.mirror.bufferRow({ uuid: tr.uuid, parentUuid: tr.parentUuid, row: rowFromTranscript(tr) });
    }
    await seed.mirror.flush();

    const mirror = await backfill(sessionId, `/t/${sessionId}.jsonl`);
    expect(mirror.arrivalOrder()).toEqual(["h1", "h2", "r1", "r2"]);
    const oip = getGraphStore().graph.observations.get(O_INITIAL_PROMPT);
    expect(oip?.summary).toBe(HEAD_PROMPT);
  });
});
