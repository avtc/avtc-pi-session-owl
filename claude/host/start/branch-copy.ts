// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import { errDetail } from "../log/err-detail.js";
/**
 * Branch/fork lineage copy: the engine copies a
 * branched or forked conversation's TRANSCRIPT under a NEW session id — the
 * first row's `forkedFrom.sessionId` names the origin — but it never copies
 * owl's derived state. Rebuilding from the transcript alone loses every
 * observation the origin had derived and re-derives a different graph over
 * time. This copies the origin's session directory verbatim for the new id
 * BEFORE any storage assembly reads the target, so mirror, ledgers,
 * timeline, checkpoints and watermarks all survive the branch and a later
 * engine rewind to a pre-branch point stays closed over the same rows.
 *
 * Invariants:
 * - `.session.json` travels nowhere: the caller's marker write records the
 *   NEW session's envelope facts.
 * - Inert by construction: a populated target, a transcript without
 *   forkedFrom, a missing origin — all skip and leave today's rebuild path
 *   as the degrade. The helper NEVER throws: a hook-top throw would kill the
 *   whole start pulse.
 * - Known residual (no delete primitive on this platform): a write that
 *   fails mid-copy leaves a partial target that later starts treat as
 *   populated. The failure log names the directory to remove; each copy is
 *   name-identical to its origin, so a re-run after removal is byte-faithful.
 */

/** The injected file surface (engine `$.fs`, record-shaped like the specs' mem fs). */
export interface LineageIo {
  read(path: string): Promise<string>;
  list(dir: string): Promise<{ name: string; kind: string }[]>;
  write(path: string, text: string): Promise<unknown>;
}

export type LineageCopyStatus =
  | "copied"
  | "no-source"
  | "no-forked-from"
  | "target-populated"
  | "origin-missing"
  | "failed";

export interface LineageCopyResult {
  status: LineageCopyStatus;
  originSessionId: string | null;
  files: string[];
}

/** Copy the origin's owl state for a new branch/fork session id. */
export async function copyBranchLineageStore(args: {
  sessionId: string;
  transcriptPath: string;
  targetDir: string;
  originDirPathFor: (sessionId: string) => string;
  io: LineageIo;
  log(line: string): void;
}): Promise<LineageCopyResult> {
  const skip = (status: LineageCopyStatus, note: string): LineageCopyResult => {
    args.log(`branch store copy: skipped (${status}) — ${note}`);
    return { status, originSessionId: null, files: [] };
  };
  try {
    if (typeof args.transcriptPath !== "string" || args.transcriptPath === "") {
      return skip("no-source", "the start envelope carries no transcript path");
    }
    let transcript: string;
    try {
      transcript = await args.io.read(args.transcriptPath);
    } catch (cause) {
      return skip("no-source", `transcript unreadable (${String(cause)})`);
    }
    const firstLine = transcript.split("\n").find((l) => l.trim() !== "");
    let forked: string | null = null;
    if (firstLine !== undefined) {
      try {
        const row: unknown = JSON.parse(firstLine);
        const candidate = (row as { forkedFrom?: { sessionId?: unknown } } | null)?.forkedFrom?.sessionId;
        forked = typeof candidate === "string" && candidate !== "" ? candidate : null;
      } catch (err) {
        args.log(`branch store copy: session row unreadable (forked-from unknown): ${errDetail(err)}`);
        forked = null;
      }
    }
    if (forked === null) {
      return skip("no-forked-from", "the transcript's first row names no origin session");
    }
    if (forked === args.sessionId) {
      return skip("no-forked-from", "origin equals the target");
    }
    const originDir = args.originDirPathFor(forked);
    let originEntries: { name: string; kind: string }[];
    try {
      originEntries = await args.io.list(originDir);
    } catch {
      return skip("origin-missing", `no origin dir: ${originDir}`);
    }
    const originFiles = originEntries.filter((e) => e.kind === "file").map((e) => e.name);
    if (originFiles.length === 0) {
      return skip("origin-missing", `origin dir is empty: ${originDir}`);
    }
    // The target must be fresh: anything besides the callee's marker means
    // this session already produced state, which a copy must never clobber.
    let foreign = 0;
    try {
      const targetEntries = await args.io.list(args.targetDir);
      foreign = targetEntries.filter((e) => e.kind === "file" && e.name !== ".session.json").length;
    } catch (err) {
      // an absent target dir is the fresh case — everything else is said
      args.log(`branch store copy: target dir listing failed (counted as fresh): ${errDetail(err)}`);
      foreign = 0;
    }
    if (foreign > 0) {
      return skip("target-populated", `${foreign} file(s) already present`);
    }
    const files: string[] = [];
    for (const name of originFiles) {
      if (name === ".session.json") continue;
      let data: string;
      try {
        data = await args.io.read(`${originDir}/${name}`);
      } catch (cause) {
        args.log(
          `branch store copy: FAILED reading origin=${forked} file=${name} (${String(cause)}) — remove ${args.targetDir} to retry the copy`,
        );
        return { status: "failed", originSessionId: forked, files };
      }
      try {
        await args.io.write(`${args.targetDir}/${name}`, data);
      } catch (cause) {
        args.log(
          `branch store copy: FAILED writing target=${args.targetDir} file=${name} (${String(cause)}) — remove the target dir to retry the copy`,
        );
        return { status: "failed", originSessionId: forked, files };
      }
      files.push(name);
    }
    args.log(`branch store copy: origin=${forked} files=${files.length}`);
    return { status: "copied", originSessionId: forked, files };
  } catch (cause) {
    // the hook survives whatever this threw
    args.log(`branch store copy: skipped (failed) — ${String(cause)}`);
    return { status: "failed", originSessionId: null, files: [] };
  }
}
