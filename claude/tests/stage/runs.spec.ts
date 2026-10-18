// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// The stage run-state machine: one record per spawned stage agent. These
// tests pin the state transitions the relay/tools/watchdog build on — the
// flags, the no-progress counter, and the watchdog's staleness trip.
import { beforeEach, describe, expect, test } from "vitest";
import {
  abortRun,
  clearAllStageRuns,
  completeStageRun,
  completeStep,
  createStageRun,
  enableStageDumpArchive,
  getStageRun,
  noteAccepted,
  type StageRunConfig,
  stageRunCount,
  takeStageDump,
  timeoutRun,
} from "../../host/stage/runs.js";

const CFG: StageRunConfig = { maxTokens: 1000, timeoutMs: 30_000, noProgressTurns: 3 };

describe("stage run-state", () => {
  beforeEach(() => {
    clearAllStageRuns();
  });
  test("create seeds a clean run and getStageRun finds it by agentId", () => {
    const run = createStageRun("ag-1", "observer", CFG);
    expect(run.agentId).toBe("ag-1");
    expect(run.stage).toBe("observer");
    expect(run.config).toEqual(CFG);
    expect(run.abortFlag).toBe(false);
    expect(run.abortReason).toBeNull();
    expect(run.timedOut).toBe(false);
    expect(run.stepCount).toBe(0);
    expect(run.acceptedRecords).toBe(0);
    expect(run.zeroAcceptedSteps).toBe(0);
    expect(getStageRun("ag-1")).toBe(run);
    expect(stageRunCount()).toBe(1);
  });

  test("getStageRun rejects absent/undefined ids (the caller gate's deny side)", () => {
    createStageRun("ag-2", "builder", CFG);
    expect(getStageRun(undefined)).toBeUndefined();
    expect(getStageRun(null)).toBeUndefined();
    expect(getStageRun("no-such-agent")).toBeUndefined();
  });

  test("abortRun sets the flag once — the first reason sticks (the dump marker)", () => {
    const run = createStageRun("ag-3", "observer", CFG);
    abortRun("ag-3", "signal");
    expect(run.abortFlag).toBe(true);
    expect(run.abortReason).toBe("signal");
    abortRun("ag-3", "later-reason");
    expect(run.abortReason).toBe("signal");
    abortRun("unknown-agent", "x"); // no throw, no effect
  });

  test("timeoutRun marks timedOut and aborts with reason 'timeout'", () => {
    const run = createStageRun("ag-4", "selector", CFG);
    timeoutRun("ag-4");
    expect(run.timedOut).toBe(true);
    expect(run.abortFlag).toBe(true);
    expect(run.abortReason).toBe("timeout");
  });

  test("noteAccepted accumulates; completeStep resets the no-progress counter on progress", () => {
    const run = createStageRun("ag-5", "observer", CFG);
    noteAccepted("ag-5", 2);
    expect(run.acceptedRecords).toBe(2);
    expect(completeStep("ag-5")).toBe(false);
    expect(run.stepCount).toBe(1);
    expect(run.zeroAcceptedSteps).toBe(0);
  });

  test("the no-progress rule trips the abort at the configured turn count", () => {
    const run = createStageRun("ag-6", "observer", { ...CFG, noProgressTurns: 3 });
    expect(completeStep("ag-6")).toBe(false); // 1st zero turn
    expect(run.zeroAcceptedSteps).toBe(1);
    expect(completeStep("ag-6")).toBe(false); // 2nd
    expect(run.zeroAcceptedSteps).toBe(2);
    expect(completeStep("ag-6")).toBe(true); // 3rd — trip
    expect(run.abortFlag).toBe(true);
    expect(run.abortReason).toBe("no-progress");
    expect(run.stepCount).toBe(3);
  });

  test("a zero-accepted step after progress restarts the count from one", () => {
    const run = createStageRun("ag-7", "observer", { ...CFG, noProgressTurns: 3 });
    noteAccepted("ag-7", 1);
    completeStep("ag-7"); // progress — reset
    expect(completeStep("ag-7")).toBe(false);
    expect(run.zeroAcceptedSteps).toBe(1);
  });

  test("noProgressTurns 0 disables the rule (goal-extract-style one-shot runs)", () => {
    const run = createStageRun("ag-8", "observer", { ...CFG, noProgressTurns: 0 });
    for (let i = 0; i < 10; i += 1) completeStep("ag-8");
    expect(run.abortFlag).toBe(false);
  });

  test("no turn cap exists (pi parity — NO_TURN_LIMIT everywhere; no maxTurns knob to disable)", () => {
    const run = createStageRun("ag-mt", "builder", { ...CFG, noProgressTurns: 0 });
    for (let i = 0; i < 100; i += 1) completeStep("ag-mt");
    expect(run.abortFlag).toBe(false); // only timeout/no-progress/signal levers exist (pi parity)
  });

  test("an aborted run's zero steps do not re-trip (first reason sticks)", () => {
    const run = createStageRun("ag-9", "observer", CFG);
    abortRun("ag-9", "signal");
    expect(completeStep("ag-9")).toBe(false);
    expect(run.abortReason).toBe("signal");
  });

  test("completeStageRun removes the run and hands back the final state", () => {
    createStageRun("ag-11", "observer", CFG);
    const final = completeStageRun("ag-11");
    expect(final?.agentId).toBe("ag-11");
    expect(getStageRun("ag-11")).toBeUndefined();
    const before = stageRunCount();
    createStageRun("ag-11b", "observer", CFG);
    completeStageRun("ag-11b");
    expect(stageRunCount()).toBe(before); // removed again
    expect(completeStageRun("ag-11")).toBeUndefined();
  });

  test("completion merges into the stage's dump archive ONLY when armed (order kept)", () => {
    // unarmed (dumps disabled — the default): NOTHING accumulates
    const off = createStageRun("ag-off", "observer", CFG);
    off.dump.outputRows.push("row-x");
    completeStageRun("ag-off");
    expect(takeStageDump("observer")).toBeNull();

    enableStageDumpArchive("selector");
    const a = createStageRun("ag-a", "selector", CFG);
    a.dump.sections.push('<pass n="1">\n');
    a.dump.outputRows.push("row-1");
    a.dump.fabricatedStop = "timeout";
    completeStageRun("ag-a");
    const b = createStageRun("ag-b", "selector", CFG);
    b.dump.sections.push("</pass>\n", '<pass n="2">\n');
    b.dump.outputRows.push("row-2");
    b.dump.handback = { tool: "SubagentHandback", result: { ok: true } };
    completeStageRun("ag-b");

    const merged = takeStageDump("selector");
    expect(merged).not.toBeNull();
    expect(merged?.sections).toEqual(['<pass n="1">\n', "</pass>\n", '<pass n="2">\n']);
    expect(merged?.outputRows).toEqual(["row-1", "row-2"]);
    expect(merged?.handback).toEqual({ tool: "SubagentHandback", result: { ok: true } });
    expect(merged?.fabricatedStop).toBe("timeout"); // the first sticks
    expect(takeStageDump("selector")).toBeNull(); // take clears
    expect(takeStageDump("builder")).toBeNull(); // other stages untouched
  });
});
