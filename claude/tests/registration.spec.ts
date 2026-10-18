// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import { readFileSync } from "node:fs";
import { join } from "node:path";
// Host-binding skeleton: registration flow, session registry, .session.json
// marker, teardown. Drives the real register.ts through the local harness;
// the kit loader side is covered by claude/plugin-test/registration.test.ts.
import { beforeEach, describe, expect, test, vi } from "vitest";
import { log } from "../core/src/log.js";
import { OWL_RECALL_FULL_NAME, OWL_RECALL_TOOL_DESCRIPTION } from "../host/recall/spec.js";
import { getBinding, releaseBinding } from "../host/runs/bind.js";
import { contextTokensFor, recordMeasure } from "../host/triggers/context.js";
import { acquireOrSkip, pruneIdleLocks } from "../host/triggers/run-locks.js";
import { createHarness } from "./helpers/harness.js";

const FIXTURES = join(__dirname, "fixtures", "transcripts");

/** The main-simple fixture as transcript jsonl text (rows one per line). */
function mainSimpleJsonl(): string {
  const data = JSON.parse(readFileSync(join(FIXTURES, "main-simple.json"), "utf8")) as {
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

let h: any;

beforeEach(() => {
  h = createHarness();
  h.env.set("CLAUDE_CONFIG_DIR", "/cfg");
});

describe("host binding skeleton — registration", () => {
  test("register(on) wires every plan-listed event without throwing", async () => {
    const wired = await h.load();
    for (const name of [
      "engine.create",
      "plugin.register",
      "session.start",
      "classic.SessionStart",
      "classic.SubagentStop",
      "session.end",
      "session.append",
      "turn.step",
      "turn.complete",
      "session.measure",
      "session.compact",
      "tool.register",
      "tool.call",
      "command.register",
      "command.run",
      "agent.offer",
      "ui.render",
      "prompt.submit",
      "prompt.attachment",
      "session.receive",
    ]) {
      expect(wired, `event ${name}`).toContain(name);
    }
  });

  test("session.start registers tools/commands/noun idempotently", async () => {
    await h.load();
    await h.dispatch("session.start", { cwd: "/w", surface: "terminal", prompt: true });
    expect(h.tools.registered.map((t: any) => t.name)).toContain("owl_recall");
    const recallSpec = h.tools.registered.find((t: any) => t.name === "owl_recall");
    expect((recallSpec as any).description).toBe(OWL_RECALL_TOOL_DESCRIPTION); // the full pi-verbatim text, never a placeholder
    expect(h.commands.registered.map((c: any) => c.name).sort()).toEqual([
      "owl-cat",
      "owl-find",
      "owl-find-all",
      "owl-ls",
      "owl-reobserve-0-obs-chunks",
      "owl-rescan",
      "owl-settings",
      "owl-status",
    ]);
    const firstCalls = h.tools.registered.length + h.commands.registered.length;
    // second start (a fresh kit session) re-registers nothing
    await h.dispatch("session.start", { cwd: "/w", surface: "terminal", prompt: true });
    expect(h.tools.registered.length + h.commands.registered.length).toBe(firstCalls);
  });

  test("the deferral pins ride the registered specs (register-time isDeferred, 2.1.293 — t33)", async () => {
    await h.load();
    await h.dispatch("classic.SessionStart", {
      source: "startup",
      session_id: "s-desc",
      transcript_path: "/t.jsonl",
      cwd: "/w",
    });
    const recallSpec = h.tools.registered.find((t: any) => t.name === "owl_recall");
    expect((recallSpec as any).isDeferred).toBe(false); // in-list: the schema rides the prompt from the first render
    for (const spec of h.tools.registered) {
      if (spec.name !== "owl_recall") {
        expect((spec as any).isDeferred).toBe(true); // stage tools: behind ToolSearch, cache-stable
      }
    }
  });

  test("classic.SessionStart anchors the conflict timeline (Channel C owl-active windows)", async () => {
    await h.load();
    await h.dispatch("classic.SessionStart", {
      source: "clear",
      session_id: "sess-tl",
      transcript_path: "/cfg/projects/p/sess-tl.jsonl",
      cwd: "/w",
    });
    // the timeline append is void-fired (best-effort evidence) — let it settle
    await new Promise((r) => setTimeout(r, 20));
    const tlPaths = h.fsPaths().filter((p: string) => /session-owl\/sessions\/sess-tl\/timeline-[^/]+\.jsonl$/.test(p));
    expect(tlPaths).toHaveLength(1);
    const events = ((await h.fsRead(tlPaths[0] as string)) as string)
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as { t: string });
    expect(events.some((ev) => ev.t === "enable")).toBe(true); // the process anchor
    expect(events.some((ev) => ev.t === "pause")).toBe(false); // no conflicts armed
  });

  test("the enable+pause pair from one start lands BOTH events (serialized appends)", async () => {
    // hits armed BEFORE the start: the anchor fires enable + pause as two
    // back-to-back void appends — unserialized read-modify-write would drop
    // one (both read the same prev, the later write wins)
    const { setConflictHits: armHits, _resetConflictStateForTest: resetHits } = await import(
      "../host/conflicts/pause.js"
    );
    armHits([{ channel: "B", name: "other-mod@x", evidence: "session.compact" }]);
    try {
      const h2 = createHarness();
      await h2.load();
      h2.env.set("CLAUDE_CONFIG_DIR", "/cfg");
      await h2.dispatch("classic.SessionStart", {
        source: "clear",
        session_id: "sess-race",
        transcript_path: "/t.jsonl",
        cwd: "/w",
      });
      await new Promise((r) => setTimeout(r, 30));
      const texts = (
        await Promise.all(
          h2
            .fsPaths()
            .filter((p: string) => /session-owl\/sessions\/sess-race\/timeline-[^/]+\.jsonl$/.test(p))
            .map((p: string) => h2.fsRead(p) as unknown as string),
        )
      ).join("\n");
      expect(texts).toContain('"t":"enable"');
      expect(texts).toContain('"t":"pause"'); // BOTH survived the pair
    } finally {
      resetHits();
    }
  });

  test("a {compact} source SessionStart takes NO action (no second enable anchor, handle stable)", async () => {
    const { getInstalledSettingsHandle } = await import("../host/settings/consumer.js");
    await h.load();
    await h.dispatch("classic.SessionStart", {
      source: "startup",
      session_id: "sess-compact",
      transcript_path: "/t/sess-compact.jsonl",
      cwd: "/w",
    });
    await new Promise((r) => setTimeout(r, 25));
    const handleBefore = getInstalledSettingsHandle();
    await h.dispatch("classic.SessionStart", {
      source: "compact",
      session_id: "sess-compact",
      transcript_path: "/t/sess-compact.jsonl",
      cwd: "/w",
    });
    await new Promise((r) => setTimeout(r, 25));
    // exactly ONE enable anchor (the compact source re-runs nothing)
    const texts = (
      await Promise.all(
        h
          .fsPaths()
          .filter((p: string) => /session-owl\/sessions\/sess-compact\/timeline-[^/]+\.jsonl$/.test(p))
          .map((p: string) => h.fsRead(p) as unknown as string),
      )
    ).join("\n");
    expect(texts.split('"t":"enable"').length - 1).toBe(1);
    // the settings handle was NOT rebuilt (the pane's controller stays valid)
    expect(getInstalledSettingsHandle()).toBe(handleBefore);
  });

  test("a RE-START (resume/clear) keeps the settings handle identity — init is idempotent", async () => {
    const { getInstalledSettingsHandle } = await import("../host/settings/consumer.js");
    await h.load();
    await h.dispatch("classic.SessionStart", {
      source: "startup",
      session_id: "sess-re",
      transcript_path: "/t/sess-re.jsonl",
      cwd: "/w",
    });
    const first = getInstalledSettingsHandle();
    await h.dispatch("classic.SessionStart", {
      source: "resume",
      session_id: "sess-re",
      transcript_path: "/t/sess-re.jsonl",
      cwd: "/w2",
    });
    expect(getInstalledSettingsHandle()).toBe(first); // same handle — reloaded, not replaced
  });

  test("classic.SessionStart bootstraps the registry and writes the .session.json marker", async () => {
    await h.load();
    await h.dispatch("classic.SessionStart", {
      source: "clear",
      session_id: "sess-1",
      transcript_path: "/cfg/projects/p/sess-1.jsonl",
      cwd: "/w",
    });
    expect(h.registryKeys()).toEqual(["sess-1"]);
    // classic.SessionStart alone (no session.start before it) also registers
    expect(h.tools.registered.map((t: any) => t.name)).toContain("owl_recall");
    expect(h.commands.registered.length).toBe(8);
    const marker = JSON.parse(await h.fsRead("/cfg/session-owl/sessions/sess-1/.session.json"));
    expect(marker).toEqual({ sessionId: "sess-1", transcriptPath: "/cfg/projects/p/sess-1.jsonl" });
  });

  test("marker re-read on resume: tolerant of absent/corrupt files", async () => {
    await h.load();
    await h.fsWrite("/cfg/session-owl/sessions/sess-2/.session.json", "{corrupt");
    await h.dispatch("classic.SessionStart", {
      source: "resume",
      session_id: "sess-2",
      transcript_path: "/cfg/projects/p/sess-2.jsonl",
      cwd: "/w",
    });
    // corrupt marker was re-recorded from the envelope
    const marker = JSON.parse(await h.fsRead("/cfg/session-owl/sessions/sess-2/.session.json"));
    expect(marker.sessionId).toBe("sess-2");
    // transcript_path comes from the envelope, never derived from cwd
    expect(marker.transcriptPath).toBe("/cfg/projects/p/sess-2.jsonl");
  });

  test("two terminals (two harness sessions) write identical markers — benign", async () => {
    const h2 = createHarness();
    h2.env.set("CLAUDE_CONFIG_DIR", "/cfg");
    await h.load();
    await h2.load();
    for (const harness of [h, h2]) {
      await harness.dispatch("classic.SessionStart", {
        source: "clear",
        session_id: "shared",
        transcript_path: "/cfg/projects/p/shared.jsonl",
        cwd: "/w",
      });
    }
    const a = await h.fsRead("/cfg/session-owl/sessions/shared/.session.json");
    const b = await h2.fsRead("/cfg/session-owl/sessions/shared/.session.json");
    expect(a).toBe(b);
  });

  test("session.append uses the current conversation's registry entry; agentId sub-keys", async () => {
    await h.load();
    await h.dispatch("classic.SessionStart", {
      source: "clear",
      session_id: "s3",
      transcript_path: "/t.jsonl",
      cwd: "/w",
    });
    await h.dispatch("session.append", { message: { type: "user" }, door: "prompt", origin: "user", uuid: "u1" });
    await h.dispatch("session.append", {
      message: { type: "assistant" },
      door: "response",
      origin: "model",
      uuid: "u2",
      agentId: "ag1",
    });
    expect(h.registryKeys().sort()).toEqual(["s3", "s3|ag1"]);
  });

  test("session.measure records the context snapshot under the session (null context tolerated)", async () => {
    await h.load();
    await h.dispatch("classic.SessionStart", {
      source: "startup",
      session_id: "s-meas",
      transcript_path: "/t.jsonl",
      cwd: "/w",
    });
    await h.dispatch("session.measure", { context: null, rateLimits: [], changed: [] }); // out-of-contract null: no throw
    expect(contextTokensFor("s-meas")).toBeNull();
    await h.dispatch("session.measure", {
      context: { tokens: 12_345, window: 200_000, percent: 6 },
      rateLimits: [],
      changed: ["context"],
    });
    expect(contextTokensFor("s-meas")).toBe(12_345);
  });

  test("session.end clears the registry entry, runs teardown hooks, and prunes the trigger maps", async () => {
    await h.load();
    await h.dispatch("classic.SessionStart", {
      source: "clear",
      session_id: "s4",
      transcript_path: "/t.jsonl",
      cwd: "/w",
    });
    let tornDown = 0;
    h.onTeardown(() => {
      tornDown += 1;
    });
    // the trigger layer's per-conversation maps ride the same teardown
    recordMeasure("s4", { tokens: 1000, window: 200_000 });
    const idleLock = acquireOrSkip("s4", "observe");
    expect(idleLock).not.toBeNull();
    idleLock?.release();
    await h.dispatch("session.end", { reason: "clear", sessionId: "s4", resume: false });
    expect(tornDown).toBe(1);
    expect(h.registryKeys()).toEqual([]);
    expect(contextTokensFor("s4")).toBeNull(); // measures pruned
    expect(pruneIdleLocks()).toBe(0); // the idle lock entry already pruned
  });

  test("engine.create folds the sessionOwl noun; closures work without a live $", async () => {
    await h.load();
    const built = await h.engineCreate();
    expect(typeof built.sessionOwl).toBe("object");
    expect(typeof built.sessionOwl.reloadConfig).toBe("function");
    expect(typeof built.sessionOwl.getConfig).toBe("function");
    expect(typeof built.sessionOwl.getConflictPause).toBe("function");
    // getConfig answers from module state with no handler context live
    const cfg = await built.sessionOwl.getConfig();
    expect(cfg).toBeDefined();
    // LIVE state, not a skeleton: the pause predicate reads the conflicts
    // module (hits recorded ⇒ paused while enabled); the config read is the
    // settings entry point (defaults before init — never a placeholder flag)
    expect(cfg.__skeleton).toBeUndefined();
    expect(cfg.enabled).toBe(true); // the default config's enabled
    expect(await built.sessionOwl.getConflictPause()).toBe(false); // no hits yet
    const { setConflictHits, _resetConflictStateForTest } = await import("../host/conflicts/pause.js");
    setConflictHits([{ channel: "B", name: "other-mod@x", evidence: "compaction-hook" }]);
    try {
      expect(await built.sessionOwl.getConflictPause()).toBe(true); // live predicate
    } finally {
      _resetConflictStateForTest();
    }
  });

  test("session.start THEN classic.SessionStart (the dual-source sequence) registers exactly once", async () => {
    await h.load();
    await h.dispatch("session.start", { cwd: "/w", surface: "terminal", prompt: true });
    const afterFirst = h.tools.registered.length + h.commands.registered.length;
    await h.dispatch("classic.SessionStart", {
      source: "clear",
      session_id: "s9",
      transcript_path: "/t.jsonl",
      cwd: "/w",
    });
    expect(h.tools.registered.length + h.commands.registered.length).toBe(afterFirst);
    expect(h.registryKeys()).toEqual(["s9"]);
  });

  test("registration survives a missing config dir (no CLAUDE_CONFIG_DIR/HOME/USERPROFILE)", async () => {
    await h.load();
    h.env.set("CLAUDE_CONFIG_DIR", "");
    await h.dispatch("session.start", { cwd: "/w", surface: "terminal", prompt: true });
    expect(h.tools.registered.map((t: any) => t.name)).toContain("owl_recall");
    expect(h.commands.registered.length).toBe(8);
  });

  test("turn.step passes the chunk stream through (generator handler)", async () => {
    await h.load();
    const out = (await h.dispatch("turn.step", { turnId: "t", index: 0, model: "m" })) as Record<string, unknown>;
    // the pass-through arm returns the CHAIN'S OWN value — the harness's
    // next resolves the input event, so the echo IS that event, every field
    // intact (`model` survives — a reconstructed six-field object would
    // have stripped it)
    expect(out.turnId).toBe("t");
    expect(out.index).toBe(0);
    expect(out.model).toBe("m"); // a field OUTSIDE owl's slice — preserved only if untouched
  });

  test("hostile session ids cannot escape the sessions dir (sanitize)", async () => {
    await h.load();
    await h.dispatch("classic.SessionStart", {
      source: "clear",
      session_id: "..",
      transcript_path: "/t.jsonl",
      cwd: "/w",
    });
    const paths = h.fsPaths();
    const markers = paths.filter((p: string) => p.endsWith("/.session.json"));
    expect(markers).toEqual(["/cfg/session-owl/sessions/_/.session.json"]);
    // nothing escapes the sanitized session root (the conflict timeline
    // lives inside it — same sanitized id, same confinement). The one
    // allowed outsider is the logger's own FIXED sink (never derived from
    // the session id — the escape vector this test guards).
    const escapees = paths.filter(
      (p: string) => !p.startsWith("/cfg/session-owl/sessions/") && p !== "/cfg/logs/avtc-pi-session-owl/0.log",
    );
    expect(escapees).toEqual([]); // the failure output names any escapee
  });

  test("sanitize keeps distinct session ids distinct (no underscore collision)", async () => {
    const st = await import("../host/state.js");
    expect(st.sessionDirPath("/cfg", "a|b")).not.toBe(st.sessionDirPath("/cfg", "a_b"));
    expect(st.sessionDirPath("/cfg", "a|b")).toBe(st.sessionDirPath("/cfg", "a|b")); // stable
    // unpadded hex would collide: b and  both -> "%1b"
    expect(st.sessionDirPath("/cfg", "b")).not.toBe(st.sessionDirPath("/cfg", ""));
  });

  test("parseSessionMarker: corrupt text -> null, valid -> object", async () => {
    await h.load();
    const st = await import("../host/state.js");
    expect(st.parseSessionMarker("{corrupt")).toBeNull();
    expect(st.parseSessionMarker(JSON.stringify({ sessionId: "x" }))).toEqual({ sessionId: "x" });
  });

  test("turn.complete{agentId} routes to the bridge's awaiting resolver", async () => {
    await h.load();
    const p = h.bridge().awaitAgentCompletion("agX");
    await h.dispatch("turn.complete", {
      answer: "done",
      durationMs: 5,
      isAborted: false,
      turnId: "t1",
      agentId: "agX",
    });
    await expect(p).resolves.toEqual({ answer: "done", isAborted: false, agentId: "agX", usage: null });
  });
});

describe("turn-boundary trigger arms — the loop goes live", () => {
  test("a stage launch routes THROUGH the subagent companion (origin-cleared)", async () => {
    await h.load();
    await h.dispatch("classic.SessionStart", {
      source: "startup",
      session_id: "sess-launch",
      transcript_path: "/cfg/projects/p/sess-launch.jsonl",
      cwd: "/w",
    });
    await h.dispatch("session.append", {
      uuid: "l1",
      parentUuid: null,
      door: "prompt",
      origin: { kind: "composer" },
      message: { type: "user", content: [{ type: "text", text: "hello" }] },
    });
    await h.dispatch("session.append", {
      uuid: "l2",
      parentUuid: "l1",
      door: "prompt",
      origin: { kind: "composer" },
      message: { type: "assistant", content: [{ type: "text", text: "answer" }] },
    });
    await h.dispatch("session.append", {
      uuid: "l3",
      parentUuid: "l2",
      door: "prompt",
      origin: { kind: "composer" },
      message: { type: "user", content: [{ type: "text", text: `remember ${"z".repeat(20000)}` }] },
    });
    await h.dispatch("session.append", {
      uuid: "l4",
      parentUuid: "l3",
      door: "prompt",
      origin: { kind: "composer" },
      message: { type: "assistant", content: [{ type: "text", text: "noted" }] },
    });
    h.sessionApi.set([]);
    await h.dispatch("turn.complete", { answer: "noted", isAborted: false });
    await new Promise((resolve) => setTimeout(resolve, 80));
    // the launch went through the companion's tool, and the spawn the
    // harness saw came from the simulated companion's ambient code — the
    // plugin itself never spawned directly
    const launches = h.toolCalls.calls.filter((c: unknown) =>
      String((c as { tool?: unknown }).tool ?? "").includes("session-owl-subagent-support__launch"),
    );
    expect(launches.length).toBeGreaterThan(0);
    expect(h.spawned.calls.length).toBeGreaterThan(0);
    expect(String((h.spawned.calls[0] as Record<string, unknown>).subagentType ?? "")).toContain("observe");
  });

  test("a contentless completion (the resume dangling shape) launches NOTHING", async () => {
    await h.load();
    await h.dispatch("classic.SessionStart", {
      source: "startup",
      session_id: "sess-gate",
      transcript_path: "/cfg/projects/p/sess-gate.jsonl",
      cwd: "/w",
    });
    await h.dispatch("session.append", {
      uuid: "g1",
      parentUuid: null,
      door: "prompt",
      origin: { kind: "composer" },
      message: { type: "user", content: [{ type: "text", text: "hello" }] },
    });
    // a completed round first — primes the gate's history
    await h.dispatch("session.append", {
      uuid: "g2",
      parentUuid: "g1",
      door: "prompt",
      origin: { kind: "composer" },
      message: { type: "assistant", content: [{ type: "text", text: "answer" }] },
    });
    h.sessionApi.set([]);
    await h.dispatch("turn.complete", { answer: "answer", isAborted: false });
    await new Promise((resolve) => setTimeout(resolve, 30));
    const fired = h.spawned.calls.length;
    // the dangling shape: a fresh user prompt, NO assistant content, and a
    // completion — the resume boundary — launches nothing even though the
    // unobserved mass is huge
    await h.dispatch("session.append", {
      uuid: "g3",
      parentUuid: "g2",
      door: "prompt",
      origin: { kind: "composer" },
      message: { type: "user", content: [{ type: "text", text: `more ${"y".repeat(20000)}` }] },
    });
    h.sessionApi.set([]);
    await h.dispatch("turn.complete", { answer: "", isAborted: false });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(h.spawned.calls.length).toBe(fired);
  });

  test("turn.complete launches the observer once the threshold is crossed (spawn recorded)", async () => {
    await h.load();
    await h.dispatch("classic.SessionStart", {
      source: "startup",
      session_id: "sess-trig",
      transcript_path: "/cfg/projects/p/sess-trig.jsonl",
      cwd: "/w",
    });
    // the first user row is the (already-covered) initial prompt; the SECOND
    // user row is the unobserved mass that crosses the observer threshold
    await h.dispatch("session.append", {
      uuid: "t1",
      parentUuid: null,
      door: "prompt",
      origin: { kind: "composer" },
      message: { type: "user", content: [{ type: "text", text: "hello owl" }] },
    });
    const big = `remember ${"x".repeat(20000)}`;
    await h.dispatch("session.append", {
      uuid: "t2",
      parentUuid: "t1",
      door: "prompt",
      origin: { kind: "composer" },
      message: { type: "user", content: [{ type: "text", text: big }] },
    });
    // a REAL round carries assistant content — the boundary gate requires
    // it (a resumed session's dangling completion has none and fires
    // nothing)
    await h.dispatch("session.append", {
      uuid: "t3",
      parentUuid: "t2",
      door: "prompt",
      origin: { kind: "composer" },
      message: { type: "assistant", content: [{ type: "text", text: "noted" }] },
    });
    h.sessionApi.set([]);
    await h.dispatch("turn.complete", { answer: "done", isAborted: false });
    // fire-and-forget: the launch chain settles asynchronously
    await new Promise((resolve) => setTimeout(resolve, 50));
    // the harness's spawn recorder saw the observe stage agent spawn
    expect(h.spawned.calls.length).toBeGreaterThan(0);
    expect(String((h.spawned.calls[0] as Record<string, unknown>).subagentType ?? "")).toContain("observe");
  });

  test("turn.complete{agentId} — a SUBAGENT loop's wrap-up still sees its rows (the snapshot precedes the release)", async () => {
    await h.load();
    // The wrap-up contract is pinned under subagentMode "inherited" — the
    // mode where a subagent loop's turn boundary still launches its
    // observer. (The DEFAULT "on-compaction" defers that launch to the
    // loop's compaction catch-up — pinned in eval/bind specs.)
    h.env.set("CLAUDE_SETTINGS_SESSION_OWL", JSON.stringify({ subagentMode: "inherited" }));
    await h.dispatch("classic.SessionStart", {
      source: "startup",
      session_id: "sess-ag",
      transcript_path: "/cfg/projects/p/sess-ag.jsonl",
      cwd: "/w",
    });
    await h.dispatch("session.append", {
      uuid: "a0",
      parentUuid: null,
      door: "prompt",
      origin: { kind: "composer" },
      agentId: "sub-9",
      message: { type: "user", content: [{ type: "text", text: "hello sub" }] },
    });
    await h.dispatch("session.append", {
      uuid: "a1",
      parentUuid: "a0",
      door: "prompt",
      origin: { kind: "composer" },
      agentId: "sub-9",
      message: { type: "user", content: [{ type: "text", text: `sub ${"w".repeat(20000)}` }] },
    });
    await h.dispatch("session.append", {
      uuid: "a2",
      parentUuid: "a1",
      door: "prompt",
      origin: { kind: "composer" },
      agentId: "sub-9",
      message: { type: "assistant", content: [{ type: "text", text: "sub done" }] },
    });
    h.sessionApi.set([]);
    // the loop's TERMINAL event: the arm fires the boundary and then
    // SYNCHRONOUSLY releases the capture — the boundary must snapshot the
    // loop's rows before that release or the wrap-up reads an empty branch
    await h.dispatch("turn.complete", { agentId: "sub-9", answer: "done", isAborted: false });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(h.spawned.calls.length).toBeGreaterThan(0); // the observer launched
    expect(String((h.spawned.calls[0] as Record<string, unknown>).subagentType ?? "")).toContain("observe");
    // the loop is TERMINAL at its completion: its binding is released with
    // the capture/storage/checkpoint (no per-loop retention for the
    // process lifetime)
    expect(releaseBinding("sess-ag|sub-9")).toBe(false); // already dropped
  });

  test("session.end releases the MAIN-loop binding too (nothing outlives the session)", async () => {
    await h.load();
    await h.dispatch("classic.SessionStart", {
      source: "startup",
      session_id: "sess-end",
      transcript_path: "/cfg/projects/p/sess-end.jsonl",
      cwd: "/w",
    });
    const before = getBinding("sess-end", "sess-end", null); // armed by the session's events
    await h.dispatch("session.end", {});
    expect(getBinding("sess-end", "sess-end", null)).not.toBe(before); // the teardown dropped it
  });

  test("turn.step mid-turn matrix also launches (same lock, same conversation)", async () => {
    await h.load();
    await h.dispatch("classic.SessionStart", {
      source: "startup",
      session_id: "sess-step",
      transcript_path: "/cfg/projects/p/sess-step.jsonl",
      cwd: "/w",
    });
    await h.dispatch("session.append", {
      uuid: "s0",
      parentUuid: null,
      door: "prompt",
      origin: { kind: "composer" },
      message: { type: "user", content: [{ type: "text", text: "hello step" }] },
    });
    await h.dispatch("session.append", {
      uuid: "s1",
      parentUuid: "s0",
      door: "prompt",
      origin: { kind: "composer" },
      message: { type: "user", content: [{ type: "text", text: `keep ${"y".repeat(20000)}` }] },
    });
    h.sessionApi.set([]);
    await h.dispatch("turn.step", { index: 1, turnId: "tt" });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(h.spawned.calls.length).toBeGreaterThan(0);
  });

  test("a disabled session never launches (dormant parity)", async () => {
    await h.load();
    await h.dispatch("classic.SessionStart", {
      source: "startup",
      session_id: "sess-off",
      transcript_path: "/cfg/projects/p/sess-off.jsonl",
      cwd: "/w",
    });
    const st = await import("../host/state.js");
    st.setOwlEnabled(false); // the live master switch (the settings flip path)
    await h.dispatch("session.append", {
      uuid: "d0",
      parentUuid: null,
      door: "prompt",
      origin: { kind: "composer" },
      message: { type: "user", content: [{ type: "text", text: "hello off" }] },
    });
    await h.dispatch("session.append", {
      uuid: "d1",
      parentUuid: "d0",
      door: "prompt",
      origin: { kind: "composer" },
      message: { type: "user", content: [{ type: "text", text: `off ${"z".repeat(20000)}` }] },
    });
    h.sessionApi.set([]);
    await h.dispatch("turn.complete", { answer: "done", isAborted: false });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(h.spawned.calls.length).toBe(0);
  });
});

describe("startup backfill wiring — the classic.SessionStart start sequence", () => {
  test("a started session re-mirrors its transcript rows into the session dir", async () => {
    await h.load();
    await h.fsWrite("/cfg/projects/p/sess-bf.jsonl", mainSimpleJsonl());
    await h.dispatch("classic.SessionStart", {
      source: "startup",
      session_id: "sess-bf",
      transcript_path: "/cfg/projects/p/sess-bf.jsonl",
      cwd: "/w",
    });
    // the re-mirror wrote at least one mirror batch into the session dir
    const mirrorBatches = h.fsPaths().filter((p: string) => /session-owl\/sessions\/sess-bf\/m\d+-/.test(p));
    expect(mirrorBatches.length).toBeGreaterThan(0);
    // the batches carry the transcript's live rows verbatim (uuid-keyed)
    let allBatchText = "";
    for (const p of mirrorBatches) {
      const t = await h.fsRead(p);
      allBatchText += `${t ?? ""}\n`;
    }
    expect(allBatchText).toContain('"uuid":"m-1"');
  });

  test("the graph reconstructs over the mirrored rows (registry core built, initial prompt captured)", async () => {
    await h.load();
    await h.fsWrite("/cfg/projects/p/sess-bf2.jsonl", mainSimpleJsonl());
    await h.dispatch("classic.SessionStart", {
      source: "resume",
      session_id: "sess-bf2",
      transcript_path: "/cfg/projects/p/sess-bf2.jsonl",
      cwd: "/w",
    });
    // nGoal seeded + the initial prompt captured: at least one ledger
    // record file exists beyond the mirror batches and the marker
    const ledgerFiles = h
      .fsPaths()
      .filter((p: string) => /session-owl\/sessions\/sess-bf2\//.test(p))
      .filter((p: string) => !/\/m\d+-/.test(p) && !/\.session\.json$/.test(p) && !/timeline-/.test(p));
    expect(ledgerFiles.length).toBeGreaterThan(0);
  });
});

describe("compaction takeover wiring — session.compact", () => {
  const tail = [
    { role: "user", text: "first prompt", toolUses: [] },
    { role: "assistant", text: "a reply", toolUses: [] },
    { role: "user", text: "second prompt", toolUses: [] },
  ];

  test("an enabled session ANSWERS: summary first, the kept tail after, the stages ran", async () => {
    // fixture: the ensure-ready Builder must actually run its pass — opt out
    // of the budget fast-path (render-ready-skip) through the real settings
    // env the consumer initializes from
    h.env.set("CLAUDE_SETTINGS_SESSION_OWL", JSON.stringify({ builderSkipWithinBudget: false, keepRecentTokens: 1 }));
    await h.load();
    await h.fsWrite("/cfg/projects/p/sess-cp.jsonl", mainSimpleJsonl());
    await h.dispatch("classic.SessionStart", {
      source: "startup",
      session_id: "sess-cp",
      transcript_path: "/cfg/projects/p/sess-cp.jsonl",
      cwd: "/w",
    });
    await h.dispatch("session.append", {
      uuid: "c1",
      parentUuid: null,
      door: "prompt",
      origin: { kind: "composer" },
      message: { type: "user", content: [{ type: "text", text: `post-start ${"k".repeat(6000)}` }] },
    });
    h.sessionApi.set([]);
    const result = (await h.dispatch("session.compact", { trigger: "manual", messages: tail })) as {
      messages: Array<{ role: string; text: string }>;
      tokensAfter?: number;
    };
    expect(result.messages.length).toBe(2); // summary + the kept tail (budget 1: the newest row alone)
    expect(result.messages[0]?.role).toBe("user");
    expect(result.messages[0]?.text.startsWith("# Memory")).toBe(true);
    expect(result.messages.slice(1).map((m) => m.text)).toEqual(["second prompt"]); // the swallowed rows drop
    expect(typeof result.tokensAfter).toBe("number");
    // the ensure-ready phases launched at least the always-on Builder
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(h.spawned.calls.some((c: Record<string, unknown>) => String(c.subagentType).includes(":build"))).toBe(true);
  });

  test("disabled => pass through to the engine's own compaction (identity return)", async () => {
    await h.load();
    await h.dispatch("classic.SessionStart", {
      source: "startup",
      session_id: "sess-cp-off",
      transcript_path: "/cfg/projects/p/sess-cp-off.jsonl",
      cwd: "/w",
    });
    const st = await import("../host/state.js");
    st.setOwlEnabled(false);
    const event = { trigger: "manual", messages: tail };
    const returned = await h.dispatch("session.compact", event);
    expect(returned).toBe(event); // plain next(e) passthrough, never an answer
  });

  test("conflict-paused => pass through (the dormant contract)", async () => {
    await h.load();
    await h.dispatch("classic.SessionStart", {
      source: "startup",
      session_id: "sess-cp-paused",
      transcript_path: "/cfg/projects/p/sess-cp-paused.jsonl",
      cwd: "/w",
    });
    const pa = await import("../host/conflicts/pause.js");
    pa.setConflictHits([{ channel: "B", name: "other-mod@x", evidence: "compaction-hook" }]);
    try {
      const event = { trigger: "auto", messages: tail };
      const returned = await h.dispatch("session.compact", event);
      expect(returned).toBe(event);
    } finally {
      pa.setConflictHits(null);
    }
  });
});

describe("owl_recall serving — tool.call", () => {
  /** Arm a fresh session (the serve needs a current conversation). */
  async function start(sess: string): Promise<void> {
    await h.load();
    await h.dispatch("classic.SessionStart", {
      source: "startup",
      session_id: sess,
      transcript_path: `/cfg/projects/p/${sess}.jsonl`,
      cwd: "/w",
    });
  }

  /** Run a call and return its settled outcome (the harness rethrows). */
  async function call(event: Record<string, unknown>): Promise<any> {
    return await h.dispatch("tool.call", event);
  }

  test("an enabled session SERVES: the call answers {result}, never the passthrough event", async () => {
    await start("sess-rk-main");
    const event = { tool: OWL_RECALL_FULL_NAME, tool_use_id: "u-rk1" };
    const out = await call(event);
    expect(out).not.toBe(event); // pass-through returns the EVENT itself
    expect(typeof (out as { result?: unknown }).result).toBe("string");
    // a SEED-dependent exact browse text is the vendored executor's contract
    // (kit + handler suites pin it) — here the wiring claim: a plain browse
    // call never errors, it serves
    expect(String((out as { result: string }).result).length).toBeGreaterThan(0);
  });

  test("the model's arguments ride beside tool and reach the vendored executor", async () => {
    await start("sess-rk-input");
    const out = await call({ tool: OWL_RECALL_FULL_NAME, tool_use_id: "u-rk2", query: "w4-no-match" });
    // query present ⇒ the search path, NOT the root browse ("No memory yet.")
    expect((out as { result: string }).result).toBe("No matches.");
  });

  test("mid-session disabled => REJECTS with pi's exact reason text", async () => {
    await start("sess-rk-off");
    const st = await import("../host/state.js");
    st.setOwlEnabled(false);
    try {
      const out = await call({ tool: OWL_RECALL_FULL_NAME, tool_use_id: "u-rk3" });
      expect(out).toEqual({ deny: "session-owl is disabled (enable it first)." });
    } finally {
      st.setOwlEnabled(true);
    }
  });

  test("conflict-paused => SERVES (pause is not disabled; the tool is read-only)", async () => {
    await start("sess-rk-paused");
    const pa = await import("../host/conflicts/pause.js");
    pa.setConflictHits([{ channel: "B", name: "other-mod@x", evidence: "compaction-hook" }]);
    try {
      const out = await call({ tool: OWL_RECALL_FULL_NAME, tool_use_id: "u-rk4" });
      expect(out).not.toHaveProperty("tool");
      expect(typeof (out as { result?: unknown }).result).toBe("string");
    } finally {
      pa.setConflictHits(null);
    }
  });

  test("an in-band error result ANSWERS {deny} with its exact text (the model's error row)", async () => {
    await start("sess-rk-err");
    // `lines` without ids is a hard error inside executeRecall — the argument
    // must also survive the envelope mapping, so this pins both (the deny
    // delivery + input spread) at the dispatch surface
    const EXACT =
      "`lines` reads a range of a single observation — pass one observation id, or a node id with one observation.";
    const out = await call({ tool: OWL_RECALL_FULL_NAME, tool_use_id: "u-rk5", lines: "40-60" });
    expect(out).toEqual({ deny: EXACT });
  });

  test("another plugin's tool.call passes through untouched (identity)", async () => {
    await start("sess-rk-other");
    const other = { tool: "Read", tool_use_id: "u-rk6", file_path: "/x" };
    expect(await call(other)).toBe(other);
  });

  test("a subagent loop's call pins ITS OWN conversation binding (agentId composes the key)", async () => {
    await start("sess-rk-loop");
    expect(releaseBinding("sess-rk-loop|loop-1")).toBe(false); // nothing pinned yet
    const out = await call({
      tool: OWL_RECALL_FULL_NAME,
      tool_use_id: "u-rk7",
      agentId: "loop-1",
      query: "w4-loop-no-match",
    });
    expect((out as { result: string }).result).toBe("No matches.");
    expect(releaseBinding("sess-rk-loop|loop-1")).toBe(true); // the loop's binding exists (main key would not)
  });
});

describe("registration survives an engine-refused source (the unbound startup start)", () => {
  test("a refused tool.register neither burns the gate nor aborts the classic bootstrap", async () => {
    await h.load();
    // the startup classic start runs BEFORE the session binds: the engine
    // refuses $.tool.register until the later session.start
    h.refuseToolRegisters(1);
    await h.dispatch("classic.SessionStart", {
      source: "startup",
      session_id: "sess-refused",
      transcript_path: "/cfg/projects/p/sess-refused.jsonl",
      cwd: "/w",
    });
    const st = await import("../host/state.js");
    // the bootstrap SURVIVED the refusal (the conversation armed, the
    // marker written — everything after surfaces registration runs)
    expect(st.getCurrentSession()).toBe("sess-refused");
    expect(h.fsPaths()).toContain("/cfg/session-owl/sessions/sess-refused/.session.json");
    // the tools gate did NOT burn: the bound source registers the recall
    // tool at session.start (retry), exactly once
    h.clearToolRegisterRefusals();
    await h.dispatch("session.start", { cwd: "/w", surface: "terminal", prompt: true });
    const names = h.tools.registered.map((t: { name: string }) => t.name);
    expect(names.filter((n: string) => n === "owl_recall")).toHaveLength(1);
    await h.dispatch("session.start", { cwd: "/w", surface: "terminal", prompt: true }); // idempotence
    expect(
      h.tools.registered.map((t: { name: string }) => t.name).filter((n: string) => n === "owl_recall"),
    ).toHaveLength(1);
  });
});

describe("handback channel — no interception (the platform routes spawned agents' steps past us)", () => {
  test("the enforcer note for a stage agent intercepts nothing; the agent's turn.step passes through", async () => {
    await h.load();
    await h.dispatch("classic.SessionStart", {
      source: "startup",
      session_id: "sess-kill",
      transcript_path: "/cfg/projects/p/sess-kill.jsonl",
      cwd: "/w",
    });
    const bridge2 = await import("../host/engine-bridge.js");
    bridge2.recordSpawn("ag-kill-1", { stage: "observer" });
    try {
      // the engine's enforcer note arrives as a door-"note" row — with the
      // kill removed it is just another captured row: no arm, no suppression
      await h.dispatch("session.append", {
        uuid: "note-1",
        door: "note",
        origin: { kind: "engine" },
        agentId: "ag-kill-1",
        message: {
          type: "user",
          isMeta: true,
          content: [
            {
              type: "text",
              text: "[handback-send-enforce] Your report has not been delivered. Call SubagentHandback({message: <your full report>}).",
            },
          ],
        },
      });
      // a turn.step for that agent passes straight through (the dispatch
      // trace fires, the request is never suppressed)
      const out = await h.dispatch("turn.step", { turnId: "turn-9", index: 0, agentId: "ag-kill-1", model: "m" });
      expect((out as { turnId?: string }).turnId).toBe("turn-9");
      expect(bridge2.consumeDeliberateAbort("ag-kill-1")).toBe(false); // nothing marked
    } finally {
      bridge2.forgetSpawn("ag-kill-1");
    }
  });

  test("a main-loop turn.step refreshes the session-model fallback with the engine-resolved model", async () => {
    await h.load();
    const state2 = await import("../host/state.js");
    state2.setSessionModel(null);
    try {
      await h.dispatch("turn.step", { turnId: "turn-m1", index: 0, model: "mimo-v2.6-flash" });
      expect(state2.getSessionModel()).toBe("mimo-v2.6-flash");
      // a later dispatch with a different resolved model refreshes it
      await h.dispatch("turn.step", { turnId: "turn-m2", index: 0, model: "other-model" });
      expect(state2.getSessionModel()).toBe("other-model");
      // a subagent-bearing dispatch never touches the main-model slot
      const bridge2 = await import("../host/engine-bridge.js");
      bridge2.recordSpawn("ag-model-1", { stage: "observer" });
      try {
        await h.dispatch("turn.step", { turnId: "turn-m3", index: 0, agentId: "ag-model-1", model: "stage-model" });
        expect(state2.getSessionModel()).toBe("other-model");
      } finally {
        bridge2.forgetSpawn("ag-model-1");
      }
    } finally {
      state2.setSessionModel(null);
    }
  });

  test("the engine's default-model label is not a model id — the session-model slot records null instead", async () => {
    await h.load();
    const state2 = await import("../host/state.js");
    state2.setSessionModel(null);
    try {
      // the session-start config read holds the /config row's human label
      // when the session runs the default model — never forwardable (a
      // `$.model.complete` request sent it verbatim: 404 model_not_found)
      state2.setSessionModel("Default (recommended)");
      expect(state2.getSessionModel()).toBe(null);
      // a concrete id is kept, aliases too ([1m]-suffixed gateway ids included)
      state2.setSessionModel("mimo-v2.6-flash[1m]");
      expect(state2.getSessionModel()).toBe("mimo-v2.6-flash[1m]");
      state2.setSessionModel("haiku");
      expect(state2.getSessionModel()).toBe("haiku");
      // switching back to the default clears the stale concrete id — the
      // slot never names a model the session no longer runs
      state2.setSessionModel("Default (recommended)");
      expect(state2.getSessionModel()).toBe(null);
      // and a turn.step carrying the label over a concrete slot does the same
      state2.setSessionModel("sonnet");
      await h.dispatch("turn.step", { turnId: "turn-label", index: 0, model: "Default (recommended)" });
      expect(state2.getSessionModel()).toBe(null);
    } finally {
      state2.setSessionModel(null);
    }
  });

  test("classic.SessionStart records the engine's model from $.session.model() — start-time truth, no config model row", async () => {
    await h.load();
    const state2 = await import("../host/state.js");
    state2.setSessionModel(null);
    try {
      h.sessionModelApi.set("mimo-v2.6-flash[1m]");
      await h.dispatch("classic.SessionStart", {
        source: "startup",
        session_id: "sess-sm",
        transcript_path: "/cfg/projects/p/sess-sm.jsonl",
        cwd: "/w",
      });
      // the slot holds the CONCRETE id the engine serves at start — before
      // any message, so an immediate rescan can extract the goal
      expect(state2.getSessionModel()).toBe("mimo-v2.6-flash[1m]");
    } finally {
      state2.setSessionModel(null);
      h.sessionModelApi.set("probed-session-model");
    }
  });

  test("a rejected $.session.model read at start leaves the slot null — the config row is never the source", async () => {
    await h.load();
    const state2 = await import("../host/state.js");
    state2.setSessionModel(null);
    try {
      h.sessionModelApi.set(null, new Error("engine getter unavailable"));
      await h.dispatch("classic.SessionStart", {
        source: "startup",
        session_id: "sess-sm-err",
        transcript_path: "/cfg/projects/p/sess-sm-err.jsonl",
        cwd: "/w",
      });
      expect(state2.getSessionModel()).toBe(null);
    } finally {
      state2.setSessionModel(null);
      h.sessionModelApi.set("probed-session-model");
    }
  });

  test("the file-boundary singleton reset clears the session-model slot (isolate:false files must not inherit it)", async () => {
    const state2 = await import("../host/state.js");
    const { resetClaudeHostSingletons } = await import("./helpers/host-teardown.js");
    // a spec's SessionStart dispatch leaves the slot set — the NEXT file
    // must not read it (its own chain would resolve a foreign model)
    state2.setSessionModel("leaked-model");
    await resetClaudeHostSingletons();
    expect(state2.getSessionModel()).toBe(null);
  });

  test("classic.SessionStart seeds the widget's window from $.session.usage() — denominator ready before any measure", async () => {
    await h.load();
    const { windowFor, _resetMeasureSnapshots } = await import("../host/triggers/context.js");
    h.sessionUsageApi.set(128_000);
    try {
      await h.dispatch("classic.SessionStart", {
        source: "startup",
        session_id: "sess-window-seed",
        transcript_path: "/cfg/projects/p/sess-window-seed.jsonl",
        cwd: "/w",
      });
      expect(windowFor("sess-window-seed")).toBe(128_000);
    } finally {
      h.sessionUsageApi.set(128_000);
      _resetMeasureSnapshots();
    }
  });

  test("a rejected $.session.usage() read at start leaves the window unseeded (best-effort, never a gate)", async () => {
    await h.load();
    const { windowFor, _resetMeasureSnapshots } = await import("../host/triggers/context.js");
    h.sessionUsageApi.set(null, new Error("usage unavailable"));
    try {
      await h.dispatch("classic.SessionStart", {
        source: "startup",
        session_id: "sess-window-seed-err",
        transcript_path: "/cfg/projects/p/sess-window-seed-err.jsonl",
        cwd: "/w",
      });
      expect(windowFor("sess-window-seed-err")).toBeNull();
    } finally {
      h.sessionUsageApi.set(128_000);
      _resetMeasureSnapshots();
    }
  });
});

describe("main-only strip of session-owl from injected MCP text (prompt.attachment)", () => {
  const instructionText = [
    "# MCP Server Instructions",
    "",
    "The following MCP servers have provided instructions for how to use their tools and resources:",
    "",
    "## session-owl",
    "Tools registered by the session-owl plugin through $.tool.register.",
    "",
    "## session-owl-subagent-support",
    "Tools registered by the session-owl-subagent-support plugin through $.tool.register.",
    "",
    "## comfyui",
    "ComfyUI instructions stay.",
  ].join("\n");
  const deltaText = [
    "mcp__comfyui__get_queue",
    "mcp__session-owl__cat",
    "mcp__session-owl__find",
    "mcp__session-owl-subagent-support__launch",
    "mcp__duckduckgo-mcp-server__search",
  ].join("\n");

  test("main: mcp_instructions_delta loses every session-owl block, foreign blocks and intro stay", async () => {
    await h.load();
    const ev = { type: "mcp_instructions_delta", text: instructionText, origin: { kind: "engine" } };
    const res = await h.dispatch("prompt.attachment", ev);
    expect(res).not.toBe(ev); // answered, not passed through
    expect(res.text).not.toContain("session-owl");
    expect(res.text).toContain("## comfyui");
    expect(res.text).toContain("The following MCP servers");
  });

  test("main: deferred_tools_delta drops the session-owl name lines, keeps the rest", async () => {
    await h.load();
    const res = await h.dispatch("prompt.attachment", { type: "deferred_tools_delta", text: deltaText });
    const kept: string[] = res.text.split("\n");
    expect(kept).not.toContain("mcp__session-owl__cat");
    expect(kept).not.toContain("mcp__session-owl__find");
    expect(kept).not.toContain("mcp__session-owl-subagent-support__launch");
    expect(kept).toContain("mcp__comfyui__get_queue");
    expect(kept).toContain("mcp__duckduckgo-mcp-server__search");
  });

  test("main: a delta that is only session-owl empties out to text: null", async () => {
    await h.load();
    const res = await h.dispatch("prompt.attachment", {
      type: "deferred_tools_delta",
      text: "mcp__session-owl__cat\nmcp__session-owl__ls",
    });
    expect(res).toEqual({ text: null });
  });

  test("subagent (agentId set): the same text passes through untouched", async () => {
    await h.load();
    const ev = { type: "deferred_tools_delta", text: deltaText, agentId: "ag-stage-1" };
    const res = await h.dispatch("prompt.attachment", ev);
    expect(res).toBe(ev);
  });

  test("lifecycle diagnostics carry source, cwd presence, resolved settings and the end reason", async () => {
    const spy = vi.spyOn(log, "info").mockImplementation(() => {});
    await h.load();
    // THE traced shape: a classic start WITHOUT a cwd field (the /branch /
    // fork envelope)
    await h.dispatch("classic.SessionStart", {
      source: "fork",
      session_id: "sess-trace",
      transcript_path: "/cfg/projects/p/sess-trace.jsonl",
      // cwd deliberately absent
    });
    await h.dispatch("session.end", { reason: "resume", sessionId: "sess-trace" });
    // reload AFTER the end — the classic start performs its own settings reload
    await h.dispatch("classic.SessionStart", {
      source: "resume",
      session_id: "sess-trace-2",
      transcript_path: "/cfg/projects/p/sess-trace-2.jsonl",
      cwd: "/w",
    });
    const lines = spy.mock.calls.map((c) => String(c[0] ?? ""));
    const text = lines.join("\n");
    expect(text).toContain("classic SessionStart source=fork session=sess-trace cwd=<absent>");
    expect(text).toContain("session.end reason=resume session=sess-trace");
    // the settings reload the classic start performs — empty cwd = the
    // project layer falls out and defaults win
    expect(text).toMatch(/settings: (first-load|reload) cwd=""/);
    // loader probes: exactly what the loader SAW before deciding (argument
    // shapes asserted explicitly)
    expect(text).toContain("settings env.get probe =");
    expect(text).toContain("settings env.set probe name=");
    // THE arity guard: the VALUE must be a settings JSON blob, never the
    // env-var NAME (a NAME-as-value write resets every layer to defaults)
    expect(text).toMatch(/settings env\.set probe name=CLAUDE_SETTINGS_SESSION_OWL valueHead="\{/);
    spy.mockRestore();
  });

  test("a fork start copies the origin's owl store for the new session id (lineage copy)", async () => {
    await h.load();
    const first = JSON.stringify({
      kind: "user",
      sessionId: "sess-b2",
      forkedFrom: { sessionId: "sess-o2" },
    });
    await h.fsWrite("/cfg/projects/p/sess-b2.jsonl", `${first}\n{}`);
    await h.fsWrite("/cfg/session-owl/sessions/sess-o2/ledger-a.jsonl", "ORIGIN-BYTES");
    await h.fsWrite("/cfg/session-owl/sessions/sess-o2/m1-x.jsonl", "ORIGIN-MIRROR");
    await h.fsWrite("/cfg/session-owl/sessions/sess-o2/.session.json", '{"sessionId":"sess-o2"}');
    await h.dispatch("classic.SessionStart", {
      source: "fork",
      session_id: "sess-b2",
      transcript_path: "/cfg/projects/p/sess-b2.jsonl",
      cwd: "/w",
    });
    // the derived state travels with the copied transcript
    expect(await h.fsRead("/cfg/session-owl/sessions/sess-b2/ledger-a.jsonl")).toBe("ORIGIN-BYTES");
    expect(await h.fsRead("/cfg/session-owl/sessions/sess-b2/m1-x.jsonl")).toBe("ORIGIN-MIRROR");
    // the marker stays the NEW session's envelope facts (never the origin's)
    const marker = JSON.parse(await h.fsRead("/cfg/session-owl/sessions/sess-b2/.session.json"));
    expect(marker.sessionId).toBe("sess-b2");
    expect(marker.transcriptPath).toBe("/cfg/projects/p/sess-b2.jsonl");
    // the origin's store is never touched
    expect(await h.fsRead("/cfg/session-owl/sessions/sess-o2/.session.json")).toBe('{"sessionId":"sess-o2"}');
  });

  test("main: an unrelated attachment type never sees the filter", async () => {
    await h.load();
    const ev = { type: "skill_listing", text: "mentions session-owl in prose stays" };
    const res = await h.dispatch("prompt.attachment", ev);
    expect(res).toBe(ev);
  });

  test("subagent handoff (classic.SubagentStop) evicts the loop's resident state", async () => {
    const gs = await import("../core/src/store/graph-store.js");
    await h.load();
    const key = "sess-handoff|agent16hex000001";
    gs.activateConversation(key);
    const resident = gs.getGraphStore();
    expect(gs.activateConversation(key).resident).toBe(true); // hydrated
    await h.dispatch("classic.SubagentStop", {
      session_id: "sess-handoff",
      agent_id: "agent16hex000001",
      agent_transcript_path: "/cfg/sess-handoff/subagents/agent16hex000001.jsonl",
      agent_type: "general-purpose",
      stop_hook_active: false,
    });
    await new Promise((r) => setTimeout(r, 30)); // the eviction awaits the
    // run-lock and completes on a microtask behind the dispatch
    expect(gs.activateConversation(key).resident).toBe(false);
    expect(gs.getGraphStore()).not.toBe(resident); // a resume re-hydrates cold
  });

  test("a still-running stage run defers the handoff eviction until its release", async () => {
    const gs = await import("../core/src/store/graph-store.js");
    await h.load();
    const key = "sess-handoff|agent16hex000002";
    gs.activateConversation(key);
    const resident = gs.getGraphStore(); // hydrate the state
    expect(gs.activateConversation(key).resident).toBe(true);
    const held = acquireOrSkip(key, "observe"); // the loop's stage run drains
    expect(held).not.toBeNull();
    await h.dispatch("classic.SubagentStop", {
      session_id: "sess-handoff",
      agent_id: "agent16hex000002",
      agent_transcript_path: "/cfg/sess-handoff/subagents/agent16hex000002.jsonl",
      agent_type: "general-purpose",
      stop_hook_active: false,
    });
    await new Promise((r) => setTimeout(r, 30));
    expect(gs.activateConversation(key).resident).toBe(true); // still draining
    held?.release();
    await new Promise((r) => setTimeout(r, 30));
    expect(gs.activateConversation(key).resident).toBe(false);
    expect(gs.getGraphStore()).not.toBe(resident); // a resume re-hydrates cold
  });
});
