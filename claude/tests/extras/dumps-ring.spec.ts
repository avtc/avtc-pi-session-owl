// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

//  debug dumps — the ring-slot port: same module/constants/
// content as pi with three mechanical adaptations (RMW append, ring-slot
// prune by oldest-slot claiming, location <dataDir>/dumps/<sanitized-cwd>/).
// These tests pin the ring semantics; the pure builders' format parity with
// pi's debug-dump.ts is pinned below (header/tools/sanitize are pi-verbatim).
import { describe, expect, test } from "vitest";
import {
  appendDump,
  appendHeaderDurable,
  appendRunParts,
  type DumpFs,
  dumpToolBlock,
  flushRunDump,
  openStageDump,
  type StageDumpHandle,
  sanitizeForPath,
  stageDumpHeader,
} from "../../host/dumps/module.js";

/** Memory DumpFs with controllable mtimes (the claim tiebreak reads them). */
function memoryFs(seed: Record<string, { text: string; mtime?: number }> = {}) {
  const files = new Map<string, { text: string; mtime: number }>(
    Object.entries(seed).map(([p, v]) => [p, { text: v.text, mtime: v.mtime ?? 0 }]),
  );
  const writes: string[] = [];
  const fs: DumpFs = {
    readText: async (p) => {
      const f = files.get(p);
      if (f === undefined) throw new Error(`ENOENT: ${p}`);
      return f.text;
    },
    writeText: async (p, t) => {
      files.set(p, { text: t, mtime: files.get(p)?.mtime ?? 1 });
      writes.push(p);
    },
    listDir: async (d) => {
      const names = new Set<string>();
      for (const key of files.keys()) {
        if (!key.startsWith(`${d}/`)) continue;
        names.add(key.slice(d.length + 1));
      }
      return [...names].sort();
    },
    statMtime: async (p) => files.get(p)?.mtime ?? null,
  };
  return { fs, files, writes };
}

const BASE = "/data"; // the owl data dir (the seam — injected)
const CWD = "E:\\work\\git\\proj ect";
const DIR = `${BASE}/dumps/E-work-git-project`;

describe("sanitizeForPath — pi-verbatim", () => {
  test("separators become hyphens, unsafe chars drop, repeats collapse", () => {
    // the SPACE is not filename-safe — dropped, not hyphenated (pi-verbatim)
    expect(sanitizeForPath("E:\\work\\git/proj ect")).toBe("E-work-git-project");
    expect(sanitizeForPath("a..b")).toBe("ab");
    expect(sanitizeForPath("--x--")).toBe("x");
    expect(sanitizeForPath("a.b_c-d")).toBe("a.b_c-d");
  });
});

describe("openStageDump — the disable gate + deferred materialization", () => {
  test("limit 0 returns null (dumps disabled — the default)", () => {
    expect(openStageDump("observer", 0, { baseDir: BASE, cwd: CWD, now: 0 })).toBeNull();
  });

  test("opening touches NO filesystem — the dir materializes on first append only", async () => {
    const mem = memoryFs();
    const h = openStageDump("observer", 3, { baseDir: BASE, cwd: CWD, now: 1_000 });
    expect(h).not.toBeNull();
    expect(mem.files.size).toBe(0);
    expect(await mem.fs.listDir(DIR)).toEqual([]);
  });

  test("the handle names the ring slot path <dir>/<stage>-<slot>.txt", () => {
    const h = openStageDump("builder", 2, { baseDir: BASE, cwd: CWD, now: 0 });
    expect(h?.path.startsWith(`${DIR}/builder-`)).toBe(true);
    expect(h?.path.endsWith(".txt")).toBe(true);
  });
});

describe("appendDump — RMW append, claiming, never throws", () => {
  test("first append claims the lowest FREE slot (0) and writes the content", async () => {
    const mem = memoryFs();
    const h = openStageDump("observer", 3, { baseDir: BASE, cwd: CWD, now: 0 }) as StageDumpHandle;
    await appendDump(mem.fs, h, "hello");
    expect(mem.files.get(`${DIR}/observer-0.txt`)?.text).toBe("hello");
  });

  test("a second append RMWs the SAME slot — content concatenates", async () => {
    const mem = memoryFs();
    const h = openStageDump("observer", 3, { baseDir: BASE, cwd: CWD, now: 0 }) as StageDumpHandle;
    await appendDump(mem.fs, h, "a");
    await appendDump(mem.fs, h, "b");
    expect(mem.files.get(`${DIR}/observer-0.txt`)?.text).toBe("ab");
  });

  test("a null handle no-ops (disabled)", async () => {
    const mem = memoryFs();
    await appendDump(mem.fs, null, "x");
    expect(mem.files.size).toBe(0);
  });

  test("claiming picks the OLDEST slot by the header started attr", async () => {
    // two prior dumps: slot 1 older than slot 0 — the claim reuses slot 1
    const mem = memoryFs({
      [`${DIR}/observer-0.txt`]: { text: '<dump stage="observer" started="2026-01-03T00:00:00.000Z">\n' },
      [`${DIR}/observer-1.txt`]: { text: '<dump stage="observer" started="2026-01-01T00:00:00.000Z">\n' },
    });
    const h = openStageDump("observer", 2, { baseDir: BASE, cwd: CWD, now: 0 }) as StageDumpHandle;
    await appendDump(mem.fs, h, "new");
    expect(mem.files.get(`${DIR}/observer-1.txt`)?.text).toBe("new");
    expect(mem.files.get(`${DIR}/observer-0.txt`)?.text).toContain("2026-01-03");
  });

  test("EQUAL started attrs tiebreak on stat mtimeMs (lower wins)", async () => {
    const mem = memoryFs({
      [`${DIR}/builder-0.txt`]: { text: '<dump stage="builder" started="2026-01-01T00:00:00.000Z">\n', mtime: 900 },
      [`${DIR}/builder-1.txt`]: { text: '<dump stage="builder" started="2026-01-01T00:00:00.000Z">\n', mtime: 200 },
    });
    const h = openStageDump("builder", 2, { baseDir: BASE, cwd: CWD, now: 0 }) as StageDumpHandle;
    await appendDump(mem.fs, h, "new");
    expect(mem.files.get(`${DIR}/builder-1.txt`)?.text).toBe("new");
  });

  test("a missing header falls back to stat mtimeMs (lower wins)", async () => {
    const mem = memoryFs({
      [`${DIR}/builder-0.txt`]: { text: "no header", mtime: 500 },
      [`${DIR}/builder-1.txt`]: { text: "no header", mtime: 100 },
    });
    const h = openStageDump("builder", 2, { baseDir: BASE, cwd: CWD, now: 0 }) as StageDumpHandle;
    await appendDump(mem.fs, h, "new");
    expect(mem.files.get(`${DIR}/builder-1.txt`)?.text).toBe("new");
  });

  test("a full ring with unreadable slots never throws (best-effort)", async () => {
    const mem = memoryFs({ [`${DIR}/s-0.txt`]: { text: "x" } });
    mem.fs.readText = async () => {
      throw new Error("locked");
    };
    const h = openStageDump("s", 1, { baseDir: BASE, cwd: CWD, now: 0 }) as StageDumpHandle;
    await expect(appendDump(mem.fs, h, "y")).resolves.toBeUndefined();
  });

  test("a write failure is swallowed (dumping must not break the run)", async () => {
    const mem = memoryFs();
    mem.fs.writeText = async () => {
      throw new Error("disk full");
    };
    const h = openStageDump("s", 2, { baseDir: BASE, cwd: CWD, now: 0 }) as StageDumpHandle;
    await expect(appendDump(mem.fs, h, "y")).resolves.toBeUndefined();
  });

  test("appendHeaderDurable places the header even when the FIRST write attempt fails", async () => {
    const mem = memoryFs();
    const realWrite = mem.fs.writeText;
    let calls = 0;
    mem.fs.writeText = async (p, t) => {
      calls += 1;
      if (calls === 1) throw new Error("flaky first write"); // the observed loss: the claim survives, the content does not
      await realWrite(p, t);
    };
    const h = openStageDump("s", 5, { baseDir: BASE, cwd: CWD, now: 0 }) as StageDumpHandle;
    const header = '<dump stage="s" started="1970-01-01T00:00:00.000Z">\n<system-prompt>SP\n</system-prompt>\n';
    await expect(appendHeaderDurable(mem.fs, h, header)).resolves.toBe(true);
    expect((await mem.fs.readText(h.path)).startsWith(`<dump stage="s"`)).toBe(true);
  });

  test("appendHeaderDurable reports false when every attempt fails (no throw)", async () => {
    const mem = memoryFs();
    mem.fs.writeText = async () => {
      throw new Error("disk full");
    };
    const h = openStageDump("s", 5, { baseDir: BASE, cwd: CWD, now: 0 }) as StageDumpHandle;
    await expect(appendHeaderDurable(mem.fs, h, '<dump stage="s">\n')).resolves.toBe(false);
  });
});

describe("dumpToolBlock / flushRunDump — the pi content format", () => {
  test("the header stamps the debugging session/agent it belongs to", async () => {
    const mem = memoryFs();
    const h = openStageDump("s", 5, {
      baseDir: BASE,
      cwd: CWD,
      now: 0,
      session: "sess-42",
      agent: "agent-7",
    }) as StageDumpHandle;
    await appendDump(mem.fs, h, stageDumpHeader("s", h.startedIso, "SP", [], { session: h.session, agent: h.agent }));
    const text = await mem.fs.readText(h.path);
    expect(text.startsWith('<dump stage="s" started=')).toBe(true);
    expect(text).toContain('session="sess-42"');
    expect(text).toContain('agent="agent-7"');
  });

  test("dumpToolBlock renders name + description + parameters (pi-verbatim)", () => {
    const block = dumpToolBlock({
      name: "ls",
      description: "list",
      parameters: { type: "object", properties: { a: { type: "string" } } },
    });
    expect(block).toBe(
      '<tool name="ls">\n<description>\nlist\n</description>\n<parameters>\n' +
        JSON.stringify({ type: "object", properties: { a: { type: "string" } } }) +
        "\n</parameters>\n</tool>\n",
    );
    const bare = dumpToolBlock({ name: "t", parameters: {} });
    expect(bare).not.toContain("<description>");
  });

  test("flushRunDump drains inputs + sections + rendered rows + handback + marker + footer", async () => {
    const mem = memoryFs();
    const h = openStageDump("selector", 2, { baseDir: BASE, cwd: CWD, now: 0 }) as StageDumpHandle;
    await flushRunDump(mem.fs, h, {
      inputs: ["the prompt", "pass two's prompt"],
      sections: ['<pass n="1">\n', "</pass>\n"],
      outputRows: [
        "row-a",
        { role: "assistant", content: "the reply text" },
        {
          role: "user",
          content: [
            { type: "text", text: "block one" },
            { type: "text", text: "block two" },
          ],
        },
        { tool: "t", result: { ok: true } },
      ],
      handback: { tool: "SubagentHandback", result: { ok: true } },
      fabricatedStop: "timeout",
    });
    const text = mem.files.get(`${DIR}/selector-0.txt`)?.text ?? "";
    expect(text).toContain("<input>\nthe prompt\n</input>\n");
    expect(text).toContain("<input>\npass two's prompt\n</input>\n"); // EVERY input in order
    expect(text).toContain('<pass n="1">\n');
    expect(text).toContain("</pass>\n");
    // rows: strings pass through, role/content rows render, others JSON
    expect(text).toContain("<output>\nrow-a\n");
    expect(text).toContain("[assistant] the reply text");
    expect(text).toContain("[user] block one\nblock two");
    expect(text).toContain('{"tool":"t","result":{"ok":true}}');
    expect(text).toContain("</output>\n");
    expect(text).toContain("<handback");
    expect(text).toContain("SubagentHandback");
    expect(text).toContain("<fabricated-stop>timeout</fabricated-stop>\n");
    expect(text.endsWith("</dump>\n")).toBe(true);
  });

  test("a circular row degrades to String() — the never-throws contract", async () => {
    const mem = memoryFs();
    const h = openStageDump("s", 1, { baseDir: BASE, cwd: CWD, now: 0 }) as StageDumpHandle;
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    await expect(
      appendRunParts(mem.fs, h, {
        inputs: [],
        sections: [],
        outputRows: [circular],
        handback: null,
        fabricatedStop: null,
      }),
    ).resolves.toBeUndefined();
    expect(mem.files.get(`${DIR}/s-0.txt`)?.text).toContain("[object Object]");
  });

  test("appendRunParts drains WITHOUT the footer (the incremental per-pass path)", async () => {
    const mem = memoryFs();
    const h = openStageDump("builder", 3, { baseDir: BASE, cwd: CWD, now: 0 }) as StageDumpHandle;
    await appendRunParts(mem.fs, h, {
      inputs: [],
      sections: ['<pass n="1">\n'],
      outputRows: ["r1"],
      handback: null,
      fabricatedStop: null,
    });
    await appendRunParts(mem.fs, h, {
      inputs: [],
      sections: ["</pass>\n"],
      outputRows: ["r2"],
      handback: null,
      fabricatedStop: null,
    });
    const mid = mem.files.get(`${DIR}/builder-0.txt`)?.text ?? "";
    // containment: the closer lands AFTER its drain's rows (the wrappers
    // wrap); each drain carries its own <output> block (pi appends per call)
    expect(mid).toContain('<pass n="1">\n<output>\nr1\n</output>\n');
    expect(mid).toContain("<output>\nr2\n</output>\n</pass>\n");
    expect(mid).not.toContain("</dump>"); // the footer only at run end
  });

  test("flushRunDump on a null handle no-ops", async () => {
    const mem = memoryFs();
    await flushRunDump(mem.fs, null, {
      inputs: [],
      sections: [],
      outputRows: [],
      handback: null,
      fabricatedStop: null,
    });
    expect(mem.files.size).toBe(0);
  });
});
