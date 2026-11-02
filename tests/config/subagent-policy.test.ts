// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

/**
 * The subagent self-application policy (applySubagentPolicy in config/schema.ts):
 * in a child session (PI_SUBAGENT_PARENT_PID set), the config's own subagentMode
 * decides the effective behavior — disabled → owl off, on-compaction → observer
 * deferred, inherited → verbatim. In the root session the marker is absent and
 * the config passes through untouched.
 *
 * Ported from avtc-pi-subagent tests/env.test.ts (applySessionOwlSubagentPolicy),
 * where this logic used to live as a spawn-side env-blob rewrite (the leak this
 * move fixes). The scenarios map 1:1 onto the config seam.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  _resetGetSessionOwlSettings,
  _setGetSessionOwlSettings,
  DEFAULT_CONFIG,
  getSessionOwlSettings,
} from "../../src/config/schema.js";

const MARKER = "PI_SUBAGENT_PARENT_PID";

function withMarker(value: string | undefined, fn: () => void): void {
  const prev = process.env[MARKER];
  if (value === undefined) delete process.env[MARKER];
  else process.env[MARKER] = value;
  try {
    fn();
  } finally {
    if (prev === undefined) delete process.env[MARKER];
    else process.env[MARKER] = prev;
  }
}

afterEach(() => {
  _resetGetSessionOwlSettings();
});

describe("subagent policy self-application (getSessionOwlSettings)", () => {
  it("root session (no marker): config passes through unchanged in every mode", () => {
    for (const subagentMode of ["inherited", "disabled", "on-compaction"] as const) {
      _setGetSessionOwlSettings(() => ({
        ...DEFAULT_CONFIG,
        subagentMode,
        enabled: true,
        observerMode: "on-threshold",
      }));
      withMarker(undefined, () => {
        const cfg = getSessionOwlSettings();
        expect(cfg.enabled).toBe(true);
        expect(cfg.observerMode).toBe("on-threshold");
        expect(cfg.subagentMode).toBe(subagentMode);
      });
    }
  });

  it("no `process` global (the Claude hooks sandbox): the policy reads as a root session, never throws", () => {
    // The sandbox may not expose Node's `process`; the read must degrade to
    // the root-session no-op instead of a ReferenceError that kills the
    // settings bootstrap for the whole session.
    _setGetSessionOwlSettings(() => ({ ...DEFAULT_CONFIG, subagentMode: "on-compaction", enabled: true }));
    const prevProcess = globalThis.process;
    vi.stubGlobal("process", undefined);
    try {
      const cfg = getSessionOwlSettings();
      expect(cfg.enabled).toBe(true);
      expect(cfg.observerMode).toBe(DEFAULT_CONFIG.observerMode);
    } finally {
      vi.unstubAllGlobals();
      if (prevProcess !== undefined) globalThis.process = prevProcess;
    }
  });

  it("child + subagentMode disabled: owl fully off, every other knob intact", () => {
    // THE critical shape (ported verbatim): the owl settings read is absolute —
    // the policy must toggle the master switch WITHOUT resetting anything else.
    _setGetSessionOwlSettings(() => ({
      ...DEFAULT_CONFIG,
      enabled: true,
      subagentMode: "disabled",
      observerThresholdTokens: 1,
      observerMaxTokens: 16384,
    }));
    withMarker("12345", () => {
      const cfg = getSessionOwlSettings();
      expect(cfg.enabled).toBe(false);
      expect(cfg.subagentMode).toBe("disabled");
      expect(cfg.observerThresholdTokens).toBe(1);
      expect(cfg.observerMaxTokens).toBe(16384);
    });
  });

  it("child + subagentMode on-compaction: the observer is deferred to the child's own compaction", () => {
    _setGetSessionOwlSettings(() => ({
      ...DEFAULT_CONFIG,
      enabled: true,
      subagentMode: "on-compaction",
      observerMode: "on-threshold",
      observerThresholdTokens: 4000,
    }));
    withMarker("12345", () => {
      const cfg = getSessionOwlSettings();
      expect(cfg.enabled).toBe(true);
      expect(cfg.observerMode).toBe("on-compaction");
      expect(cfg.observerThresholdTokens).toBe(4000);
    });
  });

  it("child + on-compaction over an already-deferred config: idempotent", () => {
    _setGetSessionOwlSettings(() => ({
      ...DEFAULT_CONFIG,
      enabled: true,
      subagentMode: "on-compaction",
      observerMode: "on-compaction",
    }));
    withMarker("12345", () => {
      const cfg = getSessionOwlSettings();
      expect(cfg.observerMode).toBe("on-compaction");
      expect(cfg.enabled).toBe(true);
    });
  });

  it("child + subagentMode inherited: the config is returned verbatim", () => {
    const source = {
      ...DEFAULT_CONFIG,
      enabled: true,
      subagentMode: "inherited",
      observerMode: "on-threshold",
      debugLog: true,
    } as const;
    _setGetSessionOwlSettings(() => ({ ...source }));
    withMarker("12345", () => {
      const cfg = getSessionOwlSettings();
      expect(cfg).toEqual(source);
    });
  });

  it("child + already-off config: stays off (idempotent rewrite)", () => {
    _setGetSessionOwlSettings(() => ({ ...DEFAULT_CONFIG, enabled: false, subagentMode: "disabled" }));
    withMarker("12345", () => {
      expect(getSessionOwlSettings().enabled).toBe(false);
    });
  });

  it("child + the default config path (no handle, no override): policy still applies", () => {
    // DEFAULT_CONFIG has subagentMode "on-compaction" — before any settings init,
    // a child session must still self-apply the deferred observer.
    withMarker("12345", () => {
      const cfg = getSessionOwlSettings();
      expect(cfg.subagentMode).toBe("on-compaction");
      expect(cfg.observerMode).toBe("on-compaction");
    });
  });

  it("empty-string marker value counts as a child (marker presence is the signal)", () => {
    _setGetSessionOwlSettings(() => ({ ...DEFAULT_CONFIG, enabled: true, subagentMode: "disabled" }));
    withMarker("", () => {
      expect(getSessionOwlSettings().enabled).toBe(false);
    });
  });
});
