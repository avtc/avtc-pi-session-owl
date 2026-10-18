// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// The startup invocation of the bootstrap helper: when the backfill's
// transcript read is over the read cap, CLI surfaces run
// helpers/bootstrap.mjs via $.process.run — it streams the transcript
// line-by-line and writes owl mirror batches directly into the session
// directory (the engine-uninvolved, user-runnable script is the SAME
// helper; the startup run is the ladder's automatic rung). Non-CLI
// surfaces DEFER to the next CLI open and /owl-status documents the
// manual command (the ladder's rung 2). Failure is log-and-continue: the
// readable backlog still observes (rung 4) and the blocked backlog stays
// pending — self-heals at the next CLI open or the manual run.
//
// The planner here is pure (surface + paths in, argv + decision out);
// the process run is an injected seam so the register.ts wiring spells
// the engine call literally (the hard $-literal rules forbid passing $
// or its nouns across boundaries).
import { errDetail } from "../log/err-detail.js";
import type { StartSurface } from "../retention/prune-caller.js";

export const BOOTSTRAP_HELPER_RELATIVE = "helpers/bootstrap.mjs";

/** The plugin-closure path join (no node:path — the closure forbids it;
 *  string joins are the sanctioned form, same as the sibling dists). */
function pluginJoin(root: string, rel: string): string {
  const clean = root.replace(/[\\/]+$/, "");
  return `${clean}/${rel}`;
}

export interface BootstrapCallerInput {
  surface: StartSurface;
  /** The session transcript path (the stream source). */
  transcriptPath: string;
  /** The Claude config dir (the session directory lives under it). */
  configDir: string;
  /** The conversation's session id (the session directory name). */
  sessionId: string;
  /** The plugin root (the helper ships beside hooks/). */
  pluginRoot: string;
}

export interface BootstrapPlan {
  /** Whether the helper runs this start. */
  run: boolean;
  /** "cli" runs it; "non-cli-defers" waits for a CLI surface. */
  reason: "cli" | "non-cli-defers";
  /** The resolved script path (null when not running). */
  script: string | null;
  /** The argv after the script. */
  args: string[];
}

/** The pure planner: CLI surfaces (null = CLI -p, "terminal" = interactive)
 *  stream the over-cap transcript automatically; anything else defers. */
export function planBootstrapInvocation(input: BootstrapCallerInput): BootstrapPlan {
  const script = pluginJoin(input.pluginRoot, BOOTSTRAP_HELPER_RELATIVE);
  const cli = input.surface === null || input.surface === "terminal";
  if (!cli) return { run: false, reason: "non-cli-defers", script: null, args: [] };
  const args = [input.transcriptPath, "--config-dir", input.configDir, "--session-id", input.sessionId];
  return { run: true, reason: "cli", script, args };
}

/** The manual command /owl-status documents while the backlog is blocked
 *  (the ladder's rung 2 — the user runs the SAME helper by hand). */
export function manualBootstrapCommand(
  input: Omit<BootstrapCallerInput, "surface"> & { surface?: StartSurface },
): string {
  const plan = planBootstrapInvocation({ ...input, surface: "terminal" });
  const script = plan.script ?? pluginJoin(input.pluginRoot, BOOTSTRAP_HELPER_RELATIVE);
  const argv = [script, ...plan.args];
  // quote every token that may contain spaces (paths on Windows do)
  return ["node", ...argv].map((t) => (/^[^\\/"'\s]+$/u.test(t) ? t : `"${t}"`)).join(" ");
}

export type RunProcessFn = (argv: string[]) => Promise<{
  stdout: string;
  exitCode: number;
  isStdoutTruncated?: boolean;
}>;

export interface BootstrapRunResult {
  ok: boolean;
  /** The helper's parsed summary when the run succeeded ({rows, pages,…}). */
  report?: { rows?: unknown; pages?: unknown; sessionDir?: unknown };
  /** The failure description when it did not (never thrown — bootstrap
   *  failures are log-and-continue by contract; the backlog stays pending). */
  error?: string;
}

/** Run the planned bootstrap. NEVER throws: a helper crash, a non-zero
 *  exit, or a malformed summary degrades to {ok:false} — the caller logs
 *  and the start sequence proceeds (the blocked backlog self-heals at the
 *  next CLI open or the manual run). */
export async function runBootstrapHelper(
  deps: { runProcess: RunProcessFn; log: (message: string, err?: unknown) => void },
  input: BootstrapCallerInput,
  nodeBin = "node",
): Promise<BootstrapRunResult> {
  const plan = planBootstrapInvocation(input);
  if (!plan.run || plan.script === null) return { ok: false, error: plan.reason };
  try {
    const { stdout, exitCode, isStdoutTruncated } = await deps.runProcess([nodeBin, plan.script, ...plan.args]);
    if (isStdoutTruncated === true) {
      const error = "bootstrap helper stdout truncated";
      deps.log("transcript bootstrap failed", new Error(error));
      return { ok: false, error };
    }
    const line = stdout.trim().split("\n").pop() ?? "";
    if (line.length > 0) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch (err) {
        deps.log(
          "bootstrap helper stdout was not JSON (treated as not-done)",
          err instanceof Error ? err : new Error(errDetail(err)),
        );
        parsed = null;
      }
      if (parsed !== null && typeof parsed === "object" && (parsed as { done?: unknown }).done === true) {
        return { ok: true, report: parsed as BootstrapRunResult["report"] };
      }
      if (parsed !== null && typeof parsed === "object" && (parsed as { error?: unknown }).error !== undefined) {
        const error = `bootstrap helper reported: ${String((parsed as { error?: unknown }).error)}`;
        deps.log("transcript bootstrap failed", new Error(error));
        return { ok: false, error };
      }
    }
    if (exitCode !== 0) {
      const error = `bootstrap helper exited ${exitCode}`;
      deps.log("transcript bootstrap failed", new Error(error));
      return { ok: false, error };
    }
    // exit 0 with no parseable summary line — the batches on disk are the
    // output; trust the exit code
    return { ok: true };
  } catch (err) {
    deps.log("transcript bootstrap failed", err);
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
