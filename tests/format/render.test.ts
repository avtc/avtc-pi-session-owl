// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import { describe, expect, it } from "vitest";
import {
  formatDayTime,
  formatNodeLine,
  formatObservationLine,
  formatTimestamp,
  formatTimestampRange,
  RENDER_LEGEND,
  toStoredTimestamp,
} from "../../src/format/render.js";
import type { Node, Observation } from "../../src/types.js";
import { countLines, estimateContentTokens, N_GOAL } from "../../src/types.js";

const FIXED_NOW = "2026-07-29T09:00:00.000Z";

describe("formatTimestamp", () => {
  it("renders a stored YYYY-MM-DD HH:MM as Jul 28 14:30", () => {
    expect(formatTimestamp("2026-07-28T14:30:00.000Z")).toBe("Jul 28 14:30");
  });

  it("maps every month to its abbreviation", () => {
    expect(formatTimestamp("2026-01-05T08:00:00.000Z")).toBe("Jan 05 08:00");
    expect(formatTimestamp("2026-12-31T23:59:00.000Z")).toBe("Dec 31 23:59");
  });

  it("renders an out-of-range month as a placeholder (defensive)", () => {
    expect(formatTimestamp("2026-99-05 08:00")).toBe("??? 05 08:00");
  });
});

describe("formatDayTime", () => {
  it("renders a stored instant as <Mon> <DD> <HH:MM> (month + day + time)", () => {
    expect(formatDayTime("2026-07-28T14:30:00.000Z")).toBe("Jul 28 14:30");
  });

  it("maps month + day + time (locale-independent English abbreviations)", () => {
    expect(formatDayTime("2026-01-05T08:00:00.000Z")).toBe("Jan 05 08:00");
    expect(formatDayTime("2026-12-31T23:59:00.000Z")).toBe("Dec 31 23:59");
  });

  it("falls back for a legacy non-ISO value", () => {
    expect(formatDayTime("2026-07-28 14:30")).toBe("2026-07-28 14:30");
  });
});

describe("formatTimestampRange", () => {
  it("renders a cross-day range with both dates", () => {
    expect(formatTimestampRange("2026-07-28T14:30:00.000Z", "2026-07-29T09:15:00.000Z")).toBe(
      "Jul 28 14:30 — Jul 29 09:15",
    );
  });

  it("compresses a same-day range to a single date + end time", () => {
    expect(formatTimestampRange("2026-07-28T14:30:00.000Z", "2026-07-28T17:00:00.000Z")).toBe("Jul 28 14:30 — 17:00");
  });

  it("collapses an identical start/end to a single timestamp", () => {
    expect(formatTimestampRange("2026-07-28T14:30:00.000Z", "2026-07-28T14:30:00.000Z")).toBe("Jul 28 14:30");
  });
});

describe("toStoredTimestamp", () => {
  it("normalizes a real ISO session-entry timestamp to the stored UTC ISO contract", () => {
    expect(toStoredTimestamp("2026-07-29T09:22:50.283Z")).toBe("2026-07-29T09:22:50.283Z");
  });

  it("passes an already-contracted value through unchanged", () => {
    expect(toStoredTimestamp("2026-07-29T09:22:00.000Z")).toBe("2026-07-29T09:22:00.000Z");
  });

  it("passes an unparseable value through unchanged (tolerant)", () => {
    expect(toStoredTimestamp("not a timestamp")).toBe("not a timestamp");
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
      rangeStart: "2026-07-28T14:30:00.000Z",
      rangeEnd: "2026-07-29T09:15:00.000Z",
    });
    expect(formatNodeLine(node, { viewer: "builder" })).toBe(
      "n7 · high · Auth migration to JWT · 3nodes 12obs · Jul 28 14:30 — Jul 29 09:15",
    );
  });

  it("uses grammar-correct singular/plural for child counts (1node Xobs)", () => {
    const node = makeNode({
      id: "n7",
      summary: "Auth migration",
      importance: "high",
      observationIds: repeatObs(1),
      childNodeIds: ["n8"],
    });
    expect(formatNodeLine(node, { viewer: "builder" })).toContain("1node 1obs");
  });

  it("uses grammar-correct singular for a multi-line obs size", () => {
    const obs = makeObservation({
      id: "o9",
      summary: "line one\nline two\nline three",
      importance: "high",
      timestamp: "2026-07-28T14:30:00.000Z",
    });
    // 3 lines (3line, plural) + ceil(28/4)=7 tokens (7tokens, plural)
    expect(formatObservationLine(obs, { viewer: "builder" })).toContain("3lines 7tokens");
  });

  it("renders empty observation content as 0lines 0tokens", () => {
    const obs = makeObservation({
      id: "o1",
      summary: "",
      importance: "low",
      timestamp: "2026-07-28T14:30:00.000Z",
    });
    expect(formatObservationLine(obs, { viewer: "builder" })).toContain("0lines 0tokens");
  });

  it("counts a trailing newline as a terminator, not an extra line", () => {
    const obs = makeObservation({
      id: "o2",
      summary: "a single line with a trailing newline\n",
      importance: "low",
      timestamp: "2026-07-28T14:30:00.000Z",
    });
    // one line of content + a terminator newline → 1line, not 2lines
    expect(formatObservationLine(obs, { viewer: "builder" })).toContain("1line ");
    expect(formatObservationLine(obs, { viewer: "builder" })).not.toContain("2lines");
  });

  it("omits the child count when the node has only observations", () => {
    const node = makeNode({ id: "nGoal", summary: "the goal", importance: "crit", observationIds: repeatObs(2) });
    expect(formatNodeLine(node, { viewer: "nonBuilder" })).toBe("nGoal · crit · the goal · 2obs · Jul 29 09:00");
  });

  it("renders an archived node with the 📦 glyph", () => {
    const node = makeNode({ id: "n3", summary: "old branch", importance: "low", state: "archived" });
    expect(formatNodeLine(node, { viewer: "builder" })).toBe("n3 · 📦low · old branch · 0obs · Jul 29 09:00");
  });

  it("renders an obsolete node with the 🪦 glyph and the → supersededBy link", () => {
    const node = makeNode({
      id: "n2",
      summary: "YAML config",
      importance: "med",
      state: "obsolete",
      supersededBy: "n7",
    });
    expect(formatNodeLine(node, { viewer: "builder" })).toBe("n2 · 🪦med · YAML config · → n7 · 0obs · Jul 29 09:00");
  });

  it("emits the 🆕 glyph for a new node only when the viewer is the Builder", () => {
    const node = makeNode({
      id: "n12",
      summary: "Build failed: TS2322",
      importance: "med",
      state: "new",
      observationIds: repeatObs(1),
    });
    expect(formatNodeLine(node, { viewer: "builder" })).toBe(
      "n12 · 🆕med · Build failed: TS2322 · 1obs · Jul 29 09:00",
    );
  });

  it("renders a new node as active (no glyph) for a non-Builder viewer", () => {
    const node = makeNode({
      id: "n12",
      summary: "Build failed: TS2322",
      importance: "med",
      state: "new",
      observationIds: repeatObs(1),
    });
    expect(formatNodeLine(node, { viewer: "nonBuilder" })).toBe(
      "n12 · med · Build failed: TS2322 · 1obs · Jul 29 09:00",
    );
  });

  it("renders an empty summary with no summary segment (no fallback)", () => {
    // wrappers are seeded with their observation's summary at capture, so an
    // empty summary is not a normal state; the render simply omits the segment.
    const node = makeNode({
      id: "n15",
      summary: "",
      importance: "med",
      state: "new",
      observationIds: repeatObs(1),
    });
    expect(formatNodeLine(node, { viewer: "builder" })).toBe("n15 · 🆕med · 1obs · Jul 29 09:00");
  });

  it("appends 'in <parent>' when showParent is set", () => {
    const node = makeNode({ id: "n20", summary: "leaf branch", importance: "high", observationIds: repeatObs(1) });
    expect(formatNodeLine(node, { viewer: "builder", showParent: "n7" })).toBe(
      "n20 · high · leaf branch · in n7 · 1obs · Jul 29 09:00",
    );
  });
});

describe("formatObservationLine", () => {
  it("renders an observation with its single timestamp", () => {
    const obs = makeObservation({
      id: "o5",
      summary: "Chose JWT for stateless auth",
      importance: "high",
      timestamp: "2026-07-28T14:30:00.000Z",
    });
    expect(formatObservationLine(obs, { viewer: "builder" })).toBe(
      "o5 · high · Chose JWT for stateless auth · 1line 7tokens · Jul 28 14:30",
    );
  });

  it("appends 'in <parent>' when showParent is set", () => {
    const obs = makeObservation({
      id: "o5",
      summary: "a fact",
      importance: "low",
      timestamp: "2026-07-28T14:30:00.000Z",
    });
    expect(formatObservationLine(obs, { viewer: "nonBuilder", showParent: "n7" })).toBe(
      "o5 · low · a fact · in n7 · 1line 2tokens · Jul 28 14:30",
    );
  });

  it("applies formatContent to transform the content line", () => {
    const obs = makeObservation({
      id: "o5",
      summary: "a fact",
      importance: "low",
      timestamp: "2026-07-28T14:30:00.000Z",
    });
    const upper = (c: string) => c.toUpperCase();
    expect(formatObservationLine(obs, { viewer: "nonBuilder", formatContent: upper })).toBe(
      "o5 · low · A FACT · 1line 2tokens · Jul 28 14:30",
    );
  });

  it("omits the content segment when formatContent returns empty (content-free header)", () => {
    const obs = makeObservation({
      id: "o5",
      summary: "a fact",
      importance: "low",
      timestamp: "2026-07-28T14:30:00.000Z",
    });
    const none = () => "";
    expect(formatObservationLine(obs, { viewer: "nonBuilder", showParent: "n7", formatContent: none })).toBe(
      "o5 · low · in n7 · 1line 2tokens · Jul 28 14:30",
    );
  });
});

describe("RENDER_LEGEND", () => {
  it("is the canonical one-line shared legend (non-Builder; no Builder-only glyph)", () => {
    expect(RENDER_LEGEND).toBe(
      "n.. node · o.. observation · importance crit high med low (how much it matters if lost) · 📦archived 🪦obsolete",
    );
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
    const obs = makeObservation({
      id: "o1",
      summary: "a\nb\nc",
      importance: "low",
      timestamp: "2026-07-28T14:30:00.000Z",
    });
    const line = formatObservationLine(obs, { viewer: "nonBuilder" });
    expect(line).toContain("a b c");
  });

  it("omits the summary segment when it is empty (no double delimiter)", () => {
    const node = makeNode({ id: "n1", summary: "", importance: "med", observationIds: repeatObs(1) });
    const line = formatNodeLine(node, { viewer: "nonBuilder" });
    expect(line).not.toContain("·  ·");
    expect(line).toBe("n1 · med · 1obs · Jul 29 09:00");
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
  overrides: Partial<Observation> & Pick<Observation, "id" | "summary" | "importance" | "timestamp">,
): Observation {
  const summary = overrides.summary;
  return {
    id: overrides.id,
    summary,
    summaryTokens: estimateContentTokens(summary),
    detailsLines: overrides.detailsLines ?? countLines(summary),
    detailsTokens: overrides.detailsTokens ?? estimateContentTokens(summary),
    importance: overrides.importance,
    sourceEntryIds: overrides.sourceEntryIds ?? ["1"],
    timestamp: overrides.timestamp,
    parentNode: overrides.parentNode ?? (N_GOAL as Observation["parentNode"]),
  };
}

function repeatObs(n: number): Observation["id"][] {
  return Array.from({ length: n }, (_, i) => `o${i + 1}` as Observation["id"]);
}
