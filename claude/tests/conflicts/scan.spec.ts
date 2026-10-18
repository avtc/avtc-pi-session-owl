// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// The bounded source scan + the adapted override regex (Channel A/B):
// pi's scan constants and walk discipline port verbatim;
// the registration marker adapts from pi's session_before_compact to
// Claude's session.compact, and the override shape from cancel/summary to
// the answers the platform's compaction hook can give (messages/skip).
import { describe, expect, test } from "vitest";
import { type ScanIo, scansCompactOverride } from "../../host/conflicts/scan.js";

/** In-memory io over a flat file map (path -> content) + dir set. */
function makeIo(files: Record<string, string>, dirs: string[] = []): ScanIo {
  const norm = (p: string): string => p.replace(/\\/g, "/").replace(/\/+$/, "");
  return {
    list: async (dir) => {
      const d = norm(dir);
      const names = new Set<string>();
      for (const f of Object.keys(files)) {
        if (f.startsWith(`${d}/`)) names.add(f.slice(d.length + 1).split("/")[0]);
      }
      for (const sub of dirs) {
        if (sub.startsWith(`${d}/`)) names.add(sub.slice(d.length + 1).split("/")[0]);
      }
      return [...names].map((name) => ({
        name,
        kind: (files[`${d}/${name}`] !== undefined ? "file" : "directory") as "file" | "directory",
      }));
    },
    read: async (p) => files[norm(p)] ?? "",
    stat: async (p) => ({ size: (files[norm(p)] ?? "").length }),
  };
}

const ON = 'on("session.compact",';
const ANSWER_MESSAGES = `${ON} async ($, e, next) => { if (x) return { messages: [m] }; return next(e); }`;
const ANSWER_SKIP = `${ON} async ($, e, next) => { return { skip: "why" }; }`;
const PASSIVE = `${ON} async ($, e, next) => { log(e); return next(e); }`;

describe("conflicts scan — the adapted override regex", () => {
  test("an answering registration hits (messages shape)", async () => {
    const io = makeIo({ "/pkg/hooks/register.js": ANSWER_MESSAGES });
    expect(await scansCompactOverride("/pkg", io)).toBe(true);
  });

  test("an answering registration hits (skip shape)", async () => {
    const io = makeIo({ "/pkg/hooks/register.js": ANSWER_SKIP });
    expect(await scansCompactOverride("/pkg", io)).toBe(true);
  });

  test("a passive registrant does not hit (registration alone is not a conflict)", async () => {
    const io = makeIo({ "/pkg/hooks/register.js": PASSIVE });
    expect(await scansCompactOverride("/pkg", io)).toBe(false);
  });

  test("an override beyond the 1200-char window does not hit", async () => {
    const pad = "x".repeat(1400);
    const io = makeIo({ "/pkg/r.js": `${ON} async ($, e, next) => { ${pad} return { messages: [] }; }` });
    expect(await scansCompactOverride("/pkg", io)).toBe(false);
  });

  test("single quotes and the arrow-object form both match", async () => {
    const arrow = `on('session.compact', ($, e) => ({ messages: [e] }))`;
    expect(await scansCompactOverride("/p", makeIo({ "/p/a.js": arrow }))).toBe(true);
  });
});

describe("conflicts scan — the bounded walk (pi's constants verbatim)", () => {
  test("depth 2 reaches nested sources; depth 3 does not", async () => {
    const deep = { "/pkg/a/b/c/hit.js": ANSWER_MESSAGES };
    expect(await scansCompactOverride("/pkg", makeIo(deep, ["/pkg/a", "/pkg/a/b", "/pkg/a/b/c"]))).toBe(false);
    const nested = { "/pkg/a/hit.js": ANSWER_MESSAGES, "/pkg/a/b/hit2.js": ANSWER_MESSAGES };
    expect(await scansCompactOverride("/pkg", makeIo(nested, ["/pkg/a", "/pkg/a/b"]))).toBe(true);
  });

  test("node_modules, dotfiles and .d.ts are skipped", async () => {
    const io = makeIo(
      {
        "/pkg/node_modules/x.js": ANSWER_MESSAGES,
        "/pkg/.hidden.js": ANSWER_MESSAGES,
        "/pkg/hooks.d.ts": ANSWER_MESSAGES,
      },
      ["/pkg/node_modules", "/pkg/.git"],
    );
    expect(await scansCompactOverride("/pkg", io)).toBe(false);
  });

  test("the file budget caps at 40 scannable files (the 41st hit is unseen)", async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 40; i++) files[`/pkg/f${i}.js`] = "void 0";
    expect(await scansCompactOverride("/pkg", makeIo(files))).toBe(false);
    files["/pkg/f40.js"] = ANSWER_MESSAGES; // 41st — beyond the budget
    expect(await scansCompactOverride("/pkg", makeIo(files))).toBe(false);
    files["/pkg/f0.js"] = ANSWER_MESSAGES; // within the budget
    expect(await scansCompactOverride("/pkg", makeIo(files))).toBe(true);
  });

  test("a file over 4 MiB is skipped; unreadable entries never throw", async () => {
    const big = { "/pkg/big.js": "x".repeat(4 * 1024 * 1024 + 1) };
    expect(await scansCompactOverride("/pkg", makeIo(big))).toBe(false);
    const broken: ScanIo = {
      list: async () => {
        throw new Error("boom");
      },
      read: async () => {
        throw new Error("boom");
      },
      stat: async () => {
        throw new Error("boom");
      },
    };
    expect(await scansCompactOverride("/pkg", broken)).toBe(false);
  });
});
