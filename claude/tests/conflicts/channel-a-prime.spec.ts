// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// Channel A-prime (the engine.create fold list) + the per-session timeline.
// The fold snapshot is taken at owl's engine.create step; the unrooted
// determination runs at the awaited first session.start — any entry then
// still not self, not rooted via Channel A (registry/settings) and not
// witnessed via Channel B (plugin.register envelope) is an unrooted module
// (an inline --plugin-dir dev mod before owl, or an unwitnessed
// engine-internal module) and fails safe: conservative hit, pause with the
// name. Escape is ignoreConflicts.
import { describe, expect, test } from "vitest";
import {
  determineUnrooted,
  recordBWitness,
  recordFoldList,
  resetFoldState,
} from "../../host/conflicts/channel-a-prime.js";

describe("conflicts Channel A-prime — the unrooted determination", () => {
  test("a fold entry rooted via A (registry) or witnessed via B (envelope) is not a hit", () => {
    resetFoldState();
    recordFoldList(["session-owl", "evil@market", "witnessed-mod"]);
    recordBWitness("witnessed-mod");
    const hits = determineUnrooted({
      selfName: "session-owl",
      familyPrefix: "avtc-claude-",
      rootedNames: ["evil@market"],
    });
    expect(hits).toEqual([]);
  });

  test("an unrooted entry BEFORE owl fails safe: hit with the name", () => {
    resetFoldState();
    recordFoldList(["mystery-mod", "session-owl", "evil@market", "witnessed-mod"]);
    recordBWitness("witnessed-mod");
    const hits = determineUnrooted({
      selfName: "session-owl",
      familyPrefix: "avtc-claude-",
      rootedNames: ["evil@market"],
    });
    expect(hits).toEqual([{ channel: "A-prime", name: "mystery-mod", evidence: "unrooted" }]);
  });

  test("self and the family namespace are exempt from the fail-safe", () => {
    resetFoldState();
    recordFoldList(["mystery-mod", "session-owl", "avtc-claude-logger"]);
    const hits = determineUnrooted({ selfName: "session-owl", familyPrefix: "avtc-claude-", rootedNames: [] });
    expect(hits).toEqual([{ channel: "A-prime", name: "mystery-mod", evidence: "unrooted" }]);
  });

  test("a bare fold name roots a registry key of name@marketplace (matching modulo the market suffix)", () => {
    resetFoldState();
    recordFoldList(["session-owl", "evil"]);
    const hits = determineUnrooted({
      selfName: "session-owl",
      familyPrefix: "avtc-claude-",
      rootedNames: ["evil@market"],
    });
    expect(hits).toEqual([]);
  });
});

describe("conflicts Channel A-prime — the stock machine (engine builtins)", () => {
  test("engine builtins AFTER owl in the fold list never hit (inner of owl, envelopes never reach a user-tier listener)", () => {
    resetFoldState();
    // the stock-install shape: owl + the engine's own builtins,
    // empty registry, no witnesses — zero hits, owl never self-pauses
    recordFoldList(["session-owl", "cc-plugin-agents-md", "cc-plugin-telemetry"]);
    const hits = determineUnrooted({
      selfName: "session-owl",
      familyPrefix: "avtc-claude-",
      rootedNames: [],
    });
    expect(hits).toEqual([]);
  });

  test("the blind spot stays guarded: an unwitnessed unrooted entry BEFORE owl still hits", () => {
    resetFoldState();
    recordFoldList(["mystery-mod", "session-owl", "cc-plugin-telemetry"]);
    const hits = determineUnrooted({
      selfName: "session-owl",
      familyPrefix: "avtc-claude-",
      rootedNames: [],
    });
    expect(hits).toEqual([{ channel: "A-prime", name: "mystery-mod", evidence: "unrooted" }]);
  });
});
