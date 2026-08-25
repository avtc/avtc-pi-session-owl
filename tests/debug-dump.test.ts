// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// Stage dumps: one timestamped file per Observer/Builder/Selector/goal-extract
// LLM run under <cwd>/.pi/memkeeper/debug/ (or an injected dir for tests),
// pruned per stage prefix to the debugDumpLimit setting. The file appears only
// on the first append (a skipped run leaves nothing). Synchronous appends —
// flushed to disk immediately, nothing lost if the process dies mid-run.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { appendDump, DUMP_FOOTER, dumpToolBlock, NO_DUMP, openStageDump, stageDumpHeader } from "../src/debug-dump.js";

/** Fresh temp dir per test — no litter in the repo. */
function tempDumpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "mk-dump-test-"));
}

function dumpFiles(dir: string, stage: string): string[] {
  return fs
    .readdirSync(dir)
    .filter((f) => f.startsWith(`${stage}-`) && f.endsWith(".txt"))
    .sort();
}

describe("openStageDump", () => {
  it("limit 0 → null (dumps disabled; no dir created)", () => {
    const dir = tempDumpDir();
    expect(openStageDump("builder", 0, dir)).toBeNull();
    // no debug/ subdir materialized
    expect(fs.existsSync(path.join(dir, "debug"))).toBe(false);
  });

  it("opens a dump path but creates NOTHING (no dir, no file, no prune) until the first append", () => {
    const dir = tempDumpDir();
    const dump = openStageDump("builder", 5, dir);
    expect(dump).not.toBeNull();
    expect(dump).toContain(path.join("debug", "builder-"));
    expect(fs.existsSync(path.join(dir, "debug"))).toBe(false); // no dir yet
    appendDump(dump, "hello");
    expect(fs.readFileSync(dump as string, "utf8")).toBe("hello");
  });

  it("a run that opens but never appends does not prune existing dumps", () => {
    const dir = tempDumpDir();
    const first = openStageDump("builder", 1, dir) as string;
    appendDump(first, "keep me");
    openStageDump("builder", 1, dir); // opened (would prune at open) but never appended
    expect(fs.existsSync(first)).toBe(true); // prune deferred to a real write
  });

  it("prunes older same-stage dumps to the limit (newest kept)", () => {
    const dir = tempDumpDir();
    const paths = [1, 2, 3, 4].map((n) => {
      const p = openStageDump("builder", 2, dir) as string;
      appendDump(p, `dump ${n}`);
      return p;
    });
    const kept = dumpFiles(path.join(dir, "debug"), "builder");
    expect(kept.length).toBe(2);
    expect(fs.existsSync(paths[0] as string)).toBe(false); // oldest pruned
    expect(fs.existsSync(paths[1] as string)).toBe(false);
    expect(fs.existsSync(paths[2] as string)).toBe(true);
    expect(fs.existsSync(paths[3] as string)).toBe(true);
  });

  it("prunes per stage prefix (selector dumps never touch builder dumps)", () => {
    const dir = tempDumpDir();
    appendDump(openStageDump("builder", 1, dir) as string, "b1");
    appendDump(openStageDump("selector", 1, dir) as string, "s1");
    appendDump(openStageDump("builder", 1, dir) as string, "b2"); // prunes b1
    appendDump(openStageDump("selector", 1, dir) as string, "s2"); // prunes s1
    const debugDir = path.join(dir, "debug");
    expect(dumpFiles(debugDir, "builder").length).toBe(1);
    expect(dumpFiles(debugDir, "selector").length).toBe(1);
  });
});

describe("appendDump", () => {
  it("null path → no-op (dumps disabled)", () => {
    expect(() => appendDump(NO_DUMP, "x")).not.toThrow();
  });

  it("a failing write never throws (best-effort)", () => {
    expect(() => appendDump(path.join(tempDumpDir(), "missing-root", "x.txt"), "x")).not.toThrow();
  });
});

describe("stageDumpHeader / footer", () => {
  it("formats the dump header: stage attr, system prompt, tools with description + parameters", () => {
    const tools = [
      {
        name: "mkdir",
        label: "mkdir",
        description: "Make a folder.",
        parameters: { type: "object", properties: { summary: { type: "string" } } },
      },
    ] as unknown as Parameters<typeof stageDumpHeader>[3];
    const header = stageDumpHeader("builder", "2026-08-25T01-02-03-000-abc", "You keep the graph.", tools);
    expect(header.startsWith('<dump stage="builder" started="2026-08-25T01-02-03-000-abc">\n')).toBe(true);
    expect(header).toContain("<system-prompt>\nYou keep the graph.\n</system-prompt>\n");
    expect(header).toContain('<tool name="mkdir">\n<description>\nMake a folder.\n</description>\n');
    expect(header).toContain(
      '<parameters>\n{"type":"object","properties":{"summary":{"type":"string"}}}\n</parameters>\n',
    );
    expect(header.endsWith("</tools>\n")).toBe(true);
  });

  it("omits the description tag for a tool without one", () => {
    const tools = [{ name: "x", label: "x", parameters: { type: "object" } }] as unknown as Parameters<
      typeof stageDumpHeader
    >[3];
    const header = stageDumpHeader("builder", "ts", "p", tools);
    expect(header).not.toContain("<description>");
    expect(header).toContain('<tool name="x">\n<parameters>');
  });

  it("omits the whole <tools> section when there are no tools (goal-extract one-shot, observer per-chunk tools)", () => {
    const header = stageDumpHeader("goal-extract", "ts", "p", []);
    expect(header).not.toContain("<tools>");
    expect(header.endsWith("</system-prompt>\n")).toBe(true);
  });

  it("dumpToolBlock formats one tool (description + parameters JSON)", () => {
    const tool = { name: "ls", description: "List.", parameters: { type: "object" } } as unknown as Parameters<
      typeof dumpToolBlock
    >[0];
    const block = dumpToolBlock(tool);
    expect(block).toContain('<tool name="ls">\n<description>\nList.\n</description>\n');
    expect(block).toContain('<parameters>\n{"type":"object"}\n</parameters>\n');
  });

  it("footer closes the dump tag", () => {
    expect(DUMP_FOOTER).toBe("</dump>\n");
  });
});
