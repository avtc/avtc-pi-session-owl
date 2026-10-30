// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// The load-time ledger heal: when the fold detects a restated lineage uuid
// (a legitimate stream states each uuid exactly once), the rewrite runs
// helpers/ledger-compact.mjs through the process seam (real unlink needs a
// real Node process — the platform fs surface has no delete) and the load
// re-reads the healed files. NEVER throws: a missing seam or a failed
// helper keeps loading from the redundant stream (the fold is last-wins in
// memory either way) and a later load retries the heal.

export interface LedgerHealReport {
  done: boolean;
  restatedEdges?: number;
  uniqueEdges?: number;
  noop?: boolean;
}

/** The helper's invocation (the host always runs --apply — the dry-run is
 *  the human-facing default). Pure; mirrors the bootstrap caller's shape. */
export function planLedgerHealInvocation(input: { pluginRoot: string; sessionDir: string }): {
  script: string;
  args: string[];
} {
  const clean = input.pluginRoot.replace(/[\\/]+$/, "");
  return {
    script: `${clean}/helpers/ledger-compact.mjs`,
    args: ["--session-dir", input.sessionDir, "--apply"],
  };
}

export async function runLedgerHeal(
  deps: {
    runProcess: (argv: string[]) => Promise<{ stdout: string; exitCode: number }>;
    log: (message: string, err?: unknown) => void;
  },
  input: { pluginRoot: string; sessionDir: string },
  nodeBin = "node",
): Promise<LedgerHealReport> {
  const plan = planLedgerHealInvocation(input);
  try {
    // the NODE BINARY leads the argv — a bare .mjs path would shell-open,
    // not run
    const { stdout, exitCode } = await deps.runProcess([nodeBin, plan.script, ...plan.args]);
    const line = stdout.trim().split("\n").pop() ?? "";
    if (line.length === 0) {
      deps.log("ledger heal helper produced no report", new Error("empty stdout"));
      return { done: false };
    }
    const parsed = JSON.parse(line) as LedgerHealReport & { error?: string };
    if (exitCode !== 0 || parsed.done !== true) {
      deps.log(`ledger heal helper reported failure: ${parsed.error ?? `exit ${exitCode}`}`);
      return { done: false };
    }
    return { done: true, restatedEdges: parsed.restatedEdges, uniqueEdges: parsed.uniqueEdges, noop: parsed.noop };
  } catch (err) {
    deps.log("ledger heal helper failed", err);
    return { done: false };
  }
}
