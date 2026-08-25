// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// Stage dumps — one timestamped file per Observer/Builder/Selector/goal-extract
// LLM run, capturing what the model saw (system prompt, tools, per-call input)
// and produced (thinking, text, tool calls, results) in the tagged memory
// format. Gated by the `debugDumpLimit` setting (0 = disabled): `openStageDump`
// returns null and every `appendDump` becomes a no-op. Writes are synchronous
// (appendFileSync) so output is flushed immediately — nothing is lost if the
// process dies mid-run. The file materializes only on the first append, so a
// skipped run (e.g. the Builder fast-path) leaves nothing behind. Pruning is
// per stage prefix: each stage keeps at most `limit` newest files.

import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";

/** "Dumps disabled" sentinel — the null dump path (every append no-ops). */
export const NO_DUMP: string | null = null;
/** "Use the default dump base" (<cwd>/.pi/memkeeper) — the null dumpDir. */
export const DEFAULT_DUMP_BASE: string | null = null;

const DEBUG_DIR_NAME = "debug";
const TXT_EXT = ".txt";
/** Monotonic counter for same-millisecond dump ordering (deterministic prune
 *  order: filename sort = creation order within a process). */
let dumpCounter = 0;

/** The default dump base: <cwd>/.pi/memkeeper (the dump dir itself is
 *  `<base>/debug/`, mirroring an injected test dir). */
function defaultDumpBase(): string {
  return path.join(process.cwd(), ".pi", "memkeeper");
}

/**
 * Create a new timestamped dump path `<stage>-<isoTs>-<counter>-<nonce>.txt`
 * under `<dumpDir | default>`, prune older files with the same stage prefix to
 * keep at most `limit`, and return the new path. The file itself is not created
 * here — the first `appendDump` creates it. Returns null when `limit <= 0`
 * (dumps disabled): no dir is created, nothing is pruned.
 *
 * `dumpDir: string | null` — the base dir; null uses the default
 *  `<cwd>/.pi/memkeeper`, and the dumps live in its `debug/` subdir. Tests
 *  inject a temp base so they never touch the repo's .pi/.
 */
export function openStageDump(stage: string, limit: number, dumpDir: string | null): string | null {
  if (limit <= 0) return null; // dumps disabled (debugDumpLimit = 0)
  const dir = path.join(dumpDir ?? defaultDumpBase(), DEBUG_DIR_NAME);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  // Filename = <stage>-<isoTs>-<paddedCounter>-<nonce>.txt: the padded counter
  // breaks same-ms ties deterministically (pruning sorts by filename, not
  // mtime); the nonce guards cross-process/restart collisions.
  const seq = dumpCounter++;
  const nonce = Math.random().toString(16).slice(2, 8);
  const dumpPath = path.join(dir, `${stage}-${timestamp}-${seq.toString().padStart(6, "0")}-${nonce}${TXT_EXT}`);
  const existing = fs
    .readdirSync(dir)
    .filter((f) => f.startsWith(`${stage}-`) && f.endsWith(TXT_EXT))
    .sort()
    .map((f) => path.join(dir, f));
  while (existing.length >= limit) {
    const oldest = existing.shift();
    if (!oldest) break;
    try {
      fs.unlinkSync(oldest);
    } catch {
      /* best-effort */
    }
  }
  return dumpPath;
}

/** Append content to a dump file (synchronously flushed). Never throws.
 *  No-op on a null path (dumps disabled) — call sites pass the `openStageDump`
 *  result through unconditionally. */
export function appendDump(dumpPath: string | null, content: string): void {
  if (!dumpPath) return; // disabled — no-op
  try {
    fs.appendFileSync(dumpPath, content);
  } catch {
    // best-effort — dumping must not break the stage run
  }
}

/** The closing tag appended at run end. */
export const DUMP_FOOTER = "</dump>\n";

/** Format the dump header: the `<dump>` open tag with stage + started attrs,
 *  the `<system-prompt>` block, and the `<tools>` block (one `<tool name=…>`
 *  per tool: description + parameters JSON; the description tag is omitted for
 *  a tool without one). Pure — no I/O, testable. */
export function stageDumpHeader(
  stage: string,
  startedIso: string,
  systemPrompt: string,
  tools: readonly AgentTool[],
): string {
  const toolBlocks = tools.map((tool) => {
    const description =
      typeof tool.description === "string" && tool.description.length > 0
        ? `<description>\n${tool.description}\n</description>\n`
        : "";
    return `<tool name="${tool.name}">\n${description}<parameters>\n${JSON.stringify(tool.parameters)}\n</parameters>\n</tool>\n`;
  });
  return (
    `<dump stage="${stage}" started="${startedIso}">\n` +
    `<system-prompt>\n${systemPrompt}\n</system-prompt>\n` +
    `<tools>\n${toolBlocks.join("")}</tools>\n`
  );
}
