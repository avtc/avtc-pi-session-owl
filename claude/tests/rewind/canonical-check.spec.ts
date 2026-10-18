// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// The canonical-view check — layer 2: `messages({as:"api"})` is the canonical
// chain's actual view. Owl aligns it against the mirror on tool_use_id
// fingerprints (text fallback): last-flushed rows absent ⇒ the conversation
// was truncated. P* = the deepest previously-known live-path row still
// present — the alignment junction, provisional until verified.

import { describe, expect, test } from "vitest";
import {
  absentTailConfirm,
  alignCanonical,
  type Fingerprint,
  fingerprintBlocks,
  fingerprintText,
} from "../../host/rewind/canonical-check.js";

/** A row fingerprint from raw content blocks (the mirror row shape). */
const fp = (o: Partial<Fingerprint> = {}): Fingerprint => ({ toolUseIds: [], toolResultIds: [], textSig: "", ...o });

const blocks = (arr: unknown[]) => arr;

describe("fingerprints", () => {
  test("tool_use / tool_result ids are extracted, text is normalized-joined", () => {
    const f = fingerprintBlocks(
      blocks([
        { type: "text", text: "  Hello   world  " },
        { type: "tool_use", id: "t1", name: "ls" },
        { type: "tool_result", tool_use_id: "t1", content: "ok" },
        { type: "image", source: {} },
      ]),
    );
    expect(f).toEqual(fp({ toolUseIds: ["t1"], toolResultIds: ["t1"], textSig: "hello world" }));
  });

  test("text fallback normalization collapses whitespace and case, caps length", () => {
    expect(fingerprintText("A  B\nc")).toBe(fingerprintText("a b      C"));
    expect(fingerprintText("x".repeat(500)).length).toBeLessThanOrEqual(200);
  });

  test("non-array and block-less content yields an empty fingerprint", () => {
    expect(fingerprintBlocks("plain string" as unknown)).toEqual(fp());
    expect(fingerprintBlocks([])).toEqual(fp());
  });
});

describe("alignCanonical — the layered check's verdict", () => {
  const row = (uuid: string, f: Fingerprint) => ({ uuid, f });

  test("clean: the whole known path is present (the api form may extend past it)", () => {
    const known = [row("r1", fp({ toolUseIds: ["t1"] })), row("r2", fp({ toolResultIds: ["t1"] }))];
    const api = [
      { toolUseIds: ["t1"], toolResultIds: [], textSig: "" },
      { toolUseIds: [], toolResultIds: ["t1"], textSig: "" },
      { toolUseIds: ["t9"], toolResultIds: [], textSig: "" }, // the new turn
    ];
    const v = alignCanonical(known, api);
    expect(v.kind).toBe("clean");
  });

  test("rewind: the absent tail is contiguous; P* is the row before it", () => {
    const known = [
      row("r1", fp({ toolUseIds: ["t1"] })),
      row("r2", fp({ toolResultIds: ["t1"] })),
      row("r3", fp({ toolUseIds: ["t2"] })),
      row("r4", fp({ toolResultIds: ["t2"] })),
    ];
    // rewound to r2: r3, r4 absent; a new row r5' rides after r2's content
    const api = [fp({ toolUseIds: ["t1"] }), fp({ toolResultIds: ["t1"] }), fp({ toolUseIds: ["t3"] })];
    const v = alignCanonical(known, api);
    if (v.kind !== "divergence") throw new Error(`expected divergence, got ${v.kind}`);
    expect(v.P).toBe("r2");
    expect(v.evidence.knownAbsent).toBe(2);
    expect(v.provisional).toBe(false); // tool-id junction match
  });

  test("deep rewind beyond the api window: the junction still sits at the window tail", () => {
    // 12 known rows; the api window shows only its tail (rows r8..r10 + new)
    const known = Array.from({ length: 12 }, (_, i) => row(`r${i + 1}`, fp({ toolUseIds: [`t${i + 1}`] })));
    const api = [fp({ toolUseIds: ["t9"] }), fp({ toolUseIds: ["t10"] }), fp({ toolUseIds: ["t99"] })];
    const v = alignCanonical(known, api);
    if (v.kind !== "divergence") throw new Error(`expected divergence, got ${v.kind}`);
    expect(v.P).toBe("r10");
  });

  test("text-only junction match stays provisional", () => {
    const known = [row("r1", fp({ textSig: "hello" })), row("r2", fp({ textSig: "world" }))];
    const api = [fp({ textSig: "hello" }), fp({ textSig: "new prompt" })];
    const v = alignCanonical(known, api);
    if (v.kind !== "divergence") throw new Error(`expected divergence, got ${v.kind}`);
    expect(v.P).toBe("r1");
    expect(v.provisional).toBe(true);
  });

  test("a WINDOWED pure-chat prefix (text-only matches) keeps its immunity — the anchor falls back to the lowest text match", () => {
    const known = [
      row("q1", fp({ textSig: "hello" })),
      row("q2", fp({ textSig: "how are you" })),
      row("q3", fp({ textSig: "fine" })),
      row("q4", fp({ textSig: "and you" })),
    ];
    // the window kept only the tail: q3, q4 (+ a new row)
    const api = [fp({ textSig: "fine" }), fp({ textSig: "and you" }), fp({ textSig: "new" })];
    expect(alignCanonical(known, api).kind).toBe("clean");
    // mirror image: an early-session rewind from a pure-chat point with a
    // tool tail still detects — the dead tail's tool ids NEVER survive in
    // the canonical view (the engine assigns fresh ids), so the tail reads
    // dead above the text anchor
    const toolTail = [...known, row("q5", fp({ toolUseIds: ["tq"] }))];
    const rewoundApi = [fp({ textSig: "hello" }), fp({ toolUseIds: ["tnew"] })];
    const v = alignCanonical(toolTail, rewoundApi);
    if (v.kind !== "divergence") throw new Error(`expected divergence, got ${v.kind}`);
    expect(v.evidence.knownAbsent).toBeGreaterThanOrEqual(4); // q2..q5 dead
  });

  test("duplicate text prompts (the repeated-prompt pool) align exactly — the retyped-prompt shape", () => {
    const known = [
      row("k1", fp({ toolUseIds: ["t5"] })),
      row("k2", fp({ textSig: "go on" })),
      row("k8", fp({ toolResultIds: ["t4"] })),
    ];
    const api = [fp({ textSig: "go on" }), fp({ textSig: "go on" }), fp({ toolResultIds: ["t4"] })];
    expect(alignCanonical(known, api).kind).toBe("clean");
    // and a rewound variant still reads the tail dead: the user rewound to
    // the "go on" prompt and retyped it — the tool result row is gone
    const rewound = [fp({ toolUseIds: ["t5"] }), fp({ textSig: "go on" }), fp({ toolUseIds: ["t9"] })];
    const v = alignCanonical(known, rewound);
    if (v.kind !== "divergence") throw new Error(`expected divergence, got ${v.kind}`);
    expect(v.evidence.knownAbsent).toBe(1); // k8
  });

  test("nothing known present ⇒ divergence with P* null (the api form excludes all owl rows)", () => {
    const known = [row("r1", fp({ toolUseIds: ["t1"] }))];
    const api = [fp({ toolUseIds: ["t7"] })];
    const v = alignCanonical(known, api);
    expect(v.kind).toBe("divergence");
    if (v.kind === "divergence") expect(v.P).toBeNull();
  });

  test("an empty known path is clean (the fresh-session truth)", () => {
    expect(alignCanonical([], [fp()]).kind).toBe("clean");
  });

  test("a known row with an empty fingerprint (no ids, no text) is UNGRADEABLE — exempt from the alignment", () => {
    const known = [row("r1", fp()), row("r2", fp({ toolUseIds: ["t1"] }))];
    const api = [fp(), fp({ toolUseIds: ["t1"] })];
    const v = alignCanonical(known, api);
    // r1 carries no signal (an image-only prompt): it neither anchors nor
    // dies — the judgeable row r2 matches, so the turn is clean
    expect(v.kind).toBe("clean");
  });

  test("a summarized/windowed api prefix is structurally exempt — never a rewind (compaction or the 4,096 window)", () => {
    const known = [
      row("A", fp({ toolUseIds: ["ta"] })),
      row("B", fp({ toolUseIds: ["tb"] })),
      row("C", fp({ toolUseIds: ["tc"] })), // below the kept region
      row("D", fp({ toolUseIds: ["td"] })),
      row("E", fp({ toolUseIds: ["te"] })),
    ];
    const api = [fp({ textSig: "summary of a b c" }), fp({ toolUseIds: ["td"] }), fp({ toolUseIds: ["te"] })];
    // A B C absent from the ROOT side of the lowest match (D): window or
    // summary shape — clean; the boundary option stays belt-and-suspenders
    expect(alignCanonical(known, api).kind).toBe("clean");
    expect(alignCanonical(known, api, { exemptUpTo: "C" }).kind).toBe("clean");
    // but a TAIL absence is still a rewind (the deliberate asymmetry)
    const rewound = [fp({ toolUseIds: ["ta"] }), fp({ toolUseIds: ["tb"] }), fp({ toolUseIds: ["tnew"] })];
    const v = alignCanonical(known, rewound);
    if (v.kind !== "divergence") throw new Error(`expected divergence, got ${v.kind}`);
    expect(v.evidence.knownAbsent).toBe(3); // C D E — above the lowest match B
  });
});

describe("deadUuids — the rewound-away branch nominates by uuid", () => {
  const fp = (sig: string): import("../../host/rewind/canonical-check.js").Fingerprint => ({
    toolUseIds: [],
    toolResultIds: [],
    textSig: sig,
  });

  test("interior absence (the fork shape) reports the abandoned uuids and is NOT tail-lag", () => {
    const known = [
      { uuid: "alpha1", f: fp("alpha turn") },
      { uuid: "beta1", f: fp("beta turn one") },
      { uuid: "beta2", f: fp("beta turn two") },
      { uuid: "fork9", f: fp("the fork re-send") },
    ];
    // the api view carries alpha + the fork re-send — the beta branch is gone
    const v = alignCanonical(known, [known[0].f, known[3].f]);
    if (v.kind !== "divergence") throw new Error(`expected divergence, got ${v.kind}`);
    expect(v.evidence.deadUuids).toEqual(["beta1", "beta2"]);
    expect(v.evidence.absentAfterJunction).toBe(false);
    expect(v.P).toBe("fork9");
  });
});

describe("absentTailConfirm — the rows-form double check", () => {
  test("true when the known tip is absent from the messages() rows form", () => {
    // rewound to r2: the old tip r4 is gone, r5' rides the live path
    expect(absentTailConfirm(["r1", "r2", "r5prime"], "r4")).toBe(true);
  });
  test("false while the tip is still there", () => {
    expect(absentTailConfirm(["r1", "r2", "r3"], "r3")).toBe(false);
  });
});
