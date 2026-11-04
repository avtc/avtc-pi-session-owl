// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// The resume-time mirror compaction: the sweep's duplicate census decides,
// the helper (helpers/mirror-compact.mjs) rewrites the batches to one line
// per uuid through the process seam (real unlink needs a real Node process
// — the platform fs surface has no delete). The threshold keeps the pass
// off healthy stores: one rewrite collapses the duplicate mass, the census
// reads ~0 forever after, and the pass never fires again.

/** The duplicate mass worth a rewrite: at least this many duplicate lines
 *  AND at least this share of the total. */
const COMPACT_MIN_DUP_LINES = 1000;
const COMPACT_MIN_DUP_RATIO = 0.3;

/** The widest parent gap a live-captured compaction custom can legitimately
 *  show: the append envelope carries no parentUuid, so the capture infers
 *  the custom's parent at the write tip (a handful of rows back at most,
 *  interleaved side content included). */
const STITCH_MAX_PARENT_GAP = 32;

/** Whether a compaction custom's parent is an artifact worth restitching
 *  from the transcript: the capture infers a custom's parent at the write
 *  tip or leaves it null (the engine's boundary row never arrives through
 *  the append envelope) — a custom parented hundreds of rows back is a
 *  rewrite-era residue, and the branch walker skips the whole span between
 *  the custom and its parent (the summarized segment leaves the served
 *  branch). Pure. */
export function shouldStitchMirrorParents(
  rows: readonly { uuid: string; parentUuid: string | null; row: unknown }[],
): boolean {
  const pos = new Map<string, number>();
  for (let i = 0; i < rows.length; i += 1) {
    const r = rows[i];
    if (r !== undefined && !pos.has(r.uuid)) pos.set(r.uuid, i);
  }
  for (let i = 0; i < rows.length; i += 1) {
    const r = rows[i];
    if (r === undefined) continue;
    const inner = r.row as { door?: unknown } | null;
    if (inner === null || typeof inner !== "object" || inner.door !== "compaction") continue;
    if (r.parentUuid === null) continue;
    const at = pos.get(r.parentUuid);
    if (at === undefined) continue;
    if (i - at > STITCH_MAX_PARENT_GAP) return true;
  }
  return false;
}

/** The load-time heal lane over a sweep: when the duplicate census or the
 *  artifact-parent signature says the mirror is in a wrong state, run the
 *  rewrite (the caller's heal seam) and serve the RE-SWEPT rows so the
 *  load proceeds from the healed state. A heal that reports failure keeps
 *  the original rows — a later load retries. */
export async function sweepWithStitch<
  S extends {
    rows: readonly { uuid: string; parentUuid: string | null; row: unknown }[];
    lines: number;
    uniqueUuids: number;
  },
>(
  sweep: S,
  heal: () => Promise<boolean>,
  resweep: () => Promise<S>,
  log: (message: string) => void,
): Promise<{ sweep: S; compacted: boolean }> {
  if (!shouldCompactMirror(sweep) && !shouldStitchMirrorParents(sweep.rows)) {
    return { sweep, compacted: false };
  }
  const ok = await heal();
  if (!ok) return { sweep, compacted: false };
  const fresh = await resweep();
  log(
    `mirror compacted: ${String(sweep.lines)} line(s) -> ${String(fresh.lines)} (${String(fresh.uniqueUuids)} unique)`,
  );
  return { sweep: fresh, compacted: true };
}

/** Whether the census crosses the compaction threshold. Pure. */
export function shouldCompactMirror(census: { lines: number; uniqueUuids: number }): boolean {
  const dup = census.lines - census.uniqueUuids;
  if (dup < COMPACT_MIN_DUP_LINES) return false;
  return dup >= COMPACT_MIN_DUP_RATIO * census.lines;
}

/** The helper's invocation (the host always runs --apply — the dry-run is
 *  the human-facing default). Pure; mirrors the bootstrap caller's shape. */
export function planMirrorCompactInvocation(input: {
  pluginRoot: string;
  configDir: string;
  sessionId: string;
  /** The session transcript: when given, the rewrite orders the output by
   *  the transcript's row order (the engine's write chronology) instead of
   *  first occurrence. */
  transcriptPath?: string | null;
}): {
  script: string;
  args: string[];
} {
  const clean = input.pluginRoot.replace(/[\\/]+$/, "");
  const args = ["--config-dir", input.configDir, "--session-id", input.sessionId, "--apply"];
  if (typeof input.transcriptPath === "string") args.push("--transcript", input.transcriptPath);
  return {
    script: `${clean}/helpers/mirror-compact.mjs`,
    args,
  };
}

export interface MirrorCompactReport {
  done: boolean;
  noop?: boolean;
  kept?: number;
  removed?: number;
  /** true/false when a transcript was given (ordered/not); absent otherwise. */
  transcriptOrder?: boolean;
  error?: string;
}

/** Run the compaction through the process seam. NEVER throws: a failed
 *  spawn, non-zero exit, or malformed report degrades to {done:false} —
 *  the caller logs and the resume proceeds (the duplicates cost disk, not
 *  correctness; the next resume retries). */
export async function runMirrorCompact(
  deps: {
    runProcess: (argv: string[]) => Promise<{ stdout: string; exitCode: number }>;
    log: (message: string, err?: unknown) => void;
  },
  input: { pluginRoot: string; configDir: string; sessionId: string; transcriptPath?: string | null },
  nodeBin = "node",
): Promise<MirrorCompactReport> {
  // One rewrite per session at a time, shared across every caller (the boot
  // backfill and the conversation's prepared context both heal through this
  // seam): two helper processes rewriting the same directory concurrently
  // collide mid-rewrite exactly like the ledger heal race, so a concurrent
  // caller awaits the in-flight run and reuses its result.
  const key = `${input.configDir}|${input.sessionId}`;
  const settled = inflight.get(key);
  if (settled !== undefined) return settled;
  const run = compactOnce(deps, input, nodeBin).finally(() => {
    inflight.delete(key);
  });
  inflight.set(key, run);
  return run;
}

const inflight = new Map<string, Promise<MirrorCompactReport>>();

async function compactOnce(
  deps: {
    runProcess: (argv: string[]) => Promise<{ stdout: string; exitCode: number }>;
    log: (message: string, err?: unknown) => void;
  },
  input: { pluginRoot: string; configDir: string; sessionId: string; transcriptPath?: string | null },
  nodeBin: string,
): Promise<MirrorCompactReport> {
  const plan = planMirrorCompactInvocation(input);
  try {
    const { stdout, exitCode } = await deps.runProcess([nodeBin, plan.script, ...plan.args]);
    const parsed = JSON.parse(stdout.trim().split("\n").pop() ?? "{}") as MirrorCompactReport;
    if (exitCode !== 0 || parsed.done !== true) {
      deps.log(
        `mirror compaction failed (exit ${String(exitCode)})`,
        new Error(String(parsed.error ?? "malformed report")),
      );
      return { done: false, error: String(parsed.error ?? `exit ${String(exitCode)}`) };
    }
    return parsed;
  } catch (err) {
    deps.log("mirror compaction unavailable (the process seam or the helper failed)", err);
    return { done: false, error: err instanceof Error ? err.message : String(err) };
  }
}
