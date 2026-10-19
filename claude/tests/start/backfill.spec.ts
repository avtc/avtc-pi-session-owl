// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import { readFileSync } from "node:fs";
import { join } from "node:path";
// The backfill suite: the start sequence over a session directory — mirror
// sweep + transcript read + crash-window re-mirror (absent-check) + store
// reconstruction (fold + frontier) + pending computation (coverage union) +
// initial-prompt capture. Fork-cold adoption copies the parent's segments;
// clear is the fresh-session path.
import { beforeEach, describe, expect, test } from "vitest";
import { clearDetailsCache } from "../../core/src/format/details.js";
import { appendObservation, getGraphStore as graphOf, resetForNewSession } from "../../core/src/store/graph-store.js";
import { O_INITIAL_PROMPT } from "../../core/src/types.js";
import { _resetCoreInstances, getCore } from "../../host/core-instances.js";
import { runBackfill } from "../../host/start/backfill.js";
import { captureInitialPrompt } from "../../host/start/initial-prompt.js";
import { corePendingEvaluator } from "../../host/start/pending.js";
import { parseTranscriptRows, rowFromTranscript } from "../../host/start/transcript-reader.js";
import { createMemoryFs } from "../../host/storage/fs-adapter.js";
import { LedgerWriter } from "../../host/storage/ledger.js";
import { MirrorWriter } from "../../host/storage/mirror.js";
import { prepareStoreContext, sweepSession } from "../../host/storage/store-context.js";

const FIX = join(__dirname, "..", "fixtures", "transcripts");

function jsonl(name: string): string {
  const d = JSON.parse(readFileSync(join(FIX, `${name}.json`), "utf8")) as {
    rows: Record<string, unknown>[];
  };
  return `${d.rows
    .map((r) => {
      if (r.kind === "metadata" || r.kind === "metadata-tip") return String(r.raw);
      const { kind, ...row } = r;
      void kind;
      return JSON.stringify(row);
    })
    .join("\n")}\n`;
}

const mem = createMemoryFs();

beforeEach(async () => {
  mem.files.clear();
  _resetCoreInstances();
  resetForNewSession();
  clearDetailsCache();
});

function makeStorage(sessionId: string): { mirror: MirrorWriter; ledger: LedgerWriter; dir: string } {
  const dir = `/cfg/session-owl/sessions/${sessionId}`;
  return {
    mirror: new MirrorWriter(mem.adapter, dir, `run-${sessionId}`),
    ledger: new LedgerWriter(mem.adapter, dir, `run-${sessionId}`),
    dir,
  };
}

describe("backfill — restart on a populated dir", () => {
  test("fold + frontier + pending reconstruct (records carry the frontier)", async () => {
    // seed: full mirror + an observation record covering the first user turn
    const transcript = jsonl("main-simple");
    const dir = "/cfg/session-owl/sessions/sess-main";
    await mem.adapter.writeText("/t/sess-main.jsonl", transcript);
    {
      const parsed = parseTranscriptRows(transcript);
      const mirror = new MirrorWriter(mem.adapter, dir, "seed-a");
      const ledger = new LedgerWriter(mem.adapter, dir, "seed-a");
      for (const tr of parsed.rows) {
        mirror.bufferRow({ uuid: tr.uuid, parentUuid: tr.parentUuid, row: rowFromTranscript(tr) });
      }
      await mirror.flush();
      const prepared = await prepareStoreContext(mem.adapter, dir, ledger, mirror);
      // a record-bearing observation covering up to the tool-result row
      const { encodeObservation } = await import("../../core/src/store/codecs.js");
      const { makeObservation, O_INITIAL_PROMPT: OIP, N_GOAL } = await import("../../core/src/types.js");
      const { applyCreateNode, applyRecordObservation } = await import("../../core/src/graph/mutations.js");
      const { appendGraphDelta } = await import("../../core/src/store/graph-store.js");
      // a REAL prior session persists the full capture chain: nGoal seed +
      // record_observation delta + the observation record itself
      appendGraphDelta(
        prepared.ctx,
        applyCreateNode(graphOf().graph, {
          id: N_GOAL,
          summary: "",
          importance: "crit",
          parentNode: null,
          state: "active",
        }),
      );
      const obs = makeObservation({
        id: OIP,
        summary: "prompt",
        importance: "crit",
        sourceEntryIds: ["m-1"],
        timestamp: "2026-10-06T11:00:01.000Z",
        parentNode: N_GOAL,
      });
      appendGraphDelta(prepared.ctx, applyRecordObservation(graphOf().graph, { obs }));
      appendObservation(prepared.ctx, {
        coversFromId: "m-1",
        coversUpToId: "m-4",
        records: [encodeObservation(obs)],
        tokenCount: 1,
      });
      await ledger.flush();
    }

    const storage = makeStorage("sess-main");
    const result = await runBackfill(storage.mirror, storage.ledger, {
      key: "sess-main",
      sessionId: "sess-main",
      agentId: null,
      fs: mem.adapter,
      transcriptPath: "/t/sess-main.jsonl",
      enabled: true,
      fireGoalExtract: () => {},
      computePending: corePendingEvaluator,
    });

    expect(result.frontier).toBe("m-4");
    // pending = holes on the live path behind the frontier (none: covered
    // through m-4) — everything after m-4 is the open tail, not pending
    expect(result.pending).toEqual([]);
    expect(result.remirrored).toBe(0); // everything already mirrored
    // a second backfill ("restart") derives the SAME state
    const storage2 = makeStorage("sess-main");
    const again = await runBackfill(storage2.mirror, storage2.ledger, {
      key: "sess-main",
      sessionId: "sess-main",
      agentId: null,
      fs: mem.adapter,
      transcriptPath: "/t/sess-main.jsonl",
      enabled: true,
      fireGoalExtract: () => {},
      computePending: corePendingEvaluator,
    });
    expect(again.frontier).toBe(result.frontier);
    expect(again.pending).toEqual(result.pending);
  });

  test("crash window: rows whose turn never flushed are re-mirrored (absent-check)", async () => {
    const transcript = jsonl("main-simple");
    await mem.adapter.writeText("/t/sess-main.jsonl", transcript);
    {
      // the crash: mirror holds only m-1..m-4 (the last turn never flushed)
      const parsed = parseTranscriptRows(transcript);
      const mirror = new MirrorWriter(mem.adapter, "/cfg/session-owl/sessions/sess-main", "crash-a");
      await (async () => {
        for (const tr of parsed.rows.slice(0, 4)) {
          mirror.bufferRow({ uuid: tr.uuid, parentUuid: tr.parentUuid, row: rowFromTranscript(tr) });
        }
        await mirror.flush();
      })();
    }
    const storage = makeStorage("sess-main");
    const result = await runBackfill(storage.mirror, storage.ledger, {
      key: "sess-main",
      sessionId: "sess-main",
      agentId: null,
      fs: mem.adapter,
      transcriptPath: "/t/sess-main.jsonl",
      enabled: true,
      fireGoalExtract: () => {},
      computePending: corePendingEvaluator,
    });
    expect(result.remirrored).toBe(3); // m-5, m-6, m-7
    // the re-mirrored rows are durable: a sweep finds all 7
    const sweep = await sweepSession(mem.adapter, "/cfg/session-owl/sessions/sess-main");
    expect(sweep.rows).toHaveLength(7);
    // and a repeat backfill re-mirrors NOTHING (absent-check idempotent)
    const storage2 = makeStorage("sess-main");
    const again = await runBackfill(storage2.mirror, storage2.ledger, {
      key: "sess-main",
      sessionId: "sess-main",
      agentId: null,
      fs: mem.adapter,
      transcriptPath: "/t/sess-main.jsonl",
      enabled: true,
      fireGoalExtract: () => {},
      computePending: corePendingEvaluator,
    });
    expect(again.remirrored).toBe(0);
  });

  test("dead-tail rows are never pending (live path excludes the abandoned branch)", async () => {
    const transcript = jsonl("branched");
    await mem.adapter.writeText("/t/sess-br.jsonl", transcript);
    const storage = makeStorage("sess-br");
    const result = await runBackfill(storage.mirror, storage.ledger, {
      key: "sess-br",
      sessionId: "sess-br",
      agentId: null,
      fs: mem.adapter,
      transcriptPath: "/t/sess-br.jsonl",
      enabled: true,
      fireGoalExtract: () => {},
      computePending: corePendingEvaluator,
    });
    // no observation records — but the enabled start captures oInitialPrompt
    // (the mechanical capture advances the frontier past the first user row)
    expect(result.frontier).toBe("m-1");
    expect(result.pending).toEqual([]); // nothing between the anchor and the frontier
    // the mirror holds ONLY live-path rows (m-6 dead tail never re-mirrored)
    const sweep = await sweepSession(mem.adapter, "/cfg/session-owl/sessions/sess-br");
    const uuids = sweep.rows.map((r) => r.uuid);
    expect(uuids).toContain("m-6b");
    expect(uuids).not.toContain("m-6");
  });

  test("a fresh session (clear) is the empty path: no adoption, seeded graph", async () => {
    const storage = makeStorage("sess-new");
    const result = await runBackfill(storage.mirror, storage.ledger, {
      key: "sess-new",
      sessionId: "sess-new",
      agentId: null,
      fs: mem.adapter,
      transcriptPath: null,
      enabled: true,
      fireGoalExtract: () => {},
      computePending: corePendingEvaluator,
    });
    expect(result.frontier).toBeNull();
    expect(result.pending).toEqual([]);
    expect(result.remirrored).toBe(0);
    const handle = await getCore("sess-new");
    expect(handle.store.getGraphStore().graph.nodes.has("nGoal")).toBe(true);
  });
});

describe("backfill — fork adoption", () => {
  test("a cold fork adopts the parent's segments (records + mirror) into the child dir", async () => {
    // parent: sess-main with a full mirror + an observation covering m-4
    const transcript = jsonl("main-simple");
    await mem.adapter.writeText("/t/sess-fork.jsonl", transcript); // copied rows, original uuids
    const parentDir = "/cfg/session-owl/sessions/sess-parent";
    {
      const parsed = parseTranscriptRows(transcript);
      const mirror = new MirrorWriter(mem.adapter, parentDir, "p-seed");
      const ledger = new LedgerWriter(mem.adapter, parentDir, "p-seed");
      for (const tr of parsed.rows) {
        mirror.bufferRow({ uuid: tr.uuid, parentUuid: tr.parentUuid, row: rowFromTranscript(tr) });
      }
      await mirror.flush();
      const prepared = await prepareStoreContext(mem.adapter, parentDir, ledger, mirror);
      const { encodeObservation } = await import("../../core/src/store/codecs.js");
      const { makeObservation, O_INITIAL_PROMPT: OIP, N_GOAL } = await import("../../core/src/types.js");
      const { applyCreateNode, applyRecordObservation } = await import("../../core/src/graph/mutations.js");
      const { appendGraphDelta } = await import("../../core/src/store/graph-store.js");
      appendGraphDelta(
        prepared.ctx,
        applyCreateNode(graphOf().graph, {
          id: N_GOAL,
          summary: "",
          importance: "crit",
          parentNode: null,
          state: "active",
        }),
      );
      const obs = makeObservation({
        id: OIP,
        summary: "prompt",
        importance: "crit",
        sourceEntryIds: ["m-1"],
        timestamp: "2026-10-06T11:00:01.000Z",
        parentNode: N_GOAL,
      });
      appendGraphDelta(prepared.ctx, applyRecordObservation(graphOf().graph, { obs }));
      appendObservation(prepared.ctx, {
        coversFromId: "m-1",
        coversUpToId: "m-4",
        records: [encodeObservation(obs)],
        tokenCount: 1,
      });
      await ledger.flush();
    }

    // child: NEW session dir (empty), transcript tip still names the parent
    const storage = makeStorage("sess-fork");
    const result = await runBackfill(storage.mirror, storage.ledger, {
      key: "sess-fork",
      sessionId: "sess-fork",
      agentId: null,
      fs: mem.adapter,
      transcriptPath: "/t/sess-fork.jsonl",
      enabled: true,
      fireGoalExtract: () => {},
      computePending: corePendingEvaluator,
      forkParentSessionId: "sess-parent",
    });
    expect(result.adoptedFromParent).toBe(true);
    expect(result.frontier).toBe("m-4"); // the parent's frontier carried over
    expect(result.remirrored).toBe(0); // rows came with the adopted mirror
  });
});

describe("initial-prompt — mechanical capture over rows", () => {
  test("captures the first user entry once; fires the goal-extract hook exactly on capture", async () => {
    const fired: string[] = [];
    const storage = makeStorage("sess-ip");
    const transcript = jsonl("main-simple");
    await mem.adapter.writeText("/t/sess-ip.jsonl", transcript);
    await runBackfill(storage.mirror, storage.ledger, {
      key: "sess-ip",
      sessionId: "sess-ip",
      agentId: null,
      fs: mem.adapter,
      transcriptPath: "/t/sess-ip.jsonl",
      enabled: true,
      fireGoalExtract: (text) => {
        fired.push(text);
      },
    });
    // the run above captured the initial prompt; the hook fired once
    expect(fired).toEqual(["Read the config and report the theme"]);
    // the record is in the graph
    const handle = await getCore("sess-ip");
    const graph = handle.store.getGraphStore().graph;
    expect(graph.observations.has(O_INITIAL_PROMPT)).toBe(true);
    expect(graph.hasInitialPrompt).toBe(true);
    // idempotent: a second backfill does not re-capture or re-fire
    const fired2: string[] = [];
    const storage2 = makeStorage("sess-ip");
    await runBackfill(storage2.mirror, storage2.ledger, {
      key: "sess-ip",
      sessionId: "sess-ip",
      agentId: null,
      fs: mem.adapter,
      transcriptPath: "/t/sess-ip.jsonl",
      enabled: true,
      fireGoalExtract: (text) => {
        fired2.push(text);
      },
    });
    expect(fired2).toEqual([]);
  });

  test("captureInitialPrompt is a no-op with no user entries", async () => {
    const handle = await getCore("sess-empty");
    const prepared = await prepareStoreContext(
      mem.adapter,
      "/cfg/session-owl/sessions/sess-empty",
      new LedgerWriter(mem.adapter, "/cfg/session-owl/sessions/sess-empty", "ip-x"),
      new MirrorWriter(mem.adapter, "/cfg/session-owl/sessions/sess-empty", "ip-x"),
    );
    const fired: string[] = [];
    const out = captureInitialPrompt(handle, prepared.ctx, [], (t) => fired.push(t));
    expect(out).toBeNull();
    expect(fired).toEqual([]);
  });
});

describe("backfill — pending backlog over the merged branch view", () => {
  test("a coverage hole between two records IS pending (the real evaluator fed session entries)", async () => {
    const transcript = jsonl("main-simple");
    await mem.adapter.writeText("/t/sess-hole.jsonl", transcript);
    {
      // records cover m-1..m-2 and m-4..m-5 — m-3's entry is the hole
      const parsed = parseTranscriptRows(transcript);
      const dir = "/cfg/session-owl/sessions/sess-hole";
      const mirror = new MirrorWriter(mem.adapter, dir, "hole-a");
      const ledger = new LedgerWriter(mem.adapter, dir, "hole-a");
      for (const tr of parsed.rows) {
        mirror.bufferRow({ uuid: tr.uuid, parentUuid: tr.parentUuid, row: rowFromTranscript(tr) });
      }
      await mirror.flush();
      const prepared = await prepareStoreContext(mem.adapter, dir, ledger, mirror);
      const { encodeObservation } = await import("../../core/src/store/codecs.js");
      const { makeObservation, N_GOAL } = await import("../../core/src/types.js");
      const { applyCreateNode, applyRecordObservation } = await import("../../core/src/graph/mutations.js");
      const { appendGraphDelta } = await import("../../core/src/store/graph-store.js");
      appendGraphDelta(
        prepared.ctx,
        applyCreateNode(graphOf().graph, {
          id: N_GOAL,
          summary: "",
          importance: "crit",
          parentNode: null,
          state: "active",
        }),
      );
      const mk = (id: string, src: string[]) =>
        makeObservation({
          id: id as Parameters<typeof makeObservation>[0]["id"],
          summary: "obs",
          importance: "med",
          sourceEntryIds: src,
          timestamp: "2026-10-06T11:00:09.000Z",
          parentNode: N_GOAL,
        });
      const o1 = mk("o1", ["m-1"]);
      appendGraphDelta(prepared.ctx, applyRecordObservation(graphOf().graph, { obs: o1 }));
      appendObservation(prepared.ctx, {
        coversFromId: "m-1",
        coversUpToId: "m-2",
        records: [encodeObservation(o1)],
        tokenCount: 1,
      });
      const o2 = mk("o2", ["m-5"]);
      appendGraphDelta(prepared.ctx, applyRecordObservation(graphOf().graph, { obs: o2 }));
      appendObservation(prepared.ctx, {
        coversFromId: "m-5",
        coversUpToId: "m-5",
        records: [encodeObservation(o2)],
        tokenCount: 1,
      });
      await ledger.flush();
    }

    const storage = makeStorage("sess-hole");
    const result = await runBackfill(storage.mirror, storage.ledger, {
      key: "sess-hole",
      sessionId: "sess-hole",
      agentId: null,
      fs: mem.adapter,
      transcriptPath: "/t/sess-hole.jsonl",
      enabled: true,
      fireGoalExtract: () => {},
      computePending: corePendingEvaluator,
    });
    expect(result.frontier).toBe("m-5");
    expect(result.pending).toHaveLength(1); // the m-4 hole (the toolResult entry)
    const hole = result.pending[0];
    expect(hole?.entries.map((e) => e.id)).toEqual(["m-4"]);
  });
});

describe("backfill — fork adoption by the tip evidence rule", () => {
  test("a transcript whose tip names ANOTHER session adopts that parent's segments (no explicit option)", async () => {
    // parent dir with one mirror batch
    const parentDir = "/cfg/session-owl/sessions/sess-realparent";
    await mem.adapter.writeText(
      `${parentDir}/m1-bbbbbbbb.jsonl`,
      `${JSON.stringify({ uuid: "t-1", parentUuid: null, row: rowFromTranscript(parseTranscriptRows(jsonl("main-simple")).rows[0] as never) })}\n`,
    );
    // child transcript rows stamped with the PARENT's sessionId, tip too
    const childRows = jsonl("main-simple")
      .split("\n")
      .filter((l) => l.length > 0)
      .map((l) => {
        const row = JSON.parse(l);
        row.sessionId = "sess-realparent";
        return JSON.stringify(row);
      });
    const childTip = JSON.stringify({ type: "last-prompt", sessionId: "sess-realparent", leafUuid: "m-7" });
    await mem.adapter.writeText("/t/sess-tipchild.jsonl", `${[...childRows, childTip].join("\n")}\n`);

    const storage = makeStorage("sess-tipchild");
    const result = await runBackfill(storage.mirror, storage.ledger, {
      key: "sess-tipchild",
      sessionId: "sess-tipchild",
      agentId: null,
      fs: mem.adapter,
      transcriptPath: "/t/sess-tipchild.jsonl",
      enabled: true,
      fireGoalExtract: () => {},
      computePending: corePendingEvaluator,
    });
    expect(result.adoptedFromParent).toBe(true);
    const sweep = await sweepSession(mem.adapter, "/cfg/session-owl/sessions/sess-tipchild");
    expect(sweep.rows.map((r) => r.uuid)).toContain("t-1");
  });
});

describe("goal-extract holder — never throws", () => {
  test("a throwing launcher is contained (the capture path survives)", async () => {
    const { registerGoalExtractLauncher, launchGoalExtract, _resetGoalExtractLauncher } = await import(
      "../../host/start/goal-extract.js"
    );
    registerGoalExtractLauncher(() => {
      throw new Error("boom");
    });
    expect(() => launchGoalExtract("text", "s")).not.toThrow();
    _resetGoalExtractLauncher();
  });
});

describe("backfill — ladder path, disabled arm, and pinned semantics", () => {
  test("a too-large transcript reports tooLarge AND still reconstructs (rung 4)", async () => {
    const transcript = jsonl("main-simple");
    await mem.adapter.writeText("/t/sess-huge.jsonl", `${transcript}//${"y".repeat(4 * 1024 * 1024)}`);
    // a seeded record gives the ladder-case reconstruction something to find
    const parsed = parseTranscriptRows(transcript);
    const dir = "/cfg/session-owl/sessions/sess-huge";
    {
      const mirror = new MirrorWriter(mem.adapter, dir, "huge-a");
      const ledger = new LedgerWriter(mem.adapter, dir, "huge-a");
      // INCOMPLETE mirror (m-7 absent): remirrored === 0 below is therefore
      // DISCRIMINATING — only the tooLarge gate keeps m-7 out
      for (const tr of parsed.rows.filter((r) => r.uuid !== "m-7")) {
        mirror.bufferRow({ uuid: tr.uuid, parentUuid: tr.parentUuid, row: rowFromTranscript(tr) });
      }
      await mirror.flush();
      const prepared = await prepareStoreContext(mem.adapter, dir, ledger, mirror);
      const { encodeObservation } = await import("../../core/src/store/codecs.js");
      const { makeObservation, O_INITIAL_PROMPT: OIP2, N_GOAL } = await import("../../core/src/types.js");
      const { applyCreateNode, applyRecordObservation } = await import("../../core/src/graph/mutations.js");
      const { appendGraphDelta } = await import("../../core/src/store/graph-store.js");
      appendGraphDelta(
        prepared.ctx,
        applyCreateNode(graphOf().graph, {
          id: N_GOAL,
          summary: "",
          importance: "crit",
          parentNode: null,
          state: "active",
        }),
      );
      const obs = makeObservation({
        id: OIP2,
        summary: "p",
        importance: "crit",
        sourceEntryIds: ["m-1"],
        timestamp: "2026-10-06T11:00:01.000Z",
        parentNode: N_GOAL,
      });
      appendGraphDelta(prepared.ctx, applyRecordObservation(graphOf().graph, { obs }));
      appendObservation(prepared.ctx, {
        coversFromId: "m-1",
        coversUpToId: "m-4",
        records: [encodeObservation(obs)],
        tokenCount: 1,
      });
      await ledger.flush();
    }
    const storage = makeStorage("sess-huge");
    const result = await runBackfill(storage.mirror, storage.ledger, {
      key: "sess-huge",
      sessionId: "sess-huge",
      agentId: null,
      fs: mem.adapter,
      transcriptPath: "/t/sess-huge.jsonl",
      enabled: true,
      fireGoalExtract: () => {},
      computePending: corePendingEvaluator,
    });
    expect(result.tooLarge).toBe(true);
    expect(result.remirrored).toBe(0); // no transcript re-mirror on the ladder path
    expect(result.frontier).toBe("m-4"); // reconstruction still ran from the segments
  }, 30_000);

  test("enabled:false reconstructs read-only — no seed, no capture, frontier still derives", async () => {
    const transcript = jsonl("main-simple");
    await mem.adapter.writeText("/t/sess-off.jsonl", transcript);
    // seed one record so the read-only reconstruction has a frontier to find
    {
      const parsed = parseTranscriptRows(transcript);
      const dir = "/cfg/session-owl/sessions/sess-off";
      const mirror = new MirrorWriter(mem.adapter, dir, "off-a");
      const ledger = new LedgerWriter(mem.adapter, dir, "off-a");
      for (const tr of parsed.rows) {
        mirror.bufferRow({ uuid: tr.uuid, parentUuid: tr.parentUuid, row: rowFromTranscript(tr) });
      }
      await mirror.flush();
      const prepared = await prepareStoreContext(mem.adapter, dir, ledger, mirror);
      const { encodeObservation } = await import("../../core/src/store/codecs.js");
      const { makeObservation, O_INITIAL_PROMPT: OIPOFF, N_GOAL } = await import("../../core/src/types.js");
      const { applyCreateNode, applyRecordObservation } = await import("../../core/src/graph/mutations.js");
      const { appendGraphDelta } = await import("../../core/src/store/graph-store.js");
      appendGraphDelta(
        prepared.ctx,
        applyCreateNode(graphOf().graph, {
          id: N_GOAL,
          summary: "",
          importance: "crit",
          parentNode: null,
          state: "active",
        }),
      );
      const obs = makeObservation({
        id: OIPOFF,
        summary: "p",
        importance: "crit",
        sourceEntryIds: ["m-1"],
        timestamp: "2026-10-06T11:00:01.000Z",
        parentNode: N_GOAL,
      });
      appendGraphDelta(prepared.ctx, applyRecordObservation(graphOf().graph, { obs }));
      appendObservation(prepared.ctx, {
        coversFromId: "m-1",
        coversUpToId: "m-4",
        records: [encodeObservation(obs)],
        tokenCount: 1,
      });
      await ledger.flush();
    }
    const firedOff: string[] = [];
    const storage = makeStorage("sess-off");
    const result = await runBackfill(storage.mirror, storage.ledger, {
      key: "sess-off",
      sessionId: "sess-off",
      agentId: null,
      fs: mem.adapter,
      transcriptPath: "/t/sess-off.jsonl",
      enabled: false,
      fireGoalExtract: (t) => {
        firedOff.push(t);
      },
      computePending: corePendingEvaluator,
    });
    expect(result.initialPromptCaptured).toBe(false);
    expect(firedOff).toEqual([]);
    const handle = await getCore("sess-off");
    // the seeded on-disk deltas reconstruct (nGoal, oInitialPrompt) — read-only
    expect(handle.store.getGraphStore().graph.nodes.has("nGoal")).toBe(true);
    expect(handle.store.getGraphStore().graph.hasInitialPrompt).toBe(true);
    expect(result.frontier).toBe("m-4"); // read-only reconstruction still derives
    expect(result.remirrored).toBe(0); // the mirror was already complete
  });

  test("enabled:false on a FRESH session persists no seed (the gate's behavioral pin)", async () => {
    const transcript = jsonl("main-simple");
    await mem.adapter.writeText("/t/sess-freshoff.jsonl", transcript);
    const storage = makeStorage("sess-freshoff");
    const firedFresh: string[] = [];
    const result = await runBackfill(storage.mirror, storage.ledger, {
      key: "sess-freshoff",
      sessionId: "sess-freshoff",
      agentId: null,
      fs: mem.adapter,
      transcriptPath: "/t/sess-freshoff.jsonl",
      enabled: false,
      fireGoalExtract: (t) => {
        firedFresh.push(t);
      },
      computePending: corePendingEvaluator,
    });
    expect(result.initialPromptCaptured).toBe(false);
    expect(firedFresh).toEqual([]);
    const handle = await getCore("sess-freshoff");
    // the gate blocked the seed — remove it and this fails (nGoal would exist)
    expect(handle.store.getGraphStore().graph.nodes.has("nGoal")).toBe(false);
  });

  test("coversFromId:null covers NOTHING by interval (pi semantics — source citations only)", async () => {
    const transcript = jsonl("main-simple");
    await mem.adapter.writeText("/t/sess-nullcover.jsonl", transcript);
    {
      const parsed = parseTranscriptRows(transcript);
      const dir = "/cfg/session-owl/sessions/sess-nullcover";
      const mirror = new MirrorWriter(mem.adapter, dir, "nc-a");
      const ledger = new LedgerWriter(mem.adapter, dir, "nc-a");
      for (const tr of parsed.rows) {
        mirror.bufferRow({ uuid: tr.uuid, parentUuid: tr.parentUuid, row: rowFromTranscript(tr) });
      }
      await mirror.flush();
      const prepared = await prepareStoreContext(mem.adapter, dir, ledger, mirror);
      const { encodeObservation } = await import("../../core/src/store/codecs.js");
      const { makeObservation, O_INITIAL_PROMPT: OIP3, N_GOAL } = await import("../../core/src/types.js");
      const { applyCreateNode, applyRecordObservation } = await import("../../core/src/graph/mutations.js");
      const { appendGraphDelta } = await import("../../core/src/store/graph-store.js");
      appendGraphDelta(
        prepared.ctx,
        applyCreateNode(graphOf().graph, {
          id: N_GOAL,
          summary: "",
          importance: "crit",
          parentNode: null,
          state: "active",
        }),
      );
      const obs = makeObservation({
        id: OIP3,
        summary: "p",
        importance: "crit",
        sourceEntryIds: ["m-1"],
        timestamp: "2026-10-06T11:00:01.000Z",
        parentNode: N_GOAL,
      });
      appendGraphDelta(prepared.ctx, applyRecordObservation(graphOf().graph, { obs }));
      // null coversFromId: ONLY the source citation (m-1) covers — the
      // interval to m-4 covers nothing
      appendObservation(prepared.ctx, {
        coversFromId: null,
        coversUpToId: "m-4",
        records: [encodeObservation(obs)],
        tokenCount: 1,
      });
      await ledger.flush();
    }
    const storage = makeStorage("sess-nullcover");
    const result = await runBackfill(storage.mirror, storage.ledger, {
      key: "sess-nullcover",
      sessionId: "sess-nullcover",
      agentId: null,
      fs: mem.adapter,
      transcriptPath: "/t/sess-nullcover.jsonl",
      enabled: true,
      fireGoalExtract: () => {},
      computePending: corePendingEvaluator,
    });
    expect(result.frontier).toBe("m-4");
    // m-2 and m-4 remain pending: only m-1 is covered (by citation) — the
    // null interval covers nothing; contiguous uncovered renderables merge
    // into one range (pi's range semantics)
    const holes = result.pending.map((r) => r.entries.map((e) => e.id));
    expect(holes).toEqual([["m-2", "m-4"]]);
  });

  test("INVARIANT: a record citing a mid-group ROW uuid degrades to an empty backlog (documented, not silent)", async () => {
    const transcript = jsonl("main-simple");
    await mem.adapter.writeText("/t/sess-midcite.jsonl", transcript);
    {
      const parsed = parseTranscriptRows(transcript);
      const dir = "/cfg/session-owl/sessions/sess-midcite";
      const mirror = new MirrorWriter(mem.adapter, dir, "mc2-a");
      const ledger = new LedgerWriter(mem.adapter, dir, "mc2-a");
      for (const tr of parsed.rows) {
        mirror.bufferRow({ uuid: tr.uuid, parentUuid: tr.parentUuid, row: rowFromTranscript(tr) });
      }
      await mirror.flush();
      const prepared = await prepareStoreContext(mem.adapter, dir, ledger, mirror);
      const { encodeObservation } = await import("../../core/src/store/codecs.js");
      const { makeObservation, O_INITIAL_PROMPT: OIP4, N_GOAL } = await import("../../core/src/types.js");
      const { applyCreateNode, applyRecordObservation } = await import("../../core/src/graph/mutations.js");
      const { appendGraphDelta } = await import("../../core/src/store/graph-store.js");
      appendGraphDelta(
        prepared.ctx,
        applyCreateNode(graphOf().graph, {
          id: N_GOAL,
          summary: "",
          importance: "crit",
          parentNode: null,
          state: "active",
        }),
      );
      const obs = makeObservation({
        id: OIP4,
        summary: "p",
        importance: "crit",
        sourceEntryIds: ["m-3"], // m-3 is a MID-GROUP row (inside the m-2 assistant entry)
        timestamp: "2026-10-06T11:00:01.000Z",
        parentNode: N_GOAL,
      });
      appendGraphDelta(prepared.ctx, applyRecordObservation(graphOf().graph, { obs }));
      appendObservation(prepared.ctx, {
        coversFromId: "m-1",
        coversUpToId: "m-3",
        records: [encodeObservation(obs)],
        tokenCount: 1,
      });
      await ledger.flush();
    }
    const storage = makeStorage("sess-midcite");
    const result = await runBackfill(storage.mirror, storage.ledger, {
      key: "sess-midcite",
      sessionId: "sess-midcite",
      agentId: null,
      fs: mem.adapter,
      transcriptPath: "/t/sess-midcite.jsonl",
      enabled: true,
      fireGoalExtract: () => {},
      computePending: corePendingEvaluator,
    });
    // the frontier (m-3, a row id) does not resolve on the merged ENTRY view
    // → pending reads empty — records MUST cite entry ids (group starts)
    expect(result.frontier).toBe("m-3");
    expect(result.pending).toEqual([]);
  });

  test("fork-parent lookup uses the SAME encoding as the session-dir layout (a raw '|' id)", async () => {
    const st = await import("../../host/state.js");
    const parentDir = st.sessionDirPath("/cfg", "par|ent"); // percent-encoded on disk
    await mem.adapter.writeText(
      `${parentDir}/m1-cccccccc.jsonl`,
      `${JSON.stringify({ uuid: "e-1", parentUuid: null, row: rowFromTranscript(parseTranscriptRows(jsonl("main-simple")).rows[0] as never) })}\n`,
    );
    await mem.adapter.writeText("/t/sess-encchild.jsonl", jsonl("main-simple").replace(/"sess-main"/g, '"par|ent"'));
    const storage = makeStorage("sess-encchild");
    const result = await runBackfill(storage.mirror, storage.ledger, {
      key: "sess-encchild",
      sessionId: "sess-encchild",
      agentId: null,
      fs: mem.adapter,
      transcriptPath: "/t/sess-encchild.jsonl",
      enabled: true,
      fireGoalExtract: () => {},
      computePending: corePendingEvaluator,
    });
    expect(result.adoptedFromParent).toBe(true);
    const sweep = await sweepSession(mem.adapter, "/cfg/session-owl/sessions/sess-encchild");
    expect(sweep.rows.map((r) => r.uuid)).toContain("e-1");
  });
});

describe("backfill — a rewind fork across a compaction boundary", () => {
  test("the re-mirrored chain resolves through the boundary onto the rewound branch; the abandoned one stays off", async () => {
    const transcript = jsonl("fork-compact");
    await mem.adapter.writeText("/t/sess-fork.jsonl", transcript);
    const storage = makeStorage("sess-fork");
    const result = await runBackfill(storage.mirror, storage.ledger, {
      key: "sess-fork",
      sessionId: "sess-fork",
      agentId: null,
      fs: mem.adapter,
      transcriptPath: "/t/sess-fork.jsonl",
      enabled: true,
      fireGoalExtract: () => {},
      computePending: corePendingEvaluator,
    });
    expect(result.remirrored).toBe(5); // the live path only (the abandoned m-3/m-4 never mirror)
    // the summary row's parent resolves THROUGH the uncarried boundary
    // chrome onto the rewound row m-2b — never onto the abandoned branch
    expect(storage.mirror.rowByUuid("m-5")?.parentUuid).toBe("m-2b");
    const chain = storage.mirror.chainTo("m-6");
    expect(chain).toEqual(["m-1", "m-2", "m-2b", "m-5", "m-6"]);
  });
});
