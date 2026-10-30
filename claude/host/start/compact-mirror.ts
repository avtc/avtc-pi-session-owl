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
export const COMPACT_MIN_DUP_LINES = 1000;
export const COMPACT_MIN_DUP_RATIO = 0.3;

/** Whether the census crosses the compaction threshold. Pure. */
export function shouldCompactMirror(census: { lines: number; uniqueUuids: number }): boolean {
  const dup = census.lines - census.uniqueUuids;
  if (dup < COMPACT_MIN_DUP_LINES) return false;
  return dup >= COMPACT_MIN_DUP_RATIO * census.lines;
}

/** The helper's invocation (the host always runs --apply — the dry-run is
 *  the human-facing default). Pure; mirrors the bootstrap caller's shape. */
export function planMirrorCompactInvocation(input: { pluginRoot: string; configDir: string; sessionId: string }): {
  script: string;
  args: string[];
} {
  const clean = input.pluginRoot.replace(/[\\/]+$/, "");
  return {
    script: `${clean}/helpers/mirror-compact.mjs`,
    args: ["--config-dir", input.configDir, "--session-id", input.sessionId, "--apply"],
  };
}

export interface MirrorCompactReport {
  done: boolean;
  noop?: boolean;
  kept?: number;
  removed?: number;
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
  input: { pluginRoot: string; configDir: string; sessionId: string },
  nodeBin = "node",
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
