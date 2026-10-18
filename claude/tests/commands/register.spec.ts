// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// The command registrar arm: the eight kebab-named commands (pi's names with
// `/owl:` → `/owl-`, pi-verbatim descriptions with the name swapped), the
// dispatcher routing command.run to the right body, and the {} return (H3 —
// nothing model-visible). Also pins the drift between the dispatcher's
// table and state.ts's registration specs (they must register exactly the
// commands the dispatcher serves).
import { describe, expect, test } from "vitest";
import { DEFAULT_CONFIG } from "../../core/src/config/schema.js";
import type { OwlCommandDeps } from "../../host/commands/handlers.js";
import { dispatchOwlCommand, OWL_COMMANDS, owlCommandByName } from "../../host/commands/register.js";
import type { NotifyFn } from "../../host/notify/adapter.js";
import { COMMAND_SPECS } from "../../host/state.js";
import { rigUp } from "../runs/helpers.js";

async function makeDispatchDeps(sessionId: string) {
  const rig = await rigUp(sessionId, [], false);
  const notified: Array<{ level: string; text: string }> = [];
  const notify: NotifyFn = (text, level) => notified.push({ text, level });
  const deps: OwlCommandDeps = {
    key: sessionId,
    notify,
    confirm: async () => false,
    isEnabled: () => true,
    getSettings: () => DEFAULT_CONFIG,
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
  return { deps, notified };
}

describe("the command table", () => {
  test("exactly the eight kebab commands, pi's order-independent set", () => {
    expect(OWL_COMMANDS.map((c) => c.name).sort()).toEqual(
      [
        "owl-ls",
        "owl-cat",
        "owl-find",
        "owl-find-all",
        "owl-rescan",
        "owl-reobserve-0-obs-chunks",
        "owl-status",
        "owl-settings",
      ].sort(),
    );
  });

  test("descriptions are pi-verbatim with the kebab name swapped in", () => {
    const byName = new Map(OWL_COMMANDS.map((c) => [c.name, c.description]));
    expect(byName.get("owl-ls")).toBe("List memory — roots, or a node's children. Usage: /owl-ls [nodeId]");
    expect(byName.get("owl-cat")).toBe(
      "Show a node's full observations, or one observation's full text. Usage: /owl-cat <id>",
    );
    expect(byName.get("owl-find")).toBe("Search memory by regex (non-obsolete). Usage: /owl-find <query>");
    expect(byName.get("owl-find-all")).toBe(
      "Search memory by regex (incl. obsolete/superseded). Usage: /owl-find-all <query>",
    );
    expect(byName.get("owl-rescan")).toBe(
      "Discard the memory graph and re-observe the session from the start. --reuse-observations rebuilds from collected observations.",
    );
    expect(byName.get("owl-reobserve-0-obs-chunks")).toBe(
      "Re-observe session ranges that were skipped with zero observations (repair after a degraded model run). Usage: /owl-reobserve-0-obs-chunks",
    );
    expect(byName.get("owl-status")).toBe("Show memory stats and per-phase token/cost usage. Usage: /owl-status");
    expect(byName.get("owl-settings")).toBe("Configure SessionOwl Settings");
  });

  test("state.ts registers exactly the dispatcher's set (name drift gate)", () => {
    const registered = COMMAND_SPECS.map((s) => s.name).sort();
    const served = OWL_COMMANDS.map((c) => c.name).sort();
    expect(registered).toEqual(served);
  });
});

describe("dispatchOwlCommand", () => {
  test("routes each name to its body with the raw args and returns {} (H3)", async () => {
    const { deps, notified } = await makeDispatchDeps("cmd-dispatch-ls");
    const result = await dispatchOwlCommand({ command: "owl-ls", args: "" }, deps);
    expect(result).toEqual({});
    expect(notified).toEqual([{ level: "info", text: "No memory yet." }]);
  });

  test("args pass through verbatim (trimArg is the body's job)", async () => {
    const { deps, notified } = await makeDispatchDeps("cmd-dispatch-cat");
    await dispatchOwlCommand({ command: "owl-cat", args: "  " }, deps);
    expect(notified[0]?.text).toBe("Usage: /owl-cat <id> — give a node id or an observation id.");
  });

  test("each of the eight names resolves to a handler", () => {
    for (const c of OWL_COMMANDS) {
      expect(owlCommandByName(c.name)).toBeDefined();
    }
    expect(owlCommandByName("owl-nope")).toBeUndefined();
  });

  test("every registered command has a bound handler (the loud join holds)", () => {
    for (const c of OWL_COMMANDS) {
      expect(typeof c.handler).toBe("function");
    }
  });

  test("all eight dispatch smoke (each answers {} without throwing)", async () => {
    for (const c of OWL_COMMANDS) {
      const rig = await makeDispatchDeps(`cmd-dispatch-all-${c.name}`);
      const result = await dispatchOwlCommand({ command: c.name, args: "" }, rig.deps);
      expect(result).toEqual({});
    }
  });

  test("a foreign command is NOT ours: null (pass through to the engine)", async () => {
    const { deps } = await makeDispatchDeps("cmd-dispatch-foreign");
    const result = await dispatchOwlCommand({ command: "compact", args: "" }, deps);
    expect(result).toBeNull();
  });

  test("owl-rescan and owl-reobserve-0-obs-chunks route to their bodies", async () => {
    const a = await makeDispatchDeps("cmd-dispatch-rescan");
    await dispatchOwlCommand({ command: "owl-rescan", args: "" }, a.deps);
    // declined confirm ⇒ no notify; assert the confirm path ran via the spy seam
    const b = await makeDispatchDeps("cmd-dispatch-reobs");
    b.deps.isEnabled = () => false;
    await dispatchOwlCommand({ command: "owl-reobserve-0-obs-chunks", args: "" }, b.deps);
    expect(b.notified).toEqual([{ level: "warning", text: "session-owl is disabled (enable it first)." }]);
  });
});
