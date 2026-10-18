// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>
//
// The full-service arm invariant: every handler that arms the bridge arms
// the SAME complete table — a row event (append/turn.complete) re-arming a
// minimal subset would strip uiInvalidate/toolRegister/agentSpawn from
// currentServices(), breaking the settings after-change capsules (and the
// stage spawn path) after any row fired.
import { beforeEach, describe, expect, test } from "vitest";
import { currentServices } from "../host/engine-bridge.js";
import { createHarness } from "./helpers/harness.js";

describe("bridge arm tables — one full superset from every handler", () => {
  let h: ReturnType<typeof createHarness>;
  beforeEach(async () => {
    h = createHarness();
    await h.load();
    await h.dispatch("classic.SessionStart", {
      session_id: "s-arm-1",
      cwd: "/w",
      source: "startup",
      transcript_path: "/t/s-arm-1.jsonl",
    });
  });

  test("after session.append re-arms, the non-fs services are still armed", async () => {
    await h.dispatch("session.append", { door: "prompt", uuid: "u-1", row: {} });
    const svcs = currentServices();
    expect(typeof svcs.uiInvalidate).toBe("function");
    expect(typeof svcs.toolRegister).toBe("function");
    expect(typeof svcs.agentSpawn).toBe("function");
    expect(typeof svcs.uiLog).toBe("function");
  });

  test("after turn.complete re-arms, the same full table holds", async () => {
    await h.dispatch("turn.complete", { answer: "", isAborted: false });
    const svcs = currentServices();
    expect(typeof svcs.uiInvalidate).toBe("function");
    expect(typeof svcs.toolRegister).toBe("function");
    expect(typeof svcs.agentSpawn).toBe("function");
    expect(typeof svcs.envGetSessionOwlSettings).toBe("function");
  });

  test("report() rides the USER-VISIBLE ui transport once services are armed", async () => {
    // a broken event shape trips a report() path; the ui recorder must see
    // the error line UNPREFIXED — sayError's $.ui.log copy is a transcript
    // row the user sees (no [debug] prefix — errors surface on file log +
    // ui, console strictly last)
    await h.dispatch("session.append", { door: 12345, uuid: null, row: null }); // malformed on purpose
    // the ui copy carries the error UNPREFIXED — the engine's own row
    // attribution names the plugin (report's uiText drops the manual prefix)
    expect(h.uiLog.length).toBeGreaterThan(0);
    expect(h.uiLog.some((l) => l.startsWith("session-owl: session-owl:"))).toBe(false); // never doubled
  });

  test("session.start arms the full table too (fsStat included)", async () => {
    await h.dispatch("session.start", { cwd: "/w", surface: "terminal", prompt: true });
    const svcs = currentServices();
    expect(typeof svcs.fsStat).toBe("function");
    expect(typeof svcs.agentSpawn).toBe("function");
  });
});
