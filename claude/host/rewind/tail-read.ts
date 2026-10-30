// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// The tail-read tier of the live chain verifier: the file's LAST N
// uuid-bearing rows with the compaction-boundary flag and the torn-tail
// signal — the facts the deferred processor walks to assign owl-chain
// parents (nearest preceding observable row) and detect rewinds. Two tiers
// serve the same facts: the capsule reads the whole file (≤4 MiB platform
// cap) and this module parses only its end; over-cap files run
// helpers/verify.mjs --tail (a streaming ring buffer; the process capsule
// works on every surface). A torn tail (a mid-write last line) tells the
// caller to back off and re-read later — a large append can be one huge
// row. Every failure degrades to null — a missing tier is never a wrong
// verdict; the caller decides what an absent read means.

import { errDetail } from "../log/err-detail.js";
import type { RunProcessFn } from "../retention/prune-caller.js";
import { isCapRefusal } from "./helper-pass.js";

/** The platform's whole-file read cap (bytes). */
const CAPSULE_CAP_BYTES = 4 * 1024 * 1024;

export interface TailRow {
  uuid: string;
  /** parentUuid, else the logical link (boundary rows carry null + logical) */
  parentUuid: string | null;
  /** true on system/compact_boundary rows — the chain's fresh roots */
  boundary: boolean;
}

export interface TailFacts {
  rows: TailRow[];
  /** the file's last line looked mid-write — back off and re-read */
  torn: boolean;
}

/** Parse the file's last N uuid-bearing rows out of a whole-file capsule
 *  read. Tolerant in the middle (non-JSON and uuid-less lines are skipped,
 *  like every transcript parser here); suspicious only at the very end: a
 *  last line without a trailing newline, or one that fails to parse, is
 *  torn and excluded from the rows. */
export function parseCapsuleTail(text: string, maxRows: number): TailFacts {
  if (text === "") return { rows: [], torn: false };
  const endsWithNewline = text.endsWith("\n");
  const lines = text.split("\n");
  // a trailing "" from the final newline is not a line
  if (endsWithNewline) lines.pop();
  let torn = !endsWithNewline;
  if (!endsWithNewline && lines.length > 0) {
    lines.pop(); // the unterminated fragment is excluded from the rows
  }
  // scan from the END: only the last maxRows uuid-bearing rows matter, so
  // the prefix is never parsed
  const rows: TailRow[] = [];
  for (let i = lines.length - 1; i >= 0 && rows.length < maxRows; i -= 1) {
    const line = lines[i]?.trim() ?? "";
    if (line === "") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      if (i === lines.length - 1) torn = true; // the final line is mid-write junk
      continue; // tolerated mid-file junk
    }
    if (parsed === null || typeof parsed !== "object") continue;
    const row = parsed as {
      uuid?: unknown;
      parentUuid?: unknown;
      logicalParentUuid?: unknown;
      type?: unknown;
      subtype?: unknown;
    };
    if (typeof row.uuid !== "string") continue; // metadata without a chain slot
    const parent =
      typeof row.parentUuid === "string"
        ? row.parentUuid
        : typeof row.logicalParentUuid === "string"
          ? row.logicalParentUuid
          : null;
    rows.push({
      uuid: row.uuid,
      parentUuid: parent,
      boundary: row.type === "system" && row.subtype === "compact_boundary",
    });
  }
  return { rows: rows.reverse(), torn };
}

/** Which tier serves this read: the capsule under the cap, the helper over
 *  it, and an absent file is the caller's signal (a vanished transcript is
 *  itself an amputation fact, not this module's verdict). */
export function planTailTier(size: number | null): { tier: "capsule" | "helper" | "absent"; reason: string } {
  if (size === null) return { tier: "absent", reason: "no-file" };
  if (size <= CAPSULE_CAP_BYTES) return { tier: "capsule", reason: "under-cap" };
  return { tier: "helper", reason: "over-cap" };
}

/** The helper tail-mode argv (the same module as the full verify pass,
 *  streamed as a ring buffer). */
export function planTailInvocation(input: {
  transcriptPath: string;
  pluginRoot: string;
  maxRows: number;
  nodeBin?: string;
}): string[] {
  const clean = input.pluginRoot.replace(/[\\/]+$/, "");
  return [
    input.nodeBin ?? "node",
    `${clean}/helpers/verify.mjs`,
    input.transcriptPath,
    "--tail",
    String(input.maxRows),
  ];
}

/** Parse the helper's stdout (ONE JSON line: {ok, torn, tail: [[uuid,
 *  parent|null, 0|1], ...]}) into the tail facts; anything malformed or
 *  ok:false degrades to null. */
export function parseTailHelperOutput(raw: string, log?: (message: string, err?: unknown) => void): TailFacts | null {
  const line = raw.trim().split("\n").pop() ?? "";
  if (line === "") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch (err) {
    log?.(`tail-helper output line was not JSON: ${errDetail(err)}`, err);
    return null;
  }
  if (parsed === null || typeof parsed !== "object") return null;
  const report = parsed as { ok?: unknown; torn?: unknown; tail?: unknown };
  if (report.ok !== true || !Array.isArray(report.tail)) return null;
  const rows: TailRow[] = [];
  for (const entry of report.tail) {
    if (!Array.isArray(entry) || typeof entry[0] !== "string") continue;
    rows.push({
      uuid: entry[0],
      parentUuid: typeof entry[1] === "string" ? entry[1] : null,
      boundary: entry[2] === 1,
    });
  }
  return { rows, torn: report.torn === true };
}

/** The seams readTail needs (all injected — the register wiring spells the
 *  engine calls literally; nothing here touches $). */
export interface TailReadDeps {
  /** whole-file read (the capsule) — may refuse over-cap */
  fsRead: (path: string) => Promise<string>;
  /** the process run seam (helpers) */
  runProcess: RunProcessFn;
  log: (message: string, err?: unknown) => void;
}

/** Read the tail through the tier the size dictates. NEVER throws: a
 *  refused capsule escalates to the helper only on the cap refusal (a
 *  raced-upward size); every other failure is a missing tier — logged,
 *  null. */
export async function readTail(
  deps: TailReadDeps,
  input: { size: number | null; transcriptPath: string; pluginRoot: string; maxRows: number; nodeBin?: string },
): Promise<TailFacts | null> {
  const tier = planTailTier(input.size);
  if (tier.tier === "absent") return null;
  if (tier.tier === "capsule") {
    try {
      return parseCapsuleTail(await deps.fsRead(input.transcriptPath), input.maxRows);
    } catch (err) {
      const message = String((err as { message?: unknown })?.message ?? err);
      if (!isCapRefusal(message)) {
        deps.log(`tail read (capsule) failed: ${message}`, err);
        return null;
      }
      // the size raced past the cap between stat and read — fall through
      // to the helper tier
    }
  }
  try {
    const { stdout, exitCode, isStdoutTruncated } = await deps.runProcess(planTailInvocation(input));
    if (isStdoutTruncated === true) {
      deps.log("tail helper stdout truncated", new Error("tail helper stdout truncated"));
      return null;
    }
    if (exitCode !== 0) {
      deps.log(`tail helper exited ${exitCode}`, new Error(`tail helper exited ${exitCode}`));
      return null;
    }
    return parseTailHelperOutput(stdout, deps.log);
  } catch (err) {
    deps.log(`tail read (helper) failed: ${errDetail(err)}`, err);
    return null;
  }
}
