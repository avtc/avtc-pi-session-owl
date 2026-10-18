// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// Engine-kit twin of the start suite: the bootstrap ladder predicate and the
// transcript reader (parse, tip marker, live path, the door derivation)
// loaded from the plugin's own tree under the hooks-environment import
// rules. The full backfill sequence lives in the Node suite (it needs the
// multiplexer's serialized swap).
import { describe, expect, test } from "claude-code/testing";
import { planBootstrap } from "../host/start/bootstrap-ladder.js";
import { livePath, parseTranscriptRows, rowFromTranscript } from "../host/start/transcript-reader.js";

const CAP = 4 * 1024 * 1024 - 64 * 1024;

describe("start sequence — engine-run twin", () => {
  test("the ladder: direct under the cap, helper on CLI, blocked hint off-CLI", () => {
    expect(planBootstrap({ byteSize: 1024, canRunProcess: false }).read).toBe("direct");
    expect(planBootstrap({ byteSize: CAP + 1, canRunProcess: true }).read).toBe("helper");
    const blocked = planBootstrap({ byteSize: CAP + 1, canRunProcess: false });
    expect(blocked.read).toBe("blocked");
    expect(blocked.statusHint).toBe("await-cli-open");
    expect(blocked.degraded).toBe(true);
  });

  test("the reader: tip extraction, live path, door derivation", () => {
    const NL = String.fromCharCode(10);
    const text =
      [
        JSON.stringify({ uuid: "k-1", parentUuid: null, type: "user", message: { role: "user", content: "kit" } }),
        JSON.stringify({
          uuid: "k-2",
          parentUuid: "k-1",
          type: "assistant",
          message: { id: "kr1", model: "glm-5.1", content: [{ type: "text", text: "twin" }] },
        }),
        JSON.stringify({
          uuid: "k-3",
          parentUuid: "k-1",
          type: "assistant",
          message: { id: "kr2", model: "glm-5.1", content: [{ type: "text", text: "dead tail" }] },
        }),
        JSON.stringify({ type: "last-prompt", sessionId: "sess-kit", leafUuid: "k-2" }),
      ].join(NL) + NL;
    const parsed = parseTranscriptRows(text);
    expect(parsed.tip?.leafUuid).toBe("k-2");
    const live = livePath(parsed.rows, parsed.tip?.leafUuid ?? null);
    expect(live.map((r) => r.uuid)).toEqual(["k-1", "k-2"]);
    const doors = live.map((r) => rowFromTranscript(r).door);
    expect(doors).toEqual(["prompt", "response"]);
  });
});
