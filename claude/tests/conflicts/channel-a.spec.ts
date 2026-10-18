// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// Channel A — the disk enumeration: installed_plugins.json +
// the enabledPlugins key per settings source, unioned, deduped, filtered to
// enabled entries by the engine's precedence (policy > flag > local >
// project > user; the highest source that MENTIONS the key wins, explicit
// false disables), then self + family namespace skipped, curated markers
// checked (list ships empty), and hooks-declared mods deep-scanned with the
// bounded scan. Unscannable candidates fail safe (hit).
import { describe, expect, test } from "vitest";
import { type ChannelAIo, CONFLICT_MARKERS, runChannelA } from "../../host/conflicts/channel-a.js";

function makeIo(opts: {
  installed?: unknown;
  enabled?: Partial<Record<"user" | "project" | "local" | "flag" | "policy", Record<string, boolean>>>;
  files?: Record<string, string>;
  dirs?: string[];
  brokenDirs?: string[];
}): ChannelAIo {
  const files: Record<string, string> = { ...(opts.files ?? {}) };
  if (opts.installed !== undefined) files["<cfg>/plugins/installed_plugins.json"] = JSON.stringify(opts.installed);
  return {
    readInstalledPlugins: () => Promise.resolve(opts.installed === undefined ? null : (opts.installed as object)),
    readEnabledPlugins: (source) => Promise.resolve(opts.enabled?.[source] ?? null),
    list: async (dir) => {
      if ((opts.brokenDirs ?? []).includes(dir)) throw new Error("unreadable");
      const norm = dir.replace(/\\/g, "/");
      const names = new Set<string>();
      for (const f of Object.keys(files)) {
        if (f.startsWith(`${norm}/`)) names.add(f.slice(norm.length + 1).split("/")[0]);
      }
      for (const sub of opts.dirs ?? []) {
        if (sub.startsWith(`${norm}/`)) names.add(sub.slice(norm.length + 1).split("/")[0]);
      }
      return [...names].map((name) => ({
        name,
        kind: (files[`${norm}/${name}`] !== undefined ? "file" : "directory") as "file" | "directory",
      }));
    },
    read: async (p) => {
      const v = files[p.replace(/\\/g, "/")];
      if (v === undefined) throw new Error("missing");
      return v;
    },
    stat: async (p) => ({ size: (files[p.replace(/\\/g, "/")] ?? "").length }),
  };
}

const HOOKS = JSON.stringify({ modules: ["./register.js"] });
const NO_HOOKS = JSON.stringify({ modules: [] });
const OVERRIDE = 'on("session.compact", async ($, e, next) => { return { messages: [] }; });';

describe("conflicts Channel A — registry + enablement parsing", () => {
  test("installed and enabled with an overriding hooks module hits", async () => {
    const io = makeIo({
      installed: { plugins: { "evil@market": [{ installPath: "/inst/evil" }] } },
      enabled: { user: { "evil@market": true } },
      files: { "/inst/evil/hooks/hooks.json": HOOKS, "/inst/evil/hooks/register.js": OVERRIDE },
      dirs: ["/inst/evil", "/inst/evil/hooks"],
    });
    const r = await runChannelA({ io, selfName: "session-owl", selfRoot: "/owl", familyPrefix: "avtc-claude-" });
    expect(r.hits).toEqual([{ channel: "A", name: "evil@market", evidence: "session.compact" }]);
  });

  test("installed but disabled is skipped (enablement precedence: explicit false wins)", async () => {
    const io = makeIo({
      installed: { plugins: { "evil@market": [{ installPath: "/inst/evil" }] } },
      enabled: { user: { "evil@market": true }, policy: { "evil@market": false } },
      files: { "/inst/evil/hooks/hooks.json": HOOKS, "/inst/evil/hooks/register.js": OVERRIDE },
      dirs: ["/inst/evil", "/inst/evil/hooks"],
    });
    const r = await runChannelA({ io, selfName: "session-owl", selfRoot: "/owl", familyPrefix: "avtc-claude-" });
    expect(r.hits).toEqual([]);
  });

  test("a lower-precedence true does not re-enable a higher false; an unmentioned key defaults enabled (registry presence)", async () => {
    const io = makeIo({
      installed: { plugins: { "evil@market": [{ installPath: "/inst/evil" }] } },
      enabled: { project: { "evil@market": true }, local: { "evil@market": false } },
      files: { "/inst/evil/hooks/hooks.json": HOOKS },
      dirs: ["/inst/evil", "/inst/evil/hooks"],
    });
    const a = await runChannelA({ io, selfName: "session-owl", selfRoot: "/owl", familyPrefix: "avtc-claude-" });
    expect(a.hits).toEqual([]); // local(false) > project(true) ⇒ disabled
    const io2 = makeIo({
      installed: { plugins: { "evil@market": [{ installPath: "/inst/evil" }] } },
      files: { "/inst/evil/hooks/hooks.json": HOOKS, "/inst/evil/hooks/register.js": OVERRIDE },
      dirs: ["/inst/evil", "/inst/evil/hooks"],
    });
    const b = await runChannelA({ io: io2, selfName: "session-owl", selfRoot: "/owl", familyPrefix: "avtc-claude-" });
    expect(b.hits.length).toBe(1); // no source mentions it ⇒ installed state stands
  });

  test("no hooks declared => clean (the deep scan is skipped)", async () => {
    const io = makeIo({
      installed: { plugins: { "mcp@market": [{ installPath: "/inst/mcp" }] } },
      enabled: { user: { "mcp@market": true } },
      files: { "/inst/mcp/hooks/hooks.json": NO_HOOKS },
      dirs: ["/inst/mcp", "/inst/mcp/hooks"],
    });
    const r = await runChannelA({ io, selfName: "session-owl", selfRoot: "/owl", familyPrefix: "avtc-claude-" });
    expect(r.hits).toEqual([]);
  });

  test("self and the family namespace are exempt", async () => {
    const io = makeIo({
      installed: {
        plugins: {
          "session-owl@local": [{ installPath: "/owl" }],
          "avtc-claude-logger@local": [{ installPath: "/inst/logger" }],
        },
      },
      files: {
        "/owl/hooks/hooks.json": HOOKS,
        "/owl/hooks/register.js": OVERRIDE,
        "/inst/logger/hooks/hooks.json": HOOKS,
        "/inst/logger/hooks/register.js": OVERRIDE,
      },
      dirs: ["/owl", "/owl/hooks", "/inst/logger", "/inst/logger/hooks"],
    });
    const r = await runChannelA({ io, selfName: "session-owl", selfRoot: "/owl", familyPrefix: "avtc-claude-" });
    expect(r.hits).toEqual([]);
  });

  test("an unscannable candidate (hooks declared, dir unreadable) fails safe: hit", async () => {
    const io = makeIo({
      installed: { plugins: { "locked@market": [{ installPath: "/inst/locked" }] } },
      enabled: { user: { "locked@market": true } },
      files: { "/inst/locked/hooks/hooks.json": HOOKS },
      dirs: ["/inst/locked", "/inst/locked/hooks"],
      brokenDirs: ["/inst/locked/hooks"],
    });
    const r = await runChannelA({ io, selfName: "session-owl", selfRoot: "/owl", familyPrefix: "avtc-claude-" });
    expect(r.hits).toEqual([{ channel: "A", name: "locked@market", evidence: "unscannable" }]);
  });

  test("curated markers pause on name-suspicion without reading sources; a disabled curated match is advisory", async () => {
    expect(CONFLICT_MARKERS).toEqual([]); // ships empty — the extension procedure ports
    const io = makeIo({
      installed: { plugins: { "known-bad@market": [{ installPath: "/inst/known-bad" }] } },
      enabled: { user: {} },
      files: { "/inst/known-bad/hooks/hooks.json": NO_HOOKS },
      dirs: ["/inst/known-bad"],
    });
    const r = await runChannelA({
      io,
      selfName: "session-owl",
      selfRoot: "/owl",
      familyPrefix: "avtc-claude-",
      markers: ["known-bad"],
    });
    expect(r.hits).toEqual([{ channel: "A", name: "known-bad@market", evidence: "known-bad" }]);
    const io2 = makeIo({
      installed: { plugins: { "known-bad@market": [{ installPath: "/inst/known-bad" }] } },
      enabled: { user: { "known-bad@market": false } },
    });
    const r2 = await runChannelA({
      io: io2,
      selfName: "session-owl",
      selfRoot: "/owl",
      familyPrefix: "avtc-claude-",
      markers: ["known-bad"],
    });
    expect(r2.hits).toEqual([]);
    expect(r2.advisories).toEqual([{ name: "known-bad@market", evidence: "known-bad", reason: "disabled" }]);
  });

  test("malformed registry / missing settings degrade to empty, never throw", async () => {
    const io = makeIo({ installed: "not-an-object", enabled: {} });
    const r = await runChannelA({ io, selfName: "session-owl", selfRoot: "/owl", familyPrefix: "avtc-claude-" });
    expect(r.hits).toEqual([]);
  });

  test("duplicate installs dedup by key+path (one hit, not two)", async () => {
    const io = makeIo({
      installed: {
        plugins: {
          "evil@market": [{ installPath: "/inst/evil" }, { installPath: "/inst/evil" }],
        },
      },
      enabled: { user: { "evil@market": true } },
      files: { "/inst/evil/hooks/hooks.json": HOOKS, "/inst/evil/hooks/register.js": OVERRIDE },
      dirs: ["/inst/evil", "/inst/evil/hooks"],
    });
    const r = await runChannelA({ io, selfName: "session-owl", selfRoot: "/owl", familyPrefix: "avtc-claude-" });
    expect(r.hits.length).toBe(1);
  });
});
