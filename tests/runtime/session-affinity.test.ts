// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import { afterEach, describe, expect, it } from "vitest";
import {
  _resetSessionAffinity,
  clearSessionOwlSessionBase,
  getStageAffinityId,
  setSessionOwlSessionBase,
} from "../../src/runtime/session-affinity.js";

describe("session-affinity singleton", () => {
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
});
