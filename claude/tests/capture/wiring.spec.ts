// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// The wiring surface: session.append rows flow through the register handlers
// into the capture pipeline (row cache + mirror), and turn.complete flushes
// the loop's mirror batch + CHECK record into the session directory. Owl's
// own stage loops are excluded. Node-env twin of the plugin-test spec.
import { beforeEach, describe, expect, test } from "vitest";
import { releaseAllCaptures } from "../../host/capture/append-handler.js";
import { setBootstrapBlockedCommand } from "../../host/state.js";
import { sweepMirror } from "../../host/storage/mirror.js";
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

describe("capture wiring — the platform append envelope omits parentUuid", () => {
  test("rows without parentUuid capture + flush cleanly (edges stay inferred until a readable pass)", async () => {
    await harness.dispatch("classic.SessionStart", { session_id: "sess-np", transcript_path: "/t/np.jsonl" });
    // the REAL envelope shape: {message, door, origin, uuid} — NO parentUuid
    await harness.dispatch("session.append", {
      uuid: "u1",
      door: "prompt",
      origin: { kind: "composer" },
      message: { type: "user", content: [{ type: "text", text: "no parent edge" }] },
    });
    await harness.dispatch("turn.complete", { answer: "done", isAborted: false });
    const paths = harness.fsPaths().filter((p) => p.startsWith("/cfg/session-owl/sessions/sess-np/"));
    const mirror = paths.filter((p) => /\/m\d+-\w+\.jsonl$/.test(p));
    expect(mirror).toHaveLength(1);
    const lines = ((await harness.fsRead(mirror[0] ?? "")) ?? "").split("\n").filter((l) => l.length > 0);
    expect(lines).toHaveLength(1);
    const stored = JSON.parse(lines[0] ?? "{}");
    expect(stored.uuid).toBe("u1");
    expect(stored.parentUuid).toBeNull();
  });
});

describe("capture wiring — the bootstrap pause stops ALL capture", () => {
  test("an old session without an owl mirror: no silent mirroring while blocked; cleared → capture resumes", async () => {
    await harness.dispatch("classic.SessionStart", { session_id: "sess-block", transcript_path: "/t/b.jsonl" });
    setBootstrapBlockedCommand('node "P/bootstrap.mjs"');
    await harness.dispatch("session.append", {
      uuid: "u1",
      door: "prompt",
      origin: { kind: "composer" },
      message: { type: "user", content: [{ type: "text", text: "during the pause" }] },
    });
    await harness.dispatch("turn.complete", { answer: "done", isAborted: false });
    const paths = harness.fsPaths().filter((p) => p.startsWith("/cfg/session-owl/sessions/sess-block/"));
    expect(paths.filter((p) => /\/m\d+-\w+\.jsonl$/.test(p))).toHaveLength(0);

    // the pause clears — the next rows capture again
    setBootstrapBlockedCommand(null);
    await harness.dispatch("session.append", {
      uuid: "u2",
      door: "prompt",
      origin: { kind: "composer" },
      message: { type: "user", content: [{ type: "text", text: "after the pause" }] },
    });
    await harness.dispatch("turn.complete", { answer: "done", isAborted: false });
    const after = harness
      .fsPaths()
      .filter((p) => p.startsWith("/cfg/session-owl/sessions/sess-block/") && /\/m\d+-\w+\.jsonl$/.test(p));
    expect(after).toHaveLength(1);
    const lines = ((await harness.fsRead(after[0] ?? "")) ?? "").split("\n").filter((l) => l.length > 0);
    expect(lines.some((l) => l.includes('"uuid":"u2"'))).toBe(true);
    expect(lines.some((l) => l.includes('"uuid":"u1"'))).toBe(false);
  });
});

describe("capture wiring — session.append → capture → turn.complete flush", () => {
  test("rows are captured and flushed to the session dir at turn.complete", async () => {
    await harness.dispatch("classic.SessionStart", { session_id: "sess-1", transcript_path: "/t/x.jsonl" });
    await harness.dispatch("session.append", promptRow("u1", null, "hello"));
    await harness.dispatch("session.append", promptRow("u2", "u1", "world"));
    await harness.dispatch("turn.complete", { answer: "done", isAborted: false });

    const paths = harness.fsPaths().filter((p) => p.startsWith("/cfg/session-owl/sessions/sess-1/"));
    const mirror = paths.filter((p) => /\/m\d+-\w+\.jsonl$/.test(p));
    const ledger = paths.filter((p) => /\/ledger-[0-9a-f-]+\.jsonl$/.test(p));
    if (mirror.length !== 1) throw new Error(`paths=${JSON.stringify(paths)}`);
    if (ledger.length < 1) throw new Error(`ledgerPaths=${JSON.stringify(ledger)}`);
    const lines = ((await harness.fsRead(mirror[0] ?? "")) ?? "").split("\n").filter((l) => l.length > 0);
    expect(lines).toHaveLength(2);
    const first = JSON.parse(lines[0] ?? "{}");
    expect(first.uuid).toBe("u1");
    expect(first.parentUuid).toBeNull();
    // every ledger flush is its own batch file; the turn boundary now also
    // captures the initial prompt (pi's every-turn-end gate): the seed +
    // CHECK flush with the turn, then the capture's oInitialPrompt records
    // (graph_delta + observation) flush their own batch
    const ledgerLines = (
      await Promise.all(
        ledger.map(async (p2) => ((await harness.fsRead(p2)) ?? "").split("\n").filter((l) => l.length > 0)),
      )
    ).flat();
    const kinds = ledgerLines.map((l) => JSON.parse(l).kind);
    expect(kinds).toEqual(["graph_delta", "CHECK", "graph_delta", "observation"]);
  });

  test("the flushed mirror sweeps back (listDir maps platform FsEntry names)", async () => {
    await harness.dispatch("classic.SessionStart", { session_id: "sess-4", transcript_path: "/t/w.jsonl" });
    await harness.dispatch("session.append", promptRow("u1", null, "hello"));
    await harness.dispatch("session.append", promptRow("u2", "u1", "world"));
    await harness.dispatch("turn.complete", { answer: "done", isAborted: false });
    releaseAllCaptures(); // simulate restart: only the on-disk tier remains

    const dir = "/cfg/session-owl/sessions/sess-4";
    // sweep through the REAL bridge adapter (platform $.fs.list returns
    // FsEntry objects — bridgeFs.listDir must map them to names)
    const { getSessionStorage } = await import("../../host/storage/session-storage.js");
    const storage = getSessionStorage("sess-4", "sess-4", null);
    const sweep = await sweepMirror(storage.fs, dir);
    expect(sweep.rows.map((r) => r.uuid)).toEqual(["u1", "u2"]);
  });

  test("a subagent loop is released at its turn.complete; the main loop survives", async () => {
    await harness.dispatch("classic.SessionStart", { session_id: "sess-5", transcript_path: "/t/v.jsonl" });
    await harness.dispatch("session.append", promptRow("m1", null, "main"));
    await harness.dispatch("session.append", { ...promptRow("s1", null, "sub"), agentId: "agent-9" });
    await harness.dispatch("turn.complete", { answer: "sub", isAborted: false, agentId: "agent-9" });
    await harness.dispatch("turn.complete", { answer: "main", isAborted: false });

    // sub loop released (its rows are durable on disk — sweep tier owns them)
    const { getCapture } = await import("../../host/capture/append-handler.js");
    expect(getCapture("sess-5|agent-9")).toBeUndefined();
    // main loop retained
    expect(getCapture("sess-5")).toBeDefined();
  });

  test("an owl-spawn loop's rows are never captured", async () => {
    const bridge = harness.bridge();
    bridge.spawnRegistry.set("owl-1", { launchedAt: 1 });
    await harness.dispatch("classic.SessionStart", { session_id: "sess-2", transcript_path: "/t/y.jsonl" });
    await harness.dispatch("session.append", { ...promptRow("o1", null, "stage chatter"), agentId: "owl-1" });
    await harness.dispatch("turn.complete", { answer: "x", isAborted: false, agentId: "owl-1" });
    bridge.spawnRegistry.delete("owl-1");

    const paths = harness.fsPaths().filter((p) => p.includes("sessions/sess-2"));
    expect(paths.some((p) => /\/m\d+-\w+\.jsonl$/.test(p))).toBe(false);
  });

  test("a subagent loop's rows flush to its own loop key at its turn.complete", async () => {
    await harness.dispatch("classic.SessionStart", { session_id: "sess-3", transcript_path: "/t/z.jsonl" });
    await harness.dispatch("session.append", { ...promptRow("s1", null, "sub prompt"), agentId: "agent-7" });
    await harness.dispatch("turn.complete", { answer: "sub done", isAborted: false, agentId: "agent-7" });

    const paths = harness.fsPaths().filter((p) => p.includes("sessions/sess-3-agent-7"));
    expect(paths.some((p) => /\/m\d+-\w+\.jsonl$/.test(p))).toBe(true);
    expect(paths.some((p) => /\/ledger-[0-9a-f-]+\.jsonl$/.test(p))).toBe(true);
  });

  test("a foreign subagent loop's rows are NOT captured when subagentMode is disabled — nothing collected", async () => {
    harness.env.set("CLAUDE_SETTINGS_SESSION_OWL", JSON.stringify({ subagentMode: "disabled" }));
    await harness.dispatch("classic.SessionStart", { session_id: "sess-off", transcript_path: "/t/off.jsonl" });
    await harness.dispatch("session.append", { ...promptRow("s1", null, "sub prompt"), agentId: "agent-off" });
    await harness.dispatch("session.append", { ...promptRow("m1", null, "main prompt") });
    await harness.dispatch("turn.complete", { answer: "sub done", isAborted: false, agentId: "agent-off" });
    await harness.dispatch("turn.complete", { answer: "main done", isAborted: false });

    // the subagent loop collected NOTHING (no mirror, no conversation, no
    // binding — even the initial-prompt path skips it: no storage dir ever)
    const subPaths = harness.fsPaths().filter((p) => p.includes("sessions/sess-off-agent-off"));
    expect(subPaths).toHaveLength(0);
    const { getCapture } = await import("../../host/capture/append-handler.js");
    expect(getCapture("sess-off|agent-off")).toBeUndefined();
    const { hasBinding } = await import("../../host/runs/bind.js");
    expect(hasBinding("sess-off|agent-off")).toBe(false);
    // the main conversation keeps capturing under the same settings
    const mainPaths = harness.fsPaths().filter((p) => p.includes("sessions/sess-off/"));
    expect(mainPaths.some((p) => /\/m\d+-\w+\.jsonl$/.test(p))).toBe(true);
  });

  test("subagentMode disabled declines EVERY agent-scoped compaction — own stage loops included (owl answers no agent-scoped compaction under disabled)", async () => {
    harness.env.set("CLAUDE_SETTINGS_SESSION_OWL", JSON.stringify({ subagentMode: "disabled" }));
    await harness.dispatch("classic.SessionStart", { session_id: "sess-off3", transcript_path: "/t/off3.jsonl" });
    // an OWN stage run's id (in the spawn registry) — still declined
    harness.bridge().spawnRegistry.set("owl-own-1", { launchedAt: 1 });
    await harness.dispatch("session.compact", { reason: "auto", agentId: "owl-own-1" });
    harness.bridge().spawnRegistry.delete("owl-own-1");
    const { hasBinding } = await import("../../host/runs/bind.js");
    expect(hasBinding("sess-off3|owl-own-1")).toBe(false);
  });

  test("subagentMode disabled also declines the subagent loop's compaction — native compaction, no binding ensured", async () => {
    harness.env.set("CLAUDE_SETTINGS_SESSION_OWL", JSON.stringify({ subagentMode: "disabled" }));
    await harness.dispatch("classic.SessionStart", { session_id: "sess-off2", transcript_path: "/t/off2.jsonl" });
    await harness.dispatch("session.compact", { reason: "auto", agentId: "agent-off2" });

    // the loop was left entirely alone: no binding ensured for its key
    // (without the decline the takeover gate binds the conversation)
    const { hasBinding } = await import("../../host/runs/bind.js");
    expect(hasBinding("sess-off2|agent-off2")).toBe(false);
    const subPaths = harness.fsPaths().filter((p) => p.includes("sessions/sess-off2-agent-off2"));
    expect(subPaths).toHaveLength(0);
  });

  test("CONTROL — subagentMode default (on-compaction): the subagent loop's compaction IS taken over (binding ensured)", async () => {
    harness.env.set("CLAUDE_SETTINGS_SESSION_OWL", JSON.stringify({ subagentMode: "on-compaction" }));
    await harness.dispatch("classic.SessionStart", { session_id: "sess-oc", transcript_path: "/t/oc.jsonl" });
    await harness.dispatch("session.compact", { reason: "auto", agentId: "agent-oc" });

    const { hasBinding } = await import("../../host/runs/bind.js");
    expect(hasBinding("sess-oc|agent-oc")).toBe(true);
  });
});
