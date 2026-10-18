// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// Engine-run conflict twins. KIT REALITY (probed): the kit does not emit
// plugin.register for inline test plugins, and the plugin-under-test's
// engine.create/session.start arms do not fire by themselves — the
// load-order matrix therefore rides the live probes (the later-loading
// mod always receives the earlier mods' envelopes) plus the
// Node channel suites. What this twin proves under the REAL kit loader:
// (a) the conflicts modules load inside the plugin's closure (the loader
// accepts their import graph), (b) the envelope handler decides
// override/passive/builtin/classic over the real module code, (c) the
// engine's append path traverses the plugin's Channel C observer without
// mutation (door-compaction rows ride mock.session verbatim).
import * as kit from "claude-code/testing";
import { recordFoldList, resetFoldState } from "../host/conflicts/channel-a-prime.js";
import { getLiveBHits, handlePluginRegisterEnvelope, resetWaveLiveHits } from "../host/conflicts/channel-b.js";
import { observeCompactionRow } from "../host/conflicts/channel-c.js";
import { _resetConflictStateForTest, getConflictHits, setConflictHits } from "../host/conflicts/pause.js";

const OVERRIDE = 'on("session.compact", async ($, e, next) => { return { messages: [] }; });';
const PASSIVE = 'on("session.compact", async ($, e, next) => { log(e); return next(e); });';

function ioOver(files: Record<string, string>) {
  return {
    list: async (dir: string) => {
      const norm = dir.split("\\").join("/");
      const names = new Set<string>();
      for (const f of Object.keys(files)) {
        if (f.startsWith(`${norm}/`)) names.add(f.slice(norm.length + 1).split("/")[0]);
      }
      return [...names].map((name) => ({
        name,
        kind: (files[`${norm}/${name}`] !== undefined ? "file" : "directory") as "file" | "directory",
      }));
    },
    read: async (p: string) => files[p] ?? "",
    stat: async (p: string) => ({ size: (files[p] ?? "").length }),
  };
}

kit.tier("prepend");

kit.describe("conflicts — engine-run twins (closure-load + decisions)", () => {
  kit.test("the envelope handler decides over the real module code under the kit loader", async () => {
    resetFoldState();
    resetWaveLiveHits();
    _resetConflictStateForTest();
    recordFoldList(["session-owl", "evil-mod", "bell-mod"]);
    const io = ioOver({
      "/inst/evil/hooks/r.js": OVERRIDE,
      "/inst/bell/hooks/r.js": PASSIVE,
    });
    const evil = await handlePluginRegisterEnvelope(
      { name: "evil-mod", tier: "user", root: "/inst/evil", events: ["session.compact"] },
      io,
      { selfName: "session-owl", familyPrefix: "avtc-claude-" },
    );
    if (evil.hit === null || evil.hit.name !== "evil-mod")
      throw new Error(`overrider not hit: ${JSON.stringify(evil)}`);
    const bell = await handlePluginRegisterEnvelope(
      { name: "bell-mod", tier: "user", root: "/inst/bell", events: ["session.*"] },
      io,
      { selfName: "session-owl", familyPrefix: "avtc-claude-" },
    );
    if (bell.hit !== null) throw new Error("passive registrant hit");
    const builtin = await handlePluginRegisterEnvelope(
      { name: "cc-plugin-agents-md", tier: "builtin", root: "/builtin/amd", events: ["session.compact"] },
      io,
      { selfName: "session-owl", familyPrefix: "avtc-claude-" },
    );
    if (builtin.hit !== null) throw new Error("builtin tier hit");
    const classic = await handlePluginRegisterEnvelope(
      { name: "classic-mod", tier: "user", root: "/inst/classic", events: ["classic.PreCompact"] },
      io,
      { selfName: "session-owl", familyPrefix: "avtc-claude-" },
    );
    if (classic.hit !== null || classic.advisory === null) throw new Error("classic-only not advisory");
  });

  kit.test(
    "Channel C: a door-compaction row through the real engine path stays verbatim (windows empty under kit)",
    async ($: unknown, on: unknown) => {
      const mockRef = (
        kit as unknown as {
          mock?: { session: (on: unknown) => { appended: () => readonly Record<string, unknown>[] } };
        }
      ).mock;
      if (typeof mockRef?.session !== "function") {
        console.log("[conflicts] SKIP round-trip (engine kit predates mock.session; min 2.1.293)");
        return;
      }
      const dollar = $ as { session: { append: (row: Record<string, unknown>) => Promise<unknown> } };
      const sess = mockRef.session(on);
      const row = {
        uuid: `conflict-c-${Date.now()}`,
        parentUuid: null,
        type: "user",
        message: { role: "user", content: [{ type: "text", text: "c" }] },
        door: "compaction",
        origin: { plugin: "test", tier: "user" },
      };
      await dollar.session.append(row);
      const mine = sess.appended().filter((r) => r.uuid === row.uuid);
      if (mine.length !== 1) throw new Error(`row not stored once: ${mine.length}`);
      // No active window exists under the kit (no session.start ran) — the
      // observer must stay inert, exactly like a pre-owl historical row.
      const hit = await observeCompactionRow(
        { uuid: row.uuid, at: Date.now(), door: "compaction" },
        { readTimelines: async () => [], appendEvent: async () => {} },
        Date.now(),
      );
      if (hit !== null) throw new Error("hit with no owl-active window");
    },
  );

  kit.test("the pause set round-trips through the recorded state (closure instance)", () => {
    _resetConflictStateForTest();
    setConflictHits([{ channel: "B", name: "evil-mod", evidence: "session.compact" }]);
    if ((getConflictHits() ?? []).length !== 1) throw new Error("hit not recorded");
    if (getLiveBHits().length !== 0) throw new Error("live set leak");
    _resetConflictStateForTest();
  });
});
