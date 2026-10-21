// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>
//
// The acceptance sweep: the thirteen done-condition areas as one asserted
// gate-pass. Areas 1–8, 12, 13 assert the OWNING suites exist and pin the
// named behaviors (the suites themselves are the per-area evidence — this
// file is the index that fails when one goes missing); areas 9–11 assert
// the audit artifacts, the inertness gate's
// wiring, and the packaging invariants. Each test prints its area verdict
// (PASS/FAIL per line, the plan's checklist requirement).
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";
import { describe, expect, test } from "vitest";

const ROOT = join(__dirname, "..", "..", "..");
const FEATYARD = join(ROOT, ".featyard", "reviews", "2026-10-02-claude-port");

const area = (n: number, name: string) => process.stdout.write(`[acceptance] area ${n} ${name}: `);
const pass = () => process.stdout.write("PASS\n");

function exists(rel: string): boolean {
  return existsSync(join(ROOT, rel));
}

function reads(rel: string): string {
  return readFileSync(join(ROOT, rel), "utf8");
}

function has(source: string, needle: string): boolean {
  return source.includes(needle);
}

describe("acceptance sweep — the thirteen done-condition areas", () => {
  test("area 1 — build & drift: dual-tree suites, sync gate, offline validate", () => {
    area(1, "build & drift");
    // the drift gate script + its npm wiring
    expect(exists("scripts/claude-sync.mjs")).toBe(true);
    expect(has(reads("package.json"), "claude:sync-check")).toBe(true);
    expect(has(reads("package.json"), "claude:validate")).toBe(true);
    expect(has(reads("package.json"), "claude:test")).toBe(true);
    // the vendored core has its own test project (dual-tree vitest)
    expect(has(reads("vitest.config.ts"), "claude")).toBe(true);
    // the drift gate is green right now
    const out = execFileSync(process.execPath, ["scripts/claude-sync.mjs", "--check"], { cwd: ROOT, encoding: "utf8" });
    expect(out).not.toContain("FAIL");
    pass();
  }, 60_000);

  test("area 2 — host suite: the kit twins cover the registration/conflict/compaction/recall/trigger/stage surface", () => {
    area(2, "host suite");
    for (const twin of [
      "registration.test.ts", // registration flow + the in-list recall pin
      "conflicts-b.test.ts", // the conflict matrix
      "compaction.test.ts", // compaction messages/skip
      "recall.test.ts", // recall dispatch + reject-when-disabled
      "triggers.test.ts", // goal-extract mapping + the stage-tool gate arms
      "stage.test.ts", // caller gate + buffer contracts
      "widget.test.ts", // band + status fallback
      "settings.test.ts", // settings persistence
      "retention.test.ts", // the prune planner twin
      "todo-dumps.test.ts", // todo bridge + dump ring slice
      "capture.test.ts", // capture surface
      "capture-session.test.ts", // session lifecycle slice
      "start.test.ts", // backfill slice
      "rewind.test.ts", // rewind slice
      "runs.test.ts", // stage runs slice
      "commands.test.ts", // command surface slice
      "shims.test.ts", // shim contracts
    ]) {
      expect(exists(join("claude", "plugin-test", twin)), `${twin} missing`).toBe(true);
    }
    pass();
  });

  test("area 3 — observation: verbatim mirror, frontier, interleaving, no per-turn mutation", () => {
    area(3, "observation");
    const captureSpec = reads("claude/tests/capture/pipeline.spec.ts") + reads("claude/tests/capture/wiring.spec.ts");
    expect(captureSpec.length).toBeGreaterThan(0);
    expect(exists("claude/tests/triggers/matrix.spec.ts")).toBe(true);
    // the S1 pin: no per-turn memory injection — its own dedicated suite,
    // asserted by its named tests (not mere file existence)
    const s1 = reads("claude/tests/triggers/s1.spec.ts");
    expect(has(s1, "registers NO prompt.compose / prompt.context hook")).toBe(true);
    expect(has(s1, "full turn cycle never touches the prompt surfaces")).toBe(true);
    // H4: capture is uncapped — a 300 KB tool result stored whole
    expect(has(captureSpec, "UNCAPPED")).toBe(true);
    expect(exists("claude/host/storage/mirror.ts")).toBe(true);
    pass();
  });

  test("area 4 — compaction contracts: answer/skip shapes, kept-tail cut, passthrough arms (wiring gated separately)", () => {
    area(4, "compaction contracts");
    const hookSpec = reads("claude/tests/compaction/hook.spec.ts");
    // the compaction failure-class contracts by their named tests
    expect(has(hookSpec, "stage failure ⇒ {skip} + notify")).toBe(true);
    expect(has(hookSpec, "invalid graph ⇒ {skip} + notify BEFORE persisting")).toBe(true);
    expect(has(hookSpec, "disabled at entry ⇒ pass through")).toBe(true);
    expect(has(hookSpec, "kept tail is the budget suffix")).toBe(true);
    expect(exists("claude/host/compaction/answer.ts")).toBe(true);
    expect(exists("claude/host/compaction/cut.ts")).toBe(true); // the kept-tail cut
    pass();
  });

  test("area 5 — recall: in-list pin, disabled reject, conflict-paused serves", () => {
    area(5, "recall");
    const regSpec = reads("claude/plugin-test/registration.test.ts");
    expect(has(regSpec, "isDeferred")).toBe(true); // the in-list registration pin
    const regSpecNode = reads("claude/tests/recall/register.spec.ts");
    expect(has(regSpecNode, "starting DISABLED ⇒ the tool is ABSENT")).toBe(true);
    expect(has(regSpecNode, "enabled after a disabled start ⇒ registerIfNewlyEnabled registers once")).toBe(true);
    expect(exists("claude/host/recall/spec.ts")).toBe(true); // pi-verbatim params
    pass();
  });

  test("area 6 — surfaces: notify adapter, band, settings data layer, logger link", () => {
    area(6, "surfaces");
    const adapter = reads("claude/tests/commands/adapter.spec.ts");
    expect(has(adapter, "breaks replaced by the | delimiter")).toBe(true);
    expect(has(adapter, "level never reaches the ui.log capsule")).toBe(true);
    const render = reads("claude/tests/widget/render.spec.ts");
    expect(has(render, "full observe line matches pi's byte-for-byte")).toBe(true);
    expect(exists("claude/host/settings/consumer.ts")).toBe(true);
    expect(has(reads("claude/package.json"), "avtc-claude-logger")).toBe(true);
    expect(has(reads("claude/package.json"), "avtc-claude-settings-ui")).toBe(true);
    pass();
  });

  test("area 7 — conflicts: the A/A-prime/B/C matrix, both load orders, fail-safe pause", () => {
    area(7, "conflicts");
    const activation = reads("claude/tests/conflicts/activation.spec.ts");
    expect(has(activation, "unrooted") || has(activation, "fail-safe")).toBe(true); // the fail-safe pause
    expect(exists("claude/host/conflicts/channel-a-prime.ts")).toBe(true);
    expect(exists("claude/host/conflicts/pause.ts")).toBe(true);
    pass();
  });

  test("area 8 — aux: dump ring, status report, usage ledger, todo bridge, validate/smoke gates", () => {
    area(8, "aux");
    const dumps = reads("claude/tests/extras/dumps-ring.spec.ts");
    expect(has(dumps, "oldest") || has(dumps, "ring")).toBe(true); // slot eviction
    expect(has(reads("claude/tests/extras/status-report.spec.ts"), "paused")).toBe(true); // paused-first composition
    expect(has(reads("claude/tests/extras/usage-inputs.spec.ts"), "rates")).toBe(true); // cost from rates
    expect(has(reads("claude/tests/extras/todo-bridge.spec.ts"), "noun")).toBe(true); // cross-mod $-literal access
    expect(exists("claude/host/dumps/module.ts")).toBe(true);
    expect(exists("claude/host/todo/bridge-consumer.ts")).toBe(true);
    expect(has(reads("package.json"), "claude:validate")).toBe(true); // the CI drift gate
    pass();
  });

  test("area 9 — parity & gaps: the audit artifact matches the register (dev tree)", () => {
    area(9, "parity & gaps");
    const audit = join(FEATYARD, "acceptance-gaps-audit.md");
    if (existsSync(audit)) {
      const rows = reads(".featyard/reviews/2026-10-02-claude-port/acceptance-gaps-audit.md")
        .split("\n")
        .filter((l) => /^\| G\d+ /.test(l)).length;
      expect(rows).toBe(17); // every register entry audited
    } else {
      // a fresh clone (no .featyard): the README must carry the audit pointer
      expect(has(reads("claude/README.md"), "audit")).toBe(true);
    }
    pass();
  });

  test("area 10 — degradation: the inertness gate is wired (two disable modes ⇒ no load, no writes)", () => {
    area(10, "degradation");
    expect(exists("scripts/inertness-smoke.mjs")).toBe(true);
    const pkg = JSON.parse(reads("package.json")) as { scripts: Record<string, string> };
    const testChain = pkg.scripts.test ?? "";
    expect(testChain).toContain("npm run smokes"); // both smokes serialized into the chain
    expect(testChain).toContain("npm run acceptance:checklist"); // this index gate too
    const script = reads("scripts/inertness-smoke.mjs");
    expect(has(script, "disableAllHooks")).toBe(true);
    expect(has(script, "session-owl")).toBe(true); // asserts zero owl writes
    pass();
  });

  test("area 11 — packaging: name, version lock, exact pins, committed lockfile, offline-resolvable deps", () => {
    area(11, "packaging");
    const plugin = JSON.parse(reads("claude/.claude-plugin/plugin.json"));
    const claudePkg = JSON.parse(reads("claude/package.json"));
    const rootPkg = JSON.parse(reads("package.json"));
    expect(plugin.name).toBe("session-owl");
    expect(plugin.version).toBe(rootPkg.version); // one version per repo
    expect(claudePkg.version).toBe(rootPkg.version);
    expect(claudePkg.dependencies.typebox).toBe("1.3.27"); // exact pin
    expect(claudePkg.dependencies["avtc-claude-logger"]).toBe("^1.0.3"); // registry spec (release state — was the file: dev link)
    expect(claudePkg.dependencies["avtc-claude-settings-ui"]).toBe("^1.0.13");
    expect(exists("claude/package-lock.json")).toBe(true); // lockfile committed
    expect(exists("claude/.claude-plugin/types")).toBe(true); // committed types dir
    pass();
  });

  test("area 12 — storage: marker, sweep, batch refs, directory-as-index", () => {
    area(12, "storage");
    const mirror = reads("claude/tests/storage/mirror.spec.ts");
    expect(has(mirror, "one NEW m<seq>-<producer8>.jsonl per turn-flush")).toBe(true); // written-new batches
    const pipeline = reads("claude/tests/capture/pipeline.spec.ts");
    expect(has(pipeline, "CHECK record")).toBe(true); // the CHECK mark ordering
    expect(has(pipeline, "UNCAPPED")).toBe(true); // capture stores whole entries
    expect(exists("claude/tests/storage/store-context.spec.ts")).toBe(true); // the marker contracts live here
    expect(exists("claude/host/storage/session-marker.ts")).toBe(true);
    expect(exists("claude/tests/retention/prune.spec.ts")).toBe(true); // self-prune granularity
    pass();
  });

  test("area 13 — rewind/fork: layered check, orphan-fork class, blind-window quarantine", () => {
    area(13, "rewind/fork");
    const rewindSpecs =
      reads("claude/tests/rewind/canonical-check.spec.ts") +
      reads("claude/tests/rewind/lineage.spec.ts") +
      reads("claude/tests/rewind/reconcile.spec.ts");
    expect(has(rewindSpecs, "rewind: the absent tail is contiguous; P* is the row before it")).toBe(true);
    expect(has(rewindSpecs, "deep rewind beyond the api window")).toBe(true); // the 4096 window bound
    expect(has(rewindSpecs, "orphan-fork class")).toBe(true); // dead-marked, never repaired
    expect(exists("claude/host/rewind/reconcile.ts")).toBe(true);
    expect(exists("claude/host/rewind/tripwires.ts")).toBe(true);
    pass();
  });
});
