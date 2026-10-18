// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// The /owl-status and /owl-settings shells: the disabled guard with pi's
// exact notice, and the visible degrade while the serve deps are unwired —
// no silent no-ops. When the serve* deps bind, the shells delegate to them
// verbatim.
import { describe, expect, test, vi } from "vitest";
import { DEFAULT_CONFIG } from "../../core/src/config/schema.js";
import type { OwlCommandDeps } from "../../host/commands/handlers.js";
import { runOwlSettings, runOwlStatus } from "../../host/commands/handlers.js";
import type { NotifyFn } from "../../host/notify/adapter.js";
import { rigUp } from "../runs/helpers.js";

interface Notified {
  level: string;
  text: string;
}

async function makeShellDeps(sessionId: string) {
  const rig = await rigUp(sessionId, [], true);
  const notified: Notified[] = [];
  const notify: NotifyFn = (text, level) => notified.push({ level, text });
  let enabled = true;
  const deps: OwlCommandDeps = {
    key: sessionId,
    notify,
    confirm: async () => false,
    isEnabled: () => enabled,
    getSettings: () => ({ ...DEFAULT_CONFIG, enabled }),
    checkThenServe: async () => {},
    pinCore: async () => {},
    getGraphStore: () => rig.core.store.getGraphStore(),
    getLeafId: () => rig.store.getLeafId(),
    getBranch: () => rig.store.getBranch(rig.store.getLeafId()) as never,
    resetGraphForRescan: () => {},
    relaunchMaintenance: () => {},
    acquireForCompaction: async () => {
      throw new Error("unused");
    },
    acquireOrSkipObserve: () => null,
    runReuseRebuild: async () => {},
    runObserver: async () => {},
    runBuilder: async () => {},
  };
  return { deps, notified, setEnabled: (v: boolean) => (enabled = v) };
}

describe("/owl-status shell", () => {
  test("disabled: pi's exact status notice", async () => {
    const { deps, notified } = await makeShellDeps("cmd-status-disabled");
    deps.isEnabled = () => false;
    await runOwlStatus("", deps);
    expect(notified).toEqual([{ level: "info", text: "session-owl is disabled." }]);
  });

  test("enabled, no serve dep: the interim degrade (visible, not silent)", async () => {
    const { deps, notified } = await makeShellDeps("cmd-status-interim");
    await runOwlStatus("", deps);
    expect(notified).toHaveLength(1);
    expect(notified[0]?.text).toContain("session-owl");
    expect(notified[0]?.text.length).toBeGreaterThan("session-owl".length);
  });

  test("serveStatusReport bound: its report flows through the notify adapter (multi-line)", async () => {
    const { deps, notified } = await makeShellDeps("cmd-status-bound");
    deps.serveStatusReport = async () => "🦉 session-owl — status\n\nline two";
    await runOwlStatus("", deps);
    expect(notified).toEqual([{ level: "info", text: "🦉 session-owl — status\n\nline two" }]);
  });

  test("serveStatusReport failure: pi's exact status-failed template (error level)", async () => {
    const { deps, notified } = await makeShellDeps("cmd-status-fail");
    deps.serveStatusReport = vi.fn(async () => {
      throw new Error("ledger exploded");
    });
    await runOwlStatus("", deps);
    expect(notified).toEqual([{ level: "error", text: "session-owl status failed: ledger exploded" }]);
  });
});

describe("/owl-settings shell", () => {
  test("disabled: the pane still opens (settings is the re-enable path — pi opens unconditionally)", async () => {
    const { deps, notified } = await makeShellDeps("cmd-settings-disabled");
    deps.isEnabled = () => false;
    let served = 0;
    deps.serveSettings = async () => {
      served++;
    };
    await runOwlSettings("", deps);
    expect(served).toBe(1); // delegated to the pane — never a disabled notice
    expect(notified).toEqual([]);
  });

  test("enabled, no serve dep: the interim degrade (visible, not silent)", async () => {
    const { deps, notified } = await makeShellDeps("cmd-settings-interim");
    await runOwlSettings("", deps);
    expect(notified).toHaveLength(1);
    expect(notified[0]?.text).toContain("session-owl");
  });

  test("serveSettings bound: the shell delegates and stays silent itself", async () => {
    const { deps, notified } = await makeShellDeps("cmd-settings-bound");
    const served = vi.fn(async () => {});
    deps.serveSettings = served;
    await runOwlSettings("", deps);
    expect(served).toHaveBeenCalledTimes(1);
    expect(notified).toEqual([]); // the pane speaks for itself (pi parity)
  });
});
