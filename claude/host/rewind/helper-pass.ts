// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// The over-cap transcript tier's caller: `$.fs.read` refuses files over the
// 4 MiB platform cap, so CLI surfaces run helpers/verify.mjs (a streaming
// Node helper — the file is never held in memory) for the same facts the
// whole-file read would have supplied: the chain rows and the live tip.
// Non-CLI surfaces DEFER (null) — layer 2 carries the verdict there, the
// documented degrade. The planner here is pure (surface + paths in, argv
// out); the process run is an injected seam so the register.ts wiring
// spells the engine call literally (the hard $-literal rules forbid
// passing $ or its nouns across boundaries). Mirrors the prune caller's
// shape: never throws, a helper crash / non-zero exit / truncated or
// malformed stdout all degrade to null — a failed tier is a MISSING tier,
// never a wrong verdict.

import { errDetail, sayError } from "../log/err-detail.js";
import type { RunProcessFn, StartSurface } from "../retention/prune-caller.js";
import type { TranscriptPass } from "./verifier.js";

export const VERIFY_HELPER_RELATIVE = "helpers/verify.mjs";

/** The plugin-closure path join (no node:path — the closure forbids it;
 *  string joins are the sanctioned form, same as the prune caller). */
function pluginJoin(root: string, rel: string): string {
  const clean = root.replace(/[\\/]+$/, "");
  return `${clean}/${rel}`;
}

export interface VerifyPassInput {
  /** The session.start envelope's surface (null = CLI -p, "terminal" =
   *  interactive CLI; anything else defers — only CLI surfaces run
   *  processes). */
  surface: StartSurface;
  /** The transcript JSONL path (the engine's own file). */
  transcriptPath: string;
  /** The plugin root (the helper ships beside hooks/). */
  pluginRoot: string;
  /** The incremental cursor — limits edges to rows appended after this
   *  uuid (steady-state mode; the divergence-verify slot runs full). */
  after?: string | null;
  /** The node binary (defaults to PATH resolution). */
  nodeBin?: string;
}

export interface VerifyPlan {
  run: boolean;
  reason: "cli" | "desktop-defers";
  argv: string[];
}

/** Plan the helper invocation: CLI surfaces run it, everything else defers
 *  to the next CLI open. */
export function planVerifyInvocation(input: VerifyPassInput): VerifyPlan {
  const cli = input.surface === null || input.surface === "terminal";
  if (!cli) return { run: false, reason: "desktop-defers", argv: [] };
  const script = pluginJoin(input.pluginRoot, VERIFY_HELPER_RELATIVE);
  const argv = [input.nodeBin ?? "node", script, input.transcriptPath];
  if (typeof input.after === "string" && input.after !== "") argv.push("--after", input.after);
  return { run: true, reason: "cli", argv };
}

/** Does a failed fsRead message describe the over-cap refusal (the tier
 *  this helper exists for)? Anything else — an absent file, a permission
 *  failure — is a legitimately-missing tier the helper cannot fix. */
export function isCapRefusal(message: string): boolean {
  return /4194304|4 ?MiB|byte limit/i.test(message);
}

/** Parse the helper's stdout (ONE JSON line) into the verifier's pass
 *  shape; anything malformed or ok:false degrades to null. */
export function parseHelperOutput(raw: string): TranscriptPass | null {
  const line = raw.trim().split("\n").pop() ?? "";
  if (line === "") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch (err) {
    // malformed helper output — degrade to null (the callers treat absent
    // tiers as best-effort) but SAY it: silent skips hid exactly this class
    sayError(`session-owl: verify-helper output line was not JSON: ${errDetail(err)}`);
    return null;
  }
  if (parsed === null || typeof parsed !== "object") return null;
  const report = parsed as { ok?: unknown; tip?: unknown; edges?: unknown; rewound?: unknown };
  if (report.ok !== true || !Array.isArray(report.edges)) return null;
  const rows: Array<{ uuid: string; parentUuid: string | null }> = [];
  for (const edge of report.edges) {
    if (!Array.isArray(edge) || typeof edge[0] !== "string") continue;
    rows.push({ uuid: edge[0], parentUuid: typeof edge[1] === "string" ? edge[1] : null });
  }
  return {
    kind: "ok",
    rows,
    tip: typeof report.tip === "string" ? report.tip : null,
    rewound: report.rewound === true,
  };
}

/** Run the planned invocation. NEVER throws: a helper crash, a non-zero
 *  exit, or truncated/malformed stdout degrades to null (the tier goes
 *  missing — logged, never a silent or wrong verdict). */
export async function runVerifyPass(
  deps: { runProcess: RunProcessFn; log: (message: string, err?: unknown) => void },
  input: VerifyPassInput,
): Promise<TranscriptPass | null> {
  const plan = planVerifyInvocation(input);
  if (!plan.run) return null;
  try {
    const { stdout, exitCode, isStdoutTruncated } = await deps.runProcess(plan.argv);
    if (isStdoutTruncated === true) {
      deps.log("rewind verify helper stdout truncated", new Error("verify helper stdout truncated"));
      return null;
    }
    if (exitCode !== 0) {
      deps.log(`rewind verify helper exited ${exitCode}`, new Error(`verify helper exited ${exitCode}`));
      return null;
    }
    return parseHelperOutput(stdout);
  } catch (err) {
    deps.log("rewind verify helper failed", err);
    return null;
  }
}
