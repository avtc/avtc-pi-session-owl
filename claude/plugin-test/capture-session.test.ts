// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// Engine round-trip of the session.append capture path via the kit's
// mock.session: mock.session(on) arms the
// test's session.append responder, a row appended through the kit's
// $.session.append traverses the plugin's session.append hook (our capture
// observer) and lands stored, unmutated. The filing bodies (cache/mirror/
// pending) are Node-tested; this twin pins the ENGINE contract under the
// real loader.
//
// Engine guard: kits older than 2.1.293 lack mock.session; the test
// reports a visible note and passes (the same environmental
// degradation the offline gates use for a missing claude binary).
import * as kit from "claude-code/testing";

type KitMock = { session: (on: unknown) => { appended: () => readonly Record<string, unknown>[] } };
const mockRef = (kit as unknown as { mock?: KitMock }).mock;
const hasMockSession = typeof mockRef?.session === "function";

kit.describe("capture round-trip — engine-run twin (mock.session, 2.1.293+)", () => {
  kit.test("a user row appended through the engine lands stored verbatim", async ($: unknown, on: unknown) => {
    if (!hasMockSession) {
      console.log("[capture-session] SKIP round-trip (engine kit predates mock.session; min 2.1.293)");
      return;
    }
    const dollar = $ as { session: { append: (row: Record<string, unknown>) => Promise<unknown> } };
    const sess = mockRef.session(on);
    const row = {
      uuid: `twin-${Date.now()}`,
      message: { type: "user", content: [{ type: "text", text: "mock.session round-trip" }] },
      door: "prompt",
      origin: { kind: "composer" },
    };
    await dollar.session.append(row);
    const mine = sess.appended().filter((r) => r.uuid === row.uuid);
    if (mine.length !== 1) throw new Error(`expected the appended row stored once, got ${mine.length}`);
    const stored = mine[0] as { door?: string; message?: { content?: Array<{ text?: string }> } };
    if (stored.door !== "prompt") throw new Error(`door mutated: ${String(stored.door)}`);
    if (stored.message?.content?.[0]?.text !== "mock.session round-trip") throw new Error("content mutated");
  });
});
