// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import type { SessionEntry } from "@earendil-works/pi-coding-agent";
// The Selector's input-view host port: working-copy build, tail + todo
// context assembly, and the working-tree render — the same behaviors pi's
// selector/input-view.ts pins (its suite's counterparts), driven against the
// vendored core helpers.
import { describe, expect, test } from "vitest";
import type { ChunkOptions } from "../../core/src/format/chunk.js";
import type { TodoContext } from "../../core/src/todo/types.js";
import type { Node, NodeId, Observation, ObsId } from "../../core/src/types.js";
import { makeNode, nowStoredTimestamp, SessionOwlGraph } from "../../core/src/types.js";
import { extractMessageText, isUnstuckAutoContinue } from "../../host/lifecycle.js";
import {
  buildTail,
  buildTodo,
  buildWorkingCopy,
  renderWorkingRoots,
  type TailContext,
} from "../../host/runs/selector-input-view.js";

const CHUNK_OPTS: ChunkOptions = {
  tokenThreshold: 4000,
  toolBlockCapTokens: 1200,
  includeThinking: false,
  includeEntryId: true,
};

function userMsg(id: string, text: string, ts = 1): SessionEntry {
  return { id, timestamp: ts, type: "message", message: { role: "user", content: text } } as unknown as SessionEntry;
}

function assistantMsg(id: string, text: string, ts = 2): SessionEntry {
  return {
    id,
    timestamp: ts,
    type: "message",
    message: { role: "assistant", content: [{ type: "text", text }] },
  } as unknown as SessionEntry;
}

describe("lifecycle slice — unstuck predicate", () => {
  test("the exact auto-continue phrases are skipped; real text is not", () => {
    const msg = (text: string) => ({ role: "user", content: text }) as never;
    expect(isUnstuckAutoContinue(msg("continue"))).toBe(true);
    expect(isUnstuckAutoContinue(msg("please continue"))).toBe(true);
    expect(isUnstuckAutoContinue(msg("Continue"))).toBe(false); // exact-content match
    expect(isUnstuckAutoContinue(msg("please continue with the port"))).toBe(false);
  });

  test("extractMessageText joins text parts (string or TextContent[])", () => {
    expect(extractMessageText({ role: "user", content: "abc" } as never)).toBe("abc");
    expect(
      extractMessageText({
        role: "assistant",
        content: [
          { type: "text", text: "a" },
          { type: "text", text: "b" },
        ],
      } as never),
    ).toBe("ab");
  });
});

describe("buildWorkingCopy", () => {
  test("clones non-obsolete nodes + their observations; drops obsolete; reparents its children to root; injects nIrrelevant", () => {
    const src = new SessionOwlGraph({ nodes: new Map(), observations: new Map(), nextObsId: 1, nextNodeId: 1 });
    const t = nowStoredTimestamp();
    const nid = (id: string) => id as NodeId;
    const n1 = makeNode({
      id: nid("n1"),
      summary: "alive",
      importance: "high",
      parentNode: null,
      state: "active",
      createdAt: t,
    });
    const nObs = makeNode({
      id: nid("n-ob"),
      summary: "dead",
      importance: "low",
      parentNode: null,
      state: "obsolete",
      createdAt: t,
    });
    const nChild = makeNode({
      id: nid("n-child"),
      summary: "child of dead",
      importance: "low",
      parentNode: nid("n-ob"),
      state: "active",
      createdAt: t,
    });
    src.nodes.set(nid("n1"), n1);
    src.nodes.set(nid("n-ob"), nObs);
    src.nodes.set(nid("n-child"), nChild);
    src.observations.set(
      "o1" as ObsId,
      {
        id: "o1" as ObsId,
        summary: "under alive",
        importance: "med",
        sourceEntryIds: ["e1"],
        timestamp: t,
        parentNode: "n1" as NodeId,
        detailsLines: 2,
        detailsTokens: 8,
      } as unknown as Observation,
    );
    src.observations.set(
      "o2" as ObsId,
      {
        id: "o2" as ObsId,
        summary: "under dead",
        importance: "low",
        sourceEntryIds: ["e2"],
        timestamp: t,
        parentNode: "n-ob" as NodeId,
        detailsLines: 1,
        detailsTokens: 4,
      } as unknown as Observation,
    );

    const { graph, nIrrelevantId } = buildWorkingCopy(src);
    expect([...graph.nodes.keys()].sort()).toEqual(["n-child", "n1", "nIrrelevant"]);
    expect(nIrrelevantId).toBe("nIrrelevant");
    // the dropped-obsolete child reparents to root; its parent link is null
    expect(graph.nodes.get("n-child" as NodeId)?.parentNode).toBeNull();
    // observations under the dropped node go; the survivor's stay
    expect(graph.observations.has("o1")).toBe(true);
    expect(graph.observations.has("o2")).toBe(false);
    // fully independent: mutating the copy never touches the source
    const copyN1 = graph.nodes.get("n1" as NodeId);
    if (copyN1 !== undefined) copyN1.summary = "changed";
    expect(src.nodes.get("n1" as NodeId)?.summary).toBe("alive");
    expect(src.nodes.has("nIrrelevant")).toBe(false);
  });
});

describe("buildTail", () => {
  const branch: SessionEntry[] = [
    userMsg("u1", "first ask"),
    assistantMsg("a1", "first answer"),
    userMsg("u2", "continue"), // unstuck injection — skipped as "last user"
    assistantMsg("a2", "second answer"),
    userMsg("u3", "real last ask"), // the LAST real user — BEFORE the cut
    assistantMsg("a3", "third answer"), // the pair partner
    userMsg("u4", "please continue"), // unstuck — after the cut, inside the tail
    assistantMsg("a4", "post-cut answer"),
  ];
  const ctx: TailContext = {
    getBranch: () => branch,
    getLeafId: () => "u4",
  };

  test("null boundary → empty (mid-session, the Selector defers)", () => {
    expect(buildTail(ctx, { firstKeptEntryId: null }, CHUNK_OPTS)).toBe("");
  });

  test("cut not on the branch → empty", () => {
    expect(buildTail(ctx, { firstKeptEntryId: "missing" }, CHUNK_OPTS)).toBe("");
  });

  test("last real user inside the tail → the tail verbatim", () => {
    const tail = buildTail(ctx, { firstKeptEntryId: "u3" }, CHUNK_OPTS); // u3 is inside its own tail
    expect(tail).toContain("real last ask");
    expect(tail).toContain("post-cut answer");
    expect(tail).not.toContain("…<truncated events>…"); // verbatim — no prelude
  });

  test("last real user BEFORE the cut → its assistant pair + the user + the truncation marker + the tail", () => {
    const tail = buildTail(ctx, { firstKeptEntryId: "a4" }, CHUNK_OPTS);
    expect(tail).toContain("second answer"); // the user's PRECEDING assistant text
    expect(tail).toContain("real last ask");
    expect(tail).toContain("…<truncated events>…");
    expect(tail).toContain("post-cut answer");
    // the unstuck injection is never the "last user"
    expect(tail.indexOf("real last ask")).toBeGreaterThan(-1);
  });
});

describe("buildTodo", () => {
  test("in-progress with details + pending list; placeholder when idle", () => {
    const active: TodoContext = {
      getInProgress: () => ({ name: "port the runs", details: "observer first" }),
      getPending: () => [{ name: "widget" }, { name: "commands" }],
    } as unknown as TodoContext;
    expect(buildTodo(active)).toBe("Todo\nin_progress: port the runs\nobserver first\npending:\n- widget\n- commands");
    const idle: TodoContext = {
      getInProgress: () => null,
      getPending: () => [],
    } as unknown as TodoContext;
    expect(buildTodo(idle)).toBe("Todo\n(nothing in progress)");
  });
});

describe("renderWorkingRoots", () => {
  test("nGoal first, nIrrelevant last, importance order between", () => {
    const g = new SessionOwlGraph({ nodes: new Map(), observations: new Map(), nextObsId: 1, nextNodeId: 1 });
    const t = nowStoredTimestamp();
    const mk = (id: string, imp: "crit" | "high" | "med" | "low", summary: string): Node =>
      makeNode({ id: id as NodeId, summary, importance: imp, parentNode: null, state: "active", createdAt: t });
    g.nodes.set("nGoal", mk("nGoal", "crit", "the goal"));
    g.nodes.set("n-med" as NodeId, mk("n-med", "med", "medium root"));
    g.nodes.set("nIrrelevant", mk("nIrrelevant", "med", "Irrelevant"));
    g.nodes.set("n-high" as NodeId, mk("n-high", "high", "high root"));
    const text = renderWorkingRoots({ graph: g, nIrrelevantId: "nIrrelevant" as NodeId });
    const goalAt = text.indexOf("the goal");
    const highAt = text.indexOf("high root");
    const medAt = text.indexOf("medium root");
    const irrAt = text.indexOf("Irrelevant");
    expect(goalAt).toBeGreaterThanOrEqual(0);
    expect(goalAt).toBeLessThan(highAt);
    expect(highAt).toBeLessThan(medAt);
    expect(irrAt).toBeGreaterThan(medAt);
  });
});
