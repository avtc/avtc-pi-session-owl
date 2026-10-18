// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// Resident conversation states (core registry): `activate()` is a pointer
// flip onto a per-key GraphStore — no reset, no disk when the state is
// resident. pi's default path (no activate call) keeps today's lazy
// singleton behavior under one default key.

import { beforeEach, describe, expect, it } from "vitest";
import {
  activateConversation,
  currentConversationKey,
  DEFAULT_CONVERSATION_KEY,
  evictConversation,
  getGraphStore,
  resetConversationStates,
  resetForNewSession,
} from "../../src/store/graph-store.js";
import { makeNode, type NodeId } from "../../src/types.js";

describe("graph-store — resident conversation registry", () => {
  beforeEach(() => {
    resetConversationStates();
  });

  it("pi's default key: never calling activate keeps the lazy singleton shape", () => {
    expect(currentConversationKey()).toBe(DEFAULT_CONVERSATION_KEY);
    const g = getGraphStore();
    expect(g.graph.nodes).toBeInstanceOf(Map);
    // second read: same object, no re-create
    expect(getGraphStore()).toBe(g);
  });

  it("activate(K) reports a miss on first arrival and a hit when resident", () => {
    const gA = getGraphStore(); // default-key state
    expect(activateConversation("A").resident).toBe(false); // first arrival of A
    const gA2 = getGraphStore(); // lazy create under A
    expect(gA2).not.toBe(gA);

    expect(activateConversation("B").resident).toBe(false);
    const gB = getGraphStore();
    expect(gB).not.toBe(gA2);

    // back to A: resident — the SAME object comes back, contents intact
    const hit = activateConversation("A");
    expect(hit.resident).toBe(true);
    expect(getGraphStore()).toBe(gA2);
  });

  it("a resident flip preserves the previous conversation's graph state", () => {
    activateConversation("A");
    const gA = getGraphStore();
    gA.observerFrontier = "entry-a";
    gA.graph.nodes.set(
      "nA" as NodeId,
      makeNode({
        id: "nA" as NodeId,
        summary: "resident marker",
        importance: "low",
        state: "active",
        parentNode: null,
        createdAt: "2026-10-13T00:00:00.000Z",
      }),
    );

    activateConversation("B");
    getGraphStore(); // B's fresh state

    expect(activateConversation("A").resident).toBe(true);
    const back = getGraphStore();
    expect(back.observerFrontier).toBe("entry-a");
    expect(back.graph.nodes.has("nA" as NodeId)).toBe(true);
  });

  it("resetForNewSession evicts the ACTIVE key (the next arrival cold-loads)", () => {
    const gA = getGraphStore();
    resetForNewSession();
    expect(activateConversation(DEFAULT_CONVERSATION_KEY).resident).toBe(false);
    expect(getGraphStore()).not.toBe(gA);
  });

  it("resetConversationStates drops every resident state", () => {
    const gDefault = getGraphStore();
    activateConversation("A");
    const gA = getGraphStore();
    resetConversationStates();
    expect(currentConversationKey()).toBe(DEFAULT_CONVERSATION_KEY);
    expect(getGraphStore()).not.toBe(gDefault); // default evicted
    activateConversation("A");
    expect(getGraphStore()).not.toBe(gA); // A evicted → a fresh object
  });

  it("resident map holds every parallel conversation — no count cap; only events evict", () => {
    const seen = new Map<string, ReturnType<typeof getGraphStore>>();
    for (const key of ["l1", "l2", "l3", "l4", "l5", "l6"]) {
      activateConversation(key);
      seen.set(key, getGraphStore());
    }
    // every key still resident — a parallel subagent's neighbor is never
    // count-evicted (owner: no LRU, no limits for parallel subagents)
    for (const key of seen.keys()) {
      expect(activateConversation(key).resident).toBe(true);
      expect(getGraphStore()).toBe(seen.get(key));
    }
    // events are the only eviction: handoff/teardown drops exactly one key
    evictConversation("l3");
    expect(activateConversation("l3").resident).toBe(false);
    expect(getGraphStore()).not.toBe(seen.get("l3")); // cold miss ⇒ fresh state
    expect(activateConversation("l5").resident).toBe(true); // others untouched
    expect(getGraphStore()).toBe(seen.get("l5"));
  });
});
