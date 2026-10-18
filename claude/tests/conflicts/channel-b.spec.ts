// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// Channel B — the live plugin.register envelope listener:
// session.compact matched against uses.events AS PATTERNS ("*",
// "session.*", the literal count; classic.* patterns do NOT — the classic
// PreCompact hook is a different seam, advisory only; negated patterns are
// not affirmative), then the bounded scan over the envelope's root
// separates overriders from passive registrants. builtin tier skipped
// (inner — cannot override). Unscannable candidates fail safe.
import { describe, expect, test } from "vitest";
import { type Envelope, envelopeCompactMatch, handlePluginRegisterEnvelope } from "../../host/conflicts/channel-b.js";
import type { ScanIo } from "../../host/conflicts/scan.js";

function makeIo(files: Record<string, string>, dirs: string[] = [], broken: string[] = []): ScanIo {
  return {
    list: async (dir) => {
      if (broken.includes(dir)) throw new Error("unreadable");
      const norm = dir.replace(/\\/g, "/");
      const names = new Set<string>();
      for (const f of Object.keys(files))
        if (f.startsWith(`${norm}/`)) names.add(f.slice(norm.length + 1).split("/")[0]);
      for (const sub of dirs) if (sub.startsWith(`${norm}/`)) names.add(sub.slice(norm.length + 1).split("/")[0]);
      return [...names].map((name) => ({
        name,
        kind: (files[`${norm}/${name}`] !== undefined ? "file" : "directory") as "file" | "directory",
      }));
    },
    read: async (p: string) => files[p.replace(/\\/g, "/")] ?? "",
    stat: async (p: string) => ({ size: (files[p.replace(/\\/g, "/")] ?? "").length }),
  };
}

const OVERRIDE = 'on("session.compact", async ($, e, next) => { return { messages: [] }; });';
const PASSIVE = 'on("session.compact", async ($, e, next) => { log(e); return next(e); });';

describe("conflicts Channel B — the envelope pattern match", () => {
  test("the literal, the namespace wildcard and the global wildcard are affirmative", async () => {
    expect(envelopeCompactMatch(["session.compact"]).compact).toBe(true);
    expect(envelopeCompactMatch(["session.*"]).compact).toBe(true);
    expect(envelopeCompactMatch(["*"]).compact).toBe(true);
  });

  test("classic patterns are NOT affirmative (different seam) and flag classicOnly", async () => {
    const r = envelopeCompactMatch(["classic.PreCompact"]);
    expect(r.compact).toBe(false);
    expect(r.classicOnly).toBe(true);
  });

  test("other events and negated patterns are not affirmative", async () => {
    expect(envelopeCompactMatch(["session.append", "tool.call"]).compact).toBe(false);
    expect(envelopeCompactMatch(["session.append", "!session.compact"]).compact).toBe(false);
    expect(envelopeCompactMatch(["session.append", "!session.compact"]).classicOnly).toBe(false);
  });
});

describe("conflicts Channel B — the envelope handler", () => {
  const base = { selfName: "session-owl", familyPrefix: "avtc-claude-" };

  test("an overriding compact registrant at user tier hits with the envelope name", async () => {
    const env: Envelope = { name: "evil-mod", tier: "user", root: "/inst/evil", events: ["session.compact"] };
    const r = await handlePluginRegisterEnvelope(
      env,
      makeIo({ "/inst/evil/hooks/r.js": OVERRIDE }, ["/inst/evil", "/inst/evil/hooks"]),
      base,
    );
    expect(r.hit).toEqual({ channel: "B", name: "evil-mod", evidence: "session.compact" });
  });

  test("a passive compact registrant does not hit (registration alone is not a conflict)", async () => {
    const env: Envelope = { name: "bell-mod", tier: "user", root: "/inst/bell", events: ["session.compact"] };
    const r = await handlePluginRegisterEnvelope(
      env,
      makeIo({ "/inst/bell/hooks/r.js": PASSIVE }, ["/inst/bell", "/inst/bell/hooks"]),
      base,
    );
    expect(r.hit).toBeNull();
  });

  test("builtin tier is skipped (witnessed, never scanned)", async () => {
    const env: Envelope = {
      name: "cc-plugin-agents-md",
      tier: "builtin",
      root: "/builtin/amd",
      events: ["session.compact"],
    };
    const r = await handlePluginRegisterEnvelope(
      env,
      makeIo({ "/builtin/amd/r.js": OVERRIDE }, ["/builtin/amd"]),
      base,
    );
    expect(r.hit).toBeNull();
    expect(r.witness).toBe("cc-plugin-agents-md");
  });

  test("self and the family namespace are witnessed without scanning", async () => {
    const env: Envelope = { name: "session-owl", tier: "user", root: "/owl", events: ["session.compact"] };
    const r = await handlePluginRegisterEnvelope(env, makeIo({ "/owl/r.js": OVERRIDE }, ["/owl"]), base);
    expect(r.hit).toBeNull();
    const env2: Envelope = { name: "avtc-claude-logger", tier: "user", root: "/inst/log", events: ["session.compact"] };
    const r2 = await handlePluginRegisterEnvelope(env2, makeIo({ "/inst/log/r.js": OVERRIDE }, ["/inst/log"]), base);
    expect(r2.hit).toBeNull();
  });

  test("a classic-only registrant gets an advisory, not a pause", async () => {
    const env: Envelope = { name: "classic-mod", tier: "user", root: "/inst/classic", events: ["classic.PreCompact"] };
    const r = await handlePluginRegisterEnvelope(env, makeIo({}, ["/inst/classic"]), base);
    expect(r.hit).toBeNull();
    expect(r.advisory).toEqual({ name: "classic-mod", evidence: "classic.*", reason: "classic-only" });
  });

  test("an affirmative registrant whose root cannot be scanned fails safe: hit", async () => {
    const env: Envelope = { name: "locked-mod", tier: "user", root: "/inst/locked", events: ["session.*"] };
    const r = await handlePluginRegisterEnvelope(env, makeIo({}, [], ["/inst/locked"]), base);
    expect(r.hit).toEqual({ channel: "B", name: "locked-mod", evidence: "unscannable" });
  });
});
