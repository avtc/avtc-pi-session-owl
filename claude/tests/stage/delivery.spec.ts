// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// The prompt.submit delivery drop: a background spawn's report is
// delivered into the main conversation as a peer-origin agent-message the
// main model would otherwise read — owl drops exactly those whose `from`
// sits in the stage-spawn registry (the stage dump is their record).
import { describe, expect, test } from "vitest";
import { shouldDropPeerMessage } from "../../host/stage/delivery.js";

function peerEvent(text: string, from: string): Record<string, unknown> {
  return {
    text: `<agent-message from="${from}">
${text}
</agent-message>`,
    origin: { kind: "peer" },
    wait: false,
  };
}

describe("delivery drop", () => {
  test("a peer agent-message from a live stage spawn is dropped with the reason", () => {
    const registry = new Map<string, unknown>([["ag-1", { stage: "observer" }]]);
    const e = peerEvent("observation done", "ag-1");
    const drop = shouldDropPeerMessage(e, registry);
    expect(drop).toBe("session-owl: stage handback (ag-1)");
  });

  test("a peer message from an unknown agent passes (not owl's to drop)", () => {
    const registry = new Map<string, unknown>();
    const e = peerEvent("other agent's report", "someone-else");
    expect(shouldDropPeerMessage(e, registry)).toBeNull();
  });

  test("a peer message with no agent-message wrapper passes", () => {
    const registry = new Map<string, unknown>([["ag-1", {}]]);
    const e = { text: "plain peer text", origin: { kind: "peer" } };
    expect(shouldDropPeerMessage(e, registry)).toBeNull();
  });

  test("non-peer origins pass untouched (user, plugin)", () => {
    const registry = new Map<string, unknown>([["ag-1", {}]]);
    expect(shouldDropPeerMessage({ text: "hi", origin: { kind: "user" } }, registry)).toBeNull();
    expect(
      shouldDropPeerMessage(
        { text: `<agent-message from="ag-1">x</agent-message>`, origin: { kind: "plugin" } },
        registry,
      ),
    ).toBeNull();
    expect(shouldDropPeerMessage({ text: "no origin" }, registry)).toBeNull();
  });

  test("the from-id is parsed from the wrapper, tolerating attributes and whitespace", () => {
    const registry = new Map<string, unknown>([["ag-2", {}]]);
    const e = {
      text: '  <agent-message from="ag-2" kind="handback">report body</agent-message>  ',
      origin: { kind: "peer" },
    };
    expect(shouldDropPeerMessage(e, registry)).toContain("ag-2");
  });

  test("a malformed wrapper (no closing tag / no from) passes", () => {
    const registry = new Map<string, unknown>([["ag-3", {}]]);
    const open = { text: '<agent-message from="ag-3">x', origin: { kind: "peer" } };
    expect(shouldDropPeerMessage(open, registry)).toBeNull();
    const noFrom = { text: "<agent-message>x</agent-message>", origin: { kind: "peer" } };
    expect(shouldDropPeerMessage(noFrom, registry)).toBeNull();
  });

  test("the PRODUCTION envelope: wrapper in text, no context field at all — dropped", () => {
    const registry = new Map<string, unknown>([["ag-7", { stage: "builder" }]]);
    const e = {
      text: '<agent-message from="ag-7">\\n[Subagent hand-back]\\nobserver report\\n</agent-message>',
      origin: { kind: "peer" },
    };
    expect(shouldDropPeerMessage(e, registry)).toBe("session-owl: stage handback (ag-7)");
  });

  test("the context-carried wrapper still drops (defensive fallback for envelope drift)", () => {
    const registry = new Map<string, unknown>([["ag-8", {}]]);
    const e = {
      text: "report body",
      origin: { kind: "peer" },
      context: ['<agent-message from="ag-8">report body</agent-message>'],
    };
    expect(shouldDropPeerMessage(e, registry)).toContain("ag-8");
  });
});
