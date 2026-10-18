// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// The startup invocation of the prune helper: at session.start backfill,
// CLI surfaces run helpers/prune.mjs via $.process.run; non-CLI surfaces
// DEFER to the next CLI run (the only true-delete path is CLI-side —
// accumulation bounded by usage, documented). Failure is log-and-continue:
// retention never blocks the start sequence.
//
// The planner here is pure (surface + retention config in, argv + decision
// out); the process run is an injected seam so the register.ts wiring
// spells the engine call literally (the hard $-literal rules forbid passing
// $ or its nouns across boundaries). The mirror-retention values arrive as
// injected config (owl's settings fields mirrorRetentionDays /
// followCleanupPeriodDays); when the installed settings library does not
// carry them, the keep-forever default rules and the sweep stays opted
// out — the pi-parity default.
/** The session.start envelope's surface: null = CLI -p, "terminal" =
 *  interactive CLI, "desktop" = the desktop app. */
export type StartSurface = string | null;

export interface PruneCallerInput {
  surface: StartSurface;
  /** owl's mirrorRetentionDays (null = not opted in). */
  retentionDays: number | null;
  /** The follow-cleanupPeriodDays mode (reads the host's own setting). */
  followCleanupPeriodDays: boolean;
  /** The Claude config dir (sessions + settings + projects under it). */
  configDir: string;
  /** The plugin root (the helper ships beside hooks/). */
  pluginRoot: string;
  /** The node binary (defaults to PATH resolution). */
  nodeBin?: string;
}

export interface PrunePlan {
  /** Whether the helper should run at all this start. */
  run: boolean;
  /** Why: "cli" runs it; "desktop-defers" waits for a CLI session;
   *  "retention-off" is the keep-forever default (no sweep at all). */
  reason: "cli" | "desktop-defers" | "retention-off";
  /** The resolved script path (null only when not running). */
  script: string | null;
  /** The argv after the script (mode flags + config dir). */
  args: string[];
  /** --apply is always on for the real invocation (the dry-run default is
   *  the helper's TEST posture; the startup sweep is the delete pass). */
}

export const PRUNE_HELPER_RELATIVE = "helpers/prune.mjs";

/** The plugin-closure path join (no node:path — the closure forbids it;
 *  string joins are the sanctioned form, same as the sibling dists). */
function pluginJoin(root: string, rel: string): string {
  const clean = root.replace(/[\\/]+$/, "");
  return `${clean}/${rel}`;
}

/** The pure planner: decides whether and how the sweep runs this start. */
export function planPruneInvocation(input: PruneCallerInput): PrunePlan {
  const script = pluginJoin(input.pluginRoot, PRUNE_HELPER_RELATIVE);
  const retentionOn = input.retentionDays !== null || input.followCleanupPeriodDays;
  if (!retentionOn) return { run: false, reason: "retention-off", script: null, args: [] };
  // null = CLI -p; "terminal" = interactive CLI — both can run processes.
  // Any other surface value (the desktop app) defers to the next CLI run.
  const cli = input.surface === null || input.surface === "terminal";
  if (!cli) return { run: false, reason: "desktop-defers", script: null, args: [] };
  const args = ["--config-dir", input.configDir, "--apply"];
  if (input.followCleanupPeriodDays) args.push("--follow-cleanup");
  else args.push("--days", String(input.retentionDays));
  return { run: true, reason: "cli", script, args };
}

/** The injected process-run seam: (argv) => { stdout, exitCode,
 *  isStdoutTruncated? } — the register.ts wiring supplies the literal
 *  $.process.run closure (its result carries the truncation flag). */
export type RunProcessFn = (argv: string[]) => Promise<{
  stdout: string;
  exitCode: number;
  isStdoutTruncated?: boolean;
}>;

export interface PruneRunResult {
  ok: boolean;
  /** The plan's reason when the sweep did not run (retention-off /
   *  desktop-defers) — not a helper report. */
  skipped?: "retention-off" | "desktop-defers";
  /** The helper's parsed report when the run succeeded. */
  report?: unknown;
  /** The failure description when it did not (never thrown — retention
   *  failures are log-and-continue by contract). */
  error?: string;
}

/** Run the planned invocation. NEVER throws: a helper crash, a non-zero
 *  exit, or a malformed report degrades to {ok:false} — the caller logs and
 *  the start sequence proceeds (retention never blocks backfill). */
export async function runPruneHelper(
  deps: { runProcess: RunProcessFn; log: (message: string, err?: unknown) => void },
  input: PruneCallerInput,
  nodeBin = "node",
): Promise<PruneRunResult> {
  const plan = planPruneInvocation(input);
  if (!plan.run || plan.script === null)
    return { ok: true, skipped: plan.reason as "retention-off" | "desktop-defers" };
  try {
    const { stdout, exitCode, isStdoutTruncated } = await deps.runProcess([nodeBin, plan.script, ...plan.args]);
    if (isStdoutTruncated === true) {
      // a truncated report cannot be trusted — same log-and-continue posture
      const error = "prune helper stdout truncated";
      deps.log("mirror retention sweep failed", new Error(error));
      return { ok: false, error };
    }
    if (exitCode !== 0) {
      const error = `prune helper exited ${exitCode}`;
      deps.log("mirror retention sweep failed", new Error(error));
      return { ok: false, error };
    }
    const line = stdout.trim().split("\n").pop() ?? "";
    return { ok: true, report: JSON.parse(line) };
  } catch (err) {
    deps.log("mirror retention sweep failed", err);
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
