// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import { describe, expect, it } from "vitest";
import {
  formatNodeLine,
  formatObservationLine,
  formatTimestamp,
  formatTimestampRange,
  importanceAbbr,
  RENDER_LEGEND,
} from "../../src/format/render.js";
import type { Node, Observation } from "../../src/types.js";
import { estimateContentTokens, N_GOAL } from "../../src/types.js";

const FIXED_NOW = "2026-07-29 09:00";

describe("importanceAbbr", () => {
  it("maps each importance to its render word", () => {
    expect(importanceAbbr("critical")).toBe("crit");
    expect(importanceAbbr("high")).toBe("high");
    expect(importanceAbbr("medium")).toBe("med");
    expect(importanceAbbr("low")).toBe("low");
  });
});

describe("formatTimestamp", () => {
  it("renders a stored YYYY-MM-DD HH:MM as Jul 28 14:30", () => {
    expect(formatTimestamp("2026-07-28 14:30")).toBe("Jul 28 14:30");
  });

  it("maps every month to its abbreviation", () => {
    expect(formatTimestamp("2026-01-05 08:00")).toBe("Jan 05 08:00");
    expect(formatTimestamp("2026-12-31 23:59")).toBe("Dec 31 23:59");
  });

  it("renders an out-of-range month as a placeholder (defensive)", () => {
    expect(formatTimestamp("2026-99-05 08:00")).toBe("??? 05 08:00");
  });
});

describe("formatTimestampRange", () => {
  it("renders a cross-day range with both dates", () => {
    expect(formatTimestampRange("2026-07-28 14:30", "2026-07-29 09:15")).toBe("Jul 28 14:30 — Jul 29 09:15");
  });

  it("compresses a same-day range to a single date + end time", () => {
    expect(formatTimestampRange("2026-07-28 14:30", "2026-07-28 17:00")).toBe("Jul 28 14:30 — 17:00");
  });

  it("collapses an identical start/end to a single timestamp", () => {
    expect(formatTimestampRange("2026-07-28 14:30", "2026-07-28 14:30")).toBe("Jul 28 14:30");
  });
});

describe("formatNodeLine", () => {
  it("renders an active node with importance, counts, and a datetime range", () => {
    const node = makeNode({
      id: "n7",
      summary: "Auth migration to JWT",
      importance: "high",
      observationIds: repeatObs(12),
      childNodeIds: ["n8", "n9", "n10"],
      rangeStart: "2026-07-28 14:30",
      rangeEnd: "2026-07-29 09:15",
    });
    expect(formatNodeLine(node, { viewer: "builder" })).toBe(
      "📁 n7 high · Auth migration to JWT · 3📁 12📄 · Jul 28 14:30 — Jul 29 09:15",
    );
  });

  it("omits the child count when the node has only observations", () => {
    const node = makeNode({ id: "nGoal", summary: "the goal", importance: "critical", observationIds: repeatObs(2) });
    expect(formatNodeLine(node, { viewer: "nonBuilder" })).toBe("📁 nGoal crit · the goal · 2📄 · Jul 29 09:00");
  });

  it("renders an archived node with the 📦 glyph", () => {
    const node = makeNode({ id: "n3", summary: "old branch", importance: "low", state: "archived" });
    expect(formatNodeLine(node, { viewer: "builder" })).toBe("📁 n3 📦low · old branch · 0📄 · Jul 29 09:00");
  });

  it("renders an obsolete node with the 🪦 glyph and the → supersededBy link", () => {
    const node = makeNode({
      id: "n2",
      summary: "YAML config",
      importance: "medium",
      state: "obsolete",
      supersededBy: "n7",
    });
    expect(formatNodeLine(node, { viewer: "builder" })).toBe("📁 n2 🪦med · YAML config · → n7 · 0📄 · Jul 29 09:00");
  });

  it("emits the 🆕 glyph for a new node only when the viewer is the Builder", () => {
    const node = makeNode({
      id: "n12",
      summary: "Build failed: TS2322",
      importance: "medium",
      state: "new",
      observationIds: repeatObs(1),
    });
    expect(formatNodeLine(node, { viewer: "builder" })).toBe(
      "📁 n12 🆕med · Build failed: TS2322 · 1📄 · Jul 29 09:00",
    );
  });

  it("renders a new node as active (no glyph) for a non-Builder viewer", () => {
    const node = makeNode({
      id: "n12",
      summary: "Build failed: TS2322",
      importance: "medium",
      state: "new",
      observationIds: repeatObs(1),
    });
    expect(formatNodeLine(node, { viewer: "nonBuilder" })).toBe(
      "📁 n12 med · Build failed: TS2322 · 1📄 · Jul 29 09:00",
    );
  });

  it("appends 'in <parent>' when showParent is set", () => {
    const node = makeNode({ id: "n20", summary: "leaf branch", importance: "high", observationIds: repeatObs(1) });
    expect(formatNodeLine(node, { viewer: "builder", showParent: "n7" })).toBe(
      "📁 n20 high · leaf branch · in n7 · 1📄 · Jul 29 09:00",
    );
  });
});

describe("formatObservationLine", () => {
  it("renders an observation with its single timestamp", () => {
    const obs = makeObservation({
      id: "o5",
      content: "Chose JWT for stateless auth",
      importance: "high",
      timestamp: "2026-07-28 14:30",
    });
    expect(formatObservationLine(obs, { viewer: "builder" })).toBe(
      "📄 o5 high · Chose JWT for stateless auth · Jul 28 14:30",
    );
  });

  it("appends 'in <parent>' when showParent is set", () => {
    const obs = makeObservation({ id: "o5", content: "a fact", importance: "low", timestamp: "2026-07-28 14:30" });
    expect(formatObservationLine(obs, { viewer: "nonBuilder", showParent: "n7" })).toBe(
      "📄 o5 low · a fact · in n7 · Jul 28 14:30",
    );
  });
});

describe("RENDER_LEGEND", () => {
  it("is the canonical one-line shared legend (non-Builder; no Builder-only glyph)", () => {
    expect(RENDER_LEGEND).toBe("📁 node · 📄 observation · crit high med low · 📦archived 🪦obsolete");
  });
});

describe("singleLine rendering", () => {
  it("collapses newlines and whitespace runs so a multi-line summary stays one line", () => {
    const node = makeNode({
      id: "n1",
      summary: "line one\n  line two\t\n  three",
      importance: "high",
      observationIds: repeatObs(1),
    });
    const line = formatNodeLine(node, { viewer: "nonBuilder" });
    expect(line).toContain("line one line two three");
    expect(line.includes("\n")).toBe(false);
  });

  it("collapses newlines in an observation's content", () => {
    const obs = makeObservation({ id: "o1", content: "a\nb\nc", importance: "low", timestamp: "2026-07-28 14:30" });
    const line = formatObservationLine(obs, { viewer: "nonBuilder" });
    expect(line).toContain("a b c");
  });

  it("omits the summary segment when it is empty (no double delimiter)", () => {
    const node = makeNode({ id: "n1", summary: "", importance: "medium", observationIds: repeatObs(1) });
    const line = formatNodeLine(node, { viewer: "nonBuilder" });
    expect(line).not.toContain("·  ·");
    expect(line).toBe("📁 n1 med · 1📄 · Jul 29 09:00");
  });
});

// --- fixtures ---------------------------------------------------------------

interface NodeFixture extends Partial<Omit<Node, "timestamps">> {
  id: Node["id"];
  summary: string;
  importance: Node["importance"];
  rangeStart?: string;
  rangeEnd?: string;
}

function makeNode(fixture: NodeFixture): Node {
  const summary = fixture.summary;
  const rangeStart = fixture.rangeStart ?? FIXED_NOW;
  return {
    id: fixture.id,
    summary,
    summaryTokens: estimateContentTokens(summary),
    importance: fixture.importance,
    state: fixture.state ?? "active",
    parentNode: fixture.parentNode ?? null,
    observationIds: fixture.observationIds ?? [],
    childNodeIds: fixture.childNodeIds ?? [],
    supersededBy: fixture.supersededBy ?? null,
    timestamps: {
      createdAt: FIXED_NOW,
      updatedAt: FIXED_NOW,
      rangeStart,
      rangeEnd: fixture.rangeEnd ?? rangeStart,
    },
  };
}

function makeObservation(
  overrides: Partial<Observation> & Pick<Observation, "id" | "content" | "importance" | "timestamp">,
): Observation {
  const content = overrides.content;
  return {
    id: overrides.id,
    content,
    contentTokens: estimateContentTokens(content),
    importance: overrides.importance,
    sourceEntryIds: overrides.sourceEntryIds ?? ["1"],
    timestamp: overrides.timestamp,
    parentNode: overrides.parentNode ?? (N_GOAL as Observation["parentNode"]),
  };
}

function repeatObs(n: number): Observation["id"][] {
  return Array.from({ length: n }, (_, i) => `o${i + 1}` as Observation["id"]);
}
