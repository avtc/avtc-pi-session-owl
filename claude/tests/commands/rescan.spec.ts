// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// /owl-rescan — pi's two-mode body ported: the disabled warning, the reuse
// mode (nothing-to-rebuild guard, confirm, launch notify, fire-and-forget
// rebuild under the compaction lock) and the plain mode (confirm, void the
// graph, launch notify, fire-and-forget maintenance relaunch). Titles,
// bodies, and notify texts are pi's verbatim.
import { describe, expect, test, vi } from "vitest";
import { O_INITIAL_PROMPT } from "../../core/src/types.js";
import type { OwlCommandDeps } from "../../host/commands/handlers.js";
import { runOwlRescan } from "../../host/commands/handlers.js";
import type { NotifyFn } from "../../host/notify/adapter.js";
import type { RunHandle } from "../../host/triggers/run-locks.js";
import { rigUp } from "../runs/helpers.js";

interface Notified {
  level: string;
  text: string;
}

interface RescanRig {
  deps: OwlCommandDeps;
  notified: Notified[];
  confirm: ReturnType<typeof vi.fn>;
  reset: ReturnType<typeof vi.fn>;
  relaunch: ReturnType<typeof vi.fn>;
  reuseRebuild: ReturnType<typeof vi.fn>;
  handles: Array<{ released: boolean; controller: AbortController }>;
  launched: unknown[];
}

async function makeRescanDeps(sessionId: string, observations = 0): Promise<RescanRig> {
  const rig = await rigUp(sessionId, [], true);
  const graph = rig.core.store.getGraphStore().graph;
  // seed `observations` collected records (oInitialPrompt does not count)
  for (let i = 0; i < observations; i += 1) {
    graph.observations.set(`oExtra${i}` as never, { id: `oExtra${i}`, summary: "x" } as never);
  }
  const notified: Notified[] = [];
  const notify: NotifyFn = (text, level) => notified.push({ level, text });
  const confirm = vi.fn(async () => false);
  const reset = vi.fn(() => {});
  const relaunch = vi.fn(() => {});
  const reuseRebuild = vi.fn(async () => {});
  const handles: Array<{ released: boolean; controller: AbortController }> = [];
  const launched: unknown[] = [];
  const deps: OwlCommandDeps = {
    key: sessionId,
    notify,
    confirm,
    isEnabled: () => true,
    getSettings: () => ({ enabled: true }) as OwlCommandDeps["getSettings"] extends () => infer S ? S : never,
    checkThenServe: async () => {},
    pinCore: async () => {},
    getGraphStore: () => rig.core.store.getGraphStore(),
    getLeafId: () => rig.store.getLeafId(),
    getBranch: () => rig.store.getBranch(rig.store.getLeafId()) as never,
    resetGraphForRescan: reset,
    relaunchMaintenance: relaunch,
    acquireForCompaction: async () => {
      const entry = { released: false, controller: new AbortController() };
      handles.push(entry);
      const handle: RunHandle = {
        release: () => {
          entry.released = true;
        },
        abortController: entry.controller,
        setStage: () => {},
      };
      return handle;
    },
    acquireOrSkipObserve: () => null,
    runReuseRebuild: reuseRebuild,
    runObserver: async () => {},
    runBuilder: async () => {},
    onLaunched: (p) => launched.push(p),
  };
  return { deps, notified, confirm, reset, relaunch, reuseRebuild, handles, launched };
}

describe("/owl-rescan — the shared disabled guard", () => {
  test("disabled: pi's exact warning, no confirm, no launch", async () => {
    const { deps, notified, confirm } = await makeRescanDeps("cmd-rescan-disabled");
    deps.isEnabled = () => false;
    await runOwlRescan("", deps);
    expect(notified).toEqual([{ level: "warning", text: "session-owl is disabled (enable it first)." }]);
    expect(confirm).not.toHaveBeenCalled();
  });

  test("bootstrap-paused: the pause warning with the disable alternative, no confirm, no launch", async () => {
    const { deps, notified, confirm } = await makeRescanDeps("cmd-rescan-blocked");
    (deps as { isBootstrapBlocked?: () => boolean }).isBootstrapBlocked = () => true;
    await runOwlRescan("", deps);
    expect(notified).toEqual([
      {
        level: "warning",
        text: "session-owl is paused — history bootstrap pending (see /owl-status; or turn it off in /owl-settings)",
      },
    ]);
    expect(confirm).not.toHaveBeenCalled();
  });
});

describe("/owl-rescan --reuse-observations", () => {
  test("no collected observations: pi's exact nothing-to-rebuild notice, no confirm", async () => {
    const { deps, notified, confirm } = await makeRescanDeps("cmd-reuse-empty");
    await runOwlRescan("--reuse-observations", deps);
    expect(notified).toEqual([{ level: "info", text: "Nothing to rebuild — no collected observations yet." }]);
    expect(confirm).not.toHaveBeenCalled();
  });

  test("the oInitialPrompt record does not count as collected", async () => {
    const { deps, notified } = await makeRescanDeps("cmd-reuse-promptonly");
    deps
      .getGraphStore()
      .graph.observations.set(O_INITIAL_PROMPT as never, { id: O_INITIAL_PROMPT, summary: "prompt" } as never);
    await runOwlRescan("--reuse-observations", deps);
    expect(notified[0]?.text).toBe("Nothing to rebuild — no collected observations yet.");
  });

  test("confirm declined: nothing happens after the dialog", async () => {
    const { deps, notified, relaunch, reuseRebuild } = await makeRescanDeps("cmd-reuse-decline", 3);
    await runOwlRescan("--reuse-observations", deps);
    expect(notified).toEqual([]);
    expect(relaunch).not.toHaveBeenCalled();
    expect(reuseRebuild).not.toHaveBeenCalled();
  });

  test("confirm accepted: pi's exact title + body with the live count", async () => {
    const { deps, confirm } = await makeRescanDeps("cmd-reuse-confirm", 3);
    await runOwlRescan("--reuse-observations", deps);
    expect(confirm).toHaveBeenCalledTimes(1);
    const [title, body] = confirm.mock.calls[0] as [string, string];
    expect(title).toBe("Rebuild memory");
    expect(body).toBe(
      "Discard the current graph structure and rebuild it from the 3 collected observations without re-observing the session? The observation ledger, frontier, and usage are kept. This cannot be undone.",
    );
  });

  test("launch: the notify text with the count, then the rebuild runs under the compaction lock and releases", async () => {
    const { deps, notified, reuseRebuild, handles, launched } = await makeRescanDeps("cmd-reuse-launch", 3);
    deps.confirm = async () => true;
    await runOwlRescan("--reuse-observations", deps);
    expect(notified).toEqual([
      { level: "info", text: "Rebuilding — re-wrapping 3 collected observations into a fresh graph…" },
    ]);
    expect(launched).toHaveLength(1);
    await (launched[0] as Promise<void>);
    expect(reuseRebuild).toHaveBeenCalledTimes(1);
    expect(handles).toHaveLength(1);
    expect(handles[0]?.released).toBe(true);
  });

  test("a rebuild failure releases the lock and never rejects the launch", async () => {
    const { deps, reuseRebuild, handles, launched } = await makeRescanDeps("cmd-reuse-fail", 2);
    deps.confirm = async () => true;
    reuseRebuild.mockRejectedValueOnce(new Error("boom"));
    await runOwlRescan("--reuse-observations", deps);
    await expect(launched[0] as Promise<void>).resolves.toBeUndefined();
    expect(handles[0]?.released).toBe(true);
  });
});

describe("/owl-rescan (plain)", () => {
  test("confirm declined: the graph is NOT reset", async () => {
    const { deps, reset, relaunch, notified } = await makeRescanDeps("cmd-plain-decline");
    await runOwlRescan("", deps);
    expect(reset).not.toHaveBeenCalled();
    expect(relaunch).not.toHaveBeenCalled();
    expect(notified).toEqual([]);
  });

  test("pi's exact title + body", async () => {
    const { deps, confirm } = await makeRescanDeps("cmd-plain-confirm");
    await runOwlRescan("", deps);
    const [title, body] = confirm.mock.calls[0] as [string, string];
    expect(title).toBe("Rescan memory");
    expect(body).toBe(
      "Discard the current memory graph (observations, nodes, selected tree) and re-observe the entire session from the start? This cannot be undone.",
    );
  });

  test("confirm accepted: reset, pi's exact rescan notify, then the maintenance relaunch fires", async () => {
    const { deps, reset, relaunch, notified } = await makeRescanDeps("cmd-plain-launch");
    deps.confirm = async () => true;
    await runOwlRescan("", deps);
    expect(reset).toHaveBeenCalledTimes(1);
    expect(notified).toEqual([{ level: "info", text: "Rescanning — observing the session from the start…" }]);
    expect(relaunch).toHaveBeenCalledTimes(1);
  });

  test("the pin placements: after the guard, after the confirm, and inside the launch", async () => {
    const pins: string[] = [];
    const { deps } = await makeRescanDeps("cmd-reuse-pins", 2);
    deps.pinCore = async () => {
      pins.push("pin");
    };
    deps.confirm = async () => true;
    await runOwlRescan("--reuse-observations", deps);
    // post-guard/pre-count + inside the launch after the lock acquire
    expect(pins).toEqual(["pin", "pin"]);
    // plain mode: post-guard pin + post-confirm pin
    const pins2: string[] = [];
    const b = await makeRescanDeps("cmd-plain-pins");
    b.deps.pinCore = async () => {
      pins2.push("pin");
    };
    b.deps.confirm = async () => true;
    await runOwlRescan("", b.deps);
    expect(pins2).toEqual(["pin", "pin"]); // after the guard + after the confirm
  });

  test("a relaunch failure is contained (logged, never an unhandled rejection)", async () => {
    const { deps, launched } = await makeRescanDeps("cmd-plain-relaunchfail");
    deps.confirm = async () => true;
    deps.relaunchMaintenance = async () => {
      throw new Error("trigger chain blew up");
    };
    await runOwlRescan("", deps);
    await expect(launched[0] as Promise<void>).resolves.toBeUndefined();
  });

  test("the reuse flag is detected anywhere in the args (pi's includes check)", async () => {
    const { deps, confirm } = await makeRescanDeps("cmd-plain-flagpos", 1);
    await runOwlRescan("  --reuse-observations  ", deps);
    expect(confirm).toHaveBeenCalledTimes(1);
    expect((confirm.mock.calls[0] as string[])[0]).toBe("Rebuild memory");
  });
});

describe("/owl-rescan (plain) — goal-extraction sequencing (owner ruling)", () => {
  test("the reset waits for an in-flight goal extraction to settle", async () => {
    const { deps, reset, relaunch } = await makeRescanDeps("cmd-plain-settle");
    deps.confirm = async () => true;
    let release!: () => void;
    deps.goalExtractSettled = () =>
      new Promise<void>((resolve) => {
        release = resolve;
      });
    const run = runOwlRescan("", deps);
    await new Promise((resolve) => setImmediate(resolve));
    // suspended at the settle await — the graph is still untouched
    expect(reset).not.toHaveBeenCalled();
    expect(relaunch).not.toHaveBeenCalled();
    release();
    await run;
    expect(reset).toHaveBeenCalledTimes(1);
    expect(relaunch).toHaveBeenCalledTimes(1);
  });
});
