// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import { describe, expect, it } from "vitest";
import { alignCanonical, fingerprintBlocks, type KnownRow } from "../../host/rewind/canonical-check.js";

function row(uuid: string, content: unknown, ts?: number): KnownRow {
  const r: KnownRow = { uuid, f: fingerprintBlocks(content) };
  if (ts !== undefined) r.ts = ts;
  return r;
}

function apiOf(...rows: KnownRow[]) {
  return rows.map((r) => r.f);
}

const U1 = row("u1", [{ type: "text", text: "first prompt" }], 1);
const A1 = row("a1", [{ type: "tool_use", id: "t1", name: "Read", input: {} }], 2);
const U2 = row("u2", [{ type: "text", text: "second prompt" }], 3);
const A2 = row("a2", [{ type: "tool_use", id: "t2", name: "Read", input: {} }], 4);
const U3 = row("u3", [{ type: "text", text: "third prompt" }], 5);

describe("alignCanonical exemption anchors", () => {
  it("a boundary uuid in the known path exempts everything at-or-before it (the resume shape)", () => {
    // the resumed view carries NOTHING of the known path yet (engine
    // continuation still reconstructing) — every known row sits at-or-before
    // the pre-start tip, so the verdict must be clean, not a mass death
    const verdict = alignCanonical([U1, A1, U2, A2, U3], [], { exemptUpTo: "u3" });
    expect(verdict.kind).toBe("clean");
  });

  it("falls back to the arrival timestamp when the boundary uuid is NOT a known row", () => {
    // the persisted compaction cut anchor never reached the mirror:
    // without the fallback this silently exempts nothing
    const verdict = alignCanonical([U1, A1, U2, A2, U3], [], {
      exemptUpTo: "never-mirrored",
      exemptUpToAt: 5,
    });
    expect(verdict.kind).toBe("clean");
  });

  it("does not over-exempt: rows arriving after the boundary position stay judged", () => {
    const verdict = alignCanonical([U1, A1, U2, A2, U3], apiOf(U2), {
      exemptUpTo: "never-mirrored",
      exemptUpToAt: 2,
    });
    expect(verdict.kind).toBe("divergence");
    if (verdict.kind === "divergence") {
      expect(verdict.P).toBe("u2");
      expect(verdict.evidence.knownAbsent).toBe(2);
    }
  });

  it("exempts nothing when the anchor misses and no timestamp is given", () => {
    // no anchor, no timestamp — nothing to exempt
    const verdict = alignCanonical([U1, A1, U2, A2, U3], [], { exemptUpTo: "never-mirrored" });
    expect(verdict.kind).toBe("divergence");
  });
});
