// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  _resetSessionAffinity,
  clearSessionOwlSessionBase,
  getStageAffinityId,
  setSessionOwlSessionBase,
} from "../../src/runtime/session-affinity.js";
import { activateConversation, resetConversationStates } from "../../src/store/graph-store.js";

describe("session-affinity singleton", () => {
  // isolate:false shares module state across files in a worker — the fresh
  // premise is OWNED here, not assumed (a base leaked by another suite's
  // stage run would otherwise fail the first assertion)
  beforeEach(() => {
    _resetSessionAffinity();
  });

  afterEach(() => {
    _resetSessionAffinity();
  });

  it("returns null for every stage before a base is set", () => {
    expect(getStageAffinityId("observe")).toBeNull();
    expect(getStageAffinityId("build")).toBeNull();
    expect(getStageAffinityId("select")).toBeNull();
  });

  it("returns a per-stage id suffixed off the base after setSessionOwlSessionBase", () => {
    setSessionOwlSessionBase("abc-123");
    expect(getStageAffinityId("observe")).toBe("abc-123:observe");
    expect(getStageAffinityId("build")).toBe("abc-123:build");
    expect(getStageAffinityId("select")).toBe("abc-123:select");
  });

  it("returns null again for every stage after clearSessionOwlSessionBase", () => {
    setSessionOwlSessionBase("abc-123");
    expect(getStageAffinityId("build")).toBe("abc-123:build");
    clearSessionOwlSessionBase();
    expect(getStageAffinityId("observe")).toBeNull();
    expect(getStageAffinityId("build")).toBeNull();
    expect(getStageAffinityId("select")).toBeNull();
  });

  it("setSessionOwlSessionBase overwrites a prior base", () => {
    setSessionOwlSessionBase("first");
    expect(getStageAffinityId("build")).toBe("first:build");
    setSessionOwlSessionBase("second");
    expect(getStageAffinityId("build")).toBe("second:build");
  });

  it("bases partition per conversation: flips never cross-contaminate", () => {
    activateConversation("afA");
    setSessionOwlSessionBase("base-a");
    activateConversation("afB");
    setSessionOwlSessionBase("base-b");
    expect(getStageAffinityId("observe")).toBe("base-b:observe");

    activateConversation("afA");
    // a single shared slot would lose B's base under A's key
    expect(getStageAffinityId("observe")).toBe("base-a:observe");

    // a clear drops the ACTIVE conversation's entry; the other key keeps its own
    clearSessionOwlSessionBase();
    expect(getStageAffinityId("observe")).toBeNull();
    activateConversation("afB");
    expect(getStageAffinityId("observe")).toBe("base-b:observe");
    resetConversationStates();
  });
});
