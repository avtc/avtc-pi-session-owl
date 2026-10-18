// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// The activation orchestrator: A + A-prime + the live B merge, the pause
// module's recorded set, and pi's log ladder (silent when disabled; the
// pause line; the deliberate-co-run line).
import { beforeEach, describe, expect, test } from "vitest";
import {
  _setStaticHitsForTest,
  type ChannelAIo,
  recomputePauseSet,
  runConflictActivation,
} from "../../host/conflicts/activation.js";
import { recordFoldList, resetFoldState } from "../../host/conflicts/channel-a-prime.js";
import { recordLiveOutcome, resetWaveLiveHits } from "../../host/conflicts/channel-b.js";
import {
  _resetConflictStateForTest,
  getConflictAdvisories,
  getConflictHits,
  setConflictHits,
} from "../../host/conflicts/pause.js";

const OVERRIDE = 'on("session.compact", async ($, e, next) => { return { messages: [] }; });';

function makeIo(installed: unknown, files: Record<string, string>, dirs: string[]): ChannelAIo {
  return {
    readInstalledPlugins: async () => installed,
    readEnabledPlugins: async () => null,
    list: async (dir: string) => {
      const norm = dir.replace(/\\/g, "/");
      const names = new Set<string>();
      for (const f of Object.keys(files))
        if (f.startsWith(`${norm}/`)) names.add(f.slice(norm.length + 1).split("/")[0]);
      for (const sub of dirs) if (sub.startsWith(`${norm}/`)) names.add(sub.slice(norm.length + 1).split("/")[0]);
      return [...names].map((name) => ({
        name,
        kind: (files[`${norm}/${name}`] !== undefined ? "file" : "directory") as "file" | "directory",
      }));
    },
    read: async (p: string) => files[p.replace(/\\/g, "/")] ?? "",
    stat: async (p) => ({ size: (files[p.replace(/\\/g, "/")] ?? "").length }),
  };
}

beforeEach(() => {
  _resetConflictStateForTest();
  resetWaveLiveHits();
  resetFoldState();
});

describe("conflicts activation — the merge + log ladder", () => {
  test("the STOCK MACHINE never pauses: engine builtins after owl, empty registry, no foreign hooks", async () => {
    // the stock-install fold shape: owl + engine builtins — the
    // builtins' envelopes never reach a user-tier listener (cell 7) and the
    // installs-only registry can never root them (cell 12); A-prime's
    // blind-spot scan covers only entries BEFORE owl, so this is silent
    recordFoldList(["session-owl", "cc-plugin-agents-md", "cc-plugin-telemetry"]);
    const io = makeIo({ plugins: {} }, {}, []);
    const out = await runConflictActivation(io, {
      selfName: "session-owl",
      selfRoot: "/owl",
      familyPrefix: "avtc-claude-",
      enabled: true,
      ignoreConflicts: false,
    });
    expect(out.log).toBe("none");
    expect(getConflictHits()).toBeNull(); // nothing recorded — not even an empty advisory set
  });

  test("A hits + unrooted fold entries + live B hits merge into the recorded set", async () => {
    recordFoldList(["inline-dev-mod", "session-owl"]);
    recordLiveOutcome({ channel: "B", name: "later-mod", evidence: "session.compact" }, null);
    const io = makeIo(
      { plugins: { "evil@market": [{ installPath: "/inst/evil" }] } },
      { "/inst/evil/hooks/hooks.json": JSON.stringify({ modules: ["./r.js"] }), "/inst/evil/hooks/r.js": OVERRIDE },
      ["/inst/evil", "/inst/evil/hooks"],
    );
    const out = await runConflictActivation(io, {
      selfName: "session-owl",
      selfRoot: "/owl",
      familyPrefix: "avtc-claude-",
      enabled: true,
      ignoreConflicts: false,
    });
    expect(out.hits).toEqual([
      { channel: "A", name: "evil@market", evidence: "session.compact" },
      { channel: "A-prime", name: "inline-dev-mod", evidence: "unrooted" },
      { channel: "B", name: "later-mod", evidence: "session.compact" },
    ]);
    expect(out.log).toBe("pause");
    expect(getConflictHits()).toHaveLength(3);
  });

  test("disabled + hits records silently (off by choice is not a pause)", async () => {
    const io = makeIo(
      { plugins: { "evil@market": [{ installPath: "/inst/evil" }] } },
      { "/inst/evil/hooks/hooks.json": JSON.stringify({ modules: ["./r.js"] }), "/inst/evil/hooks/r.js": OVERRIDE },
      ["/inst/evil", "/inst/evil/hooks"],
    );
    const out = await runConflictActivation(io, {
      selfName: "session-owl",
      selfRoot: "/owl",
      familyPrefix: "avtc-claude-",
      enabled: false,
      ignoreConflicts: false,
    });
    expect(out.log).toBe("none");
    expect(getConflictHits()).toHaveLength(1);
  });

  test("ignoreConflicts + hits logs the deliberate co-run", async () => {
    const io = makeIo(
      { plugins: { "evil@market": [{ installPath: "/inst/evil" }] } },
      { "/inst/evil/hooks/hooks.json": JSON.stringify({ modules: ["./r.js"] }), "/inst/evil/hooks/r.js": OVERRIDE },
      ["/inst/evil", "/inst/evil/hooks"],
    );
    const out = await runConflictActivation(io, {
      selfName: "session-owl",
      selfRoot: "/owl",
      familyPrefix: "avtc-claude-",
      enabled: true,
      ignoreConflicts: true,
    });
    expect(out.log).toBe("ignore-conflicts");
  });

  test("recomputePauseSet merges the live B hits over the static set (pause immediately)", async () => {
    const staticHits = [{ channel: "A" as const, name: "evil@market", evidence: "session.compact" }];
    setConflictHits(staticHits);
    recordLiveOutcome({ channel: "B", name: "later-mod", evidence: "session.*" }, null);
    recomputePauseSet();
    expect(getConflictHits()).toHaveLength(2);
  });

  test("recomputePauseSet preserves the recorded advisories (the recorded set never diverges from detection)", async () => {
    _setStaticHitsForTest([]); // isolate from the previous test's static seed
    const advisory = {
      name: "passive-mod",
      evidence: "classic compaction hooks only",
      reason: "classic-only" as const,
    };
    setConflictHits([], [advisory]);
    recordLiveOutcome({ channel: "B", name: "later-mod", evidence: "session.*" }, null);
    recomputePauseSet();
    expect(getConflictHits()).toHaveLength(1);
    expect(getConflictAdvisories()).toEqual([advisory]); // NOT silently cleared
  });
});
