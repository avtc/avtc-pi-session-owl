import { beforeEach, describe, expect, test } from "vitest";
import { recordDumpOutputRow } from "../../host/stage/dumps.js";
import { clearAllStageRuns, createStageRun, takeStageFatalModelError } from "../../host/stage/runs.js";

const CFG = {
  model: "m",
  maxTurns: 8,
  maxTokens: 8000,
  timeoutMs: 60000,
  noProgressTurns: 3,
  promptChars: 2000,
  resultChars: 2000,
};

describe("fatal model-error detection in the captured stage rows", () => {
  beforeEach(() => {
    clearAllStageRuns();
  });

  test("an engine api_error system row marks the stage fatal (first detail sticks) and reports through the seam", () => {
    const seen: string[] = [];
    const onFatal = (detail: string): void => {
      seen.push(detail);
    };
    const run = createStageRun("ag-x", "observer", CFG);
    recordDumpOutputRow(run, { message: { type: "assistant", text: "hi" }, door: "note" }, onFatal);
    expect(seen).toEqual([]);
    expect(takeStageFatalModelError("observer")).toBeNull();
    recordDumpOutputRow(run, { message: { type: "system", name: "api_error", content: [] }, door: "notice" }, onFatal);
    recordDumpOutputRow(run, { message: { type: "system", name: "api_error", status: 503 }, door: "notice" }, onFatal);
    expect(seen.length).toBe(1); // only the FIRST fatal row reports
    expect(takeStageFatalModelError("observer")).toBe("api_error");
  });

  test("status-carrying rows surface the status; other shapes never match", () => {
    const run = createStageRun("ag-y", "builder", CFG);
    recordDumpOutputRow(run, { message: { type: "system", name: "api_error", status: 529 }, door: "notice" });
    expect(takeStageFatalModelError("builder")).toBe("api_error status 529");
    recordDumpOutputRow(run, null);
    recordDumpOutputRow(run, "text");
    recordDumpOutputRow(run, { message: { type: "system", name: "other" } });
    recordDumpOutputRow(run, { nope: 1 });
    expect(takeStageFatalModelError("builder")).toBeNull();
  });
});
